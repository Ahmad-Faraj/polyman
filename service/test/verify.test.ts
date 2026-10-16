import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runVerify } from '../src/verify.ts';

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'verify-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.SECRET_SHOULD_NOT_LEAK;
});

const cli = (dir: string, code: string) => {
  writeFileSync(join(dir, 'cli.cjs'), code);
  return join(dir, 'cli.cjs');
};

describe('runVerify', () => {
  it('gives polyman a bare environment: none of our variables reach the code it runs', async () => {
    process.env.SECRET_SHOULD_NOT_LEAK = 'token';
    const dir = fresh();
    const r = await runVerify(dir, {
      cli: cli(dir, `require('fs').writeFileSync('env.json', JSON.stringify(process.env)); process.stdout.write('{"ok":true,"steps":[],"solutions":[]}')`),
      timeoutMs: 5000,
    });
    expect(r.report?.ok).toBe(true);
    const env = JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8'));
    expect(env.SECRET_SHOULD_NOT_LEAK).toBeUndefined();
    expect(env.HOME).toBe(dir);
  });

  it('reads progress from the step lines, colours and all', async () => {
    const dir = fresh();
    const steps: string[] = [];
    await runVerify(dir, {
      cli: cli(dir, `process.stderr.write('\\x1b[36m┌─ Step 3: Compiling Validator\\x1b[0m\\nnoise\\n'); process.stdout.write('{}')`),
      timeoutMs: 5000,
      onStep: (n, t) => steps.push(`${n} ${t}`),
    });
    expect(steps).toEqual(['3 Compiling Validator']);
  });

  it('says why there is no report when polyman crashes', async () => {
    const dir = fresh();
    const r = await runVerify(dir, { cli: cli(dir, `console.error('boom: Config.json missing'); process.exit(3)`), timeoutMs: 5000 });
    expect(r.report).toBeNull();
    expect(r.error).toContain('exited with 3');
    expect(r.error).toContain('boom: Config.json missing');
  });
});

describe('runVerify: stopping', () => {
  it('stops and kills the run when the visitor leaves', async () => {
    const dir = fresh();
    const left = new AbortController();
    const run = runVerify(dir, { cli: cli(dir, `setInterval(() => {}, 1000)`), timeoutMs: 60_000, signal: left.signal });
    setTimeout(() => left.abort(), 300);
    const r = await run;
    expect(r.error).toBe('cancelled');
    expect(r.seconds).toBeLessThan(5);
  });

  it('finishes even when a process it left behind keeps the output pipe open', async () => {
    const dir = fresh();
    // the child starts a daemon in a new session that inherits stdout, prints its report and exits
    const code = `
      const { spawn } = require('child_process');
      const d = spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }); // detached: a new session
      require('fs').writeFileSync('daemon.pid', String(d.pid));
      d.unref();
      process.stdout.write('{"ok":true,"steps":[],"solutions":[]}');
    `;
    const started = Date.now();
    const r = await runVerify(dir, { cli: cli(dir, code), timeoutMs: 60_000 });
    expect(r.report?.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    // outside the image there is no runner user to sweep, so clean the daemon up here
    try {
      process.kill(Number(readFileSync(join(dir, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      // already gone
    }
  });
});
