/**
 * A native adapter for the Anthropic Messages API. It gives the same
 * {@link StreamEvent}s as the OpenAI-compatible adapter, so the core does not
 * know which one it talks to.
 */

import type { ContentPart, Message } from '../core/messages';
import {
  errorFromResponse,
  isContextError,
  parseToolArgs,
} from './openai-compatible';
import { parseSse } from './sse-parser';
import {
  ProviderError,
  type ChatRequest,
  type Provider,
  type ProviderErrorKind,
  type StreamEvent,
  type ToolSpec,
} from './types';

/** The `anthropic-version` header we send. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** The Messages API needs `max_tokens`. This is used when a request has none. */
export const DEFAULT_MAX_TOKENS = 32000;

/** How to reach the Anthropic API. */
export interface AnthropicOptions {
  /** Provider id. Defaults to `anthropic`. */
  id?: string;
  /** Base URL. Defaults to `https://api.anthropic.com`. */
  baseUrl?: string;
  /** Sent as `x-api-key`. */
  apiKey?: string;
  /** More headers for every request, like `anthropic-beta`. */
  headers?: Record<string, string>;
  /** `max_tokens` when a request has no `maxOutputTokens`. */
  defaultMaxTokens?: number;
  /** The `fetch` to use. Defaults to the global one. Tests pass a fake. */
  fetch?: typeof fetch;
}

