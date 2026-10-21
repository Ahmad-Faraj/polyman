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
 * step, problem, then done, or error if the service itself fails), so the
 * page can show progress. Nothing is kept after a
 * request: the upload lives in a temporary folder that is removed at the end.
 * One verification runs at a time; Cloud Run is set to one request per
 * instance as well, this is the same rule enforced here. If the visitor
 * leaves, the run is cancelled.
 *
 * In the image the service runs as root only to hand each upload to the
 * `runner` user, run polyman as that user (runAs) and clean up after it; see
 * verify.ts.
 */
import { chmodSync, copyFileSync, mkdirSync, lchownSync, lstatSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyReply } from 'fastify';
import { configProblems, findProblems, problemLabel, type Problem } from './problems.ts';
import { readFacts, readiness, type Check, type Facts } from './readiness.ts';
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
  /** run uploaded code as this user (the service must be root to do so) */
  runAs?: { uid: number; gid: number };
}

const STATIC: Record<string, string> = {
  '/': 'index.html',
  '/docs': 'docs.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
  '/vendor/basecoat.css': 'vendor/basecoat.css',
  '/fonts/geist.woff2': 'fonts/geist.woff2',
  '/fonts/geist-mono.woff2': 'fonts/geist-mono.woff2',
};
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2' };

