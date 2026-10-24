import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { keepPrebuiltTestlib, seedPrebuiltTestlib, usesDefaultCpp } from '../src/build-once.ts';
import { settingsFrom, type Settings } from '../src/settings.ts';
import { warmUp } from '../src/warm-up.ts';

const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

// A stand-in for polyman. With buildTestlib in Config.json it leaves a testlib
// object in its cache, as polyman does. Its report says which objects it found
// there before it ran and the CPLUS_INCLUDE_PATH it was given, so a test can
// see what the service handed it.
const FAKE_CLI = `
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('Config.json', 'utf8'));
const cache = '.polyman/cache/testlib';
const found = fs.existsSync(cache) ? fs.readdirSync(cache).filter((k) => fs.existsSync(cache + '/' + k + '/testlib.o')) : [];
if (config.buildTestlib) {
  fs.mkdirSync(cache + '/${KEY}', { recursive: true });
  fs.writeFileSync(cache + '/${KEY}/testlib.o', 'object');
  fs.writeFileSync(cache + '/${KEY}/testlib.h', 'header');
}
process.stdout.write(JSON.stringify({
  schemaVersion: 1, polymanVersion: '9.9.9', ok: !config.broken, failedStep: null, steps: [],
  solutions: [{ name: 'main', tag: 'MA', matchesTag: true, reason: JSON.stringify({ found, pch: process.env.CPLUS_INCLUDE_PATH ?? null }), tests: [] }],
}));
`;

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'build-once-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** a testlib cache folder as polyman leaves it */
const cacheEntry = (problem: string, key: string, files: Record<string, string>) => {
  const dir = join(problem, '.polyman', 'cache', 'testlib', key);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};

