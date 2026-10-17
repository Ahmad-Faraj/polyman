import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { ChangedFile, Finding, Incident, Severity } from './risk.ts';

/** Files changed between the merge base with `baseRef` and HEAD. */
export function changedFiles(baseRef: string): ChangedFile[] {
  // core.quotepath=off: non-ASCII paths come out as they are (as the scanners
  // report them), not quoted and octal-escaped
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const range = `${baseRef}...HEAD`;
  const statuses = new Map<string, ChangedFile['status']>();
  for (const line of git('diff', '--name-status', '--no-renames', range).split('\n').filter(Boolean)) {
    const [code, ...paths] = line.split('\t');
    statuses.set(paths[paths.length - 1], code[0] as ChangedFile['status']);
  }
  // explicit prefixes, whatever diff.noprefix or diff.mnemonicPrefix say
  const hunks = addedLines(git('diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', range));
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
      addedLines: added === '-' ? undefined : hunks.get(path),
    });
  }
  return files;
}

/**
 * The line ranges each file gained, from a `git diff -U0`: the new side of
 * every hunk header. A path git still quotes (a tab, a newline, a quote) is
 * left out, so its findings count anywhere in the file.
 *
 * A `+++ ` line is a file header only between `diff --git` and the first
 * hunk: an added line whose content starts with `++ ` prints as `+++ ` too,
 * and read as a header it would file later hunks under a made-up path.
 */
export function addedLines(diff: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let current: [number, number][] | null = null;
  let inHeader = false;
  for (const line of diff.split('\n')) {
    // content lines always start with +, - or a space, so these can't be content
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      current = null;
      continue;
    }
    if (inHeader && line.startsWith('+++ ')) {
      // git ends the name with a tab when it contains a space
      const name = line.slice(4).replace(/\t$/, '');
      current = name.startsWith('b/') ? [] : null;
      if (current) out.set(name.slice(2), current);
      continue;
    }
    if (!line.startsWith('@@')) continue;
    inHeader = false;
    const hunk = current && /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      const first = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) current!.push([first, first + count - 1]);
    }
  }
  return out;
}

const SCANNERS: Record<string, Finding['scanner']> = {
  sast: 'sast',
  secret_detection: 'secret_detection',
  dependency_scanning: 'dependency_scanning',
};

interface SecurityReport {
  scan?: { type?: string };
  vulnerabilities?: { name?: string; message?: string; severity?: string; location?: { file?: string; start_line?: number; end_line?: number } }[];
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
        line: typeof v.location?.start_line === 'number' ? v.location.start_line : undefined,
        endLine: typeof v.location?.end_line === 'number' ? v.location.end_line : undefined,
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
