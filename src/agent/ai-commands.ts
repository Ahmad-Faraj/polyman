/**
 * The `polyman ai` commands: save and remove provider keys, list providers
 * and models, and pick the default model.
 *
 * `cli.ts` loads this file with a dynamic `import()` only when an `ai`
 * command runs, so other commands never load the agent code.
 *
 * Keys are never printed: the output only shows {@link maskKey}, and every
 * error goes through {@link redact} before it leaves this file.
 */

import { PolymanError } from '../errors';
import { fmt } from '../formatter';
import { lookupCapabilities } from './providers/capabilities';
import {
  KeyStore,
  baseUrlProblem,
  keyProblem,
  maskKey,
  redact,
  type ProviderSettings,
} from './providers/key-store';
import {
  PRESETS,
  getPreset,
  presetIds,
  type Preset,
  type PresetModel,
} from './providers/presets';
import { readAllStdin, readHiddenLine } from './secret-input';

/** What the commands read and write. Tests pass fakes. */
export interface AiIo {
  /** Where keys live. Defaults to `~/.polyman/ai.json`. */
  store?: KeyStore;
  /** Reads the key for `--key-stdin`. */
  readStdin?: () => Promise<string>;
  /** Asks for the key with a hidden prompt. */
  promptHidden?: (question: string) => Promise<string>;
}

/** Options of `polyman ai login`. */
export interface AiLoginOptions {
  /** Read the key from stdin instead of a hidden prompt. */
  keyStdin?: boolean;
  /** Base URL, only for `custom`. */
  baseUrl?: string;
  /** Model ids, only for `custom`. */
  model?: string[];
}

/** `polyman ai login <provider>`: saves a key. */
export async function aiLoginAction(
  providerId: string,
  options: AiLoginOptions = {},
  io: AiIo = {}
): Promise<void> {
  const store = io.store ?? new KeyStore();
  const seen: string[] = [];
  await withRedaction(store, seen, async () => {
    const preset = requirePreset(providerId);
    if (!preset.keyRequired && preset.id !== 'custom') {
      throw new PolymanError(
        `${preset.label} runs on your machine and does not need a key.`,
        2
      );
    }
    const extra = customSettings(preset, options);

    const key = (
      options.keyStdin
        ? await (io.readStdin ?? (() => readAllStdin()))()
        : await (io.promptHidden ?? (q => readHiddenLine(q)))(
            `${preset.label} API key (hidden): `
          )
    ).trim();
    // keyProblem() messages never hold the key, so redaction starts after.
    const problem = keyProblem(key);
    if (problem) throw new PolymanError(problem, 2);
    seen.push(key);

    store.setKey(preset.id, key, extra);
    fmt.success(
      `${fmt.checkmark()} Saved the ${preset.label} key ${maskKey(key)} in ${store.path}`
    );
    const found = store.getKey(preset.id);
    if (found?.source === 'env') {
      fmt.warning(
        `${fmt.warningIcon()} ${found.envVar} is set, so polyman uses it instead of the saved key.`
      );
    }
  });
}

/** `polyman ai logout <provider>`: removes a saved key. */
export async function aiLogoutAction(
  providerId: string,
  io: AiIo = {}
): Promise<void> {
  const store = io.store ?? new KeyStore();
  await withRedaction(store, [], () => {
    const preset = requirePreset(providerId);
    if (store.removeKey(preset.id)) {
      fmt.success(`${fmt.checkmark()} Removed the ${preset.label} key.`);
    } else {
      fmt.info(`${fmt.infoIcon()} No saved ${preset.label} key.`);
    }
    const found = store.getKey(preset.id);
    if (found?.source === 'env') {
      fmt.warning(
        `${fmt.warningIcon()} ${found.envVar} is still set in your environment.`
      );
    }
    return Promise.resolve();
  });
}

/** `polyman ai list`: providers, their keys (masked) and the default. */
export async function aiListAction(io: AiIo = {}): Promise<void> {
  const store = io.store ?? new KeyStore();
  await withRedaction(store, [], () => {
    const settings = store.read();
    const def = settings.default;
    fmt.info(
      def
        ? `Default model: ${def.provider}/${def.model}`
        : 'Default model: not set (polyman ai use <provider>/<model>)'
    );
    fmt.newLine();
    for (const preset of PRESETS) {
      fmt.info(`  ${preset.id.padEnd(11)} ${keyStatus(store, preset)}`);
    }
    return Promise.resolve();
  });
}

/** `polyman ai models [provider]`: the known models. */
export async function aiModelsAction(
  providerId: string | undefined,
  io: AiIo = {}
): Promise<void> {
  const store = io.store ?? new KeyStore();
  await withRedaction(store, [], () => {
    const presets = providerId ? [requirePreset(providerId)] : PRESETS;
    for (const preset of presets) {
      fmt.info(fmt.bold(`${preset.label} (${preset.id})`));
      const models = knownModels(store, preset);
      if (models.length === 0) {
        fmt.log('  no known models');
      }
      for (const model of models) {
        fmt.info(`  ${describeModel(preset.id, model)}`);
      }
      fmt.newLine();
    }
    return Promise.resolve();
  });
}

