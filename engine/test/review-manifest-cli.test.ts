import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const CLI = resolve('src/cli/review-manifest.ts');
const dir = mkdtempSync(join(tmpdir(), 'review-manifest-'));
// the node running the tests, which strips TypeScript types; the fixture config sets the coefficients
const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { encoding: 'utf8', env: { ...process.env, AUTONOMY_CONFIG: 'test/fixtures/autonomy.yml' } });
const write = (name: string, data: unknown) => {
  const file = join(dir, name);
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
};
const session = (pipeline: number, tier: string, calls: number, extra = {}) => ({ pipeline, at: `2026-10-18T10:0${pipeline}:00Z`, flow: 'mr-reviewer', tier, skipped: false, seconds: 60, total: { calls }, ...extra });

describe('review-manifest', () => {
  it('writes the manifest from counted sessions and says what it left out', () => {
    const input = write('ok.json', { sessions: [session(1, 'high', 38), session(2, 'medium', 30), session(3, 'low', 7, { skipped: true }), session(4, 'unknown', 2)] });
    const out = join(dir, 'ok.yml');
    const r = run(input, out);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/1 high, 1 medium reviews; left out 2 reviewer sessions/);
    const m = parse(readFileSync(out, 'utf8'));
    expect(m.tree.children['high-risk-reviews'].inputs[0]).toMatchObject({ 'model-calls-low': 38, 'model-calls-high': 38 });
  });

  it('fails with a message, not a stack trace, on a missing file, no session list or a broken session', () => {
    const cases = [
      [join(dir, 'missing.json'), /can't read the sessions/],
      [write('nolist.json', { project: 'x' }), /has no "sessions" list/],
      [write('broken.json', { sessions: [{ pipeline: 9, flow: 'mr-reviewer', tier: 'high', skipped: false, at: 'x' }] }), /no valid seconds or call count, e.g. pipeline 9/],
      [write('nan.json', '{"sessions":[{"pipeline":8,"flow":"mr-reviewer","tier":"high","skipped":false,"seconds":"a","total":{"calls":3}}]}'), /pipeline 8/],
    ] as const;
    for (const [input, message] of cases) {
      const r = run(input, join(dir, 'never.yml'));
      expect(r.status, input).toBe(2);
      expect(r.stderr).toMatch(message);
      expect(r.stderr).not.toMatch(/\n\s+at /);
    }
  });
});
