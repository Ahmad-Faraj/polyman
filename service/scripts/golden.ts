/**
 * Runs every sample problem against a deployed service and compares the result
 * with what it should be (samples/NAME.expected.json): whether the problem
 * passed, which solutions matched their tags, and which guideline checks
 * failed. The same check serves as the smoke test in CI and as the production
 * check after a release.
 *
 *   node service/scripts/golden.ts https://verify.example.run.app [--json report.json]
 *
 * Exits 1 if any sample differs, or if the service can't be reached.
 */
import { writeFileSync } from 'node:fs';

export interface Expected {
  ok: boolean;
  solutions: Record<string, boolean>;
  readinessFailures: string[];
}

export interface SampleResult {
  sample: string;
  ok: boolean;
  seconds: number;
  differences: string[];
}

interface ProblemEvent {
  type: 'problem';
  ok: boolean;
  seconds: number;
  error?: string;
  report: { solutions: { name: string; matchesTag: boolean }[] } | null;
  readiness: { id: string; ok: boolean }[];
}

/** What differs between a run and what the sample should give; empty when they agree. */
export function compare(expected: Expected, got: ProblemEvent | undefined): string[] {
  if (!got) return ['no result came back'];
  const diffs: string[] = [];
  if (got.ok !== expected.ok) diffs.push(`expected ok=${expected.ok}, got ok=${got.ok}${got.error ? ` (${got.error})` : ''}`);
  const solutions = new Map((got.report?.solutions ?? []).map((s) => [s.name, s.matchesTag]));
  for (const [name, matches] of Object.entries(expected.solutions)) {
    if (!solutions.has(name)) diffs.push(`solution ${name} is missing from the report`);
    else if (solutions.get(name) !== matches) diffs.push(`solution ${name}: expected matchesTag=${matches}, got ${solutions.get(name)}`);
  }
  const failed = got.readiness.filter((c) => !c.ok).map((c) => c.id).sort();
  const want = [...expected.readinessFailures].sort();
  if (failed.join() !== want.join()) diffs.push(`guideline failures: expected [${want.join(', ')}], got [${failed.join(', ')}]`);
  return diffs;
}

export async function runGolden(base: string): Promise<SampleResult[]> {
  const samples = (await (await fetch(`${base}/api/samples`)).json()) as { name: string; expected: Expected | null }[];
  const results: SampleResult[] = [];
  for (const s of samples) {
    if (!s.expected) continue;
    const started = Date.now();
    const res = await fetch(`${base}/api/samples/${encodeURIComponent(s.name)}/verify`, { method: 'POST' });
    const text = await res.text();
    const events = res.ok ? text.trim().split('\n').map((l) => JSON.parse(l) as { type: string }) : [];
    const problem = events.find((e): e is ProblemEvent => e.type === 'problem');
    const differences = res.ok ? compare(s.expected, problem) : [`HTTP ${res.status}: ${text.slice(0, 200)}`];
    results.push({ sample: s.name, ok: differences.length === 0, seconds: (Date.now() - started) / 1000, differences });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = (process.argv[2] ?? '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) {
    console.error('usage: golden.ts BASE_URL [--json FILE]');
    process.exit(2);
  }
  const jsonAt = process.argv.indexOf('--json');
  let results: SampleResult[];
  try {
    results = await runGolden(base);
  } catch (err) {
    console.error(`could not reach ${base}: ${(err as Error).message}`);
    process.exit(1);
  }
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.sample} (${r.seconds.toFixed(1)} s)`);
    for (const d of r.differences) console.log(`     ${d}`);
  }
  if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify({ base, results }, null, 2));
  if (!results.length) console.error('no samples with an expected result');
  if (!results.length || results.some((r) => !r.ok)) process.exit(1);
}

