/**
 * Two things every verification compiled from scratch, although they come out
 * the same for every upload. Together they were about half of a verify's CPU
 * time; now each is built once, per instance or per image.
 *
 * - testlib.o: polyman keeps the testlib object it builds in the problem's
 *   `.polyman/cache/testlib/<key>/`, and an upload never brings one (unzip
 *   leaves `.polyman` out), so every upload built it again. The warm-up
 *   builds exactly this object from the service's own sample, so the service
 *   keeps a copy (keepPrebuiltTestlib) and copies it into each problem before
 *   the upload is handed to the runner (seedPrebuiltTestlib). The key covers
 *   the testlib bytes, the compiler and the flags: a problem with its own
 *   testlib.h or flags doesn't match it, and polyman builds its own as before.
 * - `<bits/stdc++.h>`: the image carries it precompiled with polyman's
 *   default flags (`-O2 -std=c++23`, see the Dockerfile). A run gets that
 *   folder on CPLUS_INCLUDE_PATH only when its problem keeps the defaults
 *   (usesDefaultCpp). g++ uses a `.gch` only when it matches the compile, and
 *   otherwise reads the header as usual.
 */
import { copyFileSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TESTLIB_CACHE = join('.polyman', 'cache', 'testlib');
// polyman's key: a sha256 in hex
const KEY = /^[0-9a-f]{64}$/;

const isDir = (p: string) => !!lstatSync(p, { throwIfNoEntry: false })?.isDirectory();
const isFile = (p: string) => !!lstatSync(p, { throwIfNoEntry: false })?.isFile();

/**
 * Copies the testlib objects polyman built in `problemDir` into `stash`.
 * Regular files only, and only from a folder that has its object and that
 * polyman didn't mark unsupported. Returns how many it kept.
 */
export function keepPrebuiltTestlib(problemDir: string, stash: string): number {
  const from = join(problemDir, TESTLIB_CACHE);
  if (!isDir(from)) return 0;
  let kept = 0;
  for (const key of readdirSync(from)) {
    const dir = join(from, key);
    if (!KEY.test(key) || !isDir(dir) || !isFile(join(dir, 'testlib.o')) || lstatSync(join(dir, 'unsupported'), { throwIfNoEntry: false })) continue;
    const to = join(stash, key);
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(dir)) if (isFile(join(dir, name))) copyFileSync(join(dir, name), join(to, name));
    kept++;
  }
  return kept;
}

/**
 * Copies the kept testlib objects into the problem's own cache, where polyman
 * looks for them. Called before the upload is handed to the runner. On any
 * failure it removes what it copied, so polyman builds the object as before.
 */
export function seedPrebuiltTestlib(stash: string | undefined, problemDir: string): void {
  if (!stash || !isDir(stash)) return;
  const keys = readdirSync(stash).filter((key) => KEY.test(key));
  if (!keys.length) return;
  const to = join(problemDir, TESTLIB_CACHE);
  try {
    mkdirSync(to, { recursive: true });
    for (const key of keys) cpSync(join(stash, key), join(to, key), { recursive: true });
  } catch (err) {
    rmSync(join(problemDir, '.polyman'), { recursive: true, force: true });
    throw err;
  }
}

/**
 * Whether polyman compiles this problem's C++ with its default flags, the
 * ones the precompiled header was built with: its Config.json sets neither
 * `cppStandard` nor a `compiler` block. An unreadable Config.json counts as no.
 */
export function usesDefaultCpp(problemDir: string): boolean {
  try {
    const config: unknown = JSON.parse(readFileSync(join(problemDir, 'Config.json'), 'utf8'));
    return !!config && typeof config === 'object' && !Array.isArray(config) && !('cppStandard' in config) && !('compiler' in config);
  } catch {
    return false;
  }
}