export function buildApp(opts: AppOptions) {
  const maxUploadBytes = opts.maxUploadBytes ?? 20 * 1024 * 1024;
  const maxProblems = opts.maxProblems ?? 26;
  const problemTimeoutMs = opts.problemTimeoutMs ?? 120_000;

  // requestTimeout: the whole upload must arrive within two minutes (it doesn't cover the streamed answer)
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 1024 * 1024, requestTimeout: 120_000 });
  app.register(multipart, { limits: { files: 1, fileSize: maxUploadBytes, fields: 0, parts: 1 } });

  const polymanVersion = (() => {
    try {
      return (JSON.parse(readFileSync(join(opts.polymanCli, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
    } catch (err) {
      app.log.warn({ err }, 'could not read the polyman version next to POLYMAN_CLI');
      return 'unknown';
    }
  })();

  let busy = false;
  /**
   * Set when cleaning up after a run failed: something of that upload may still
   * be running or stored, so this instance takes no more visitors. /health then
   * fails, and the process exits once the answer is sent, so Cloud Run
   * replaces the instance.
   */
  let unclean: string | undefined;

  /**
   * Refuses a browser on another site posting to the service. Every POST is
   * judged whatever its path, because Fastify routes the decoded path and a raw
   * prefix test is bypassed by /%61pi/. Only a request that carries an Origin is judged: scripts (curl, CI, the checks) send none and
   * pass. The Origin has to name this request's own host. The answer never
   * repeats the Origin.
   */
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'POST') return;
    const origin = req.headers.origin;
    if (origin === undefined) return;
    if (!originMatchesHost(origin, req.headers.host)) {
      return reply.code(403).send({ error: 'cross-site request refused: the Origin does not match this host' });
    }
  });

  for (const [route, file] of Object.entries(STATIC)) {
    app.get(route, async (_req, reply) => {
      const ext = file.split('.').pop()!;
      return reply.type(TYPES[ext]).header('cache-control', 'no-cache').send(readFileSync(join(opts.publicDir, file)));
    });
  }

  app.get('/health', async (_req, reply) => (unclean ? reply.code(503).send({ ok: false, reason: unclean }) : { ok: true }));

  app.get('/api/version', async () => ({ polyman: polymanVersion, service: '0.1.0', commit: opts.commit ?? 'dev' }));

  const sampleNames = () =>
    readdirSync(opts.samplesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

  app.get('/api/samples', async () =>
    sampleNames().flatMap((name) => {
      try {
        const config = JSON.parse(readFileSync(join(opts.samplesDir, name, 'Config.json'), 'utf8')) as { description?: string };
        const expectedFile = join(opts.samplesDir, `${name}.expected.json`);
        return [
          {
            name,
            description: config.description ?? '',
            expected: existsSync(expectedFile) ? JSON.parse(readFileSync(expectedFile, 'utf8')) : null,
          },
        ];
      } catch (err) {
        // one broken sample must not hide the others
        app.log.error({ err, sample: name }, 'sample could not be read');
        return [];
      }
    }),
  );

  /**
   * Runs every problem in `root` and streams the events. Everything the
   * service itself does to the upload happens before the first run: from then
   * on the folders belong to the uploaded code, which could swap a file for a
   * link to somewhere the service can write.
   */
  async function verifyAll(root: string, problems: Problem[], reply: FastifyReply) {
    const started = Date.now();
    const visitorLeft = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) visitorLeft.abort();
    });
    // the visitor may have left while the upload was being unpacked
    if (reply.raw.destroyed) visitorLeft.abort();

    const facts = new Map<Problem, Facts | null>();
    for (const p of problems) {
      if (!existsSync(join(p.dir, 'testlib.h'))) copyFileSync(opts.testlib, join(p.dir, 'testlib.h'));
      try {
        facts.set(p, readFacts(p.dir));
      } catch (err) {
        app.log.error({ err, problem: problemLabel(p, root) }, 'could not read what the guideline checks need');
        facts.set(p, null);
      }
    }
    if (opts.runAs) handTo(root, opts.runAs);

    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const send = (event: object) => reply.raw.write(`${JSON.stringify(event)}\n`);
    // progress is optional: drop it while the visitor's connection is slow to drain
    const sendStep = (event: object) => {
      if (reply.raw.writableLength < 1024 * 1024) send(event);
    };
    let allOk = true;
    let completed = 0;
    try {
      send({ type: 'start', problems: problems.map((p) => problemLabel(p, root)), polyman: polymanVersion });
      for (const p of problems) {
        if (visitorLeft.signal.aborted || unclean) break;
        const name = problemLabel(p, root);
        const result = await runVerify(p.dir, {
          cli: opts.polymanCli,
          timeoutMs: problemTimeoutMs,
          onStep: (step, title) => sendStep({ type: 'step', problem: name, step, title }),
          runAs: opts.runAs,
          signal: visitorLeft.signal,
          onCleanupProblem: (message) => app.log.error({ problem: name }, message),
        });
        if (result.unclean) {
          unclean = result.unclean;
          app.log.fatal({ problem: name }, `${unclean}; this instance takes no more visitors`);
        }
        const known = facts.get(p);
        const checks: Check[] = known
          ? readiness(known, result.report)
          : [{ id: 'readiness', title: 'Contest guidelines', severity: 'warning', ok: false, detail: 'the service could not read the files these checks need' }];
        // ready means polyman passed and no critical guideline failed
        const ok = !!result.report?.ok && checks.every((c) => c.ok || c.severity !== 'critical');
        allOk &&= ok;
        completed++;
        send({ type: 'problem', problem: name, ok, seconds: result.seconds, error: result.error, report: result.report, readiness: checks });
      }
      send({ type: 'done', ok: allOk && completed === problems.length, seconds: (Date.now() - started) / 1000 });
    } catch (err) {
      app.log.error({ err, completed, of: problems.length }, 'verification failed');
      send({ type: 'error', message: 'the service failed while checking; this is our fault, not your upload' });
    } finally {
      reply.raw.end();
    }
  }

  /** Common checks before streaming; answers with an error and returns null if the run can't start. */
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
    const issues = problems.flatMap((p) => configProblems(p.dir).map((i) => `${problemLabel(p, root)}: ${i}`));
    if (issues.length) {
      reply.code(400).send({ error: 'the upload was refused', issues });
      return null;
    }
    return problems;
  }

  const busyReply = (reply: FastifyReply) =>
    reply.code(429).header('retry-after', '30').send({ error: 'busy with another verification, try again shortly' });

  /**
   * Takes the one-at-a-time lock, makes the upload folder, runs `fill` to put
   * the problems in it and then verifies them. The folder is removed and the
   * lock released whatever happens.
   */
  async function run(reply: FastifyReply, fill: (root: string) => Promise<boolean>) {
    if (unclean) return reply.code(503).send({ error: 'this instance is being replaced, try again in a moment' });
    if (busy) return busyReply(reply);
    busy = true;
    let outer: string | undefined;
    try {
      // The folder in /tmp stays root's; the upload lives one level down and is
      // what the runner user gets. After each run, what the runner owns directly
      // in /tmp is removed, and that must never be the upload itself.
      outer = mkdtempSync(join(tmpdir(), 'verify-'));
      const root = join(outer, 'upload');
      chmodSync(outer, 0o711); // the runner may pass through it to its upload, not list it
      mkdirSync(root);
      if (!(await fill(root))) return reply;
      const problems = prepare(root, reply);
      if (problems) await verifyAll(root, problems, reply);
    } catch (err) {
      app.log.error({ err }, 'could not prepare the upload');
      if (!reply.sent && !reply.raw.headersSent) reply.code(500).send({ error: 'the service could not prepare your upload; this is our fault, try again' });
    } finally {
      try {
        if (outer) rmSync(outer, { recursive: true, force: true });
      } catch (err) {
        unclean ??= `could not remove an upload: ${(err as Error).message}`;
        app.log.fatal({ err }, 'could not remove an upload; this instance takes no more visitors');
      } finally {
        busy = false;
      }
      // replaced, not reused: exit once this answer is out
      if (unclean) reply.raw.once('finish', () => setTimeout(() => process.exit(1), 100).unref());
    }
    return reply;
  }

  app.post('/api/verify', async (req, reply) => {
    // a cheap early answer before reading the body; the lock itself is taken once the upload is in
    if (busy) return busyReply(reply);
    let zip: Buffer;
    try {
      const data = await req.file();
      if (!data || data.fieldname !== 'problem') return reply.code(400).send({ error: 'send the zip as multipart form data, field "problem"' });
      zip = await data.toBuffer();
    } catch (err) {
      const e = err as { code?: string; statusCode?: number };
      if (e.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: `the zip is larger than ${maxUploadBytes / 1024 / 1024} MB` });
      if (e.statusCode && e.statusCode < 500) return reply.code(400).send({ error: 'send the zip as multipart form data, field "problem"' });
      app.log.error({ err }, 'could not read the upload');
      return reply.code(500).send({ error: 'the upload could not be read; try again' });
    }
    return run(reply, async (root) => {
      try {
        await unzip(zip, root, DEFAULT_LIMITS);
        return true;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'EEXIST') return !reply.code(400).send({ error: 'the zip was refused: it has the same file twice' });
        // these come from what the zip contains (a file and a folder of the same name, a name too long)
        const fromTheZip: Record<string, string> = {
          ENOTDIR: 'a file and a folder have the same name',
          EISDIR: 'a file and a folder have the same name',
          ENAMETOOLONG: 'a file or folder name is too long',
          ELOOP: 'it has a path that loops',
        };
        if (e.code && fromTheZip[e.code]) return !reply.code(400).send({ error: `the zip was refused: ${fromTheZip[e.code]}` });
        // any other errno code means our side failed (disk, permissions); anything else is the zip itself
        if (e.code && /^E[A-Z]+$/.test(e.code)) throw err;
        return !reply.code(400).send({ error: `the zip was refused: ${e.message}` });
      }
    });
  });

  app.post<{ Params: { name: string } }>('/api/samples/:name/verify', async (req, reply) => {
    const { name } = req.params;
    if (!sampleNames().includes(name)) return reply.code(404).send({ error: `no sample called ${name}` });
    return run(reply, async (root) => {
      cpSync(join(opts.samplesDir, name), join(root, name), { recursive: true });
      return true;
    });
  });

  return app;
}

