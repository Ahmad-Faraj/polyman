import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { ChangedFile, Finding, Incident, Severity } from './risk.ts';

/**
 * Files changed between the merge base with `baseRef` and HEAD. Paths come
 * from NUL-separated output (-z), so they are exactly what the scanners report,
 * whatever characters they hold.
 */
export function changedFiles(baseRef: string): ChangedFile[] {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const range = `${baseRef}...HEAD`;
  const statuses = new Map<string, ChangedFile['status']>();
  const status = git('diff', '--name-status', '-z', '--no-renames', range).split('\0');
  for (let i = 0; i + 1 < status.length; i += 2) statuses.set(status[i + 1], status[i][0] as ChangedFile['status']);
  const hunks = addedLinesOf(git, range);
  const files: ChangedFile[] = [];
  for (const entry of git('diff', '--numstat', '-z', '--no-renames', range).split('\0').filter(Boolean)) {
    const [added, deleted, ...rest] = entry.split('\t');
    const path = rest.join('\t');
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
 * The added line ranges per file, or none at all when the diff can't be read
 * (one too big for the buffer, say): then every finding in a touched file
 * counts, matched by file only. The prefixes and quoting are set here
 * so a user's git config (diff.noprefix, core.quotePath) can't change them.
 */
export function addedLinesOf(git: (...args: string[]) => string, range: string): Map<string, [number, number][]> {
  try {
    return addedLines(
      git('-c', 'core.quotePath=false', 'diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', range),
    );
  } catch (err) {
    // only git failing or its output overflowing the buffer; a bug in the parser still throws
    const e = err as NodeJS.ErrnoException & { status?: number };
    if (e.code !== 'ENOBUFS' && typeof e.status !== 'number') throw err;
    console.warn(`warning: couldn't read the diff's line ranges (${e.message.split('\n')[0]}); findings count anywhere in a touched file`);
    return new Map();
  }
}

/**
 * The line ranges each file gained, from a `git diff -U0`: the new side of
 * every hunk header. A "+++" line is a file name only in a file's header, after
 * "diff --git" and before its first "@@": in a hunk, an added line that reads
 * "++ x" shows up as "+++ x" and must not start a new file. A path git still
 * quotes (a quote, a backslash or a control character in it) is left out, so
 * its findings count anywhere in the file.
 */
export function addedLines(diff: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let current: [number, number][] | null = null;
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = true;
      current = null;
      continue;
    }
    if (header && line.startsWith('+++ ')) {
      // git ends the name with a tab when it holds a space
      const name = line.slice(4).replace(/\t$/, '');
      current = name.startsWith('b/') ? [] : null;
      if (current) out.set(name.slice(2), current);
      continue;
    }
    if (!line.startsWith('@@')) continue;
    header = false;
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
  const list = Array.isArray(data) ? data : data?.incidents;
  if (!Array.isArray(list)) {
    console.warn(`${path}: expected a list of incidents, read none`);
    return [];
  }
  // an agent writes these entries: one with the wrong shape is skipped, not fatal
  return (list as unknown[]).filter((e): e is Incident => {
    const i = e as Partial<Incident> | null;
    const ok = !!i && Array.isArray(i.paths) && i.paths.every((p) => typeof p === 'string') && typeof i.weight === 'number';
    if (!ok) console.warn(`${path}: skipped an entry without paths (string list) and weight (number): ${JSON.stringify(e)}`);
    return ok;
  });
}
