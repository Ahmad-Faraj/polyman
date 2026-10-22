import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { settingsFrom } from './settings.ts';
import { warmUp } from './warm-up.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const settings = settingsFrom(process.env, {
  polymanCli: here('../../dist/cli.js'),
  samplesDir: here('../samples'),
  publicDir: here('../public'),
});
const { port, ...options } = settings;
// the warm-up's testlib object, kept for every upload; root's own folder (0700), so the runner can't reach it
const prebuiltTestlib = mkdtempSync(join(tmpdir(), 'prebuilt-testlib-'));
const app = buildApp({ ...options, prebuiltTestlib });

for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err) => {
    app.log.fatal({ err }, event);
    process.exit(1);
  });
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

// warm the compilers before the first visitor; a failure is logged, not fatal
if (process.env.SKIP_WARM_UP !== '1') {
  const warm = await warmUp(settings, undefined, prebuiltTestlib);
  app.log[warm.ok ? 'info' : 'warn']({ seconds: warm.seconds, error: warm.error, keptTestlib: warm.keptTestlib }, 'warm-up run finished');
}
await app.listen({ host: '0.0.0.0', port });
