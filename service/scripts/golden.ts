/**
 * Runs every sample problem against a running service and compares the result
 * with what it should be (samples/NAME.expected.json in this repository, not
 * what the service says): whether the problem passed, which solutions matched
 * their tags, and which guideline checks failed. CI uses it three times:
 * against the image built in the pipeline, against the candidate revision
 * before it gets traffic, and against production after the switch.
 *
 *   node service/scripts/golden.ts https://verify.example.run.app [--json report.json]
 *
 * Exits 1 if any sample differs or is missing from the service, or the
 * service can't be reached; 2 on bad usage.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** Reads one streamed answer: the problem result, plus whatever went wrong with the stream itself. */
export function readStream(text: string): { problem?: ProblemEvent; problems: string[] } {
  const problems: string[] = [];
  let problem: ProblemEvent | undefined;
  let done = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev: { type?: string; message?: string };
    try {
      ev = JSON.parse(line);
    } catch {
      problems.push(`unreadable line: ${line.slice(0, 120)}`);
      continue;
    }
    if (ev.type === 'problem') problem = ev as ProblemEvent;
    else if (ev.type === 'error') problems.push(`the service reported an error: ${ev.message}`);
    else if (ev.type === 'done') done = true;
  }
  if (!done) problems.push('the answer ended without a "done" event');
  return { problem, problems };
}

/** The expected results kept in this repository, by sample name. */
export function expectedSamples(dir = fileURLToPath(new URL('../samples/', import.meta.url))): Map<string, Expected> {
  const out = new Map<string, Expected>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.expected.json')).sort()) {
    out.set(file.replace(/\.expected\.json$/, ''), JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as Expected);
  }
  return out;
}

const timeout = (ms: number) => AbortSignal.timeout(ms);

/**
 * POSTs, waiting out a 429: on a live service real visitors may hold every
 * instance, and a busy service is not a broken one.
 */
async function postWhenFree(url: string, waitMs = 15_000, tries = 20): Promise<Response> {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { method: 'POST', signal: timeout(10 * 60_000) });
    if (res.status !== 429 || i >= tries) return res;
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

export async function runGolden(base: string, expected = expectedSamples(), waitMs?: number): Promise<SampleResult[]> {
  const listed = await fetch(`${base}/api/samples`, { signal: timeout(30_000) });
  if (!listed.ok) throw new Error(`GET /api/samples answered HTTP ${listed.status}`);
  const offered = new Set(((await listed.json()) as { name: string }[]).map((s) => s.name));

  const results: SampleResult[] = [];
  for (const [name, want] of expected) {
    const started = Date.now();
    let differences: string[];
    if (!offered.has(name)) {
      differences = ['the service does not offer this sample'];
    } else {
      const res = await postWhenFree(`${base}/api/samples/${encodeURIComponent(name)}/verify`, waitMs);
      const text = await res.text();
      if (!res.ok) differences = [`HTTP ${res.status}: ${text.slice(0, 200)}`];
      else {
        const { problem, problems } = readStream(text);
        differences = [...problems, ...compare(want, problem)];
      }
    }
    results.push({ sample: name, ok: differences.length === 0, seconds: (Date.now() - started) / 1000, differences });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = (process.argv[2] ?? '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) {
    console.error('usage: golden.ts BASE_URL [--json FILE]');
    process.exit(2);
  }
  const jsonAt = process.argv.indexOf('--json');
  const write = (body: object) => {
    if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify({ base, ...body }, null, 2));
  };
  const expected = expectedSamples();
  if (!expected.size) {
    console.error('no samples with an expected result in service/samples');
    write({ error: 'no expected samples' });
    process.exit(1);
  }
  let results: SampleResult[];
  try {
    results = await runGolden(base, expected);
  } catch (err) {
    console.error(`could not check ${base}: ${(err as Error).message}`);
    write({ error: (err as Error).message });
    process.exit(1);
  }
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.sample} (${r.seconds.toFixed(1)} s)`);
    for (const d of r.differences) console.log(`     ${d}`);
  }
  write({ results });
  if (results.some((r) => !r.ok)) process.exit(1);
}
