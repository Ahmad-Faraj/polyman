/**
 * Is the problem ready for a contest? These are the guideline checks from
 * Mazen's Polygon contest checker (its config.yaml), applied to a local polyman
 * folder and to what `polyman verify` found. They don't run code themselves.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { VerifyReport } from './verify.ts';
import { inside } from './unzip.ts';

export type Severity = 'critical' | 'warning' | 'info';

export interface Check {
  id: string;
  title: string;
  severity: Severity;
  ok: boolean;
  detail: string;
}

interface Config {
  tags?: string[];
  tutorial?: string;
  statements?: Record<string, Record<string, string | undefined>>;
  checker?: { source?: string; isStandard?: boolean };
  validator?: { source?: string };
  solutions?: { name?: string; source?: string; tag?: string; sourceType?: string }[];
}

export const MIN_TESTS = 10;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** The config as the checks expect it; anything of the wrong shape counts as missing. */
function normalise(raw: unknown): Config {
  const c = isObject(raw) ? raw : {};
  const statements: Config['statements'] = {};
  if (isObject(c.statements)) {
    for (const [lang, s] of Object.entries(c.statements)) {
      if (isObject(s)) statements[lang] = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, str(v)]));
    }
  }
  const part = (v: unknown) => (isObject(v) ? { source: str(v.source), isStandard: v.isStandard === true } : undefined);
  return {
    tags: Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === 'string') : [],
    tutorial: str(c.tutorial),
    statements,
    checker: part(c.checker),
    validator: part(c.validator),
    solutions: Array.isArray(c.solutions)
      ? c.solutions.filter(isObject).map((s) => ({ name: str(s.name), source: str(s.source), tag: str(s.tag), sourceType: str(s.sourceType) }))
      : [],
  };
}
const CORRECT = new Set(['MA', 'OK']);

const nonEmpty = (dir: string, path: string | undefined) => {
  if (!path) return false;
  try {
    const file = inside(dir, path);
    return existsSync(file) && readFileSync(file, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
};

const language = (s: { source?: string; sourceType?: string }) => {
  const hint = `${s.sourceType ?? ''} ${s.source ?? ''}`.toLowerCase();
  if (/\.(cpp|cc|cxx)\b|cpp\.|g\+\+/.test(hint)) return 'C++';
  if (/\.java\b|java\./.test(hint)) return 'Java';
  if (/\.py\b|python/.test(hint)) return 'Python';
  return 'other';
};

export function readiness(dir: string, report: VerifyReport | null): Check[] {
  const config = normalise(JSON.parse(readFileSync(inside(dir, 'Config.json'), 'utf8')));
  const checks: Check[] = [];
  const add = (id: string, title: string, severity: Severity, ok: boolean, detail: string) =>
    checks.push({ id, title, severity, ok, detail });

  const statements = Object.entries(config.statements ?? {});
  const incomplete = statements
    .map(([lang, s]) => [lang, ['legend', 'input', 'output'].filter((k) => !nonEmpty(dir, s[k]))] as const)
    .filter(([, missing]) => missing.length);
  add(
    'statement_completeness',
    'Statement has legend, input and output',
    'critical',
    statements.length > 0 && incomplete.length === 0,
    statements.length === 0
      ? 'no statement in Config.json'
      : incomplete.length
        ? incomplete.map(([lang, missing]) => `${lang}: missing or empty ${missing.join(', ')}`).join('; ')
        : `${statements.length} language(s) complete`,
  );

  const main = report?.solutions.find((s) => s.tag === 'MA');
  const tests = main?.tests.length ?? 0;
  add(
    'test_coverage',
    `At least ${MIN_TESTS} tests`,
    'critical',
    tests >= MIN_TESTS,
    report ? `${tests} test(s) ran` : 'unknown: verify did not finish',
  );

  add('checker_presence', 'Has a checker', 'critical', !!config.checker?.source, config.checker?.isStandard ? `standard checker ${config.checker.source}` : config.checker?.source ?? 'none');
  add('validator_presence', 'Has a validator', 'critical', !!config.validator?.source, config.validator?.source ?? 'none');

  const checkerSteps = report?.steps.filter((s) => s.name === 'compile-checker' || s.name === 'test-checker') ?? [];
  add(
    'checker_correctness',
    'Checker compiles and passes its tests',
    'warning',
    checkerSteps.length > 0 && checkerSteps.every((s) => s.ok),
    !report ? 'unknown: verify did not finish' : checkerSteps.length ? checkerSteps.map((s) => `${s.name}: ${s.ok ? 'ok' : s.errors.join('; ') || 'failed'}`).join(', ') : 'verify stopped before the checker',
  );

  const solutions = config.solutions ?? [];
  add('solution_presence', 'Has a main correct solution', 'critical', solutions.some((s) => s.tag === 'MA'), solutions.length ? `${solutions.length} solution(s)` : 'no solutions');

  const correctLangs = new Set<string>(solutions.filter((s) => CORRECT.has(s.tag ?? '')).map(language));
  const wrong = solutions.filter((s) => s.tag && !CORRECT.has(s.tag));
  const missing = ['C++', 'Java'].filter((l) => !correctLangs.has(l));
  add(
    'solution_diversity',
    'Correct solutions in C++ and Java, and at least one wrong solution',
    'warning',
    missing.length === 0 && wrong.length > 0,
    [missing.length ? `no correct ${missing.join(' or ')} solution` : 'C++ and Java covered', wrong.length ? `${wrong.length} wrong solution(s)` : 'no wrong solutions to show the tests catch mistakes'].join('; '),
  );

  add('tags_presence', 'Has tags', 'info', (config.tags ?? []).length > 0, (config.tags ?? []).join(', ') || 'none');

  const tutorial = nonEmpty(dir, config.tutorial) || statements.some(([, s]) => nonEmpty(dir, s.tutorial));
  add('tutorial_presence', 'Has a tutorial', 'warning', tutorial, tutorial ? 'found' : 'no tutorial file in Config.json or the statements');

  return checks;
}
