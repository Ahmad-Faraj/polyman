/**
 * @fileoverview A precompiled `<bits/stdc++.h>`, built once per compiler and
 * flags and shared by every problem of the user.
 *
 * Most of a typical solution's compile is g++ parsing `<bits/stdc++.h>`. The
 * first compile that would use it builds `bits/stdc++.h.gch` with the exact
 * compiler and flags of that compile:
 *
 * ```
 * <user cache>/polyman/pch/<key>/bits/stdc++.h.gch
 * ```
 *
 * `key` covers the compiler as resolved, its `--version` output, the
 * platform and the flags, so a different compiler or `cppStandard` or
 * `compiler.flags` gets a PCH of its own and never another key's. The folder
 * goes on the compile's include path (`-I`); it holds nothing but the `.gch`,
 * so it can shadow no header. g++ itself also skips a `.gch` that doesn't
 * match the compile and reads the header as usual.
 *
 * Used only with g++ (clang can't read GCC's `.gch`; Apple's `g++` is clang),
 * only when the compile cache is on, and only for a source whose first
 * directive is `#include <bits/stdc++.h>`. Anything else, or any problem
 * building the PCH, means the normal compile.
 *
 * Set `POLYMAN_DEBUG=1` to log which path each compile took; `POLYMAN_PCH=0`
 * turns it off.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { executor } from '../executor';
import {
  DEFAULT_MAX_ENTRY_AGE_MS,
  debugLog,
  getCompilerIdentity,
  isCacheEnabled,
} from './compile-cache';
import { quoteShellArgument } from './shell';

/** Bumped whenever the key derivation or the on-disk layout changes. */
export const PCH_FORMAT_VERSION = 1;

const GCH = path.join('bits', 'stdc++.h.gch');
const BAD = 'unsupported';

/** A failed build, or a compile that failed with the PCH, is retried after this. */
export const UNSUPPORTED_RETRY_MS = 24 * 60 * 60 * 1000;

/** Each `.gch` is about 140 MB, so a user cache keeps at most this many keys. */
export const MAX_PCH_KEYS = 2;

/** Building the PCH takes a few seconds once; give it room on slow machines. */
const PCH_BUILD_TIMEOUT_MS = 120000;

/**
 * The compile that wants the PCH.
 */
export interface PchRequest {
  /** Absolute path of the source being compiled. */
  sourcePath: string;
  /** Compiler executable as resolved, not shell-quoted. */
  compiler: string;
  /** Exact flags of the compile, not shell-quoted. */
  flags: string[];
}

/**
 * A PCH ready to compile against.
 */
export interface Pch {
  key: string;
  /** Goes on the include path with `-I`; holds only `bits/stdc++.h.gch`. */
  includeDir: string;
}

const prepared = new Map<string, Promise<Pch | null>>();

/**
 * Forgets which PCHs this process has prepared.
 */
export function resetPchState(): void {
  prepared.clear();
}

/**
 * Per-user folder for PCHs: `POLYMAN_CACHE_DIR`, else the platform's cache
 * folder (`%LOCALAPPDATA%`, `~/Library/Caches`, `$XDG_CACHE_HOME` or
 * `~/.cache`) plus `polyman/pch`.
 *
 * @returns {string} Absolute path of the folder
 */
export function getPchRoot(): string {
  const override = process.env['POLYMAN_CACHE_DIR']?.trim();
  if (override) return path.resolve(override, 'pch');
  const home = os.homedir();
  let base: string;
  if (process.platform === 'win32') {
    base = process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
  } else if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Caches');
  } else {
    base = process.env['XDG_CACHE_HOME'] ?? path.join(home, '.cache');
  }
  return path.join(base, 'polyman', 'pch');
}

/**
 * Whether a source's first directive, after blank lines and comments, is
 * `#include <bits/stdc++.h>`: only then can g++ use the PCH for it.
 *
 * @param {string} text - The source
 * @returns {boolean} True when the PCH applies
 */
export function startsWithBitsStdcpp(text: string): boolean {
  const rest = text.replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, '');
  return /^#\s*include\s*<bits\/stdc\+\+\.h>/.test(rest);
}

