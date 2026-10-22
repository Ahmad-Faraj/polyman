/**
 * Runs `polyman verify --json` on one problem folder.
 *
 * - The child gets only PATH, with HOME and TMPDIR set to the problem folder,
 *   LANG, a 60 s compile limit for polyman, and for a problem on polyman's
 *   default C++ flags the precompiled-header folder (`pchDir`, as
 *   CPLUS_INCLUDE_PATH); none of the service's other variables.
 * - In the image it runs as a user of its own (`runAs`), with a cap on how
 *   many processes that user may have, so the code it runs can't signal,
 *   inspect or read the service, and can't fork without end. When the run
 *   ends, however it ends, every process of that user is killed (from inside
 *   the user, which a fork loop can't outrun), and the files and System V IPC
 *   objects it left in shared places are removed. If that cleanup fails, the
 *   result says so (`unclean`) and the instance stops taking visitors.
 * - A time limit for the whole run, cancellation when the visitor leaves, and
 *   a cap on how much output is read.
 * - The upload's own compile cache (.polyman) never gets this far: unzip
 *   leaves it out, so what runs is compiled from the sources. (`--no-cache`
 *   would also turn off polyman's prebuilt testlib, and every compile would
 *   then run into polyman's 10 s compile limit.)
 *
 * Progress comes from the "Step N: ..." lines polyman prints to stderr.
 */
import { spawn } from 'node:child_process';
import { killTree, killUser, removeFilesOf, removeIpcOf } from './kill-tree.ts';

export interface VerifyReport {
  schemaVersion: number;
  polymanVersion: string;
  ok: boolean;
  failedStep: string | null;
  steps: { name: string; ok: boolean; errors: string[] }[];
  solutions: {
    name: string;
    tag: string;
    matchesTag: boolean;
    reason: string;
    tests: { testset: string; index: number; verdict: string; timeMs: number; message: string }[];
  }[];
}

export interface RunResult {
  report: VerifyReport | null;
  /** why there is no report: timeout, cancelled, crash, unreadable output */
  error?: string;
  seconds: number;
  /**
   * Cleaning up after the run failed, so something of this upload may still
   * be running or stored. The instance must not take another visitor.
   */
  unclean?: string;
}

export interface RunOptions {
  /** path to polyman's dist/cli.js */
  cli: string;
  timeoutMs: number;
  onStep?: (step: number, title: string) => void;
  /** run as this user and group (needs the service to run as root) */
  runAs?: { uid: number; gid: number };
  /** precompiled headers for the C++ compiles; only for a problem compiled with the flags they were built with */
  pchDir?: string;
  signal?: AbortSignal;
  /** called when cleaning up after the run found something to clean, for the log */
  onCleanupProblem?: (message: string) => void;
  /** most progress events passed to onStep (stderr is the uploaded code's to write to) */
  maxSteps?: number;
}

const STEP = /Step (\d+): (.+?)\s*$/;
// after the child exits, wait this long for its output to drain, then stop waiting:
// a process it left behind could hold the pipes open forever
const DRAIN_MS = 2000;
// a report is a few hundred KB at most; anything near this is someone filling the pipe
const MAX_STDOUT = 16 * 1024 * 1024;
// compile limit given to polyman, well inside the per-problem limit
const COMPILE_TIMEOUT_MS = 60_000;
// processes the runner user may have at once: polyman, compilers, a solution and its threads
const MAX_PROCESSES = 256;
// /tmp lives in memory on Cloud Run, so one huge file from a generator or solution could take the instance down
const MAX_FILE_BYTES = 256 * 1024 * 1024;
// polyman prints a dozen steps; the uploaded code can write to the same stderr
const MAX_STEPS = 50;
// shared writable places the runner can leave things in, besides its upload
const SHARED_DIRS = ['/tmp', '/var/tmp', '/dev/shm', '/run/lock', '/var/lock', '/dev/mqueue'];

/** A report has to have this shape before anything reads it. */
export function isReport(value: unknown): value is VerifyReport {
  const r = value as VerifyReport;
  return (
    !!r &&
    typeof r === 'object' &&
    r.schemaVersion === 1 &&
    typeof r.ok === 'boolean' &&
    Array.isArray(r.steps) &&
    Array.isArray(r.solutions) &&
    r.solutions.every((s) => s && typeof s.name === 'string' && Array.isArray(s.tests))
  );
}

