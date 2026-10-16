import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const env = process.env;

const app = buildApp({
  polymanCli: env.POLYMAN_CLI ?? here('../../dist/cli.js'),
  testlib: env.TESTLIB_H ?? '/opt/testlib/testlib.h',
  samplesDir: here('../samples'),
  publicDir: here('../public'),
  problemTimeoutMs: Number(env.PROBLEM_TIMEOUT_MS ?? 120_000),
  commit: env.APP_COMMIT,
});

const port = Number(env.PORT ?? 8080);
await app.listen({ host: '0.0.0.0', port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
