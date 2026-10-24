import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executor } from '../../src/executor';
import {
  DEFAULT_MAX_ENTRY_AGE_MS,
  resetCompileCacheState,
  setCacheEnabled,
} from '../../src/helpers/compile-cache';
import * as pch from '../../src/helpers/pch';
import type { PchRequest } from '../../src/helpers/pch';

vi.mock('../../src/executor');
vi.mock('../../src/formatter');

const executeMock = vi.mocked(executor)['execute'];

const GCC =
  'g++ (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0\nCopyright (C) 2023 Free Software Foundation, Inc.';
const CLANG = 'Ubuntu clang version 18.1.3\nTarget: x86_64-pc-linux-gnu';
const APPLE =
  'Apple clang version 16.0.0 (clang-1600.0.26.6)\nTarget: arm64-apple-darwin24.1.0';
const MSYS2 =
  'g++.exe (Rev2, Built by MSYS2 project) 14.2.0\nCopyright (C) 2024 Free Software Foundation, Inc.';

let tmpDir: string;
let cacheDir: string;

function source(name: string, text: string): string {
  const file = path.join(tmpDir, 'solutions', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function request(overrides: Partial<PchRequest> = {}): PchRequest {
  return {
    sourcePath: path.join(tmpDir, 'solutions', 'acc.cpp'),
    compiler: 'g++',
    flags: ['-O2', '-std=c++23'],
    ...overrides,
  };
}

/** Header builds (`-x c++-header`), not probes or `--version`. */
function pchBuilds(): string[] {
  return executeMock.mock.calls
    .map(([command]) => command)
    .filter(command => command.includes('c++-header'));
}

/**
 * Stand-in for a compiler: `--version` prints `identity`, `-E -H` reports
 * where bits/stdc++.h is, and a header build writes its `-o` file.
 */
function fakeCompiler(
  options: { identity?: string; failBuild?: boolean } = {}
) {
  executeMock.mockImplementation((command: string) => {
    const ok = (stdout = '', stderr = '') =>
      Promise.resolve({ stdout, stderr, exitCode: 0, success: true });
    if (command.endsWith('--version')) return ok(options.identity ?? GCC);
    if (command.includes(' -E -H ')) {
      return ok(
        '',
        '. /usr/include/c++/13/bits/stdc++.h\n.. /usr/include/c++/13/cassert\n'
      );
    }
    if (options.failBuild)
      return Promise.reject(new Error('cc1plus: out of memory'));
    const output = /-o ('[^']+'|"[^"]+")$/.exec(command)?.[1] ?? '';
    fs.writeFileSync(output.slice(1, -1), 'GCH');
    return ok();
  });
}

describe('pch.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCompileCacheState();
    pch.resetPchState();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyman-pch-'));
    cacheDir = path.join(tmpDir, 'user-cache');
    process.env['POLYMAN_CACHE_DIR'] = cacheDir;
    delete process.env['POLYMAN_PCH'];
    delete process.env['CPLUS_INCLUDE_PATH'];
    source('acc.cpp', '// accepted\n#include <bits/stdc++.h>\nint main() {}\n');
    fakeCompiler();
  });

  afterEach(() => {
    delete process.env['POLYMAN_CACHE_DIR'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds the PCH once with the exact flags and reuses it', async () => {
    const first = await pch.findPch(request());
    pch.resetPchState();
    const later = await pch.findPch(request());

    expect(first).not.toBeNull();
    expect(later).toEqual(first);
    expect(first!.includeDir).toBe(path.join(cacheDir, 'pch', first!.key));
    expect(
      fs.readFileSync(
        path.join(first!.includeDir, 'bits', 'stdc++.h.gch'),
        'utf-8'
      )
    ).toBe('GCH');
    expect(pchBuilds()).toEqual([
      expect.stringMatching(
        /^(['"])g\+\+\1 \1-O2\1 \1-std=c\+\+23\1 -x c\+\+-header \1\/usr\/include\/c\+\+\/13\/bits\/stdc\+\+\.h\1 -o /
      ),
    ]);
  });

  it('builds once for compiles that run in parallel', async () => {
    const results = await Promise.all([
      pch.findPch(request()),
      pch.findPch(request()),
      pch.findPch(request()),
    ]);
    expect(new Set(results.map(r => r?.includeDir)).size).toBe(1);
    expect(pchBuilds()).toHaveLength(1);
  });

  describe('key mismatch', () => {
    it("never hands one key's PCH to other flags or another compiler", async () => {
      const o2 = await pch.findPch(request());
      const o3 = await pch.findPch(request({ flags: ['-O3', '-std=c++23'] }));
      const cxx17 = await pch.findPch(
        request({ flags: ['-O2', '-std=c++17'] })
      );
      const g15 = await pch.findPch(request({ compiler: 'g++-15' }));

      const dirs = [o2, o3, cxx17, g15].map(r => r!.includeDir);
      expect(new Set(dirs).size).toBe(4);
      expect(pchBuilds()).toHaveLength(4);
    });

    it('changes the key when the compiler identity changes', () => {
      expect(pch.pchKey(request(), GCC)).not.toBe(
        pch.pchKey(request(), GCC.replace('13.3.0', '13.4.0'))
      );
      expect(pch.pchKey(request(), GCC)).toBe(pch.pchKey(request(), GCC));
    });

    it('does not use a PCH whose key folder holds no .gch', async () => {
      const key = pch.pchKey(request({ flags: ['-O1'] }), GCC);
      fs.mkdirSync(path.join(cacheDir, 'pch', key), { recursive: true });
      fakeCompiler({ failBuild: true });

      expect(await pch.findPch(request({ flags: ['-O1'] }))).toBeNull();
    });
  });

  describe('clang', () => {
    it.each([
      ['clang++', CLANG],
      ['Apple g++', APPLE],
    ])('skips the PCH entirely for %s', async (_name, identity) => {
      fakeCompiler({ identity });

      expect(await pch.findPch(request({ compiler: 'clang++' }))).toBeNull();
      expect(pchBuilds()).toHaveLength(0);
      expect(fs.existsSync(path.join(cacheDir, 'pch'))).toBe(false);
    });

    it('recognises GCC builds, MSYS2 included', () => {
      expect(pch.isGccIdentity(GCC)).toBe(true);
      expect(pch.isGccIdentity(MSYS2)).toBe(true);
      expect(pch.isGccIdentity(CLANG)).toBe(false);
      expect(pch.isGccIdentity(APPLE)).toBe(false);
    });
  });

  describe('build failure', () => {
    it('falls back to the normal compile and does not retry the build', async () => {
      fakeCompiler({ failBuild: true });

      expect(await pch.findPch(request())).toBeNull();
      pch.resetPchState();
      expect(await pch.findPch(request())).toBeNull();
      expect(pchBuilds()).toHaveLength(1);
    });

    it('stops using a PCH marked unsupported after a failed compile', async () => {
      const first = await pch.findPch(request());
      pch.markPchUnsupported(first!);
      expect(await pch.findPch(request())).toBeNull();
      pch.resetPchState();
      expect(await pch.findPch(request())).toBeNull();
    });
  });

  describe('atomic build', () => {
    it('never shows the .gch under its final name before the build ends', async () => {
      const seen: boolean[] = [];
      const base = executeMock.getMockImplementation()!;
      executeMock.mockImplementation(async (command, options) => {
        const result = await base(command, options);
        if (command.includes('c++-header')) {
          const key = pch.pchKey(request(), GCC);
          seen.push(
            fs.existsSync(
              path.join(cacheDir, 'pch', key, 'bits', 'stdc++.h.gch')
            )
          );
        }
        return result;
      });

      const built = await pch.findPch(request());

      expect(seen).toEqual([false]);
      expect(
        fs.existsSync(path.join(built!.includeDir, 'bits', 'stdc++.h.gch'))
      ).toBe(true);
      expect(fs.readdirSync(path.join(built!.includeDir, 'bits'))).toEqual([
        'stdc++.h.gch',
      ]);
    });

    it('leaves no temp file behind after a failed build', async () => {
      fakeCompiler({ failBuild: true });
      await pch.findPch(request());
      const dir = path.join(
        cacheDir,
        'pch',
        pch.pchKey(request(), GCC),
        'bits'
      );
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    });
  });

  describe('unsupported mark', () => {
    const key = () => pch.pchKey(request(), GCC);
    const markFile = () => path.join(cacheDir, 'pch', key(), 'unsupported');
    const writeMark = (content: string) => {
      fs.mkdirSync(path.dirname(markFile()), { recursive: true });
      fs.writeFileSync(markFile(), content);
    };
    const version = () =>
      (
        JSON.parse(
          fs.readFileSync(
            path.join(__dirname, '..', '..', 'package.json'),
            'utf8'
          )
        ) as { version: string }
      ).version;

    it('records the time and the polyman version', async () => {
      fakeCompiler({ failBuild: true });
      await pch.findPch(request());
      const mark = JSON.parse(fs.readFileSync(markFile(), 'utf8')) as {
        at: number;
        version: string;
      };
      expect(typeof mark.at).toBe('number');
      expect(mark.version).toBe(version());
    });

    it('honours a fresh mark', async () => {
      writeMark(JSON.stringify({ at: Date.now() - 1000, version: version() }));
      expect(await pch.findPch(request())).toBeNull();
      expect(pchBuilds()).toHaveLength(0);
    });

    it('retries the build after a day, and a successful build clears the mark', async () => {
      writeMark(
        JSON.stringify({
          at: Date.now() - pch.UNSUPPORTED_RETRY_MS - 1000,
          version: version(),
        })
      );
      const result = await pch.findPch(request());
      expect(result).not.toBeNull();
      expect(pchBuilds()).toHaveLength(1);
      expect(fs.existsSync(markFile())).toBe(false);
    });

    it('retries the build when the mark is from another polyman version', async () => {
      writeMark(JSON.stringify({ at: Date.now(), version: '0.0.0-old' }));
      expect(await pch.findPch(request())).not.toBeNull();
      expect(pchBuilds()).toHaveLength(1);
      expect(fs.existsSync(markFile())).toBe(false);
    });

    it.each([
      ['an empty mark', ''],
      ['an unreadable mark', '{not json'],
    ])('treats %s as expired', async (_name, content) => {
      writeMark(content);
      expect(await pch.findPch(request())).not.toBeNull();
      expect(pchBuilds()).toHaveLength(1);
    });

    it('expires the mark a failed compile left, too', async () => {
      const first = await pch.findPch(request());
      pch.markPchUnsupported(first!);
      const mark = JSON.parse(fs.readFileSync(markFile(), 'utf8')) as {
        at: number;
        version: string;
      };
      expect(typeof mark.at).toBe('number');
      expect(mark.version).toBe(version());
      writeMark(
        JSON.stringify({
          at: Date.now() - pch.UNSUPPORTED_RETRY_MS - 1000,
          version: version(),
        })
      );
      pch.resetPchState();
      expect(await pch.findPch(request())).not.toBeNull();
      expect(fs.existsSync(markFile())).toBe(false);
    });

    it('rebuilds the PCH after the mark of a failed compile expires', async () => {
      const first = await pch.findPch(request());
      expect(first).not.toBeNull();
      pch.markPchUnsupported(first!);
      writeMark(
        JSON.stringify({
          at: Date.now() - pch.UNSUPPORTED_RETRY_MS - 1000,
          version: version(),
        })
      );
      pch.resetPchState();

      const again = await pch.findPch(request());

      expect(again).not.toBeNull();
      expect(pchBuilds()).toHaveLength(2);
    });

    it('still writes the mark when the bad .gch cannot be deleted', async () => {
      const first = await pch.findPch(request());
      expect(first).not.toBeNull();
      const realRm = fs.rmSync;
      const rmSpy = vi
        .spyOn(fs, 'rmSync')
        .mockImplementation((target, opts) => {
          if (String(target).endsWith('stdc++.h.gch')) {
            throw Object.assign(new Error('EBUSY: resource busy'), {
              code: 'EBUSY',
            });
          }
          return realRm(target, opts);
        });
      try {
        expect(() => pch.markPchUnsupported(first!)).not.toThrow();
        expect(fs.existsSync(markFile())).toBe(true);
      } finally {
        rmSpy.mockRestore();
      }
    });

    it('rebuilds when an expired mark sits next to an existing .gch', async () => {
      expect(await pch.findPch(request())).not.toBeNull();
      expect(pchBuilds()).toHaveLength(1);
      writeMark(
        JSON.stringify({
          at: Date.now() - pch.UNSUPPORTED_RETRY_MS - 1000,
          version: version(),
        })
      );
      pch.resetPchState();

      expect(await pch.findPch(request())).not.toBeNull();
      expect(pchBuilds()).toHaveLength(2);
    });
  });

  describe('at most 2 keys', () => {
    const flagsFor = (n: number) => ['-O2', `-std=c++${n}`];
    const gchOf = (r: PchRequest) =>
      path.join(cacheDir, 'pch', pch.pchKey(r, GCC), 'bits', 'stdc++.h.gch');
    const age = (r: PchRequest, ms: number) => {
      const when = new Date(Date.now() - ms);
      fs.utimesSync(gchOf(r), when, when);
    };

    it('removes the least recently used key when a third is built', async () => {
      const a = request({ flags: flagsFor(11) });
      const b = request({ flags: flagsFor(14) });
      const c = request({ flags: flagsFor(17) });
      await pch.findPch(a);
      await pch.findPch(b);
      age(a, 3 * 60 * 60 * 1000);
      age(b, 2 * 60 * 60 * 1000);

      await pch.findPch(c);

      expect(fs.existsSync(gchOf(a))).toBe(false);
      expect(fs.existsSync(gchOf(b))).toBe(true);
      expect(fs.existsSync(gchOf(c))).toBe(true);
    });

    it('keeps a key that was used recently, whatever its age of creation', async () => {
      const a = request({ flags: flagsFor(11) });
      const b = request({ flags: flagsFor(14) });
      const c = request({ flags: flagsFor(17) });
      await pch.findPch(a);
      await pch.findPch(b);
      age(a, 3 * 60 * 60 * 1000);
      age(b, 2 * 60 * 60 * 1000);
      pch.resetPchState();
      await pch.findPch(a); // use refreshes a's mtime

      await pch.findPch(c);

      expect(fs.existsSync(gchOf(a))).toBe(true);
      expect(fs.existsSync(gchOf(b))).toBe(false);
      expect(fs.existsSync(gchOf(c))).toBe(true);
    });

    it('never removes the key just built, even when it looks oldest', async () => {
      const a = request({ flags: flagsFor(11) });
      const b = request({ flags: flagsFor(14) });
      const c = request({ flags: flagsFor(17) });
      await pch.findPch(a);
      await pch.findPch(b);
      const future = new Date(Date.now() + 60 * 60 * 1000);
      fs.utimesSync(gchOf(a), future, future);
      fs.utimesSync(gchOf(b), future, future);

      await pch.findPch(c);

      expect(fs.existsSync(gchOf(c))).toBe(true);
    });
  });

  describe('pruning by age', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const root = () => path.join(cacheDir, 'pch');
    const setTime = (target: string, ms: number) => {
      const when = new Date(Date.now() - ms);
      fs.utimesSync(target, when, when);
    };

    it('removes a key whose .gch is older than the maximum age, with fewer than 2 keys', async () => {
      const dir = path.join(root(), 'oldkey');
      const gch = path.join(dir, 'bits', 'stdc++.h.gch');
      fs.mkdirSync(path.dirname(gch), { recursive: true });
      fs.writeFileSync(gch, 'GCH');
      setTime(gch, DEFAULT_MAX_ENTRY_AGE_MS + DAY);

      const built = await pch.findPch(request());

      expect(built).not.toBeNull();
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(path.join(built!.includeDir, 'bits'))).toBe(true);
    });

    it('removes a mark-only folder older than the maximum age, and keeps a recent one', async () => {
      const oldDir = path.join(root(), 'oldmark');
      const recentDir = path.join(root(), 'recentmark');
      for (const dir of [oldDir, recentDir]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'unsupported'), '{}');
      }
      setTime(oldDir, DEFAULT_MAX_ENTRY_AGE_MS + DAY);

      expect(await pch.findPch(request())).not.toBeNull();

      expect(fs.existsSync(oldDir)).toBe(false);
      expect(fs.existsSync(recentDir)).toBe(true);
    });
  });

  describe('when it does not apply', () => {
    it.each([
      ['testlib first', '#include "testlib.h"\n#include <bits/stdc++.h>\n'],
      [
        'a pragma first',
        '#pragma GCC optimize("O3")\n#include <bits/stdc++.h>\n',
      ],
      ['other headers', '#include <iostream>\nint main() {}\n'],
    ])('skips a source with %s', async (_name, text) => {
      source('acc.cpp', text);
      expect(await pch.findPch(request())).toBeNull();
      expect(executeMock).not.toHaveBeenCalled();
    });

    it('is off with --no-cache, POLYMAN_PCH=0 or CPLUS_INCLUDE_PATH', async () => {
      setCacheEnabled(false);
      expect(await pch.findPch(request())).toBeNull();
      setCacheEnabled(true);
      process.env['POLYMAN_PCH'] = '0';
      expect(await pch.findPch(request())).toBeNull();
      delete process.env['POLYMAN_PCH'];
      process.env['CPLUS_INCLUDE_PATH'] = '/opt/pch';
      expect(await pch.findPch(request())).toBeNull();
      delete process.env['CPLUS_INCLUDE_PATH'];
      expect(executeMock).not.toHaveBeenCalled();
    });

    it('detects the leading include after comments and blank lines', () => {
      expect(
        pch.startsWithBitsStdcpp(
          '/* a\n b */\n\n// c\n#include <bits/stdc++.h>\n'
        )
      ).toBe(true);
      expect(pch.startsWithBitsStdcpp('#  include<bits/stdc++.h>')).toBe(true);
      expect(
        pch.startsWithBitsStdcpp('#define X 1\n#include <bits/stdc++.h>\n')
      ).toBe(false);
    });
  });
});
