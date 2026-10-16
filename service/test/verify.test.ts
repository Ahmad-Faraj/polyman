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
