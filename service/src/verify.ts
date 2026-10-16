/**
 * Runs `polyman verify --json` on one problem folder.
 *
 * - The child gets a bare environment: no variables of ours, nothing to leak.
 * - In the image it runs as a user of its own (`runAs`), so the code it runs
 *   can't signal, inspect or read the service, and every process of that user
 *   is killed when the run ends, however it ends.
 * - A time limit for the whole run, and cancellation when the visitor leaves;
 *   either kills everything polyman started, solutions included.
 * - The upload's own compile cache (.polyman) never gets this far: unzip
 *   leaves it out, so what runs is compiled from the sources. (`--no-cache`
 *   would also turn off polyman's prebuilt testlib, and every compile would
 *   then run into polyman's 10 s compile limit.)
 *
 * Progress comes from the "Step N: ..." lines polyman prints to stderr.
 */
import { spawn } from 'node:child_process';
import { killTree, killUser } from './kill-tree.ts';

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
}

export interface RunOptions {
  /** path to polyman's dist/cli.js */
  cli: string;
  timeoutMs: number;
  onStep?: (step: number, title: string) => void;
  /** run as this user and group (needs the service to run as root) */
  runAs?: { uid: number; gid: number };
  signal?: AbortSignal;
}

const STEP = /Step (\d+): (.+?)\s*$/;
// after the child exits, wait this long for its output to drain, then stop waiting:
// a process it left behind could hold the pipes open forever
const DRAIN_MS = 2000;

export function runVerify(dir: string, { cli, timeoutMs, onStep, runAs, signal }: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const child = spawn(process.execPath, ['--disable-sigusr1', cli, 'verify', '--json'], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(runAs ?? {}),
  });

  let stdout = '';
  let stderrTail = '';
  let partial = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => {
    stdout += c;
  });
  child.stderr.setEncoding('utf8').on('data', (c: string) => {
    stderrTail = (stderrTail + c).slice(-4000);
    const lines = (partial + c).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const m = STEP.exec(line.replace(/\x1b\[[0-9;]*m/g, ''));
      if (m) onStep?.(Number(m[1]), m[2]);
    }
  });

  let stopped: string | undefined;
  const stop = (why: string) => {
    if (stopped) return;
    stopped = why;
    if (child.pid) killTree(child.pid);
  };
  const timer = setTimeout(() => stop(`stopped after ${timeoutMs / 1000} s`), timeoutMs);
  const onAbort = () => stop('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  return new Promise((done) => {
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // whatever is left: the tree, and in the image every process of the runner user
      if (child.pid) killTree(child.pid);
      if (runAs) killUser(runAs.uid);
      child.stdout.destroy();
      child.stderr.destroy();

      const seconds = (Date.now() - started) / 1000;
      if (stopped) return done({ report: null, error: stopped, seconds });
      try {
        done({ report: JSON.parse(stdout) as VerifyReport, seconds });
      } catch {
        const last = stderrTail.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-5).join('\n');
        done({ report: null, error: `polyman exited with ${code} and no report${last ? `:\n${last}` : ''}`, seconds });
      }
    };
    child.on('exit', (code) => {
      // usually 'close' follows at once; if something holds the pipes, stop waiting
      const drain = setTimeout(() => finish(code), DRAIN_MS);
      child.once('close', () => {
        clearTimeout(drain);
        finish(code);
      });
    });
    child.on('error', (err) => {
      stopped ??= `could not start polyman: ${err.message}`;
      finish(null);
    });
  });
}
