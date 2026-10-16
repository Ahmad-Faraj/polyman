/**
 * The service's settings, from its environment. Refuses to start on a setting
 * that would make it unsafe or broken, rather than finding out on a visitor's
 * upload: uploaded code must never run as root or as the service's own user.
 */
import { existsSync } from 'node:fs';
import type { AppOptions } from './app.ts';

type Env = Record<string, string | undefined>;

export interface Settings extends AppOptions {
  port: number;
}

export function settingsFrom(env: Env, defaults: { polymanCli: string; samplesDir: string; publicDir: string }, uid = process.getuid?.()): Settings {
  const positive = (name: string, fallback?: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') {
      if (fallback === undefined) throw new Error(`${name} is required`);
      return fallback;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number, got "${raw}"`);
    return n;
  };

  let runAs: Settings['runAs'];
  if (env.RUNNER_UID) {
    runAs = { uid: positive('RUNNER_UID'), gid: positive('RUNNER_GID', positive('RUNNER_UID')) };
    if (runAs.uid === uid) throw new Error("RUNNER_UID is the service's own user; uploaded code needs a user of its own");
    if (uid !== undefined && uid !== 0) throw new Error('RUNNER_UID needs the service to run as root, to start polyman as that user');
  } else if (uid === 0 && env.ALLOW_RUN_AS_SELF !== '1') {
    throw new Error('running as root with no RUNNER_UID would run uploaded code as root; set RUNNER_UID (or ALLOW_RUN_AS_SELF=1 for local tests)');
  }

  const polymanCli = env.POLYMAN_CLI || defaults.polymanCli;
  const testlib = env.TESTLIB_H || '/opt/testlib/testlib.h';
  if (!existsSync(polymanCli)) throw new Error(`polyman not found at ${polymanCli} (POLYMAN_CLI)`);
  if (!existsSync(testlib)) throw new Error(`testlib.h not found at ${testlib} (TESTLIB_H)`);

  const port = positive('PORT', 8080);
  if (port > 65535) throw new Error(`PORT must be a port number, got "${env.PORT}"`);

  return {
    port,
    polymanCli,
    testlib,
    samplesDir: defaults.samplesDir,
    publicDir: defaults.publicDir,
    problemTimeoutMs: positive('PROBLEM_TIMEOUT_MS', 120_000),
    commit: env.APP_COMMIT,
    runAs,
  };
}
