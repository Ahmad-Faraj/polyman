import { matchesAny } from './glob.ts';
import type { AutonomyConfig, Tier } from './config.ts';

export interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  added: number;
  deleted: number;
}

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Info' | 'Unknown';

export interface Finding {
  scanner: 'sast' | 'secret_detection' | 'dependency_scanning';
  severity: Severity;
  name: string;
  file?: string;
}

/** A learned weight: past incidents caused by changes to these paths. */
export interface Incident {
  paths: string[];
  weight: number;
  reason: string;
  ref?: string;
}

export interface Factor {
  id: string;
  points: number;
  detail: string;
}

export interface RiskReport {
  score: number;
  tier: Tier;
  /** Set when a hard rule forces the high tier (e.g. a leaked secret). */
  forcedBy: string | null;
  factors: Factor[];
  stats: { files: number; linesChanged: number; findings: Record<Severity, number> };
}

const TIER_POINTS = { critical: 45, high: 30, medium: 12, low: 0 } as const;
const SEVERITY_POINTS: Record<Severity, number> = { Critical: 45, High: 30, Medium: 10, Low: 2, Info: 0, Unknown: 5 };

export function assessRisk(
  files: ChangedFile[],
  findings: Finding[],
  config: AutonomyConfig,
  incidents: Incident[] = [],
): RiskReport {
  const factors: Factor[] = [];
  const add = (id: string, points: number, detail: string) => {
    if (points > 0) factors.push({ id, points, detail });
  };
  let forcedBy: string | null = null;

  // paths: the most sensitive tier touched sets the base score, extra files in
  // that tier add a bit on top
  const tierOf = (path: string): keyof typeof TIER_POINTS | null => {
    for (const tier of ['critical', 'high', 'medium', 'low'] as const) {
      if (matchesAny(path, config.paths[tier])) return tier;
    }
    return null;
  };
  const byTier = new Map<string, string[]>();
  for (const f of files) {
    const tier = tierOf(f.path) ?? 'unclassified';
    byTier.set(tier, [...(byTier.get(tier) ?? []), f.path]);
  }
  for (const tier of ['critical', 'high', 'medium'] as const) {
    const hit = byTier.get(tier);
    if (hit) {
      add(`paths.${tier}`, TIER_POINTS[tier], `${tier} path touched: ${hit.slice(0, 3).join(', ')}${hit.length > 3 ? ` (+${hit.length - 3})` : ''}`);
      const extra = Math.min(15, (hit.length - 1) * 5);
      add(`paths.${tier}.spread`, extra, `${hit.length} ${tier} files changed`);
      break;
    }
  }
  const unclassified = byTier.get('unclassified')?.filter((p) => matchesAny(p, config.source)) ?? [];
  if (!byTier.has('critical') && !byTier.has('high') && !byTier.has('medium') && unclassified.length) {
    add('paths.source', 10, `application source changed: ${unclassified.slice(0, 3).join(', ')}`);
  }

  // changes to the pipeline/policy itself always count as high risk
  const governance = files.filter((f) => matchesAny(f.path, config.governance)).map((f) => f.path);
  if (governance.length) {
    const listed = governance.slice(0, 3).join(', ') + (governance.length > 3 ? ` and ${governance.length - 3} more` : '');
    add('governance', 40, `pipeline/policy files changed: ${listed}`);
    forcedBy ??= `it changes the pipeline or its policy (${listed})`;
  }

  // dependencies
  const manifests = files.filter((f) => matchesAny(f.path, config.dependencies.manifests));
  const lockOnly = !manifests.length && files.some((f) => matchesAny(f.path, config.dependencies.lockfiles));
  add('dependencies', manifests.length ? 20 : lockOnly ? 8 : 0, manifests.length ? 'dependency manifest changed' : 'lockfile changed');

  // size of the change
  const linesChanged = files.reduce((n, f) => n + f.added + f.deleted, 0);
  const sizePoints = linesChanged > 400 ? 20 : linesChanged > 150 ? 12 : linesChanged > 50 ? 5 : 0;
  add('size', sizePoints, `${linesChanged} lines changed across ${files.length} files`);
  const deleted = files.filter((f) => f.status === 'D');
  add('deletions', deleted.length ? 5 : 0, `${deleted.length} file(s) deleted`);

  const touchesSource = files.some((f) => f.status !== 'D' && matchesAny(f.path, config.source));
  const touchesTests = files.some((f) => matchesAny(f.path, config.tests));
  add('tests.missing', touchesSource && !touchesTests ? 10 : 0, 'source changed without any test changes');

  // Findings from the scanners in this pipeline. The scanners report the whole
  // repository, so only findings in files this change touches count; ones
  // without a file (some dependency findings) count too, to be safe.
  const touched = new Set(files.map((f) => f.path));
  findings = findings.filter((f) => !f.file || touched.has(f.file));
  const counts: Record<Severity, number> = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0, Unknown: 0 };
  for (const f of findings) counts[f.severity]++;
  const secretHits = findings.filter((f) => f.scanner === 'secret_detection');
  if (secretHits.length) {
    add('security.secrets', 50, `${secretHits.length} potential secret(s) detected`);
    forcedBy ??= 'a potential secret was detected';
  }
  const vulnPoints = findings
    .filter((f) => f.scanner !== 'secret_detection')
    .reduce((n, f) => n + SEVERITY_POINTS[f.severity], 0);
  add('security.findings', Math.min(60, vulnPoints), summarizeFindings(findings.filter((f) => f.scanner !== 'secret_detection')));

  // paths that caused incidents before get extra weight
  for (const incident of incidents) {
    const hit = files.find((f) => matchesAny(f.path, incident.paths));
    if (hit) add('history', incident.weight, `${hit.path}: ${incident.reason}${incident.ref ? ` (${incident.ref})` : ''}`);
  }

  const score = Math.min(100, factors.reduce((n, f) => n + f.points, 0));
  const tier: Tier = forcedBy || score >= config.thresholds.high ? 'high' : score >= config.thresholds.medium ? 'medium' : 'low';

  return { score, tier, forcedBy, factors, stats: { files: files.length, linesChanged, findings: counts } };
}

function summarizeFindings(findings: Finding[]): string {
  const bySeverity = new Map<string, number>();
  for (const f of findings) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
  return [...bySeverity].map(([s, n]) => `${n} ${s}`).join(', ') + ' security finding(s)';
}
