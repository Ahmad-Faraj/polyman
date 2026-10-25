import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
      cli: cli(dir, `require('fs').writeFileSync('env.json', JSON.stringify(process.env)); process.stdout.write('{"schemaVersion":1,"ok":true,"steps":[],"solutions":[]}')`),
      timeoutMs: 5000,
    });
    expect(r.report?.ok).toBe(true);
    const env = JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8'));
    expect(env.SECRET_SHOULD_NOT_LEAK).toBeUndefined();
    expect(env.HOME).toBe(dir);
  });

  it('turns off the CLI per-user precompiled header, with or without the service one', async () => {
    for (const pchDir of [undefined, '/opt/pch']) {
      const dir = fresh();
      await runVerify(dir, {
        cli: cli(dir, `require('fs').writeFileSync('env.json', JSON.stringify(process.env)); process.stdout.write('{"schemaVersion":1,"ok":true,"steps":[],"solutions":[]}')`),
        timeoutMs: 5000,
        ...(pchDir ? { pchDir } : {}),
      });
      const env = JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8'));
      expect(env.POLYMAN_PCH).toBe('0');
      expect(env.CPLUS_INCLUDE_PATH).toBe(pchDir);
    }
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
      process.stdout.write('{"schemaVersion":1,"ok":true,"steps":[],"solutions":[]}');
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

describe('runVerify: what it reads', () => {
  it('stops reading and kills the run past the output cap', async () => {
    const dir = fresh();
    // 20 MB of output, more than any real report
    const r = await runVerify(dir, { cli: cli(dir, `const b = 'x'.repeat(1 << 20); for (let i = 0; i < 20; i++) process.stdout.write(b); setInterval(() => {}, 1000)`), timeoutMs: 30_000 });
    expect(r.report).toBeNull();
    expect(r.error).toContain('more than 16 MB');
  });

  it('refuses a report of a shape it does not know', async () => {
    const dir = fresh();
    const r = await runVerify(dir, { cli: cli(dir, `process.stdout.write('{"schemaVersion":2,"ok":true}')`), timeoutMs: 5000 });
    expect(r.report).toBeNull();
    expect(r.error).toContain('format');
  });

  it('says when polyman was killed by a signal', async () => {
    const dir = fresh();
    const r = await runVerify(dir, { cli: cli(dir, `process.kill(process.pid, 'SIGKILL')`), timeoutMs: 5000 });
    expect(r.error).toContain('killed by SIGKILL');
  });
});

// These need root: they run in CI (jobs run as root in their container) and in
// the image, and are skipped on a developer's machine.
const root = process.getuid?.() === 0;
describe.runIf(root)('as root, with a runner user', () => {
  const RUNNER = { uid: 10099, gid: 10099 };

  it('runs polyman as the runner user and kills what it leaves behind, files in /tmp too', async () => {
    // as in the app: a root-owned folder in /tmp, the runner's upload one level down
    const { chownSync, existsSync, mkdirSync } = await import('node:fs');
    const outer = fresh();
    const { chmodSync } = await import('node:fs');
    chmodSync(outer, 0o711);
    const dir = join(outer, 'upload');
    mkdirSync(dir);
    chownSync(dir, RUNNER.uid, RUNNER.gid);
    const code = `
      const { spawn } = require('child_process');
      require('fs').writeFileSync('/tmp/left-by-runner-' + process.pid, 'x');
      spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }).unref();
      process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: process.getuid() === ${RUNNER.uid}, steps: [], solutions: [] }));
    `;
    writeFileSync(join(dir, 'cli.cjs'), code);
    const problems: string[] = [];
    const r = await runVerify(dir, { cli: join(dir, 'cli.cjs'), timeoutMs: 10_000, runAs: RUNNER, onCleanupProblem: (m) => problems.push(m) });
    expect(r.report?.ok).toBe(true);
    const { killUser } = await import('../src/kill-tree.ts');
    expect(killUser(RUNNER.uid)).toBe(0);
    expect(readdirSync('/tmp').filter((n) => n.startsWith('left-by-runner-'))).toEqual([]);
    expect(problems).toEqual([]); // kill(-1) from inside the user got the sleep; nothing was left for the outside passes
    expect(existsSync(dir)).toBe(true);
  });

  it('removes the System V shared memory and lock files the runner leaves', async () => {
    const { spawnSync } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    const { removeFilesOf, removeIpcOf } = await import('../src/kill-tree.ts');
    expect(spawnSync('ipcmk', ['-M', '65536'], { ...RUNNER }).status).toBe(0);
    spawnSync('sh', ['-c', 'touch /run/lock/left-by-runner'], { ...RUNNER });
    const owned = () => readFileSync('/proc/sysvipc/shm', 'utf8').split('\n').filter((l) => l.trim().split(/\s+/)[7] === String(RUNNER.uid));
    expect(owned().length).toBeGreaterThan(0);
    removeIpcOf(RUNNER.uid);
    removeFilesOf(RUNNER.uid, ['/run/lock']);
    expect(owned()).toEqual([]);
    expect(existsSync('/run/lock/left-by-runner')).toBe(false);
  });

  it('kills a fork loop of the runner user', async () => {
    const { spawn } = await import('node:child_process');
    const { killUser } = await import('../src/kill-tree.ts');
    spawn('sh', ['-c', 'while true; do sleep 30 & done'], { ...RUNNER, detached: true, stdio: 'ignore' }).unref();
    await new Promise((r) => setTimeout(r, 300));
    killUser(RUNNER.uid);
    expect(killUser(RUNNER.uid)).toBe(0);
  });
});
