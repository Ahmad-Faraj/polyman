import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const env = process.env;

function positive(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  return n;
}

const app = buildApp({
  polymanCli: env.POLYMAN_CLI ?? here('../../dist/cli.js'),
  testlib: env.TESTLIB_H ?? '/opt/testlib/testlib.h',
  samplesDir: here('../samples'),
  publicDir: here('../public'),
  problemTimeoutMs: positive('PROBLEM_TIMEOUT_MS', 120_000),
  commit: env.APP_COMMIT,
  // in the image: uploaded code runs as this user, never as the service
  runAs: env.RUNNER_UID ? { uid: positive('RUNNER_UID', 0), gid: positive('RUNNER_GID', positive('RUNNER_UID', 0)) } : undefined,
});

const port = Number(env.PORT ?? 8080);
await app.listen({ host: '0.0.0.0', port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
