/**
 * Runs `polyman verify --json` on one problem folder. The child gets a bare
 * environment (no variables of ours, so nothing secret to leak) and a time
 * limit for the whole run; on timeout everything it started is killed, solutions
 * included (see kill-tree.ts). Progress comes from the "Step N: ..." lines polyman prints to
 * stderr.
 */
import { spawn } from 'node:child_process';
import { killTree } from './kill-tree.ts';

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
  /** why there is no report: timeout, crash, unreadable output */
  error?: string;
  seconds: number;
}

export interface RunOptions {
  /** path to polyman's dist/cli.js */
  cli: string;
  timeoutMs: number;
  onStep?: (step: number, title: string) => void;
}

const STEP = /Step (\d+): (.+?)\s*$/;

export function runVerify(dir: string, { cli, timeoutMs, onStep }: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const child = spawn(process.execPath, [cli, 'verify', '--json'], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
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

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid!);
  }, timeoutMs);

  return new Promise((done) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      const seconds = (Date.now() - started) / 1000;
      if (timedOut) return done({ report: null, error: `stopped after ${timeoutMs / 1000} s`, seconds });
      try {
        done({ report: JSON.parse(stdout) as VerifyReport, seconds });
      } catch {
        const last = stderrTail.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-5).join('\n');
        done({ report: null, error: `polyman exited with ${code} and no report${last ? `:\n${last}` : ''}`, seconds });
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ report: null, error: `could not start polyman: ${err.message}`, seconds: (Date.now() - started) / 1000 });
    });
  });
}