/** A provider for Claude models through the native Messages API. */
export class AnthropicProvider implements Provider {
  /** Provider id. */
  readonly id: string;

  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly defaultMaxTokens: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: AnthropicOptions = {}) {
    this.id = opts.id ?? 'anthropic';
    const base = (opts.baseUrl ?? 'https://api.anthropic.com').replace(
      /\/+$/,
      ''
    );
    this.url = base.endsWith('/v1')
      ? `${base}/messages`
      : `${base}/v1/messages`;
    this.headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': ANTHROPIC_VERSION,
      ...(opts.apiKey ? { 'x-api-key': opts.apiKey } : {}),
      ...opts.headers,
    };
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.fetchFn = opts.fetch ?? fetch;
  }

  async *stream(
    req: ChatRequest,
    signal: AbortSignal
  ): AsyncIterable<StreamEvent> {
    signal.throwIfAborted();
    const response = await this.post(req, signal);
    if (!response.ok) throw await errorFromResponse(response);
    if (!response.body) {
      throw new ProviderError('server', 'the response has no body', {
        status: response.status,
      });
    }

    const turn = new TurnState();
    for await (const sse of parseSse(response.body, signal)) {
      for (const event of turn.event(parseEvent(sse.data))) {
        signal.throwIfAborted();
        yield event;
      }
      if (turn.finished) break;
    }
    signal.throwIfAborted();
    if (!turn.finished && turn.stopReason === undefined) {
      throw new ProviderError('network', 'the stream ended before the turn');
    }
    for (const event of turn.end()) yield event;
  }

  /** Sends one request. Network failures become `network` errors. */
  private async post(req: ChatRequest, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchFn(this.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(requestBody(req, this.defaultMaxTokens)),
        signal,
      });
    } catch (err) {
      signal.throwIfAborted();
      throw new ProviderError(
        'network',
        `cannot reach ${this.url}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Request

/** Marks the end of a prefix the API may cache. */
const CACHE = Object.freeze({ type: 'ephemeral' });

/** A content block in the Messages format. */
type WireBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content?: string;
      is_error?: true;
    };

/** A message in the Messages format. */
interface WireMessage {
  role: 'user' | 'assistant';
  content: WireBlock[];
}

/**
 * The JSON body of a Messages request. The system prompt and the tool list
 * get `cache_control`, since they are the same in every step of a session.
 */
export function requestBody(
  req: ChatRequest,
  defaultMaxTokens = DEFAULT_MAX_TOKENS
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxOutputTokens ?? defaultMaxTokens,
  };
  if (req.system !== '') {
    body['system'] = [{ type: 'text', text: req.system, cache_control: CACHE }];
  }
  body['messages'] = toWireMessages(req.messages);
  if (req.tools.length > 0) {
    const last = req.tools.length - 1;
    body['tools'] = req.tools.map((tool, i) => toWireTool(tool, i === last));
  }
  body['stream'] = true;
  // The API rejects `temperature` together with `thinking`.
  if (req.temperature !== undefined && req.reasoningEffort === undefined) {
    body['temperature'] = req.temperature;
  }
  if (req.reasoningEffort !== undefined) {
    // Adaptive thinking with a readable summary, so the UI has something
    // to show. The effort sets how much the model thinks.
    body['thinking'] = { type: 'adaptive', display: 'summarized' };
    body['output_config'] = { effort: req.reasoningEffort };
  }
  return body;
}

/**
 * Maps our messages to the Messages format.
 *
 * - Assistant parts keep their order: thinking, text and `tool_use` blocks.
 *   Reasoning goes back only when it has a signature (or redacted data),
 *   unchanged, since the API needs the thinking blocks of earlier turns.
 *   Reasoning from other providers has no signature and is dropped.
 * - Tool results become `tool_result` blocks in a `user` message, before any
 *   text of that message.
 * - Messages of the same role next to each other are joined into one.
 */
export function toWireMessages(messages: readonly Message[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content =
      role === 'assistant'
        ? message.parts.flatMap(assistantBlock)
        : message.parts.flatMap(userBlock);
    if (content.length === 0) continue;

    const last = out.at(-1);
    if (last?.role === role) last.content.push(...content);
    else out.push({ role, content });
  }
  for (const message of out) {
    if (message.role === 'user') message.content = toolResultsFirst(message);
  }
  return out;
}

function assistantBlock(part: ContentPart): WireBlock[] {
  switch (part.type) {
    case 'text':
      return part.text === '' ? [] : [{ type: 'text', text: part.text }];
    case 'reasoning':
      if (part.redacted !== undefined) {
        return [{ type: 'redacted_thinking', data: part.redacted }];
      }
      if (part.signature !== undefined) {
        return [
          {
            type: 'thinking',
            thinking: part.text,
            signature: part.signature,
          },
        ];
      }
      return [];
    case 'tool_call':
      return [
        {
          type: 'tool_use',
          id: part.id,
          name: part.name,
          input: toolInput(part.args),
        },
      ];
    case 'tool_result':
      return [];
  }
}

function userBlock(part: ContentPart): WireBlock[] {
  switch (part.type) {
    case 'text':
      return part.text === '' ? [] : [{ type: 'text', text: part.text }];
    case 'tool_result':
      return [
        {
          type: 'tool_result',
          tool_use_id: part.callId,
          ...(part.content !== '' ? { content: part.content } : {}),
          ...(part.isError ? { is_error: true as const } : {}),
        },
      ];
    default:
      return [];
  }
}

/** Tool results must open the user message that answers the tool calls. */
function toolResultsFirst(message: WireMessage): WireBlock[] {
  return [
    ...message.content.filter(b => b.type === 'tool_result'),
    ...message.content.filter(b => b.type !== 'tool_result'),
  ];
}

/**
 * The `input` of a `tool_use` block, which must be an object. Arguments that
 * could not be parsed are kept as the raw string; they go back as `{}`.
 */
function toolInput(args: unknown): Record<string, unknown> {
  if (isRecord(args)) return args;
  if (typeof args === 'string') {
    const parsed = parseToolArgs(args, false);
    if (parsed.ok && isRecord(parsed.value)) return parsed.value;
  }
  return {};
}

function toWireTool(tool: ToolSpec, cache: boolean): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    ...(cache ? { cache_control: CACHE } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stream

function parseEvent(data: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new ProviderError(
      'server',
      `bad JSON in the stream: ${data.slice(0, 200)}`
    );
  }
  if (!isRecord(json)) {
    throw new ProviderError('server', 'a stream event is not an object');
  }
  return json;
}

/** Turns an `error` event of the stream into a {@link ProviderError}. */
export function streamError(error: unknown): ProviderError {
  const type =
    isRecord(error) && typeof error['type'] === 'string' ? error['type'] : '';
  const message =
    isRecord(error) && typeof error['message'] === 'string'
      ? error['message']
      : '';
  return new ProviderError(
    errorKind(type, message),
    `error in the stream: ${type || 'unknown'}${message ? `: ${message}` : ''}`
  );
}

function errorKind(type: string, message: string): ProviderErrorKind {
  switch (type) {
    case 'authentication_error':
    case 'permission_error':
      return 'auth';
    case 'rate_limit_error':
      return 'rate_limit';
    case 'request_too_large':
      return 'context_too_long';
    case 'invalid_request_error':
    case 'not_found_error':
      return isContextError(message) ? 'context_too_long' : 'bad_request';
    default:
      // overloaded_error, api_error and anything new.
      return 'server';
  }
}

type StopReason = Extract<StreamEvent, { type: 'done' }>['stopReason'];

/** One content block while it streams. */
interface Block {
  type: string;
  id: string;
  name: string;
  /** `input_json_delta` pieces of a `tool_use` block. */
  json: string;
  /** The `input` of `content_block_start`, used when no pieces come. */
  input: unknown;
  signature: string;
  /** `data` of a `redacted_thinking` block. */
  data: string;
}

/** Raw token counts. Later events replace the fields they have. */
interface RawUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite: number;
}

/** The state of one streamed turn: open blocks, usage, stop reason. */
class TurnState {
  stopReason: StopReason | undefined;
  /** Whether `message_stop` came. */
  finished = false;
  private usage: RawUsage | undefined;
  private blocks = new Map<number, Block>();

  /** The events of one stream event. */
  *event(e: Record<string, unknown>): Generator<StreamEvent> {
    switch (e['type']) {
      case 'message_start': {
        const message = e['message'];
        if (isRecord(message)) this.addUsage(message['usage']);
        return;
      }
      case 'content_block_start':
        yield* this.start(indexOf(e), e['content_block']);
        return;
      case 'content_block_delta':
        yield* this.delta(indexOf(e), e['delta']);
        return;
      case 'content_block_stop':
        yield* this.stop(indexOf(e));
        return;
      case 'message_delta': {
        const delta = e['delta'];
        if (isRecord(delta) && typeof delta['stop_reason'] === 'string') {
          this.stopReason = toStopReason(delta['stop_reason']);
        }
        this.addUsage(e['usage']);
        return;
      }
      case 'message_stop':
        this.finished = true;
        return;
      case 'error':
        throw streamError(e['error']);
      default:
        // `ping` and event types added later.
        return;
    }
  }

  /** The events after the last stream event: usage, then done. */
  *end(): Generator<StreamEvent> {
    if (this.usage) {
      const { input, output, cacheRead, cacheWrite } = this.usage;
      // Anthropic counts cached tokens apart from `input_tokens`. We give
      // the whole prompt, like OpenAI, with the cache reads as a part of it.
      yield {
        type: 'usage',
        inputTokens: input + (cacheRead ?? 0) + cacheWrite,
        outputTokens: output,
        ...(cacheRead !== undefined ? { cachedTokens: cacheRead } : {}),
      };
    }
    yield { type: 'done', stopReason: this.stopReason ?? 'end' };
  }

  private *start(index: number, raw: unknown): Generator<StreamEvent> {
    if (!isRecord(raw)) return;
    const block: Block = {
      type: stringOf(raw['type']),
      id: stringOf(raw['id']),
      name: stringOf(raw['name']),
      json: '',
      input: raw['input'],
      signature: stringOf(raw['signature']),
      data: stringOf(raw['data']),
    };
    this.blocks.set(index, block);
    const text = stringOf(raw['text']);
    if (block.type === 'text' && text !== '') {
      yield { type: 'text_delta', text };
    }
    const thinking = stringOf(raw['thinking']);
    if (block.type === 'thinking' && thinking !== '') {
      yield { type: 'reasoning_delta', text: thinking };
    }
  }

  private *delta(index: number, delta: unknown): Generator<StreamEvent> {
    if (!isRecord(delta)) return;
    const block = this.blocks.get(index);
    switch (delta['type']) {
      case 'text_delta': {
        const text = stringOf(delta['text']);
        if (text !== '') yield { type: 'text_delta', text };
        return;
      }
      case 'thinking_delta': {
        const text = stringOf(delta['thinking']);
        if (text !== '') yield { type: 'reasoning_delta', text };
        return;
      }
      case 'signature_delta':
        if (block) block.signature += stringOf(delta['signature']);
        return;
      case 'input_json_delta':
        if (block) block.json += stringOf(delta['partial_json']);
        return;
      default:
        return;
    }
  }

  /** A block is complete: a tool call, or the end of a thinking block. */
  private *stop(index: number): Generator<StreamEvent> {
    const block = this.blocks.get(index);
    this.blocks.delete(index);
    if (!block) return;

    if (block.type === 'tool_use') {
      if (block.json.trim() === '') {
        // No pieces came: the start event had the whole input.
        const args = isRecord(block.input) ? block.input : {};
        yield { type: 'tool_call', id: block.id, name: block.name, args };
        return;
      }
      const parsed = parseToolArgs(block.json, false);
      if (parsed.ok && isRecord(parsed.value)) {
        yield {
          type: 'tool_call',
          id: block.id,
          name: block.name,
          args: parsed.value,
        };
      } else {
        yield {
          type: 'tool_call',
          id: block.id,
          name: block.name,
          args: block.json,
          argsError: parsed.ok
            ? 'tool arguments are not a JSON object'
            : parsed.error,
        };
      }
    } else if (block.type === 'thinking' && block.signature !== '') {
      yield { type: 'reasoning_delta', text: '', signature: block.signature };
    } else if (block.type === 'redacted_thinking' && block.data !== '') {
      yield { type: 'reasoning_delta', text: '', redacted: block.data };
    }
  }

  private addUsage(raw: unknown): void {
    if (!isRecord(raw)) return;
    const usage = (this.usage ??= { input: 0, output: 0, cacheWrite: 0 });
    const input = raw['input_tokens'];
    const output = raw['output_tokens'];
    const cacheRead = raw['cache_read_input_tokens'];
    const cacheWrite = raw['cache_creation_input_tokens'];
    if (typeof input === 'number') usage.input = input;
    if (typeof output === 'number') usage.output = output;
    if (typeof cacheRead === 'number') usage.cacheRead = cacheRead;
    if (typeof cacheWrite === 'number') usage.cacheWrite = cacheWrite;
  }
}

function toStopReason(reason: string): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'content_filter';
    default:
      // end_turn, stop_sequence, pause_turn.
      return 'end';
  }
}

function indexOf(e: Record<string, unknown>): number {
  const index = e['index'];
  return typeof index === 'number' ? index : 0;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
