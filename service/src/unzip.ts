/**
 * Unpacks an uploaded zip into a fresh folder, refusing anything that could
 * reach outside it: absolute paths, `..`, backslashes, symlinks. Sizes are
 * counted as the data is written, not taken from the zip's own headers, so a
 * zip bomb stops at the limit. A `.polyman` folder (polyman's compile cache)
 * is left out, so what runs is always compiled from the sources.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';

export interface UnzipLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_LIMITS: UnzipLimits = {
  maxEntries: 2000,
  maxTotalBytes: 100 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
};

export class UnsafeZipError extends Error {}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** The entry's path inside the folder, or an error saying why it isn't allowed. */
export function safeEntryPath(name: string): string {
  if (!name || name.includes('\0')) throw new UnsafeZipError('an entry has an empty or invalid name');
  if (name.includes('\\')) throw new UnsafeZipError(`"${name}" uses a backslash`);
  if (isAbsolute(name) || /^[a-zA-Z]:/.test(name)) throw new UnsafeZipError(`"${name}" is an absolute path`);
  const parts = name.split('/');
  if (parts.includes('..')) throw new UnsafeZipError(`"${name}" goes outside the folder`);
  return parts.filter((p) => p && p !== '.').join('/');
}

export async function unzip(zip: Buffer, dest: string, limits: UnzipLimits = DEFAULT_LIMITS): Promise<string[]> {
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  // strictFileNames off: our own check below gives a clearer message for the same cases
  const zipfile = await yauzl.fromBufferPromise(zip, { lazyEntries: true, validateEntrySizes: true });
  const written: string[] = [];
  let entries = 0;
  let total = 0;

  try {
    for await (const entry of zipfile.eachEntry()) {
      if (++entries > limits.maxEntries) throw new UnsafeZipError(`more than ${limits.maxEntries} files`);
      const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
      if (mode === S_IFLNK) throw new UnsafeZipError(`"${entry.fileName}" is a symlink`);

      const rel = safeEntryPath(entry.fileName);
      // polyman's compile cache: binaries polyman would trust instead of compiling the sources
      if (!rel || rel.split('/').includes('.polyman')) continue;
      const target = inside(root, rel);
      if (entry.fileName.endsWith('/')) {
        mkdirSync(target, { recursive: true });
        continue;
      }

      mkdirSync(dirname(target), { recursive: true });
      let fileBytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          fileBytes += chunk.length;
          total += chunk.length;
          if (fileBytes > limits.maxFileBytes) return done(new UnsafeZipError(`"${rel}" is larger than ${limits.maxFileBytes} bytes`));
          if (total > limits.maxTotalBytes) return done(new UnsafeZipError(`the files add up to more than ${limits.maxTotalBytes} bytes`));
          done(null, chunk);
        },
      });
      await pipeline(await zipfile.openReadStreamPromise(entry), counter, createWriteStream(target, { flags: 'wx' }));
      written.push(rel);
    }
  } finally {
    zipfile.close();
  }
  return written;
}

/** Joins a folder and a relative path, refusing a result outside the folder. */
export function inside(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new UnsafeZipError(`"${path}" points outside the problem folder`);
  return join(target);
}