export function runVerify(dir: string, opts: RunOptions): Promise<RunResult> {
  const { cli, timeoutMs, onStep, runAs, signal } = opts;
  const started = Date.now();
  const polyman = [process.execPath, '--disable-sigusr1', cli, 'verify', '--json'];
  // as the runner user, go through prlimit so the process cap covers everything it starts
  const [command, ...args] = runAs ? ['prlimit', `--nproc=${MAX_PROCESSES}:${MAX_PROCESSES}`, `--fsize=${MAX_FILE_BYTES}:${MAX_FILE_BYTES}`, '--', ...polyman] : polyman;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: dir,
        TMPDIR: dir,
        LANG: 'C.UTF-8',
        // compiling in the sandbox, on a fresh or busy instance, can take longer than polyman's 10 s default
        POLYMAN_COMPILE_TIMEOUT_MS: String(COMPILE_TIMEOUT_MS),
        // g++ uses bits/stdc++.h.gch from here when it matches the compile, and the real header otherwise
        ...(opts.pchDir ? { CPLUS_INCLUDE_PATH: opts.pchDir } : {}),
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(runAs ?? {}),
    });
  } catch (err) {
    // spawn throws at once when it can't switch user (the service isn't root)
    return Promise.resolve({ report: null, error: `could not start polyman: ${(err as Error).message}`, seconds: 0 });
  }

  let stdout = '';
  let stdoutBytes = 0;
  let stderrTail = '';
  let partial = '';
  let steps = 0;

  let stopped: string | undefined;
  const stop = (why: string) => {
    if (stopped) return;
    stopped = why;
    if (child.pid) killTree(child.pid);
  };

  child.stdout!.setEncoding('utf8').on('data', (c: string) => {
    if (stopped) return;
    stdoutBytes += Buffer.byteLength(c);
    if (stdoutBytes > MAX_STDOUT) return stop(`stopped: polyman printed more than ${MAX_STDOUT / 1024 / 1024} MB`);
    stdout += c;
  });
  child.stderr!.setEncoding('utf8').on('data', (c: string) => {
    stderrTail = (stderrTail + c).slice(-4000);
    const lines = (partial + c).split('\n');
    partial = (lines.pop() ?? '').slice(-4000);
    for (const line of lines) {
      const m = STEP.exec(line.replace(/\x1b\[[0-9;]*m/g, ''));
      if (m && steps++ < (opts.maxSteps ?? MAX_STEPS)) onStep?.(Number(m[1]), m[2].slice(0, 120));
    }
  });

  const timer = setTimeout(() => stop(`stopped after ${timeoutMs / 1000} s`), timeoutMs);
  const onAbort = () => stop('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  return new Promise((done) => {
    let finished = false;
    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      let unclean: string | undefined;
      try {
        // whatever is left: the tree, and in the image every process, file and IPC object of the runner user
        if (child.pid) killTree(child.pid);
        if (runAs) {
          const left = killUser(runAs.uid, runAs.gid);
          if (left) opts.onCleanupProblem?.(`${left} runner process(es) were still alive after the run and were killed`);
          removeFilesOf(runAs.uid, SHARED_DIRS);
          removeIpcOf(runAs.uid, runAs.gid);
        }
      } catch (err) {
        // fail closed: the caller must stop taking visitors on this instance
        unclean = `cleanup after the run failed: ${(err as Error).message}`;
      }
      child.stdout?.destroy();
      child.stderr?.destroy();

      const seconds = (Date.now() - started) / 1000;
      const end = (r: Omit<RunResult, 'seconds' | 'unclean'>) => done({ ...r, seconds, ...(unclean ? { unclean } : {}) });
      if (stopped) return end({ report: null, error: stopped });
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        const last = stderrTail.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-5).join('\n');
        const how = sig ? `was killed by ${sig}${sig === 'SIGKILL' ? ' (out of memory?)' : ''}` : `exited with ${code}`;
        return end({ report: null, error: `polyman ${how} and no report${last ? `:\n${last}` : ''}` });
      }
      if (!isReport(parsed)) return end({ report: null, error: 'polyman printed a report in a format this service does not know' });
      end({ report: parsed });
    };
    child.on('exit', (code, sig) => {
      // usually 'close' follows at once; if something holds the pipes, stop waiting
      const drain = setTimeout(() => finish(code, sig), DRAIN_MS);
      child.once('close', () => {
        clearTimeout(drain);
        finish(code, sig);
      });
    });
    child.on('error', (err) => {
      stopped ??= `could not start polyman: ${err.message}`;
      finish(null, null);
    });
  });
}
