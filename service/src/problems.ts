/**
 * Finds the polyman problems in an unpacked upload and checks their
 * Config.json before polyman reads it. On someone's own machine the config is
 * trusted; here it comes from a stranger, so every path in it has to stay in
 * the problem's folder, and a standard checker has to be a plain name.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { UnsafeZipError, inside } from './unzip.ts';

/** Config keys whose string values are paths, wherever they appear. */
const PATH_KEYS = new Set([
  'source',
  'input',
  'output',
  'legend',
  'notes',
  'tutorial',
  'scoring',
  'interaction',
  'testsFilePath',
  'scriptFile',
]);

export interface Problem {
  /** folder name, or "." when the zip holds a single problem at its root */
  name: string;
  dir: string;
}

/**
 * A problem is a folder with a Config.json: the upload's root (one problem),
 * or folders one or two levels down (a contest, possibly zipped inside a
 * top-level folder).
 */
export function findProblems(root: string): Problem[] {
  if (existsSync(join(root, 'Config.json'))) return [{ name: '.', dir: root }];
  const found: Problem[] = [];
  const subdirs = (dir: string) =>
    readdirSync(dir)
      .filter((n) => !n.startsWith('.') && statSync(join(dir, n)).isDirectory())
      .sort();
  for (const a of subdirs(root)) {
    if (existsSync(join(root, a, 'Config.json'))) {
      found.push({ name: a, dir: join(root, a) });
      continue;
    }
    for (const b of subdirs(join(root, a))) {
      if (existsSync(join(root, a, b, 'Config.json'))) found.push({ name: b, dir: join(root, a, b) });
    }
  }
  return found;
}

/** Every problem with what's wrong with its config; an empty list means it may run. */
export function configProblems(dir: string): string[] {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(join(dir, 'Config.json'), 'utf8'));
  } catch (err) {
    return [`Config.json is not valid JSON: ${(err as Error).message}`];
  }
  const problems: string[] = [];
  const real = realpathSync(dir);

  const walk = (value: unknown, key: string, at: string) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, key, `${at}[${i}]`));
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const standard = obj.isStandard === true;
      for (const [k, v] of Object.entries(obj)) {
        // a standard checker's source names one of polyman's own checkers
        if (standard && k === 'source') {
          if (typeof v !== 'string' || !/^[\w.-]+$/.test(v) || v.startsWith('.')) {
            problems.push(`${at}.source: a standard checker must be a plain name like "wcmp.cpp"`);
          }
          continue;
        }
        walk(v, k, `${at}.${k}`);
      }
      return;
    }
    if (typeof value === 'string' && PATH_KEYS.has(key)) {
      try {
        const target = inside(real, value);
        // the zip can't hold symlinks, but check the real location anyway
        if (existsSync(target)) inside(real, realpathSync(target));
      } catch (err) {
        problems.push(`${at}: ${err instanceof UnsafeZipError ? err.message : String(err)}`);
      }
    }
  };
  walk(config, '', 'Config.json');
  return problems;
}

/**
 * How a problem is called in the results: its path inside the zip (so day1/A
 * and day2/A stay apart), or for a single problem at the root, the name in
 * its Config.json.
 */
export function problemLabel(p: Problem, root: string): string {
  const rel = relative(root, p.dir);
  if (rel) return rel.split('\\').join('/');
  try {
    const name = (JSON.parse(readFileSync(join(p.dir, 'Config.json'), 'utf8')) as { name?: unknown }).name;
    if (typeof name === 'string' && /^[\w .-]{1,80}$/.test(name)) return name;
  } catch {
    // fall through
  }
  return 'problem';
}
