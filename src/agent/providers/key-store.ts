/**
 * Provider keys and AI settings in `~/.polyman/ai.json`.
 *
 * - The file is written with mode `0600`, and the folder is created with
 *   mode `0700`.
 * - The env var of a preset wins over the key in the file.
 * - A key is only handed out for a URL under the base URL of its own preset
 *   (or the base URL the user gave for `custom`).
 * - {@link redact} removes known keys from any text before it is shown or
 *   saved.
 *
 * This module never prints. Its errors never hold a key or file content.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ModelCapabilities } from './capabilities';
import { PRESETS, getPreset, urlBelongsTo } from './presets';
import { PolymanError } from '../../errors';

/** Settings of one provider in `ai.json`. */
export interface ProviderSettings {
  /** The API key. */
  apiKey?: string;
  /** Base URL, only for `custom`. */
  baseUrl?: string;
  /** Model ids, only for `custom`. */
  models?: string[];
}

/** The content of `ai.json`. */
export interface AiSettings {
  /** File format version. */
  version: 1;
  /** The provider and model used when none is given. */
  default?: { provider: string; model: string };
  /** Keys and settings per provider id. */
  providers: Record<string, ProviderSettings>;
  /** Capability overrides, keyed by `provider/model`. */
  overrides: Record<string, Partial<ModelCapabilities>>;
  /** Providers whose privacy notice the user accepted. */
  acceptedPrivacyNotice: string[];
}

/** A key and where it came from. */
export interface KeyLookup {
  /** The key itself. Never print it, use {@link maskKey}. */
  key: string;
  /** `env` when it came from the env var, `file` when from `ai.json`. */
  source: 'env' | 'file';
  /** The env var name, when `source` is `env`. */
  envVar?: string;
}

/** Where the store lives and which env vars it reads. */
export interface KeyStoreOptions {
  /** Home folder. Defaults to `HOME`, then `USERPROFILE`, then the OS one. */
  home?: string;
  /** Env vars to read keys from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Shortest key we accept. Real keys are much longer. */
export const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 4096;

/** Folder and file modes. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

const FIX_HINT =
  'Fix the file by hand, or delete it and run polyman ai login again.';

/** Returns an empty settings object. */
export function emptySettings(): AiSettings {
  return {
    version: 1,
    providers: {},
    overrides: {},
    acceptedPrivacyNotice: [],
  };
}

/**
 * Checks a key before it is saved: no spaces or control characters (they
 * would break the HTTP header), and a sane length. Returns the problem, or
 * `undefined` when the key looks fine. The message never holds the key.
 */
export function keyProblem(key: string): string | undefined {
  if (key.length === 0) return 'The key is empty.';
  if (/[\s\p{Cc}]/u.test(key)) {
    return 'The key has spaces or control characters.';
  }
  if (key.length < MIN_KEY_LENGTH) return 'The key is too short.';
  if (key.length > MAX_KEY_LENGTH) return 'The key is too long.';
  return undefined;
}

/**
 * Checks a base URL the user gives for `custom`. It must be http(s), and
 * plain http is only allowed for a server on this machine, so a key is never
 * sent in clear text over the network.
 */
export function baseUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'The base URL is not a valid URL.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'The base URL must start with https://.';
  }
  if (url.username !== '' || url.password !== '') {
    return 'The base URL must not hold a user name or password.';
  }
  if (url.search !== '' || url.hash !== '') {
    return 'The base URL must not have a query or a #fragment.';
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !local) {
    return 'Plain http is only allowed for localhost. Use https://.';
  }
  return undefined;
}

/**
 * Shows only the start and the end of a key, like `sk-...abcd`. Short keys
 * are fully hidden.
 */
export function maskKey(key: string): string {
  if (key.length < 12) return '****';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

/**
 * Replaces every known key in `text` with `[redacted]`. Use it on every log
 * line, error message and saved session.
 */
export function redact(text: string, keys: Iterable<string>): string {
  const sorted = [...new Set(keys)]
    .filter(key => key.length >= MIN_KEY_LENGTH)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const key of sorted) out = out.split(key).join('[redacted]');
  return out;
}

