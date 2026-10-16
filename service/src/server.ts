import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { settingsFrom } from './settings.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const { port, ...options } = settingsFrom(process.env, {
  polymanCli: here('../../dist/cli.js'),
  samplesDir: here('../samples'),
  publicDir: here('../public'),
});
const app = buildApp(options);

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

await app.listen({ host: '0.0.0.0', port });