/**
 * Whether a `--version` output is GCC's. clang (Apple's `g++` included)
 * can't use a GCC `.gch`.
 *
 * @param {string} identity - The compiler's `--version` output
 * @returns {boolean} True for GCC
 */
export function isGccIdentity(identity: string): boolean {
  if (/clang/i.test(identity)) return false;
  return /Free Software Foundation|\bGCC\b|g\+\+/.test(identity);
}

/**
 * The key of a PCH: everything that decides whether it fits a compile.
 */
export function pchKey(request: PchRequest, identity: string): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        formatVersion: PCH_FORMAT_VERSION,
        compiler: request.compiler,
        compilerIdentity: identity,
        platform: process.platform,
        arch: process.arch,
        flags: request.flags,
      })
    )
    .digest('hex');
}

/** Finds the real `<bits/stdc++.h>` the compiler would include. */
async function findHeader(request: PchRequest, dir: string): Promise<string> {
  const probe = path.join(dir, `probe.${process.pid}.cpp`);
  const out = path.join(dir, `probe.${process.pid}.ii`);
  fs.writeFileSync(probe, '#include <bits/stdc++.h>\n');
  try {
    const result = await executor.execute(
      [
        quoteShellArgument(request.compiler),
        ...request.flags.map(quoteShellArgument),
        '-E',
        '-H',
        '-o',
        quoteShellArgument(out),
        quoteShellArgument(probe),
      ].join(' '),
      { timeout: PCH_BUILD_TIMEOUT_MS, silent: true }
    );
    const match = /^\.\s+(.*bits[\\/]stdc\+\+\.h)\s*$/m.exec(result.stderr);
    if (!match) throw new Error('bits/stdc++.h not found');
    return match[1];
  } finally {
    fs.rmSync(probe, { force: true });
    fs.rmSync(out, { force: true });
  }
}

function readPolymanVersion(): string {
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, '..', '..', 'package.json'),
      'utf8'
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function markBad(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, BAD),
    JSON.stringify({ at: Date.now(), version: readPolymanVersion() })
  );
}

/**
 * Whether the key is marked unsupported right now. A mark that is older than
 * a day, was written by another polyman version, or can't be read is removed,
 * so the build is tried again.
 */
function isMarkedBad(dir: string): boolean {
  const mark = path.join(dir, BAD);
  let raw: string;
  try {
    raw = fs.readFileSync(mark, 'utf8');
  } catch {
    return false;
  }
  let fresh = false;
  try {
    const parsed = JSON.parse(raw) as { at?: unknown; version?: unknown };
    fresh =
      typeof parsed.at === 'number' &&
      Date.now() - parsed.at < UNSUPPORTED_RETRY_MS &&
      parsed.version === readPolymanVersion();
  } catch {
    // an empty or unreadable mark counts as expired
  }
  if (!fresh) fs.rmSync(mark, { force: true });
  return fresh;
}

/**
 * Removes PCHs nobody used for longer than the cache's maximum age, then the
 * least recently used ones until at most `MAX_PCH_KEYS` hold a `.gch`. The
 * key just built or used is never removed.
 */
function pruneOthers(keep: string): void {
  const root = getPchRoot();
  const now = Date.now();
  const kept: { dir: string; usedAt: number }[] = [];
  for (const key of fs.readdirSync(root)) {
    if (key === keep) continue;
    const dir = path.join(root, key);
    const gch = path.join(dir, GCH);
    const hasGch = fs.existsSync(gch);
    const usedAt = fs.statSync(hasGch ? gch : dir).mtimeMs;
    if (now - usedAt > DEFAULT_MAX_ENTRY_AGE_MS) {
      fs.rmSync(dir, { recursive: true, force: true });
    } else if (hasGch) {
      kept.push({ dir, usedAt });
    }
  }
  kept.sort((a, b) => b.usedAt - a.usedAt);
  for (const entry of kept.slice(MAX_PCH_KEYS - 1)) {
    fs.rmSync(entry.dir, { recursive: true, force: true });
    debugLog(
      `pch: removed least recently used ${path.basename(entry.dir).slice(0, 12)}`
    );
  }
}

