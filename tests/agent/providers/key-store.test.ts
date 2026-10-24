import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  KeyStore,
  baseUrlProblem,
  emptySettings,
  keyProblem,
  maskKey,
  redact,
} from '../../../src/agent/providers/key-store';
import { PolymanError } from '../../../src/errors';

const KEY = 'sk-file-key-1234567890';
const ENV_KEY = 'sk-env-key-0987654321';
const posixOnly = process.platform === 'win32' ? it.skip : it;

let home: string;
let store: KeyStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'polyman-ai-'));
  store = new KeyStore({ home, env: {} });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe('KeyStore paths', () => {
  it('lives in <home>/.polyman/ai.json, not in the real home', () => {
    expect(store.path).toBe(join(home, '.polyman', 'ai.json'));
    expect(store.path.startsWith(join(homedir(), '.polyman'))).toBe(false);
  });
});

describe('KeyStore.read', () => {
  it('gives empty settings when the file is missing', () => {
    expect(store.read()).toEqual(emptySettings());
    expect(existsSync(store.dir)).toBe(false);
  });

  it('reads the design example', () => {
    mkdirSync(store.dir);
    writeFileSync(
      store.path,
      JSON.stringify({
        version: 1,
        default: { provider: 'deepseek', model: 'deepseek-flash' },
        providers: {
          deepseek: { apiKey: KEY },
          custom: {
            baseUrl: 'https://my-server/v1',
            apiKey: 'sk-custom-123456',
            models: ['my-model'],
          },
        },
        overrides: { 'deepseek/deepseek-flash': { contextWindow: 64000 } },
        acceptedPrivacyNotice: ['deepseek'],
      })
    );
    const settings = store.read();
    expect(settings.default).toEqual({
      provider: 'deepseek',
      model: 'deepseek-flash',
    });
    expect(settings.providers['custom']?.models).toEqual(['my-model']);
    expect(settings.overrides['deepseek/deepseek-flash']).toEqual({
      contextWindow: 64000,
    });
    expect(settings.acceptedPrivacyNotice).toEqual(['deepseek']);
  });

  it('keeps fields it does not know on every write', () => {
    mkdirSync(store.dir);
    writeFileSync(
      store.path,
      `{"version": 1, "note": "mine", "extra": {"a": [1, 2]},
        "providers": {"openai": {"apiKey": "${KEY}", "organization": "org-1"}}}`
    );
    const read = () =>
      JSON.parse(readFileSync(store.path, 'utf-8')) as {
        note?: string;
        extra?: unknown;
        providers: Record<string, unknown>;
      };

    store.setDefault('deepseek', 'deepseek-flash');
    expect(read().note).toBe('mine');
    expect(read().extra).toEqual({ a: [1, 2] });
    expect(read().providers['openai'].organization).toBe('org-1');

    store.setKey('openai', 'sk-new-key-1234567890');
    expect(read().note).toBe('mine');
    expect(read().providers['openai']).toEqual({
      apiKey: 'sk-new-key-1234567890',
      organization: 'org-1',
    });

    expect(store.removeKey('openai')).toBe(true);
    expect(read().note).toBe('mine');
    expect(read().extra).toEqual({ a: [1, 2] });
    expect(read().providers['openai']).toEqual({ organization: 'org-1' });
  });

  it('does not copy __proto__, constructor or prototype', () => {
    mkdirSync(store.dir);
    writeFileSync(
      store.path,
      `{"version": 1, "__proto__": {"polluted": true}, "constructor": 1,
        "providers": {"openai": {"__proto__": {"polluted": true},
        "prototype": 2, "keep": 3}}}`
    );
    const settings = store.read();
    expect(Object.keys(settings)).not.toContain('__proto__');
    expect(Object.keys(settings)).not.toContain('constructor');
    expect(Object.keys(settings.providers['openai'] ?? {})).toEqual(['keep']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    store.setDefault('deepseek', 'deepseek-flash');
    const text = readFileSync(store.path, 'utf-8');
    expect(text).not.toContain('__proto__');
    expect(text).not.toContain('polluted');
    expect(text).not.toContain('prototype');
    expect(text).not.toContain('constructor');
    expect(text).toContain('"keep": 3');
  });

  it('throws on broken JSON without the file content in the message', () => {
    mkdirSync(store.dir);
    writeFileSync(store.path, `{"providers": {"x": {"apiKey": "${KEY}"`);
    let caught: unknown;
    try {
      store.read();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolymanError);
    const err = caught as PolymanError;
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain('is not valid JSON');
    expect(`${err.message} ${err.hint ?? ''}`).not.toContain(KEY);
  });

  it('says it cannot read the file when ai.json is a folder', () => {
    mkdirSync(store.path, { recursive: true });
    writeFileSync(join(store.path, 'secret.txt'), KEY);
    let caught: unknown;
    try {
      store.read();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolymanError);
    const err = caught as PolymanError;
    expect(err.exitCode).toBe(2);
    expect(err.message).not.toContain('valid JSON');
    expect(err.message).toContain(store.path);
    expect(err.message).toContain('EISDIR');
    expect(`${err.message} ${err.hint ?? ''}`).not.toContain(KEY);
    expect(err.hint ?? '').not.toMatch(/delete/i);
  });

  it.each([
    ['an array', '[]', /JSON object/],
    ['another version', '{"version": 2}', /unknown version/],
    ['no version', '{}', /unknown version/],
  ])('refuses %s', (_why, content, message) => {
    mkdirSync(store.dir);
    writeFileSync(store.path, content);
    expect(() => store.read()).toThrow(message);
  });

  it('drops fields with the wrong type', () => {
    mkdirSync(store.dir);
    writeFileSync(
      store.path,
      JSON.stringify({
        version: 1,
        default: { provider: 1 },
        providers: { a: 'x', b: { apiKey: 5, models: ['m', 3] } },
        overrides: { o: 1 },
        acceptedPrivacyNotice: 'all',
      })
    );
    expect(store.read()).toEqual({
      version: 1,
      providers: { b: { models: ['m'] } },
      overrides: {},
      acceptedPrivacyNotice: [],
    });
  });

  it('ignores __proto__ keys', () => {
    mkdirSync(store.dir);
    writeFileSync(
      store.path,
      '{"version":1,"providers":{"__proto__":{"apiKey":"sk-polluted-123"}},' +
        '"overrides":{"__proto__":{"tools":false}}}'
    );
    const settings = store.read();
    expect(Object.keys(settings.providers)).toEqual([]);
    expect(Object.getPrototypeOf(settings.providers)).toBe(Object.prototype);
    expect(Object.keys(settings.overrides)).toEqual([]);
  });
});

describe('KeyStore.write', () => {
  posixOnly('creates the folder with mode 0700 and the file with 0600', () => {
    store.setKey('deepseek', KEY);
    expect(mode(store.dir)).toBe(0o700);
    expect(mode(store.path)).toBe(0o600);
  });

  posixOnly('sets the file mode back to 0600 on every write', () => {
    store.setKey('deepseek', KEY);
    chmodSync(store.path, 0o644);
    store.setDefault('deepseek', 'deepseek-flash');
    expect(mode(store.path)).toBe(0o600);
  });

  it('leaves no temp files behind', () => {
    store.setKey('deepseek', KEY);
    store.setDefault('deepseek', 'deepseek-flash');
    expect(readdirSync(store.dir)).toEqual(['ai.json']);
  });

  it('writes the version 1 format', () => {
    store.setKey('deepseek', KEY);
    store.setDefault('deepseek', 'deepseek-flash');
    const json = JSON.parse(readFileSync(store.path, 'utf-8')) as unknown;
    expect(json).toEqual({
      version: 1,
      default: { provider: 'deepseek', model: 'deepseek-flash' },
      providers: { deepseek: { apiKey: KEY } },
      overrides: {},
      acceptedPrivacyNotice: [],
    });
  });
});

describe('KeyStore.openFolderMode', () => {
  const makeDir = (dirMode: number) => {
    mkdirSync(store.dir, { mode: dirMode });
    chmodSync(store.dir, dirMode);
  };

  it('is undefined when the folder is missing', () => {
    expect(store.openFolderMode()).toBeUndefined();
  });

  posixOnly('is undefined for a private folder (0700)', () => {
    makeDir(0o700);
    expect(store.openFolderMode()).toBeUndefined();
  });

  posixOnly('gives the mode when group or others have any bit', () => {
    makeDir(0o755);
    expect(store.openFolderMode()).toBe(0o755);
    chmodSync(store.dir, 0o710);
    expect(store.openFolderMode()).toBe(0o710);
    chmodSync(store.dir, 0o701);
    expect(store.openFolderMode()).toBe(0o701);
  });

  posixOnly('never changes the mode, and a write keeps it', () => {
    makeDir(0o755);
    store.setKey('deepseek', KEY);
    expect(mode(store.dir)).toBe(0o755);
    expect(mode(store.path)).toBe(0o600);
  });

  posixOnly('is undefined for the folder the store created', () => {
    store.setKey('deepseek', KEY);
    expect(store.openFolderMode()).toBeUndefined();
  });

  posixOnly('is undefined on Windows, where modes mean nothing', () => {
    makeDir(0o755);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(store.openFolderMode()).toBeUndefined();
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('KeyStore keys', () => {
  it('saves and reads a key from the file', () => {
    store.setKey('deepseek', KEY);
    expect(store.getKey('deepseek')).toEqual({ key: KEY, source: 'file' });
  });

  it('lets the env var override the file', () => {
    store.setKey('openai', KEY);
    const withEnv = new KeyStore({ home, env: { OPENAI_API_KEY: ENV_KEY } });
    expect(withEnv.getKey('openai')).toEqual({
      key: ENV_KEY,
      source: 'env',
      envVar: 'OPENAI_API_KEY',
    });
  });

  it('ignores an empty env var', () => {
    store.setKey('openai', KEY);
    const withEnv = new KeyStore({ home, env: { OPENAI_API_KEY: '  ' } });
    expect(withEnv.getKey('openai')?.source).toBe('file');
  });

  it('only reads the env var of the provider itself', () => {
    const withEnv = new KeyStore({ home, env: { OPENAI_API_KEY: ENV_KEY } });
    expect(withEnv.getKey('deepseek')).toBeUndefined();
  });

  it('refuses a bad key', () => {
    expect(() => store.setKey('openai', 'sk bad key')).toThrow(/spaces/);
    expect(existsSync(store.path)).toBe(false);
  });

  it('removes a key and keeps the other settings', () => {
    store.setKey('custom', KEY, { baseUrl: 'https://my.server/v1' });
    expect(store.removeKey('custom')).toBe(true);
    expect(store.read().providers['custom']).toEqual({
      baseUrl: 'https://my.server/v1',
    });
    expect(store.removeKey('custom')).toBe(false);
  });

  it('drops the provider entry when nothing is left', () => {
    store.setKey('deepseek', KEY);
    store.removeKey('deepseek');
    expect(store.read().providers).toEqual({});
  });

  it('keeps the default when a key changes', () => {
    store.setDefault('groq', 'openai/gpt-oss-120b');
    store.setKey('groq', KEY);
    expect(store.read().default).toEqual({
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
    });
  });

  it('knows every key, from the file and from env vars', () => {
    store.setKey('deepseek', KEY);
    const withEnv = new KeyStore({ home, env: { GROQ_API_KEY: ENV_KEY } });
    expect(withEnv.knownKeys().sort()).toEqual([ENV_KEY, KEY].sort());
  });

  it('still knows the env var keys when the file is broken', () => {
    mkdirSync(store.dir);
    writeFileSync(store.path, '{broken');
    const withEnv = new KeyStore({ home, env: { GROQ_API_KEY: ENV_KEY } });
    expect(withEnv.knownKeys()).toEqual([ENV_KEY]);
  });
});

describe('KeyStore.keyForRequest', () => {
  it('hands out the key for its own base URL', () => {
    store.setKey('deepseek', KEY);
    expect(
      store.keyForRequest(
        'deepseek',
        'https://api.deepseek.com/chat/completions'
      )
    ).toBe(KEY);
  });

  it('refuses another base URL, without the key in the message', () => {
    store.setKey('deepseek', KEY);
    expect(() =>
      store.keyForRequest('deepseek', 'https://api.openai.com/v1/chat')
    ).toThrow(/Refusing to send the deepseek key to https:\/\/api.openai.com/);
    try {
      store.keyForRequest('deepseek', 'https://evil.io/?k=1');
    } catch (error) {
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it('uses the saved base URL for custom', () => {
    store.setKey('custom', KEY, { baseUrl: 'https://my.server/v1' });
    expect(store.keyForRequest('custom', 'https://my.server/v1/models')).toBe(
      KEY
    );
    expect(() =>
      store.keyForRequest('custom', 'https://other.server/v1/models')
    ).toThrow(/Refusing/);
  });

  it('refuses custom with no base URL, and unknown providers', () => {
    expect(() => store.keyForRequest('custom', 'https://x.io/v1')).toThrow(
      /Refusing/
    );
    expect(() => store.keyForRequest('nope', 'https://x.io/v1')).toThrow(
      /Refusing/
    );
  });

  it('returns undefined when the provider has no key', () => {
    expect(
      store.keyForRequest('ollama', 'http://localhost:11434/v1/models')
    ).toBeUndefined();
  });
});

describe('redact', () => {
  it('removes every known key', () => {
    const text = `401 for ${KEY}, header Bearer ${ENV_KEY}, again ${KEY}`;
    expect(redact(text, [KEY, ENV_KEY])).toBe(
      '401 for [redacted], header Bearer [redacted], again [redacted]'
    );
  });

  it('removes the longer key first when one holds another', () => {
    expect(
      redact('x sk-abcdefgh-long y', ['sk-abcdefgh', 'sk-abcdefgh-long'])
    ).toBe('x [redacted] y');
  });

  it('skips keys too short to be real, so normal words stay', () => {
    expect(redact('the key is too short', ['short', ''])).toBe(
      'the key is too short'
    );
  });

  it('leaves text without keys alone', () => {
    expect(redact('all fine', [KEY])).toBe('all fine');
  });
});

describe('maskKey', () => {
  it('shows only the start and the end', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('sk-...cdef');
  });

  it('hides short keys fully', () => {
    expect(maskKey('sk-12345')).toBe('****');
  });

  it('never shows the full key', () => {
    expect(maskKey(KEY)).not.toContain(KEY.slice(3, -4));
  });
});

describe('keyProblem', () => {
  it.each([
    ['', /empty/],
    ['sk-a b-cdefgh', /spaces/],
    ['sk-abc\ndefgh', /spaces/],
    ['sk-abc\u0000defgh', /control/],
    ['sk-1', /too short/],
    ['x'.repeat(5000), /too long/],
  ])('refuses %j', (key, problem) => {
    expect(keyProblem(key)).toMatch(problem);
  });

  it('accepts a normal key', () => {
    expect(keyProblem(KEY)).toBeUndefined();
  });
});

describe('baseUrlProblem', () => {
  it.each([
    'https://my.server/v1',
    'http://localhost:8000/v1',
    'http://127.0.0.1:1234/v1',
    'http://[::1]:8080/v1',
  ])('accepts %s', url => {
    expect(baseUrlProblem(url)).toBeUndefined();
  });

  it.each([
    ['not a url', /not a valid URL/],
    ['ftp://my.server/v1', /https/],
    ['http://10.0.0.1/v1', /only allowed for localhost/],
    ['https://user:pw@my.server/v1', /user name/],
    ['https://my.server/v1?key=1', /query/],
  ])('refuses %s', (url, problem) => {
    expect(baseUrlProblem(url)).toMatch(problem);
  });
});
