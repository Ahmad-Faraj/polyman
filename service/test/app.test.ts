import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { buildApp } from '../src/app.ts';

// A stand-in for polyman: prints two progress steps to stderr and a report
// for the solutions in Config.json to stdout. It also records the environment
// it was given, so the tests can check nothing of ours leaks into it.
const FAKE_CLI = `
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('Config.json', 'utf8'));
fs.writeFileSync('env.json', JSON.stringify(process.env));
process.stderr.write('┌─ Step 1: Compiling Generators\\n┌─ Step 2: Generating Tests\\n');
fs.writeFileSync('saw-testlib.txt', String(fs.existsSync('testlib.h')));
if (config.mutate) {
  // the uploaded code changes its files while it runs; the guideline checks must not care
  fs.unlinkSync('l.tex');
  fs.writeFileSync('Config.json', JSON.stringify({ solutions: [] }));
}
if (config.hang) setInterval(() => {}, 1000);
else {
  const tests = Array.from({ length: 12 }, (_, i) => ({ testset: 'tests', index: i + 1, verdict: 'OK', timeMs: 3, message: '' }));
  process.stdout.write(JSON.stringify({
    schemaVersion: 1, polymanVersion: '9.9.9', ok: !config.broken, failedStep: config.broken ? 'verify-solutions' : null,
    steps: [{ name: 'compile-checker', ok: true, errors: [] }, { name: 'test-checker', ok: true, errors: [] }],
    solutions: (config.solutions || []).map((s) => ({ name: s.name, tag: s.tag, matchesTag: !config.broken, reason: 'fake', tests })),
  }));
}
`;

let base: string;
let app: ReturnType<typeof buildApp>;

/** `rename`: swap one entry name for another of the same length afterwards (yazl won't write duplicates) */
const zipOf = (files: Record<string, string>, rename?: [string, string]): Promise<Buffer> => {
  const zip = new yazl.ZipFile();
  for (const [name, data] of Object.entries(files)) zip.addBuffer(Buffer.from(data), name);
  zip.end();
  return new Promise((done) => {
    const parts: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => parts.push(c));
    zip.outputStream.on('end', () => {
      const buf = Buffer.concat(parts);
      done(rename ? Buffer.from(buf.toString('latin1').split(rename[0]).join(rename[1]), 'latin1') : buf);
    });
  });
};

const multipartBody = (zip: Buffer, field = 'problem') => {
  const boundary = '----test' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="p.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
};

const events = (body: string) => body.trim().split('\n').map((l) => JSON.parse(l));

const config = (extra: object = {}) =>
  JSON.stringify({
    solutions: [{ name: 'main', source: './solutions/a.cpp', tag: 'MA' }],
    checker: { source: './checker/chk.cpp' },
    validator: { source: './validator/val.cpp' },
    statements: { english: { legend: './l.tex', input: './i.tex', output: './o.tex' } },
    ...extra,
  });

/** A problem's files under `prefix` (e.g. 'p/'): its Config.json and the statement it names. */
const problem = (prefix = '', extra: object = {}): Record<string, string> => ({
  [`${prefix}Config.json`]: config(extra),
  [`${prefix}l.tex`]: 'legend',
  [`${prefix}i.tex`]: 'input',
  [`${prefix}o.tex`]: 'output',
});

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'app-test-'));
  writeFileSync(join(base, 'cli.js'), FAKE_CLI);
  writeFileSync(join(base, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  writeFileSync(join(base, 'testlib.h'), '// testlib');
  mkdirSync(join(base, 'public'));
  writeFileSync(join(base, 'public', 'index.html'), '<h1>verify</h1>');
  mkdirSync(join(base, 'samples', 'demo'), { recursive: true });
  for (const [name, text] of Object.entries(problem('', { description: 'a demo' }))) writeFileSync(join(base, 'samples', 'demo', name), text);
  writeFileSync(join(base, 'samples', 'demo.expected.json'), JSON.stringify({ ok: true }));
  process.env.SECRET_SHOULD_NOT_LEAK = 'yes';
  app = buildApp({
    // the app reads the version from ../package.json next to dist/cli.js
    polymanCli: join(base, 'dist', 'cli.js'),
    testlib: join(base, 'testlib.h'),
    samplesDir: join(base, 'samples'),
    publicDir: join(base, 'public'),
    problemTimeoutMs: 2000,
    maxProblems: 3,
    commit: 'abc1234',
  });
  mkdirSync(join(base, 'dist'));
  writeFileSync(join(base, 'dist', 'cli.js'), FAKE_CLI);
});

afterAll(async () => {
  await app.close();
  rmSync(base, { recursive: true, force: true });
  delete process.env.SECRET_SHOULD_NOT_LEAK;
});

describe('read-only routes', () => {
  it('serves the page, health and version', async () => {
    expect((await app.inject('/')).body).toContain('verify');
    expect((await app.inject('/health')).json()).toEqual({ ok: true });
    expect((await app.inject('/api/version')).json()).toEqual({ polyman: '9.9.9', service: '0.1.0', commit: 'abc1234' });
  });

  it('lists the samples with what they should give', async () => {
    expect((await app.inject('/api/samples')).json()).toEqual([{ name: 'demo', description: 'a demo', expected: { ok: true } }]);
  });
});