describe('keepPrebuiltTestlib', () => {
  it('keeps a folder with its object, all of its files', () => {
    cacheEntry(join(base, 'p'), KEY, { 'testlib.o': 'object', 'testlib.h': 'header', 'testlib.impl.cpp': 'impl' });
    expect(keepPrebuiltTestlib(join(base, 'p'), join(base, 'stash'))).toBe(1);
    expect(readdirSync(join(base, 'stash', KEY)).sort()).toEqual(['testlib.h', 'testlib.impl.cpp', 'testlib.o']);
    expect(readFileSync(join(base, 'stash', KEY, 'testlib.o'), 'utf8')).toBe('object');
  });

  it('skips a folder polyman marked unsupported, one with no object, and a name that is not a key', () => {
    cacheEntry(join(base, 'p'), KEY, { 'testlib.o': 'object', unsupported: '' });
    cacheEntry(join(base, 'p'), OTHER, { 'testlib.h': 'header' });
    cacheEntry(join(base, 'p'), 'not-a-key', { 'testlib.o': 'object' });
    expect(keepPrebuiltTestlib(join(base, 'p'), join(base, 'stash'))).toBe(0);
    expect(existsSync(join(base, 'stash'))).toBe(false);
  });

  it('keeps nothing from a problem with no cache', () => {
    mkdirSync(join(base, 'p'));
    expect(keepPrebuiltTestlib(join(base, 'p'), join(base, 'stash'))).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('copies regular files only, never a link', () => {
    const dir = cacheEntry(join(base, 'p'), KEY, { 'testlib.o': 'object' });
    writeFileSync(join(base, 'secret'), 'secret');
    symlinkSync(join(base, 'secret'), join(dir, 'testlib.h'));
    expect(keepPrebuiltTestlib(join(base, 'p'), join(base, 'stash'))).toBe(1);
    expect(readdirSync(join(base, 'stash', KEY))).toEqual(['testlib.o']);
  });
});

describe('seedPrebuiltTestlib', () => {
  it("copies every kept object into the problem's own cache", () => {
    cacheEntry(join(base, 'from'), KEY, { 'testlib.o': 'object', 'testlib.h': 'header' });
    keepPrebuiltTestlib(join(base, 'from'), join(base, 'stash'));
    mkdirSync(join(base, 'p'));
    seedPrebuiltTestlib(join(base, 'stash'), join(base, 'p'));
    expect(readFileSync(join(base, 'p', '.polyman', 'cache', 'testlib', KEY, 'testlib.o'), 'utf8')).toBe('object');
  });

  it('leaves the problem alone with no stash, an empty one, or none given', () => {
    mkdirSync(join(base, 'p'));
    mkdirSync(join(base, 'empty'));
    seedPrebuiltTestlib(undefined, join(base, 'p'));
    seedPrebuiltTestlib(join(base, 'missing'), join(base, 'p'));
    seedPrebuiltTestlib(join(base, 'empty'), join(base, 'p'));
    expect(existsSync(join(base, 'p', '.polyman'))).toBe(false);
  });
});

describe('the warm-up keeps its testlib object for the uploads', () => {
  const settingsFor = (config: object): Settings => {
    mkdirSync(join(base, 'samples', 'even-sum'), { recursive: true });
    writeFileSync(join(base, 'samples', 'even-sum', 'Config.json'), JSON.stringify(config));
    writeFileSync(join(base, 'cli.js'), FAKE_CLI);
    writeFileSync(join(base, 'testlib.h'), '// testlib');
    return { port: 0, polymanCli: join(base, 'cli.js'), testlib: join(base, 'testlib.h'), samplesDir: join(base, 'samples'), publicDir: base, problemTimeoutMs: 5000 };
  };

  it('keeps the object when the sample passes, and an upload then finds it before polyman runs', async () => {
    const settings = settingsFor({ buildTestlib: true });
    mkdirSync(join(base, 'stash'));
    const warm = await warmUp(settings, 'even-sum', join(base, 'stash'));
    expect(warm).toMatchObject({ ok: true, keptTestlib: 1 });
    expect(readFileSync(join(base, 'stash', KEY, 'testlib.o'), 'utf8')).toBe('object');

    const app = buildApp({ ...settings, prebuiltTestlib: join(base, 'stash') });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/samples/even-sum/verify' });
      const problem = res.body.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'problem');
      expect(JSON.parse(problem.report.solutions[0].reason).found).toEqual([KEY]);
    } finally {
      await app.close();
    }
  });

  it('keeps nothing when the sample fails', async () => {
    const settings = settingsFor({ buildTestlib: true, broken: true });
    mkdirSync(join(base, 'stash'));
    expect(await warmUp(settings, 'even-sum', join(base, 'stash'))).toMatchObject({ ok: false, keptTestlib: 0 });
    expect(readdirSync(join(base, 'stash'))).toEqual([]);
  });

  it('still resolves when the stash cannot be written', async () => {
    const settings = settingsFor({ buildTestlib: true });
    writeFileSync(join(base, 'stash-is-a-file'), 'not a directory');
    const warm = await warmUp(settings, 'even-sum', join(base, 'stash-is-a-file', 'stash'));
    expect(warm).toMatchObject({ ok: true, keptTestlib: 0 });
    expect(warm.error).toMatch(/could not keep the testlib object/);
  });

  it('runs an upload as before when nothing was kept', async () => {
    const settings = settingsFor({});
    const app = buildApp({ ...settings, prebuiltTestlib: join(base, 'stash-never-made') });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/samples/even-sum/verify' });
      const problem = res.body.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'problem');
      expect(JSON.parse(problem.report.solutions[0].reason).found).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('the precompiled bits/stdc++.h', () => {
  const configIn = (name: string, config: unknown) => {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, 'Config.json'), typeof config === 'string' ? config : JSON.stringify(config));
    return join(base, name);
  };

  it("is only for a problem on polyman's default flags", () => {
    expect(usesDefaultCpp(configIn('plain', { solutions: [] }))).toBe(true);
    expect(usesDefaultCpp(configIn('standard', { cppStandard: 'c++20' }))).toBe(false);
    expect(usesDefaultCpp(configIn('flags', { compiler: { flags: ['-O0'] } }))).toBe(false);
    expect(usesDefaultCpp(configIn('compiler', { compiler: { cpp: 'g++-13' } }))).toBe(false);
    expect(usesDefaultCpp(configIn('broken', '{ not json'))).toBe(false);
    expect(usesDefaultCpp(configIn('list', []))).toBe(false);
    expect(usesDefaultCpp(join(base, 'no-such-problem'))).toBe(false);
  });

  it('reaches polyman as CPLUS_INCLUDE_PATH for a default problem, and not for one with its own flags', async () => {
    writeFileSync(join(base, 'cli.js'), FAKE_CLI);
    writeFileSync(join(base, 'testlib.h'), '// testlib');
    configIn('samples/plain', {});
    configIn('samples/own-flags', { compiler: { flags: ['-O0'] } });
    const app = buildApp({ polymanCli: join(base, 'cli.js'), testlib: join(base, 'testlib.h'), samplesDir: join(base, 'samples'), publicDir: base, pchDir: '/opt/pch' });
    const pchOf = async (sample: string) => {
      const res = await app.inject({ method: 'POST', url: `/api/samples/${sample}/verify` });
      const problem = res.body.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'problem');
      return JSON.parse(problem.report.solutions[0].reason).pch;
    };
    try {
      expect(await pchOf('plain')).toBe('/opt/pch');
      expect(await pchOf('own-flags')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('refuses to start when PCH_DIR has no bits/stdc++.h.gch, and takes one that has it', () => {
    writeFileSync(join(base, 'cli.js'), '');
    writeFileSync(join(base, 'testlib.h'), '');
    const env = { POLYMAN_CLI: join(base, 'cli.js'), TESTLIB_H: join(base, 'testlib.h'), ALLOW_RUN_AS_SELF: '1' };
    const defaults = { polymanCli: join(base, 'cli.js'), samplesDir: base, publicDir: base };
    expect(() => settingsFrom({ ...env, PCH_DIR: join(base, 'pch') }, defaults, 1000)).toThrow(/stdc\+\+\.h\.gch not found/);
    mkdirSync(join(base, 'pch', 'bits'), { recursive: true });
    writeFileSync(join(base, 'pch', 'bits', 'stdc++.h.gch'), '');
    expect(settingsFrom({ ...env, PCH_DIR: join(base, 'pch') }, defaults, 1000).pchDir).toBe(join(base, 'pch'));
    expect(settingsFrom(env, defaults, 1000).pchDir).toBeUndefined();
  });

  it("is built in the image with exactly polyman's default flags", () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    const built = /g\+\+ (.+?) -x c\+\+-header/.exec(dockerfile)?.[1].split(' ');
    const utils = readFileSync(new URL('../../src/helpers/utils.ts', import.meta.url), 'utf8');
    const optimization = /DEFAULT_OPTIMIZATION_FLAG = '([^']+)'/.exec(utils)?.[1];
    const standard = /DEFAULT_CPP_STANDARD = '([^']+)'/.exec(utils)?.[1];
    expect(optimization && standard).toBeTruthy();
    expect(built).toEqual([optimization, `-std=${standard}`]);
    expect(dockerfile).toContain('PCH_DIR=/opt/pch');
    // the CLI's own per-user PCH never builds in the service
    expect(dockerfile).toMatch(/ENV[^\n]*(\\\n[^\n]*)*POLYMAN_PCH=0/);
  });
});
