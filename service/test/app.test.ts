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

const zipOf = (files: Record<string, string>): Promise<Buffer> => {
  const zip = new yazl.ZipFile();
  for (const [name, data] of Object.entries(files)) zip.addBuffer(Buffer.from(data), name);
  zip.end();
  return new Promise((done) => {
    const parts: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => parts.push(c));
    zip.outputStream.on('end', () => done(Buffer.concat(parts)));
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
    ...extra,
  });

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'app-test-'));
  writeFileSync(join(base, 'cli.js'), FAKE_CLI);
  writeFileSync(join(base, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  writeFileSync(join(base, 'testlib.h'), '// testlib');
  mkdirSync(join(base, 'public'));
  writeFileSync(join(base, 'public', 'index.html'), '<h1>verify</h1>');
  mkdirSync(join(base, 'samples', 'demo'), { recursive: true });
  writeFileSync(join(base, 'samples', 'demo', 'Config.json'), config({ description: 'a demo' }));
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
    const zip = await zipOf({ 'p/Config.json': config() });
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
    const zip = await zipOf({ 'A/Config.json': config(), 'B/Config.json': config({ broken: true }) });
    const ev = events((await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(zip) })).body);
    expect(ev.filter((e) => e.type === 'problem').map((e) => [e.problem, e.ok])).toEqual([
      ['A', true],
      ['B', false],
    ]);
    expect(ev.at(-1)).toMatchObject({ type: 'done', ok: false });
  });

  it('reports a problem that runs past its time limit instead of hanging', async () => {
    const zip = await zipOf({ 'Config.json': config({ hang: true }) });
    const ev = events((await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(zip) })).body);
    const problem = ev.find((e) => e.type === 'problem');
    expect(problem.ok).toBe(false);
    expect(problem.error).toContain('stopped after 2 s');
  });

  it.each([
    ['a zip with no problem in it', { 'readme.txt': 'hi' }, 'no problem found'],
    ['a path outside the problem folder', { 'Config.json': config({ solutions: [{ name: 'x', source: '../../etc/passwd', tag: 'MA' }] }) }, 'outside the problem folder'],
    ['too many problems', { 'A/Config.json': config(), 'B/Config.json': config(), 'C/Config.json': config(), 'D/Config.json': config() }, 'at most 3 problems'],
  ])('refuses %s with a 400 and a reason', async (_what, files, reason) => {
    const res = await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf(files)) });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain(reason);
  });

  it('refuses something that is not a zip, and a wrong field name', async () => {
    const notZip = await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(Buffer.from('hello')) });
    expect(notZip.statusCode).toBe(400);
    const wrongField = await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf({ 'Config.json': config() }), 'file') });
    expect(wrongField.statusCode).toBe(400);
  });

  it('leaves nothing behind in the temp folder', async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('verify-')).length;
    await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf({ 'Config.json': config() })) });
    await app.inject({ method: 'POST', url: '/api/verify', ...multipartBody(await zipOf({ 'readme.txt': 'x' })) });
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('verify-')).length).toBe(before);
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
