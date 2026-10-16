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
 * One sample also goes through the upload route (/api/verify) as a zip, the
 * way visitors send problems, so the gate covers that path too.
 *
 * Exits 1 if any sample differs or is missing from the service, or the
 * service can't be reached; 2 on bad usage.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32 } from 'node:zlib';

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
const samplesDir = fileURLToPath(new URL('../samples/', import.meta.url));

/**
 * A request, waiting out 429s: on a live service real visitors may hold every
 * instance (a whole contest can take most of an hour), and a busy service is
 * not a broken one. 15 s apart, for up to an hour by default.
 */
async function whenFree(url: string, init: RequestInit = {}, waitMs = 15_000, tries = 240): Promise<Response> {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { ...init, signal: timeout(init.method === 'POST' ? 60 * 60_000 : 30_000) });
    if (res.status !== 429 || i >= tries) return res;
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/** A zip (stored, not compressed) of a folder: enough for the upload route, no dependency. */
export function zipFolder(dir: string, prefix: string): Buffer {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(dir);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const path of files) {
    const name = Buffer.from(`${prefix}/${relative(dir, path).split('\\').join('/')}`);
    const data = readFileSync(path);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += head.length + name.length + data.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirBytes, end]);
}

/** `uploadSample`: which sample also goes through the upload route (default: the first; null: none). */
export async function runGolden(base: string, expected = expectedSamples(), waitMs?: number, uploadSample?: string | null): Promise<SampleResult[]> {
  const listed = await whenFree(`${base}/api/samples`, {}, waitMs);
  if (!listed.ok) throw new Error(`GET /api/samples answered HTTP ${listed.status}`);
  const offered = new Set(((await listed.json()) as { name: string }[]).map((s) => s.name));

  const results: SampleResult[] = [];
  for (const [name, want] of expected) {
    const started = Date.now();
    let differences: string[];
    if (!offered.has(name)) {
      differences = ['the service does not offer this sample'];
    } else {
      differences = await check(`${base}/api/samples/${encodeURIComponent(name)}/verify`, {}, want, waitMs);
    }
    results.push({ sample: name, ok: differences.length === 0, seconds: (Date.now() - started) / 1000, differences });
  }

  // the upload route, with the first sample as a visitor would send it
  const upload = uploadSample === undefined ? [...expected.keys()][0] : uploadSample;
  if (upload && offered.has(upload)) {
    const started = Date.now();
    const body = new FormData();
    body.append('problem', new Blob([new Uint8Array(zipFolder(join(samplesDir, upload), upload))], { type: 'application/zip' }), `${upload}.zip`);
    const differences = await check(`${base}/api/verify`, { body }, expected.get(upload)!, waitMs);
    results.push({ sample: `${upload} (uploaded as a zip)`, ok: differences.length === 0, seconds: (Date.now() - started) / 1000, differences });
  }
  return results;
}

async function check(url: string, init: RequestInit, want: Expected, waitMs?: number): Promise<string[]> {
  const res = await whenFree(url, { ...init, method: 'POST' }, waitMs);
  const text = await res.text();
  if (!res.ok) return [`HTTP ${res.status}: ${text.slice(0, 200)}`];
  const { problem, problems } = readStream(text);
  return [...problems, ...compare(want, problem)];
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
