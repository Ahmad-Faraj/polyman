/**
 * The HTTP side of the verify service.
 *
 *   GET  /                          the page
 *   GET  /health                    liveness
 *   GET  /api/version               polyman and service versions, commit
 *   GET  /api/samples               the sample problems and what they should give
 *   POST /api/verify                multipart field "problem": a zip of one problem or a contest
 *   POST /api/samples/:name/verify  the same, on a sample
 *
 * Verify answers with newline-delimited JSON events while it works (start,
 * step, problem, done), so the page can show progress. Nothing is kept after a
 * request: the upload lives in a temporary folder that is removed at the end.
 * One verification runs at a time; Cloud Run is set to one request per
 * instance as well, this is the same rule enforced here.
 */
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyReply } from 'fastify';
import { configProblems, findProblems, problemLabel, type Problem } from './problems.ts';
import { readiness } from './readiness.ts';
import { DEFAULT_LIMITS, unzip } from './unzip.ts';
import { runVerify } from './verify.ts';

export interface AppOptions {
  /** polyman's dist/cli.js */
  polymanCli: string;
  /** testlib.h to copy into a problem that doesn't bring its own */
  testlib: string;
  samplesDir: string;
  publicDir: string;
  maxUploadBytes?: number;
  maxProblems?: number;
  problemTimeoutMs?: number;
  commit?: string;
}

const STATIC: Record<string, string> = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
};
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

export function buildApp(opts: AppOptions) {
  const maxUploadBytes = opts.maxUploadBytes ?? 20 * 1024 * 1024;
  const maxProblems = opts.maxProblems ?? 26;
  const problemTimeoutMs = opts.problemTimeoutMs ?? 120_000;
  const polymanVersion = (() => {
    try {
      return (JSON.parse(readFileSync(join(opts.polymanCli, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
    } catch {
      return 'unknown';
    }
  })();

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 1024 * 1024 });
  app.register(multipart, { limits: { files: 1, fileSize: maxUploadBytes, fields: 0, parts: 1 } });

  let busy = false;

  for (const [route, file] of Object.entries(STATIC)) {
    app.get(route, async (_req, reply) => {
      const ext = file.split('.').pop()!;
      return reply.type(TYPES[ext]).header('cache-control', 'no-cache').send(readFileSync(join(opts.publicDir, file)));
    });
  }

  app.get('/health', async () => ({ ok: true }));

  app.get('/api/version', async () => ({ polyman: polymanVersion, service: '0.1.0', commit: opts.commit ?? 'dev' }));

  const sampleNames = () =>
    readdirSync(opts.samplesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

  app.get('/api/samples', async () =>
    sampleNames().map((name) => {
      const config = JSON.parse(readFileSync(join(opts.samplesDir, name, 'Config.json'), 'utf8')) as { description?: string };
      const expectedFile = join(opts.samplesDir, `${name}.expected.json`);
      return {
        name,
        description: config.description ?? '',
        expected: existsSync(expectedFile) ? JSON.parse(readFileSync(expectedFile, 'utf8')) : null,
      };
    }),
  );

  /** Runs every problem in `root` and streams the events; removes `root` at the end. */
  async function verifyAll(root: string, problems: Problem[], reply: FastifyReply) {
    const started = Date.now();
    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const send = (event: object) => reply.raw.write(`${JSON.stringify(event)}\n`);
    let allOk = true;
    try {
      send({ type: 'start', problems: problems.map(problemLabel), polyman: polymanVersion });
      for (const p of problems) {
        const name = problemLabel(p);
        if (!existsSync(join(p.dir, 'testlib.h'))) copyFileSync(opts.testlib, join(p.dir, 'testlib.h'));
        const result = await runVerify(p.dir, {
          cli: opts.polymanCli,
          timeoutMs: problemTimeoutMs,
          onStep: (step, title) => send({ type: 'step', problem: name, step, title }),
        });
        const checks = readiness(p.dir, result.report);
        const ok = !!result.report?.ok;
        allOk &&= ok;
        send({ type: 'problem', problem: name, ok, seconds: result.seconds, error: result.error, report: result.report, readiness: checks });
      }
      send({ type: 'done', ok: allOk, seconds: (Date.now() - started) / 1000 });
    } catch (err) {
      app.log.error(err);
      send({ type: 'error', message: 'the verification failed unexpectedly' });
    } finally {
      reply.raw.end();
      rmSync(root, { recursive: true, force: true });
    }
  }

  /** Common checks before streaming; answers with an error and returns false if the run can't start. */
  function prepare(root: string, reply: FastifyReply): Problem[] | null {
    const problems = findProblems(root);
    if (!problems.length) {
      reply.code(400).send({ error: 'no problem found: the zip needs a Config.json at its root, or one per problem folder' });
      return null;
    }
    if (problems.length > maxProblems) {
      reply.code(400).send({ error: `at most ${maxProblems} problems per upload` });
      return null;
    }
    const issues = problems.flatMap((p) => configProblems(p.dir).map((i) => `${problemLabel(p)}: ${i}`));
    if (issues.length) {
      reply.code(400).send({ error: 'the upload was refused', issues });
      return null;
    }
    return problems;
  }

  async function exclusive(reply: FastifyReply, work: () => Promise<void>) {
    if (busy) return reply.code(429).header('retry-after', '30').send({ error: 'busy with another verification, try again shortly' });
    busy = true;
    try {
      await work();
    } finally {
      busy = false;
    }
    return reply;
  }

  app.post('/api/verify', async (req, reply) =>
    exclusive(reply, async () => {
      let data;
      try {
        data = await req.file();
      } catch {
        reply.code(400).send({ error: 'send the zip as multipart form data, field "problem"' });
        return;
      }
      if (!data || data.fieldname !== 'problem') {
        reply.code(400).send({ error: 'send the zip as multipart form data, field "problem"' });
        return;
      }
      let zip: Buffer;
      try {
        zip = await data.toBuffer();
      } catch {
        reply.code(413).send({ error: `the zip is larger than ${maxUploadBytes / 1024 / 1024} MB` });
        return;
      }
      const root = mkdtempSync(join(tmpdir(), 'verify-'));
      try {
        await unzip(zip, root, DEFAULT_LIMITS);
      } catch (err) {
        rmSync(root, { recursive: true, force: true });
        reply.code(400).send({ error: `the zip was refused: ${(err as Error).message}` });
        return;
      }
      const problems = prepare(root, reply);
      if (!problems) {
        rmSync(root, { recursive: true, force: true });
        return;
      }
      await verifyAll(root, problems, reply);
    }),
  );

  app.post<{ Params: { name: string } }>('/api/samples/:name/verify', async (req, reply) =>
    exclusive(reply, async () => {
      const { name } = req.params;
      if (!sampleNames().includes(name)) {
        reply.code(404).send({ error: `no sample called ${name}` });
        return;
      }
      const root = mkdtempSync(join(tmpdir(), 'verify-'));
      cpSync(join(opts.samplesDir, name), join(root, name), { recursive: true });
      const problems = prepare(root, reply);
      if (!problems) {
        rmSync(root, { recursive: true, force: true });
        return;
      }
      await verifyAll(root, problems, reply);
    }),
  );

  return app;
}
