/**
 * A provider that plays a fixed script instead of calling a model. Tests use
 * it to run the agent with no network and no key.
 */

import type {
  ChatRequest,
  Provider,
  ProviderError,
  StreamEvent,
} from './types';

/** Token counts of a `usage` event. */
type MockUsage = Omit<Extract<StreamEvent, { type: 'usage' }>, 'type'>;

/** Why a turn ended, as in the `done` event. */
type MockStopReason = Extract<StreamEvent, { type: 'done' }>['stopReason'];

/** A tool call in a mock script. */
export interface MockToolCall {
  /** Call id. Defaults to `mock_call_<turn>_<n>`, both starting at 1. */
  id?: string;
  /** Tool name. */
  name: string;
  /** Tool arguments, already parsed. */
  args: unknown;
}

/**
 * One model turn in a mock script. Each `stream()` call plays the next step.
 *
 * Events come in this order: `reasoning_delta`, `text_delta`, one `tool_call`
 * per call (`toolCall` first, then `toolCalls`), `usage`, `done`. A field that
 * is not set gives no event.
 */
export interface MockStep {
  /** Reasoning text, sent as one `reasoning_delta`. */
  reasoning?: string;
  /** Answer text, sent as one `text_delta`. */
  text?: string;
  /** One tool call. */
  toolCall?: MockToolCall;
  /** More tool calls in the same turn. */
  toolCalls?: MockToolCall[];
  /** Token counts. No `usage` event when not set. */
  usage?: MockUsage;
  /** Defaults to `tool_calls` when the step has tool calls, else `end`. */
  stopReason?: MockStopReason;
  /**
   * Thrown after the reasoning, text and tool calls, in place of `usage` and
   * `done`. A step with only an
   * error fails before the first event, like a failed HTTP request. A step
   * with text and an error is a stream that broke in the middle.
   */
  error?: ProviderError;
}

/**
 * Plays a script of model turns: `[{ text: 'ok' }, { toolCall: { name:
 * 'verify', args: {} } }]`. It throws a plain `Error` when the script runs
 * out, since that is a bug in the test, not a provider failure.
 */
export class MockProvider implements Provider {
  /** Provider id. */
  readonly id: string;
  /** Every request the provider got, in order. */
  readonly requests: ChatRequest[] = [];

  private readonly script: readonly MockStep[];
  private played = 0;

  constructor(script: readonly MockStep[], id = 'mock') {
    this.script = [...script];
    this.id = id;
  }

  /** How many steps are left to play. */
  get remaining(): number {
    return this.script.length - this.played;
  }

  async *stream(
    req: ChatRequest,
    signal: AbortSignal
  ): AsyncIterable<StreamEvent> {
    signal.throwIfAborted();
    const step = this.script[this.played];
    if (step === undefined) {
      throw new Error(
        `MockProvider: no step left for call ${this.played + 1}, the script has ${this.script.length} step(s)`
      );
    }
    this.played += 1;
    this.requests.push(req);

    for (const event of eventsOf(step, this.played)) {
      // Give the caller a chance to abort between events, like a real stream.
      await Promise.resolve();
      signal.throwIfAborted();
      yield event;
    }
    if (step.error) {
      await Promise.resolve();
      signal.throwIfAborted();
      throw step.error;
    }
  }
}

/** The events of one step, without the error. `turn` starts at 1. */
function eventsOf(step: MockStep, turn: number): StreamEvent[] {
  const events: StreamEvent[] = [];
  if (step.reasoning !== undefined) {
    events.push({ type: 'reasoning_delta', text: step.reasoning });
  }
  if (step.text !== undefined) {
    events.push({ type: 'text_delta', text: step.text });
  }
  const calls = [
    ...(step.toolCall ? [step.toolCall] : []),
    ...(step.toolCalls ?? []),
  ];
  calls.forEach((call, i) => {
    events.push({
      type: 'tool_call',
      id: call.id ?? `mock_call_${turn}_${i + 1}`,
      name: call.name,
      args: call.args,
    });
  });
  if (step.error) return events;
  if (step.usage) events.push({ type: 'usage', ...step.usage });
  events.push({
    type: 'done',
    stopReason: step.stopReason ?? (calls.length > 0 ? 'tool_calls' : 'end'),
  });
  return events;
}