async function prepare(key: string, request: PchRequest): Promise<Pch | null> {
  const dir = path.join(getPchRoot(), key);
  const gch = path.join(dir, GCH);
  if (isMarkedBad(dir)) {
    debugLog(`pch: key ${key.slice(0, 12)} marked unsupported, not used`);
    return null;
  }
  if (fs.existsSync(gch)) {
    const now = new Date();
    fs.utimesSync(gch, now, now);
    return { key, includeDir: dir };
  }

  fs.mkdirSync(path.dirname(gch), { recursive: true });
  const tmp = `${gch}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const startedAt = Date.now();
  try {
    const header = await findHeader(request, dir);
    await executor.execute(
      [
        quoteShellArgument(request.compiler),
        ...request.flags.map(quoteShellArgument),
        '-x',
        'c++-header',
        quoteShellArgument(header),
        '-o',
        quoteShellArgument(tmp),
      ].join(' '),
      { timeout: PCH_BUILD_TIMEOUT_MS, silent: true }
    );
    fs.renameSync(tmp, gch);
    fs.rmSync(path.join(dir, BAD), { force: true });
  } catch (error) {
    debugLog(
      `pch: build failed for key ${key.slice(0, 12)} (${String(error).split('\n')[0]}); normal compiles`
    );
    markBad(dir);
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  debugLog(
    `pch: built key ${key.slice(0, 12)} in ${Date.now() - startedAt}ms at ${gch}`
  );
  try {
    pruneOthers(key);
  } catch {
    // Old PCHs only take disk space.
  }
  return { key, includeDir: dir };
}

/**
 * Returns the PCH to compile `request.sourcePath` with, building it on first
 * use, or null for the normal compile: PCH off (`POLYMAN_PCH=0`,
 * `--no-cache`, or `CPLUS_INCLUDE_PATH` already set), a compiler that isn't
 * g++, a source that doesn't start with `#include <bits/stdc++.h>`, or a
 * PCH that can't be built for this key.
 *
 * Never throws; any problem means the normal compile.
 *
 * @param {PchRequest} request - The compile that wants it
 * @returns {Promise<Pch | null>} The PCH, or null
 */
export async function findPch(request: PchRequest): Promise<Pch | null> {
  const name = path.basename(request.sourcePath);
  try {
    if (process.env['POLYMAN_PCH'] === '0' || !isCacheEnabled()) {
      debugLog(`pch: off, normal compile: ${name}`);
      return null;
    }
    if (process.env['CPLUS_INCLUDE_PATH']) {
      debugLog(`pch: CPLUS_INCLUDE_PATH is set, normal compile: ${name}`);
      return null;
    }
    if (!startsWithBitsStdcpp(fs.readFileSync(request.sourcePath, 'utf-8'))) {
      debugLog(`pch: no leading <bits/stdc++.h>, normal compile: ${name}`);
      return null;
    }
    const identity = await getCompilerIdentity(request.compiler);
    if (!isGccIdentity(identity)) {
      debugLog(
        `pch: skipped, ${request.compiler} is not g++ (${identity.split('\n')[0]}), normal compile: ${name}`
      );
      return null;
    }
    const key = pchKey(request, identity);
    let pending = prepared.get(key);
    if (!pending) {
      pending = prepare(key, request).catch(() => null);
      prepared.set(key, pending);
    }
    const pch = await pending;
    if (pch) {
      debugLog(`pch: using key ${key.slice(0, 12)} for ${name}`);
    } else {
      debugLog(
        `pch: none for key ${key.slice(0, 12)}, normal compile: ${name}`
      );
    }
    return pch;
  } catch (error) {
    debugLog(`pch: ${String(error).split('\n')[0]}, normal compile: ${name}`);
    return null;
  }
}

/**
 * Records that a compile failed with `pch` although it compiles without it,
 * so later compiles don't use it.
 *
 * @param {Pch} pch - The PCH that failed
 */
export function markPchUnsupported(pch: Pch): void {
  prepared.set(pch.key, Promise.resolve(null));
  try {
    // Delete the bad .gch too: once the mark expires, a rebuild must happen
    // instead of reusing it.
    fs.rmSync(path.join(pch.includeDir, GCH), { force: true });
    markBad(pch.includeDir);
  } catch {
    // Only this process will skip it; that is still correct.
  }
  debugLog(`pch: key ${pch.key.slice(0, 12)} marked unsupported`);
}
