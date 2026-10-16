import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { ChangedFile, Finding, Incident, Severity } from './risk.ts';

/** Files changed between the merge base with `baseRef` and HEAD. */
export function changedFiles(baseRef: string): ChangedFile[] {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const range = `${baseRef}...HEAD`;
  const statuses = new Map<string, ChangedFile['status']>();
  for (const line of git('diff', '--name-status', '--no-renames', range).split('\n').filter(Boolean)) {
    const [code, ...paths] = line.split('\t');
    statuses.set(paths[paths.length - 1], code[0] as ChangedFile['status']);
  }
  const files: ChangedFile[] = [];
  for (const line of git('diff', '--numstat', '--no-renames', range).split('\n').filter(Boolean)) {
    const [added, deleted, ...rest] = line.split('\t');
    // Renames print as "old => new" or "dir/{old => new}/file".
    const path = rest.join('\t').replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/^.* => /, '').replace('//', '/');
    files.push({
      path,
      status: statuses.get(path) ?? 'M',
      // Binary files report "-".
      added: added === '-' ? 0 : Number(added),
      deleted: deleted === '-' ? 0 : Number(deleted),
    });
  }
  return files;
}

const SCANNERS: Record<string, Finding['scanner']> = {
  sast: 'sast',
  secret_detection: 'secret_detection',
  dependency_scanning: 'dependency_scanning',
};

interface SecurityReport {
  scan?: { type?: string };
  vulnerabilities?: { name?: string; message?: string; severity?: string; location?: { file?: string } }[];
}

/** Reads every GitLab security report (gl-*-report.json) in `dir`. */
export function securityFindings(dir = '.'): { findings: Finding[]; reports: string[] } {
  const findings: Finding[] = [];
  const reports: string[] = [];
  for (const name of readdirSync(dir).filter((n) => /^gl-.*-report\.json$/.test(n))) {
    let report: SecurityReport;
    try {
      report = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8'));
    } catch {
      continue;
    }
    const scanner = SCANNERS[report.scan?.type ?? ''];
    if (!scanner) continue;
    reports.push(name);
    for (const v of report.vulnerabilities ?? []) {
      findings.push({
        scanner,
        severity: normalizeSeverity(v.severity),
        name: v.name ?? v.message ?? 'unnamed finding',
        file: v.location?.file,
      });
    }
  }
  return { findings, reports };
}

function normalizeSeverity(s: string | undefined): Severity {
  const known: Severity[] = ['Critical', 'High', 'Medium', 'Low', 'Info'];
  return known.find((k) => k.toLowerCase() === s?.toLowerCase()) ?? 'Unknown';
}

export function loadIncidents(path: string): Incident[] {
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(data) ? data : (data.incidents ?? []);
}
