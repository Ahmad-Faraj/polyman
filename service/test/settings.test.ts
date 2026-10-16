import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { settingsFrom } from '../src/settings.ts';

const dir = mkdtempSync(join(tmpdir(), 'settings-test-'));
writeFileSync(join(dir, 'cli.js'), '');
writeFileSync(join(dir, 'testlib.h'), '');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const defaults = { polymanCli: join(dir, 'cli.js'), samplesDir: dir, publicDir: dir };
const base = { TESTLIB_H: join(dir, 'testlib.h') };
const as = (uid: number, env: Record<string, string> = {}) => settingsFrom({ ...base, ...env }, defaults, uid);

describe('settingsFrom', () => {
  it('uses the defaults', () => {
    expect(as(1000)).toMatchObject({ port: 8080, problemTimeoutMs: 120_000, runAs: undefined });
  });

  it.each(['abc', '-1', '1.5', '0'])('refuses PROBLEM_TIMEOUT_MS=%s', (value) => {
    expect(() => as(1000, { PROBLEM_TIMEOUT_MS: value })).toThrow('PROBLEM_TIMEOUT_MS must be a positive whole number');
  });

  it('treats an empty value as unset', () => {
    expect(as(1000, { PROBLEM_TIMEOUT_MS: '' }).problemTimeoutMs).toBe(120_000);
  });

  it('runs uploaded code as RUNNER_UID, with its group defaulting to the same number', () => {
    expect(as(0, { RUNNER_UID: '10001' }).runAs).toEqual({ uid: 10001, gid: 10001 });
    expect(as(0, { RUNNER_UID: '10001', RUNNER_GID: '20002' }).runAs).toEqual({ uid: 10001, gid: 20002 });
  });

  it("refuses to run uploaded code as root, or as the service's own user", () => {
    expect(() => as(0)).toThrow('would run uploaded code as root');
    expect(() => as(0, { RUNNER_UID: '0' })).toThrow('positive whole number');
    expect(() => as(10001, { RUNNER_UID: '10001' })).toThrow("service's own user");
    expect(as(0, { ALLOW_RUN_AS_SELF: '1' }).runAs).toBeUndefined();
  });

  it('refuses RUNNER_UID when it is not root, since it could not switch user', () => {
    expect(() => as(1000, { RUNNER_UID: '10001' })).toThrow('needs the service to run as root');
  });

  it('refuses to start without polyman or testlib, or with a bad port', () => {
    expect(() => as(1000, { POLYMAN_CLI: join(dir, 'nope.js') })).toThrow('polyman not found');
    expect(() => as(1000, { TESTLIB_H: join(dir, 'nope.h') })).toThrow('testlib.h not found');
    expect(() => as(1000, { PORT: '70000' })).toThrow('PORT must be a port number');
  });
});
