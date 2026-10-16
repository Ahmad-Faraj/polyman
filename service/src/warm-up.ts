/**
 * The first verification on a fresh instance compiles with cold caches (the
 * JVM, g++ and testlib from disk) and can run past polyman's fixed 10 s
 * compile limit, which fails the visitor's problem for no fault of theirs.
 * So before the service listens, it verifies one sample, run exactly as a
 * visitor's upload would be. Cloud Run sends no traffic until it listens.
 */
import { chmodSync, copyFileSync, cpSync, lchownSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from './settings.ts';
import { runVerify } from './verify.ts';

export async function warmUp(settings: Settings, sample = 'even-sum'): Promise<{ seconds: number; ok: boolean; error?: string }> {
  const outer = mkdtempSync(join(tmpdir(), 'warm-up-'));
  try {
    chmodSync(outer, 0o711);
    const dir = join(outer, sample);
    cpSync(join(settings.samplesDir, sample), dir, { recursive: true });
    copyFileSync(settings.testlib, join(dir, 'testlib.h'));
    if (settings.runAs) {
      const { uid, gid } = settings.runAs;
      const give = (p: string): void => {
        lchownSync(p, uid, gid);
        if (statSync(p).isDirectory()) for (const name of readdirSync(p)) give(join(p, name));
      };
      give(dir);
    }
    const result = await runVerify(dir, { cli: settings.polymanCli, timeoutMs: settings.problemTimeoutMs ?? 120_000, runAs: settings.runAs });
    return { seconds: result.seconds, ok: !!result.report?.ok, error: result.error ?? result.unclean };
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
}
