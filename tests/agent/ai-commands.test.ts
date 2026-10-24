import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  aiListAction,
  aiLoginAction,
  aiLogoutAction,
  aiModelsAction,
  aiUseAction,
  type AiIo,
} from '../../src/agent/ai-commands';
import { KeyStore } from '../../src/agent/providers/key-store';
import { PolymanError } from '../../src/errors';

const KEY = 'sk-deepseek-1234567890abcd';
const ENV_KEY = 'sk-openai-env-0987654321';

let home: string;
let output: string[];

const makeStore = (env: NodeJS.ProcessEnv = {}) => new KeyStore({ home, env });
const printed = () => output.join('\n');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'polyman-ai-cmd-'));
  output = [];
  const capture = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const caught = async (run: Promise<void>): Promise<PolymanError> => {
  try {
    await run;
  } catch (error) {
    return error as PolymanError;
  }
  throw new Error('expected the command to fail');
};

describe('ai login', () => {
  it('saves a key from the hidden prompt and only prints it masked', async () => {
    const store = makeStore();
    const promptHidden = vi.fn(() => Promise.resolve(`${KEY}\n`));
    await aiLoginAction('deepseek', {}, { store, promptHidden });
    expect(promptHidden).toHaveBeenCalledWith('DeepSeek API key (hidden): ');
    expect(store.getKey('deepseek')).toEqual({ key: KEY, source: 'file' });
    expect(printed()).toContain('sk-...abcd');
    expect(printed()).not.toContain(KEY);
  });

  it('reads the key from stdin with --key-stdin', async () => {
    const store = makeStore();
    const readStdin = vi.fn(() => Promise.resolve(`  ${KEY}\n`));
    const promptHidden = vi.fn();
    await aiLoginAction(
      'deepseek',
      { keyStdin: true },
      { store, readStdin, promptHidden }
    );
    expect(readStdin).toHaveBeenCalledOnce();
    expect(promptHidden).not.toHaveBeenCalled();
    expect(store.getKey('deepseek')?.key).toBe(KEY);
  });

  it('says when the env var wins over the saved key', async () => {
    const store = makeStore({ OPENAI_API_KEY: ENV_KEY });
    await aiLoginAction(
      'openai',
      { keyStdin: true },
      { store, readStdin: () => Promise.resolve(KEY) }
    );
    expect(printed()).toMatch(/OPENAI_API_KEY is set/);
    expect(printed()).not.toContain(ENV_KEY);
  });

  it('refuses an unknown provider with exit code 2', async () => {
    const err = await caught(aiLoginAction('nope', {}, { store: makeStore() }));
    expect(err.exitCode).toBe(2);
    expect(err.hint).toContain('deepseek');
  });

  it('refuses ollama, which needs no key', async () => {
    const err = await caught(
      aiLoginAction('ollama', {}, { store: makeStore() })
    );
    expect(err.message).toMatch(/does not need a key/);
  });

  it('refuses a bad key and saves nothing', async () => {
    const store = makeStore();
    const err = await caught(
      aiLoginAction(
        'deepseek',
        {},
        { store, promptHidden: () => Promise.resolve('short') }
      )
    );
    expect(err.message).toBe('The key is too short.');
    expect(existsSync(store.path)).toBe(false);
  });

  it('refuses --base-url for a built-in provider', async () => {
    const err = await caught(
      aiLoginAction(
        'openai',
        { baseUrl: 'https://evil.io/v1' },
        { store: makeStore(), promptHidden: () => Promise.resolve(KEY) }
      )
    );
    expect(err.message).toMatch(/only for the custom provider/);
  });

  it('saves custom with its base URL and models', async () => {
    const store = makeStore();
    await aiLoginAction(
      'custom',
      { baseUrl: 'https://my.server/v1/', model: ['m1', ' ', 'm2'] },
      { store, promptHidden: () => Promise.resolve(KEY) }
    );
    expect(store.read().providers['custom']).toEqual({
      apiKey: KEY,
      baseUrl: 'https://my.server/v1',
      models: ['m1', 'm2'],
    });
    expect(store.keyForRequest('custom', 'https://my.server/v1/x')).toBe(KEY);
  });

  it('needs --base-url for custom, and refuses plain http to a remote host', async () => {
    const io: AiIo = {
      store: makeStore(),
      promptHidden: () => Promise.resolve(KEY),
    };
    expect((await caught(aiLoginAction('custom', {}, io))).message).toMatch(
      /needs --base-url/
    );
    expect(
      (
        await caught(
          aiLoginAction('custom', { baseUrl: 'http://10.0.0.5/v1' }, io)
        )
      ).message
    ).toMatch(/localhost/);
  });

  it('removes the new key from the message of a failure', async () => {
    const store = makeStore();
    vi.spyOn(store, 'setKey').mockImplementation(() => {
      throw new Error(`write failed for ${KEY}`);
    });
    const err = await caught(
      aiLoginAction(
        'deepseek',
        {},
        { store, promptHidden: () => Promise.resolve(KEY) }
      )
    );
    expect(err.message).toBe('write failed for [redacted]');
  });

  it('removes known keys from the message and hint of a PolymanError', async () => {
    const store = makeStore({ OPENAI_API_KEY: ENV_KEY });
    vi.spyOn(store, 'read').mockImplementation(() => {
      throw new PolymanError(`bad ${ENV_KEY}`, 2, `hint ${ENV_KEY}`);
    });
    const err = await caught(aiListAction({ store }));
    expect(err).toBeInstanceOf(PolymanError);
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('bad [redacted]');
    expect(err.hint).toBe('hint [redacted]');
  });

  it('fails cleanly when the write fails', async () => {
    const store = makeStore();
    // A folder where ai.json should be makes the rename fail.
    mkdirSync(store.path, { recursive: true });
    const err = await caught(
      aiLoginAction(
        'deepseek',
        {},
        { store, promptHidden: () => Promise.resolve(KEY) }
      )
    );
    expect(err.message).not.toContain(KEY);
    expect(printed()).not.toContain(KEY);
  });
});