/**
 * True when the Origin header names the same host and port as the Host header,
 * ignoring case and treating a scheme's default port as no port. `Origin: null`,
 * an unparseable value, a scheme other than http(s) and a missing Host do not match.
 */
function originMatchesHost(origin: unknown, host: string | undefined): boolean {
  if (typeof origin !== 'string' || !host || !/^[^\s/?#@\\]+$/.test(host)) return false;
  try {
    const from = new URL(origin);
    if (from.protocol !== 'http:' && from.protocol !== 'https:') return false;
    // parsing the Host with the Origin's scheme drops that scheme's default port on both sides
    return new URL(`${from.protocol}//${host}`).host === from.host;
  } catch {
    return false;
  }
}

/** Gives a folder (or file) and everything in it to the runner user, readable by nobody else. */
function handTo(path: string, { uid, gid }: { uid: number; gid: number }) {
  const walk = (p: string) => {
    // lchown: never follow a link (unzip refuses them, this is a second guard)
    lchownSync(p, uid, gid);
    if (lstatSync(p).isSymbolicLink()) return;
    const entries = (() => {
      try {
        return readdirSync(p, { withFileTypes: true });
      } catch {
        return null; // a file
      }
    })();
    if (!entries) return;
    chmodSync(p, 0o700);
    for (const e of entries) walk(join(p, e.name));
  };
  walk(path);
}