describe('POST /api/verify', () => {
  it('streams start, steps, the problem result with readiness, and done', async () => {
    const zip = await zipOf({ ...problem('p/') });
    const res = await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(zip) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const ev = events(res.body);
    expect(ev.map((e) => e.type)).toEqual(['start', 'step', 'step', 'problem', 'done']);
    expect(ev[0].problems).toEqual(['p']);
    expect(ev[1]).toMatchObject({ problem: 'p', step: 1, title: 'Compiling Generators' });
    expect(ev[3].ok).toBe(true);
    expect(ev[3].report.solutions[0].name).toBe('main');
    expect(ev[3].readiness.find((c: { id: string }) => c.id === 'test_coverage').ok).toBe(true);
    expect(ev[4].ok).toBe(true);
  });

  it('runs every problem of a contest and is not ok if one fails', async () => {
    const zip = await zipOf({ ...problem('A/'), ...problem('B/', { broken: true }) });
    const ev = events((await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(zip) })).body);
    expect(ev.filter((e) => e.type === 'problem').map((e) => [e.problem, e.ok])).toEqual([
      ['A', true],
      ['B', false],
    ]);
    expect(ev.at(-1)).toMatchObject({ type: 'done', ok: false });
  });

  it('reports a problem that runs past its time limit instead of hanging', async () => {
    const zip = await zipOf({ ...problem('', { hang: true }) });
    const ev = events((await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(zip) })).body);
    const result = ev.find((e) => e.type === 'problem');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('stopped after 2 s');
  });

  it.each([
    ['a zip with no problem in it', { 'readme.txt': 'hi' }, 'no problem found'],
    ['a path outside the problem folder', { ...problem('', { solutions: [{ name: 'x', source: '../../etc/passwd', tag: 'MA' }] }) }, 'outside the problem folder'],
    ['too many problems', { ...problem('A/'), ...problem('B/'), ...problem('C/'), ...problem('D/') }, 'at most 3 problems'],
  ])('refuses %s with a 400 and a reason', async (_what, files, reason) => {
    const res = await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf(files)) });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain(reason);
  });

  it('refuses something that is not a zip, and a wrong field name', async () => {
    const notZip = await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(Buffer.from('hello')) });
    expect(notZip.statusCode).toBe(400);
    const wrongField = await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf({ ...problem('') }), 'file') });
    expect(wrongField.statusCode).toBe(400);
  });

  it('leaves nothing behind in the temp folder', async () => {
    const ours = () => new Set(readdirSync(tmpdir()).filter((n) => /^verify-[A-Za-z0-9]{6}$/.test(n)));
    const before = ours();
    await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf({ ...problem('') })) });
    await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf({ 'readme.txt': 'x' })) });
    // no folder appeared that is still there (others may come and go in parallel tests)
    expect([...ours()].filter((n) => !before.has(n))).toEqual([]);
  });
});

describe('the order of things', () => {
  it('reads what the guideline checks need before the uploaded code runs', async () => {
    const ev = events((await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf(problem('', { mutate: true, tags: ['math'] }))) })).body);
    const checks = Object.fromEntries(ev.find((e) => e.type === 'problem').readiness.map((c: { id: string }) => [c.id, c]));
    expect(checks.statement_completeness.ok).toBe(true);
    expect(checks.tags_presence.ok).toBe(true);
    expect(checks.solution_presence.ok).toBe(true);
  });

  it('is not ready when a critical guideline fails, even if polyman passed', async () => {
    const files = problem('', {});
    delete files['l.tex'];
    const ev = events((await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf(files)) })).body);
    const result = ev.find((e) => e.type === 'problem');
    expect(result.report.ok).toBe(true);
    expect(result.ok).toBe(false);
    expect(ev.at(-1)).toMatchObject({ type: 'done', ok: false });
  });
});

describe('one verification at a time', () => {
  it('answers 429 while one runs, and takes the next once it is over', async () => {
    const first = app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf(problem('', { hang: true }))) });
    await new Promise((r) => setTimeout(r, 300));
    const busy = await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf(problem(''))) });
    expect(busy.statusCode).toBe(429);
    expect(busy.headers['retry-after']).toBe('30');
    expect((await app.inject({ method: 'POST', url: '/api/samples/demo/verify' })).statusCode).toBe(429);
    await first;
    expect((await app.inject({ method: 'POST', url: '/api/samples/demo/verify' })).statusCode).toBe(200);
  });

  it('releases the lock after a refused upload', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf({ 'readme.txt': 'x' })) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/samples/demo/verify' })).statusCode).toBe(200);
  });
});

describe('when the service itself fails', () => {
  it('answers 500, removes the upload and frees the lock if testlib.h is missing', async () => {
    const broken = buildApp({
      polymanCli: join(base, 'dist', 'cli.js'),
      testlib: join(base, 'no-such-testlib.h'),
      samplesDir: join(base, 'samples'),
      publicDir: join(base, 'public'),
    });
    const ours = () => new Set(readdirSync(tmpdir()).filter((n) => /^verify-[A-Za-z0-9]{6}$/.test(n)));
    const before = ours();
    const res = await broken.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf(problem(''))) });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('our fault');
    expect([...ours()].filter((n) => !before.has(n))).toEqual([]);
    expect((await broken.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf(problem(''))) })).statusCode).toBe(500);
    await broken.close();
  });

  it('refuses a zip that has the same file twice, without overwriting the first', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf({ ...problem(''), 'y.tex': 'second' }, ['y.tex', 'l.tex'])) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('the same file twice');
  });
});

describe('POST /api/samples/:name/verify', () => {
  it('verifies a sample', async () => {
    const ev = events((await app.inject({ method: 'POST', url: '/api/samples/demo/verify' })).body);
    expect(ev.at(-1)).toMatchObject({ type: 'done', ok: true });
  });

  it('404s an unknown sample, including one that tries to climb out', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/samples/nope/verify' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/samples/..%2Fsamples/verify' })).statusCode).toBe(404);
  });
});
