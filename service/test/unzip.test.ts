import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { UnsafeZipError, inside, safeEntryPath, unzip } from '../src/unzip.ts';

interface Entry {
  name: string;
  data?: string | Buffer;
  mode?: number;
}

/** Builds a zip. yazl refuses unsafe names, so `rename` swaps in a same-length name afterwards. */
function zipOf(entries: Entry[], rename?: [string, string]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const e of entries) zip.addBuffer(Buffer.from(e.data ?? 'x'), e.name, e.mode ? { mode: e.mode } : {});
  zip.end();
  return new Promise((done, fail) => {
    const parts: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => parts.push(c));
    zip.outputStream.on('error', fail);
    zip.outputStream.on('end', () => {
      let buf = Buffer.concat(parts);
      if (rename) {
        const [from, to] = rename;
        if (from.length !== to.length) throw new Error('rename must keep the length');
        buf = Buffer.from(buf.toString('latin1').split(from).join(to), 'latin1');
      }
      done(buf);
    });
  });
}

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'unzip-test-'));
  dirs.push(d);
  return join(d, 'out');
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('unzip', () => {
  it('unpacks a normal problem folder', async () => {
    const dest = fresh();
    const files = await unzip(await zipOf([{ name: 'p/Config.json', data: '{}' }, { name: 'p/solutions/a.cpp', data: 'int main(){}' }]), dest);
    expect(files.sort()).toEqual(['p/Config.json', 'p/solutions/a.cpp']);
    expect(readFileSync(join(dest, 'p/solutions/a.cpp'), 'utf8')).toBe('int main(){}');
  });

  // yauzl refuses these itself before our own check sees them; either way nothing is written
  it.each([
    ['a parent folder', 'zz/evil.txt', '../evil.txt'],
    ['a parent folder written with a backslash', 'zz_evil.txt', '..\\evil.txt'],
    ['an absolute path', 'xetc/evil', '/etc/evil'],
  ])('refuses %s and writes nothing outside', async (_what, safe, unsafe) => {
    const dest = fresh();
    const zip = await zipOf([{ name: safe }], [safe, unsafe]);
    await expect(unzip(zip, dest)).rejects.toThrow();
    expect(existsSync(join(dest, '..', 'evil.txt'))).toBe(false);
    expect(existsSync('/etc/evil')).toBe(false);
  });

  it('treats a backslash as a folder separator, inside the folder', async () => {
    const dest = fresh();
    expect(await unzip(await zipOf([{ name: 'a_b.txt' }], ['a_b.txt', 'a\\b.txt']), dest)).toEqual(['a/b.txt']);
  });

  it('refuses a symlink, wherever it points', async () => {
    const zip = await zipOf([{ name: 'p/link', data: '/etc/passwd', mode: 0o120777 }]);
    await expect(unzip(zip, fresh())).rejects.toThrow('is a symlink');
  });

  it('stops a file that is bigger than its limit while writing it', async () => {
    const zip = await zipOf([{ name: 'big.txt', data: Buffer.alloc(5000, 'a') }]);
    await expect(unzip(zip, fresh(), { maxEntries: 10, maxTotalBytes: 1e6, maxFileBytes: 1000 })).rejects.toThrow('larger than 1000');
  });

  it('stops when the files add up to more than the total limit (a zip bomb compresses well)', async () => {
    const zip = await zipOf([
      { name: 'a.txt', data: Buffer.alloc(800, 'a') },
      { name: 'b.txt', data: Buffer.alloc(800, 'b') },
    ]);
    expect(zip.length).toBeLessThan(1000);
    await expect(unzip(zip, fresh(), { maxEntries: 10, maxTotalBytes: 1000, maxFileBytes: 1000 })).rejects.toThrow('add up to more than');
  });

  it('refuses too many files', async () => {
    const zip = await zipOf([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    await expect(unzip(zip, fresh(), { maxEntries: 2, maxTotalBytes: 1e6, maxFileBytes: 1e6 })).rejects.toThrow('more than 2 files');
  });

  it('refuses something that is not a zip', async () => {
    await expect(unzip(Buffer.from('not a zip at all'), fresh())).rejects.toThrow();
  });
});

describe('path checks', () => {
  it('safeEntryPath drops empty and "." segments and refuses the rest', () => {
    expect(safeEntryPath('./p//a.txt')).toBe('p/a.txt');
    expect(() => safeEntryPath('../a')).toThrow(UnsafeZipError);
    expect(() => safeEntryPath('/a')).toThrow(UnsafeZipError);
    expect(() => safeEntryPath('C:/a')).toThrow(UnsafeZipError);
    expect(() => safeEntryPath('a\\b')).toThrow(UnsafeZipError);
  });

  it('inside() accepts paths in the folder and refuses the rest', () => {
    expect(inside('/srv/p', './solutions/a.cpp')).toBe('/srv/p/solutions/a.cpp');
    expect(() => inside('/srv/p', '../q/a.cpp')).toThrow('outside the problem folder');
    expect(() => inside('/srv/p', '/etc/passwd')).toThrow('outside the problem folder');
  });
});