/** `polyman ai use <provider>/<model>`: sets the default model. */
export async function aiUseAction(spec: string, io: AiIo = {}): Promise<void> {
  const store = io.store ?? new KeyStore();
  await withRedaction(store, [], () => {
    const slash = spec.indexOf('/');
    const providerId = slash === -1 ? '' : spec.slice(0, slash);
    const modelId = slash === -1 ? '' : spec.slice(slash + 1).trim();
    if (providerId === '' || modelId === '') {
      throw new PolymanError(
        `"${spec}" is not <provider>/<model>.`,
        2,
        'Example: polyman ai use deepseek/deepseek-flash'
      );
    }
    const preset = requirePreset(providerId);
    store.setDefault(preset.id, modelId);
    fmt.success(`${fmt.checkmark()} Default model: ${preset.id}/${modelId}`);

    if (!knownModels(store, preset).some(m => m.id === modelId)) {
      fmt.warning(
        `${fmt.warningIcon()} ${modelId} is not in the known models of ${preset.label}. It is used as is.`
      );
    }
    if (preset.keyRequired && !store.getKey(preset.id)) {
      fmt.warning(
        `${fmt.warningIcon()} No ${preset.label} key yet. Run: polyman ai login ${preset.id}`
      );
    }
    if (preset.id === 'custom' && !store.baseUrlFor('custom')) {
      fmt.warning(
        `${fmt.warningIcon()} No base URL for custom yet. Run: polyman ai login custom --base-url <url>`
      );
    }
    const overrides = store.read().overrides;
    if (!lookupCapabilities(preset.id, modelId, overrides).tools) {
      fmt.warning(
        `${fmt.warningIcon()} This model has no tool support. It can only chat, it cannot build the problem.`
      );
    }
    return Promise.resolve();
  });
}

function requirePreset(providerId: string): Preset {
  const preset = getPreset(providerId);
  if (!preset) {
    throw new PolymanError(
      `Unknown provider "${providerId}".`,
      2,
      `Known providers: ${presetIds().join(', ')}`
    );
  }
  return preset;
}

function customSettings(
  preset: Preset,
  options: AiLoginOptions
): ProviderSettings {
  const models = options.model ?? [];
  if (preset.id !== 'custom') {
    if (options.baseUrl !== undefined || models.length > 0) {
      throw new PolymanError(
        '--base-url and --model are only for the custom provider.',
        2,
        `${preset.label} keys are only sent to ${preset.baseUrl}`
      );
    }
    return {};
  }
  if (options.baseUrl === undefined) {
    throw new PolymanError(
      'The custom provider needs --base-url.',
      2,
      'Example: polyman ai login custom --base-url https://my-server/v1 --model my-model'
    );
  }
  const problem = baseUrlProblem(options.baseUrl);
  if (problem) throw new PolymanError(problem, 2);
  const extra: ProviderSettings = {
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
  };
  const ids = models.map(m => m.trim()).filter(m => m !== '');
  if (ids.length > 0) extra.models = ids;
  return extra;
}

function keyStatus(store: KeyStore, preset: Preset): string {
  const found = store.getKey(preset.id);
  let status: string;
  if (found?.source === 'env') {
    status = `key from ${found.envVar} ${maskKey(found.key)}`;
  } else if (found) {
    status = `key saved ${maskKey(found.key)}`;
  } else if (!preset.keyRequired && preset.id !== 'custom') {
    status = 'no key needed';
  } else {
    status = 'no key';
  }
  if (preset.id === 'custom') {
    const base = store.baseUrlFor('custom');
    status += base ? `, ${base}` : ', no base URL';
  }
  return status;
}

function knownModels(store: KeyStore, preset: Preset): PresetModel[] {
  if (preset.id !== 'custom') return preset.models;
  const ids = store.read().providers['custom']?.models ?? [];
  return ids.map(id => ({ id }));
}

function describeModel(providerId: string, model: PresetModel): string {
  const caps = lookupCapabilities(providerId, model.id);
  const parts = [model.id.padEnd(26)];
  if (model.contextWindow !== undefined) {
    parts.push(`context ${model.contextWindow.toLocaleString('en-US')}`);
  }
  if (model.maxOutput !== undefined) {
    parts.push(`output ${model.maxOutput.toLocaleString('en-US')}`);
  }
  parts.push(caps.tools ? 'tools' : 'chat only');
  if (caps.reasoning) parts.push('reasoning');
  if (
    model.pricePerMTokIn !== undefined &&
    model.pricePerMTokOut !== undefined
  ) {
    parts.push(
      `${usd(model.pricePerMTokIn)} in / ${usd(model.pricePerMTokOut)} out per 1M tokens`
    );
  }
  return parts.join('  ');
}

function usd(value: number): string {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

/**
 * Runs `fn` and removes every known key (and the keys in `extra`) from the
 * message and hint of any error it throws.
 */
async function withRedaction(
  store: KeyStore,
  extra: string[],
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const all = [...store.knownKeys(), ...extra];
    if (error instanceof PolymanError) {
      throw new PolymanError(
        redact(error.message, all),
        error.exitCode,
        error.hint === undefined ? undefined : redact(error.hint, all)
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redact(message, all));
  }
}