describe('ai logout', () => {
  it('removes a saved key', async () => {
    const store = makeStore();
    store.setKey('deepseek', KEY);
    await aiLogoutAction('deepseek', { store });
    expect(store.getKey('deepseek')).toBeUndefined();
    expect(printed()).toMatch(/Removed the DeepSeek key/);
  });

  it('says when there was no key', async () => {
    await aiLogoutAction('deepseek', { store: makeStore() });
    expect(printed()).toMatch(/No saved DeepSeek key/);
  });

  it('says when the env var is still set', async () => {
    await aiLogoutAction('openai', {
      store: makeStore({ OPENAI_API_KEY: ENV_KEY }),
    });
    expect(printed()).toMatch(/OPENAI_API_KEY is still set/);
    expect(printed()).not.toContain(ENV_KEY);
  });
});

describe('ai list', () => {
  it('shows every provider, masked keys and the default', async () => {
    const store = makeStore({ OPENAI_API_KEY: ENV_KEY });
    store.setKey('deepseek', KEY);
    store.setKey('custom', 'sk-custom-key-000111', {
      baseUrl: 'https://my.server/v1',
    });
    store.setDefault('deepseek', 'deepseek-flash');
    await aiListAction({ store });
    const text = printed();
    expect(text).toContain('Default model: deepseek/deepseek-flash');
    expect(text).toMatch(/openai\s+key from OPENAI_API_KEY sk-\.\.\.4321/);
    expect(text).toMatch(/deepseek\s+key saved sk-\.\.\.abcd/);
    expect(text).toMatch(/groq\s+no key/);
    expect(text).toMatch(/ollama\s+no key needed/);
    expect(text).toMatch(/custom\s+key saved .*, https:\/\/my.server\/v1/);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(ENV_KEY);
    expect(text).not.toContain('sk-custom-key-000111');
  });

  it('says when no default is set', async () => {
    await aiListAction({ store: makeStore() });
    expect(printed()).toMatch(/Default model: not set/);
  });

  it('fails with exit code 2 on a broken ai.json, without its content', async () => {
    const store = makeStore();
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(store.path, `{"providers":{"x":{"apiKey":"${KEY}"`);
    const err = await caught(aiListAction({ store }));
    expect(err.exitCode).toBe(2);
    expect(`${err.message} ${err.hint ?? ''}`).not.toContain(KEY);
  });
});

describe('ai models', () => {
  it('lists the known models of one provider, with prices', async () => {
    await aiModelsAction('groq', { store: makeStore() });
    const text = printed();
    expect(text).toContain('Groq (groq)');
    expect(text).toMatch(
      /openai\/gpt-oss-120b .*context 131,072 .*\$0\.15 in \/ \$0\.60 out/
    );
    expect(text).not.toContain('DeepSeek');
  });

  it('lists every provider when none is given', async () => {
    await aiModelsAction(undefined, { store: makeStore() });
    expect(printed()).toContain('OpenAI (openai)');
    expect(printed()).toContain('Ollama (local) (ollama)');
  });

  it('lists the models saved for custom', async () => {
    const store = makeStore();
    store.setKey('custom', KEY, {
      baseUrl: 'https://my.server/v1',
      models: ['my-model'],
    });
    await aiModelsAction('custom', { store });
    expect(printed()).toMatch(/my-model\s+tools/);
  });

  it('refuses an unknown provider', async () => {
    const err = await caught(aiModelsAction('nope', { store: makeStore() }));
    expect(err.exitCode).toBe(2);
  });
});

describe('ai use', () => {
  it('sets the default', async () => {
    const store = makeStore();
    store.setKey('deepseek', KEY);
    await aiUseAction('deepseek/deepseek-flash', { store });
    expect(store.read().default).toEqual({
      provider: 'deepseek',
      model: 'deepseek-flash',
    });
    expect(printed()).not.toMatch(/⚠|not in the known models|No DeepSeek key/);
  });

  it('keeps a / inside the model id', async () => {
    const store = makeStore();
    await aiUseAction('groq/openai/gpt-oss-120b', { store });
    expect(store.read().default).toEqual({
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
    });
  });

  it('warns about an unknown model and a missing key', async () => {
    await aiUseAction('groq/my-model', { store: makeStore() });
    expect(printed()).toMatch(/not in the known models of Groq/);
    expect(printed()).toMatch(/No Groq key yet/);
  });

  it('warns when the model can only chat', async () => {
    const store = makeStore();
    store.update(s => {
      s.overrides['ollama/tiny'] = { tools: false };
    });
    await aiUseAction('ollama/tiny', { store });
    expect(printed()).toMatch(/can only chat, it cannot build the problem/);
  });

  it.each(['deepseek', 'deepseek/', '/model', ''])(
    'refuses %j with exit code 2',
    async spec => {
      const err = await caught(aiUseAction(spec, { store: makeStore() }));
      expect(err.exitCode).toBe(2);
      expect(err.hint).toMatch(/polyman ai use/);
    }
  );

  it('refuses an unknown provider', async () => {
    const err = await caught(aiUseAction('nope/model', { store: makeStore() }));
    expect(err.message).toMatch(/Unknown provider/);
  });
});
