/**
 * A fake session for building the UI without the real agent. On `send` it
 * replays a scripted demo with small delays: the Think step, notes, a write
 * approval with a diff, and a verify that fails and then passes.
 */

import type {
  AgentEvent,
  ApprovalDecision,
  EventBus,
  SeqEvent,
} from '../../core/events.js';
import type { Message } from '../../core/messages.js';
import type { AgentSessionApi } from '../../core/session-types.js';
import type { PermissionMode } from '../../tools/types.js';

type TurnEnd = 'done' | 'cancelled' | 'max_steps' | 'error';

/** A small event bus, enough for the fake session and the tests. */
export class FakeBus implements EventBus {
  private seq = 0;
  private readonly listeners = new Set<(e: SeqEvent) => void>();
  /** Every event sent so far. */
  readonly events: SeqEvent[] = [];

  emit(e: AgentEvent): void {
    const event = { ...e, seq: ++this.seq };
    this.events.push(event);
    for (const fn of [...this.listeners]) fn(event);
  }

  on(fn: (e: SeqEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

class Cancelled extends Error {}

const VALIDATOR_PREVIEW = [
  '+ #include "testlib.h"',
  '+',
  '+ int main(int argc, char* argv[]) {',
  '+     registerValidation(argc, argv);',
  '+     int n = inf.readInt(1, 200000, "n");',
  '+     inf.readSpace();',
  '+     long long k = inf.readLong(-2000000000LL, 2000000000LL, "k");',
  '+     inf.readEoln();',
  '+     inf.readInts(n, -1000000000, 1000000000, "a");',
  '+     inf.readEoln();',
  '+     inf.readEof();',
  '+ }',
].join('\n');

/** Options of the fake session. */
export interface FakeSessionOptions {
  /** Multiplies every delay. 0 for tests. Default 1. */
  delayScale?: number;
  /** The mode at start. Default `ask`. */
  mode?: PermissionMode;
}

/** Implements {@link AgentSessionApi} with scripted turns. */
export class FakeSession implements AgentSessionApi {
  private readonly history: Message[] = [];
  private readonly scale: number;
  private mode: PermissionMode;
  private turn = 0;
  private ids = 0;
  private abort: AbortController | null = null;
  private readonly waiting = new Map<
    string,
    (decision: ApprovalDecision) => void
  >();

  constructor(
    private readonly bus: EventBus,
    opts: FakeSessionOptions = {}
  ) {
    this.scale = opts.delayScale ?? 1;
    this.mode = opts.mode ?? 'ask';
  }

  get messages(): readonly Message[] {
    return this.history;
  }

  /** Changes the permission mode. `auto-edit` skips the write approval. */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  async send(text: string): Promise<TurnEnd> {
    if (this.abort) throw new Error('a turn is already running');
    const abort = new AbortController();
    this.abort = abort;
    const turnId = `turn-${++this.turn}`;
    this.history.push(this.message('user', text));
    this.bus.emit({ type: 'turn_start', turnId });
    let reason: TurnEnd = 'done';
    let error: string | undefined;
    try {
      const answer = await this.script(this.turn, text, abort.signal);
      this.history.push(this.message('assistant', answer));
    } catch (err) {
      if (err instanceof Cancelled) {
        reason = 'cancelled';
      } else {
        reason = 'error';
        error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.abort = null;
      this.waiting.clear();
    }
    this.bus.emit(
      error === undefined
        ? { type: 'turn_end', turnId, reason }
        : { type: 'turn_end', turnId, reason, error }
    );
    return reason;
  }

  cancel(): void {
    this.abort?.abort();
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    const resolve = this.waiting.get(approvalId);
    if (!resolve) return;
    this.waiting.delete(approvalId);
    this.bus.emit({ type: 'approval_resolved', approvalId, decision });
    resolve(decision);
  }

  private message(role: 'user' | 'assistant', text: string): Message {
    return {
      id: `m${++this.ids}`,
      role,
      parts: [{ type: 'text', text }],
      createdAt: new Date().toISOString(),
    };
  }

  /** Waits `ms` (times the scale), or throws when the turn is cancelled. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Cancelled());
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms * this.scale);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Cancelled());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Streams text in small chunks, like a model. */
  private async stream(text: string, signal: AbortSignal): Promise<void> {
    const chunks = text.match(/\S+\s*|\s+/g) ?? [];
    for (const chunk of chunks) {
      await this.sleep(25, signal);
      this.bus.emit({ type: 'text_delta', text: chunk });
    }
  }

  /** Emits `approval_needed` and waits for the answer. */
  private ask(
    approval: Omit<Extract<AgentEvent, { type: 'approval_needed' }>, 'type'>,
    signal: AbortSignal
  ): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Cancelled());
        return;
      }
      signal.addEventListener('abort', () => reject(new Cancelled()), {
        once: true,
      });
      this.waiting.set(approval.approvalId, resolve);
      this.bus.emit({ type: 'approval_needed', ...approval });
    });
  }

  private usage(input: number, output: number, costUsd: number): void {
    this.bus.emit({
      type: 'usage',
      inputTokens: input,
      outputTokens: output,
      costUsd,
    });
  }

  /** Runs the script of one turn and returns the last answer text. */
  private async script(
    turn: number,
    text: string,
    signal: AbortSignal
  ): Promise<string> {
    if (turn === 1) return this.thinkStep(signal);
    if (turn === 2) return this.buildStep(signal);
    const answer = `(fake session) You said: "${text}". The scripted demo is over, this turn only echoes.`;
    await this.stream(answer, signal);
    this.usage(900, 40, 0.0004);
    return answer;
  }

  private async thinkStep(signal: AbortSignal): Promise<string> {
    for (const part of [
      'The user wants pairs with sum k. ',
      'I should ask about order and repeats first.',
    ]) {
      await this.sleep(300, signal);
      this.bus.emit({ type: 'reasoning_delta', text: part });
    }
    await this.stream(
      [
        'Nice. Before we build anything, let us fix the task:',
        '',
        '1. Are the pairs ordered (`i < j`)?',
        '2. Can values repeat?',
        '3. What are the limits on `k`? I guess `|k| <= 2e9`, so the sum needs `long long`.',
        '',
        'My idea: sort the array and use **two pointers**, `O(n log n)`.',
      ].join('\n'),
      signal
    );
    this.usage(2100, 160, 0.0011);
    this.bus.emit({
      type: 'tool_call',
      callId: 'c1',
      name: 'update_notes',
      args: { section: 'Constraints' },
      risk: 'write',
    });
    await this.sleep(400, signal);
    this.bus.emit({ type: 'notes_updated', notes: '# Idea\nCount pairs...' });
    this.bus.emit({
      type: 'tool_result',
      callId: 'c1',
      ok: true,
      summary: 'notes updated',
    });
    const answer =
      'I wrote the idea and the constraints in the notes. Answer the questions, then say **build**.';
    await this.stream(answer, signal);
    this.usage(2400, 30, 0.0009);
    return answer;
  }

  private async verify(
    callId: string,
    passed: boolean,
    signal: AbortSignal
  ): Promise<void> {
    this.bus.emit({
      type: 'tool_call',
      callId,
      name: 'verify',
      args: {},
      risk: 'run',
    });
    const lines = [
      'Compiling 4 solutions ...',
      'Generating tests ... (24/24)',
      'Validating tests ... (24/24)',
      'Running main.cpp on tests ... (24/24)',
      'Running brute.cpp on tests ... (24/24)',
      'Running wa-overflow.cpp on tests ... (12/24)',
      'Running wa-overflow.cpp on tests ... (24/24)',
    ];
    for (const line of lines) {
      await this.sleep(350, signal);
      this.bus.emit({ type: 'tool_progress', callId, line });
    }
    await this.sleep(300, signal);
    this.bus.emit(
      passed
        ? {
            type: 'tool_result',
            callId,
            ok: true,
            summary:
              'verify passed: 4 solutions, 25 tests, every verdict matches its tag',
          }
        : {
            type: 'tool_result',
            callId,
            ok: false,
            summary:
              'verify failed: wa-overflow.cpp (WA) passed all 24 tests\nno test has a sum above 2^31',
          }
    );
  }

  private async buildStep(signal: AbortSignal): Promise<string> {
    await this.stream('Good. I will start with the validator.', signal);
    this.usage(3000, 420, 0.0021);
    this.bus.emit({
      type: 'tool_call',
      callId: 'c2',
      name: 'write_file',
      args: { path: 'validator/val.cpp', content: '...' },
      risk: 'write',
    });
    if (this.mode === 'ask') {
      const decision = await this.ask(
        {
          approvalId: 'a1',
          callId: 'c2',
          title: 'Write validator/val.cpp?',
          preview: VALIDATOR_PREVIEW,
        },
        signal
      );
      if (decision.kind === 'deny') {
        this.bus.emit({
          type: 'tool_result',
          callId: 'c2',
          ok: false,
          summary: `denied by the user${decision.reason ? `: ${decision.reason}` : ''}`,
        });
        const answer =
          'Ok, I did not write the file. Tell me what to change and I will try again.';
        await this.stream(answer, signal);
        return answer;
      }
    }
    await this.sleep(200, signal);
    this.bus.emit({
      type: 'tool_result',
      callId: 'c2',
      ok: true,
      summary: 'wrote validator/val.cpp (12 lines)',
    });

    await this.stream('Now let us run verify on the whole problem.', signal);
    this.usage(3600, 60, 0.0012);
    await this.verify('c3', false, signal);

    await this.stream(
      'The wrong solution `wa-overflow.cpp` passed every test, so the tests are weak. I will add a test with big values near `1e9`.',
      signal
    );
    this.usage(4200, 120, 0.0016);
    this.bus.emit({
      type: 'tool_call',
      callId: 'c4',
      name: 'generate',
      args: { testset: 'tests' },
      risk: 'run',
    });
    await this.sleep(500, signal);
    this.bus.emit({
      type: 'tool_progress',
      callId: 'c4',
      line: 'gen 25 1000000000 > test 25',
    });
    await this.sleep(300, signal);
    this.bus.emit({
      type: 'tool_result',
      callId: 'c4',
      ok: true,
      summary: 'generated 25 tests',
    });
    await this.verify('c5', true, signal);

    const answer = [
      'Done. `verify` passes now:',
      '',
      '- `main.cpp` and `brute.cpp` pass all 25 tests',
      '- `wa-overflow.cpp` fails test 25 with **WA**, as its tag says',
    ].join('\n');
    await this.stream(answer, signal);
    this.usage(4800, 90, 0.0018);
    return answer;
  }
}