/** Reads and writes `~/.polyman/ai.json`. */
export class KeyStore {
  /** The `.polyman` folder. */
  readonly dir: string;
  /** The `ai.json` file. */
  readonly path: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: KeyStoreOptions = {}) {
    const home =
      opts.home ??
      (process.env['HOME'] || process.env['USERPROFILE'] || homedir());
    this.dir = join(home, '.polyman');
    this.path = join(this.dir, 'ai.json');
    this.env = opts.env ?? process.env;
  }

  /**
   * Reads the settings. A missing file gives empty settings. A broken file
   * throws, without its content in the message.
   */
  read(): AiSettings {
    if (!existsSync(this.path)) return emptySettings();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf-8'));
    } catch {
      // The parser error can quote the file, and the file holds keys.
      throw new PolymanError(`${this.path} is not valid JSON.`, 2, FIX_HINT);
    }
    return parseSettings(raw, this.path);
  }

  /**
   * Writes the settings. It creates the folder with mode `0700` when it is
   * missing, writes a temp file with mode `0600`, then renames it, so a
   * crash never leaves a half-written file.
   */
  write(settings: AiSettings): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
      // mkdir applies the umask, chmod makes the mode exact.
      chmodSync(this.dir, DIR_MODE);
    }
    const tmp = join(this.dir, `.ai.json.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, {
        mode: FILE_MODE,
        flag: 'wx',
      });
      chmodSync(tmp, FILE_MODE);
      renameSync(tmp, this.path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  /** Changes the settings with `change`, then writes them. */
  update(change: (settings: AiSettings) => void): AiSettings {
    const settings = this.read();
    change(settings);
    this.write(settings);
    return settings;
  }

  /** The key of a provider: the env var first, then `ai.json`. */
  getKey(providerId: string): KeyLookup | undefined {
    const envVar = getPreset(providerId)?.envVar ?? '';
    if (envVar !== '') {
      const fromEnv = this.env[envVar]?.trim();
      if (fromEnv) return { key: fromEnv, source: 'env', envVar };
    }
    const fromFile = this.read().providers[providerId]?.apiKey;
    if (fromFile) return { key: fromFile, source: 'file' };
    return undefined;
  }

  /** Saves a key, after {@link keyProblem} accepts it. */
  setKey(providerId: string, key: string, extra: ProviderSettings = {}): void {
    const problem = keyProblem(key);
    if (problem) throw new Error(problem);
    this.update(settings => {
      settings.providers[providerId] = {
        ...settings.providers[providerId],
        ...extra,
        apiKey: key,
      };
    });
  }

  /** Removes a saved key. Returns false when there was none. */
  removeKey(providerId: string): boolean {
    const settings = this.read();
    const entry = settings.providers[providerId];
    if (!entry?.apiKey) return false;
    delete entry.apiKey;
    if (Object.keys(entry).length === 0) {
      delete settings.providers[providerId];
    }
    this.write(settings);
    return true;
  }

  /** Sets the default provider and model. */
  setDefault(provider: string, model: string): void {
    this.update(settings => {
      settings.default = { provider, model };
    });
  }

  /**
   * The base URL keys of this provider may go to: the preset one, or the one
   * saved for `custom`.
   */
  baseUrlFor(providerId: string): string | undefined {
    const preset = getPreset(providerId);
    if (!preset) return undefined;
    if (preset.baseUrl !== '') return preset.baseUrl;
    return this.read().providers[providerId]?.baseUrl;
  }

  /**
   * The key to send with a request to `url`. It throws when `url` is not
   * under the base URL of the provider, so a key never goes to another
   * server. Returns `undefined` when the provider has no key.
   */
  keyForRequest(providerId: string, url: string): string | undefined {
    const base = this.baseUrlFor(providerId);
    if (!base || !urlBelongsTo(base, url)) {
      throw new Error(
        `Refusing to send the ${providerId} key to ${safeOrigin(url)}: ` +
          'it is not the base URL of that provider.'
      );
    }
    return this.getKey(providerId)?.key;
  }

  /**
   * Every key we know, from env vars and the file, for {@link redact}. A
   * broken file still gives the env var keys.
   */
  knownKeys(): string[] {
    const keys: string[] = [];
    for (const preset of PRESETS) {
      if (preset.envVar === '') continue;
      const value = this.env[preset.envVar]?.trim();
      if (value) keys.push(value);
    }
    let providers: AiSettings['providers'] = {};
    try {
      providers = this.read().providers;
    } catch {
      // Errors of read() never hold file content, so nothing is lost.
    }
    for (const entry of Object.values(providers)) {
      if (entry.apiKey) keys.push(entry.apiKey);
    }
    return keys;
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'an invalid URL';
  }
}

/** Keys that would change an object's prototype if we copied them. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSettings(raw: unknown, path: string): AiSettings {
  if (!isRecord(raw))
    throw new PolymanError(`${path} must hold a JSON object.`, 2, FIX_HINT);
  if (raw['version'] !== 1) {
    throw new PolymanError(`${path} has an unknown version.`, 2, FIX_HINT);
  }
  const settings = emptySettings();
  const def = raw['default'];
  if (
    isRecord(def) &&
    typeof def['provider'] === 'string' &&
    typeof def['model'] === 'string'
  ) {
    settings.default = { provider: def['provider'], model: def['model'] };
  }
  const providers = raw['providers'];
  if (isRecord(providers)) {
    for (const [id, value] of Object.entries(providers)) {
      if (UNSAFE_KEYS.has(id) || !isRecord(value)) continue;
      const entry: ProviderSettings = {};
      if (typeof value['apiKey'] === 'string') entry.apiKey = value['apiKey'];
      if (typeof value['baseUrl'] === 'string') {
        entry.baseUrl = value['baseUrl'];
      }
      const models = value['models'];
      if (Array.isArray(models)) {
        entry.models = models.filter((m): m is string => typeof m === 'string');
      }
      settings.providers[id] = entry;
    }
  }
  const overrides = raw['overrides'];
  if (isRecord(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      if (UNSAFE_KEYS.has(key) || !isRecord(value)) continue;
      // capabilities.ts checks each field before it uses it.
      settings.overrides[key] = value as Partial<ModelCapabilities>;
    }
  }
  const accepted = raw['acceptedPrivacyNotice'];
  if (Array.isArray(accepted)) {
    settings.acceptedPrivacyNotice = accepted.filter(
      (id): id is string => typeof id === 'string'
    );
  }
  return settings;
}
