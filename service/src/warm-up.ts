/**
 * The first verification on a fresh instance compiles with cold caches (the
 * JVM, g++ and testlib from disk) and can run past polyman's fixed 10 s
 * compile limit, which fails the visitor's problem for no fault of theirs.
 * So before the service listens, it verifies one sample, run exactly as a
 * visitor's upload would be. Cloud Run sends no traffic until it listens.
 *
 * The testlib object it builds is the one every upload would build again, so
 * when the run passes it is kept in `keepTestlibIn` (see build-once.ts). The
 * sample is the service's own, so the object is built from trusted code.
 */
import { chmodSync, copyFileSync, cpSync, lchownSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepPrebuiltTestlib, usesDefaultCpp } from './build-once.ts';
import type { Settings } from './settings.ts';
import { runVerify } from './verify.ts';

export async function warmUp(
  settings: Settings,
  sample = 'even-sum',
  keepTestlibIn?: string,
): Promise<{ seconds: number; ok: boolean; error?: string; keptTestlib: number }> {
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
    const pchDir = settings.pchDir && usesDefaultCpp(dir) ? settings.pchDir : undefined;
    const result = await runVerify(dir, { cli: settings.polymanCli, timeoutMs: settings.problemTimeoutMs ?? 120_000, runAs: settings.runAs, pchDir });
    const ok = !!result.report?.ok;
    const keptTestlib = ok && !result.unclean && keepTestlibIn ? keepPrebuiltTestlib(dir, keepTestlibIn) : 0;
    return { seconds: result.seconds, ok, error: result.error ?? result.unclean, keptTestlib };
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
}
