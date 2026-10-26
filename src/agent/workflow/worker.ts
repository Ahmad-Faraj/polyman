/**
 * The Gemma worker: runs one task as a small agent session with its own
 * prompt, tools, sandbox and budget, then stops.
 *
 * The session, registry, sandbox and gate come from factories, so this file
 * only depends on their contracts. The wiring (W0b) passes the real classes:
 * `AgentSession`, `DefaultToolRegistry`, `FolderSandbox` and
 * `DefaultPermissionGate`.
 */

import { isAbsolute, relative } from 'path';
import type { AgentEvent, EventBus, SeqEvent } from '../core/events';
import type { AgentSessionApi, AgentSessionDeps } from '../core/session-types';
import type { Provider } from '../providers/types';
import type { CliRunner } from '../runner/types';
import { skillTools } from '../skills';
import type {
  PermissionGate,
  PermissionMode,
  Sandbox,
  Tool,
  ToolOutput,
  ToolRegistry,
} from '../tools/types';
import { workerPrompt } from './prompts';
import {
  WORKFLOW_LIMITS,
  type ConfigPatch,
  type PlanTask,
  type Spec,
  type TaskKind,
  type Worker,
  type WorkerOutcome,
} from './types';

/** Context budget of a worker, in tokens (doc 10, Budgets). */
export const WORKER_CONTEXT_TOKENS = 16000;

/** The summary when a worker used all its steps. */
export const STEP_LIMIT_SUMMARY =
  'stopped at the step limit without finish_task';

/** What the worker needs. The factories let W0b pass the real classes. */
export interface GemmaWorkerOptions {
  provider: Provider;
  model: string;
  /** The problem folder. Every worker works inside it. */
  problemDir: string;
  runner: CliRunner;
  /** The workflow bus. Gets the workers' `usage` events only. */
  bus: EventBus;
  /**
   * The tools a worker may get, usually `[...fsTools(), ...cliTools()]`.
   * Each task gets only the ones its kind needs. `load_skill` is added from
   * `skillTools()` when it is not in the list.
   */
  tools: Tool[];
  /** Makes a session, `new AgentSession(deps)`. */
  createSession(deps: AgentSessionDeps): AgentSessionApi;
  /** Makes a registry, `new DefaultToolRegistry({ permissions })`. */
  createRegistry(permissions: PermissionGate): ToolRegistry;
  /** Makes a sandbox, `new FolderSandbox(root, { allowWrite })`. */
  createSandbox(root: string, allowWrite: string[]): Sandbox;
  /** Makes a gate, `new DefaultPermissionGate(bus, mode)`. */
  createGate(bus: EventBus, mode: PermissionMode): PermissionGate;
  /** Keys to redact from errors. */
  secrets?(): string[];
  /** Upper bound on generated tokens per call, 8000 by default. */
  maxOutputTokens?: number;
  /** Sampling temperature, 0.3 by default. */
  temperature?: number;
}

/** Kinds that write files. */
const WRITING_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>([
  'statement',
  'main_solution',
  'brute_force',
  'wrong_solution',
  'validator',
  'generators',
  'fix',
]);

/** Kinds that get the bigger step budget. */
const HARD_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>([
  'main_solution',
  'validator',
  'fix',
]);

/** The tool names a worker of this kind gets, in order. */
export function workerToolNames(kind: TaskKind): string[] {
  const names = ['read_file', 'list_files', 'load_skill'];
  if (WRITING_KINDS.has(kind)) names.push('write_file', 'edit_file');
  if (
    kind === 'main_solution' ||
    kind === 'brute_force' ||
    kind === 'wrong_solution'
  ) {
    names.push('run_solution');
  }
  if (kind === 'validator') names.push('test_target');
  if (kind === 'generators') names.push('generate');
  if (kind === 'fix') names.push('verify');
  if (kind === 'statement_critic') names.push('review');
  names.push('finish_task');
  return names;
}

/** Model calls a worker of this kind may make. */
export function workerMaxSteps(kind: TaskKind): number {
  return HARD_KINDS.has(kind)
    ? WORKFLOW_LIMITS.workerStepsHard
    : WORKFLOW_LIMITS.workerStepsSimple;
}

/** The first user message of a fresh worker session. */
export function workerFirstMessage(
  task: PlanTask,
  spec: Spec,
  note?: string
): string {
  const lines = [
    'The spec:',
    spec.trim(),
    '',
    `Your task: ${task.id}, ${task.kind}: ${task.title}`,
    task.brief.trim(),
    `Files you own: ${task.ownsFiles.length > 0 ? task.ownsFiles.join(', ') : 'none'}`,
  ];
  const params = Object.entries(task.params ?? {});
  if (params.length > 0) {
    lines.push('Params:', ...params.map(([k, v]) => `- ${k}: ${v}`));
  }
  if (note) lines.push('', `Last attempt failed: ${note}`);
  lines.push('', 'Start now. Call finish_task when done.');
  return lines.join('\n');
}

/** What one `run` collects from the session. */
interface RunState {
  finish?: { summary: string; configPatch?: ConfigPatch };
  cancelRequested: boolean;
  calls: Map<string, { name: string; args: unknown }>;
  filesWritten: string[];
  error?: string;
}

/** One session of one task, kept across attempts. */
interface TaskSession {
  session: AgentSessionApi;
  state: RunState;
}

function newState(): RunState {
  return { cancelRequested: false, calls: new Map(), filesWritten: [] };
}

/** A worker backed by one model, usually Gemma 4. */
export class GemmaWorker implements Worker {
  private readonly opts: GemmaWorkerOptions;
  private readonly sessions = new Map<string, TaskSession>();

  constructor(opts: GemmaWorkerOptions) {
    this.opts = opts;
  }

  async run(
    input: {
      task: PlanTask;
      spec: Spec;
      attempt: number;
      note?: string;
      fresh: boolean;
    },
    signal: AbortSignal
  ): Promise<WorkerOutcome> {
    signal.throwIfAborted();
    const { task, spec, note, fresh } = input;
    let entry = this.sessions.get(task.id);
    const isNew = fresh || entry === undefined;
    if (isNew || entry === undefined) {
      entry = this.makeTaskSession(task);
      this.sessions.set(task.id, entry);
    }
    const current = entry;
    current.state = newState();

    const text = isNew
      ? workerFirstMessage(task, spec, note)
      : `${note ? `Last attempt failed: ${note}` : 'The last attempt failed.'}\nFix it, then call finish_task.`;

    const onAbort = (): void => current.session.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    let reason: Awaited<ReturnType<AgentSessionApi['send']>>;
    try {
      reason = await current.session.send(text);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    const st = current.state;
    const filesWritten = [...st.filesWritten];
    if (st.finish) {
      const out: WorkerOutcome = { summary: st.finish.summary, filesWritten };
      if (st.finish.configPatch) out.configPatch = st.finish.configPatch;
      return out;
    }
    signal.throwIfAborted();
    switch (reason) {
      case 'max_steps':
        return { summary: STEP_LIMIT_SUMMARY, filesWritten };
      case 'error':
        return {
          summary: `the worker stopped on an error: ${st.error ?? 'unknown error'}`,
          filesWritten,
        };
      case 'cancelled':
        return { summary: 'the worker was cancelled', filesWritten };
      case 'done':
        return {
          summary: `ended without finish_task: ${lastText(current.session) || 'no answer'}`,
          filesWritten,
        };
    }
  }

  /** Builds a new session with the tools, sandbox and gate of this task. */
  private makeTaskSession(task: PlanTask): TaskSession {
    const o = this.opts;
    const localBus = new LocalBus();
    const gate = o.createGate(localBus, 'plan-approved');
    const registry = o.createRegistry(gate);
    const sandbox = o.createSandbox(o.problemDir, [...task.ownsFiles]);

    const entry: TaskSession = {
      session: undefined as unknown as AgentSessionApi,
      state: newState(),
    };
    for (const tool of this.toolsFor(task.kind, entry)) registry.register(tool);

    localBus.on(e => this.onSessionEvent(e, entry));

    const deps: AgentSessionDeps = {
      provider: o.provider,
      model: o.model,
      tools: registry,
      permissions: gate,
      bus: localBus,
      buildSystemPrompt: () => Promise.resolve(workerPrompt(task.kind)),
      makeToolContext: signal => ({
        problemDir: o.problemDir,
        signal,
        runner: o.runner,
        sandbox,
        progress: () => {},
        setProblemDir: () => {},
      }),
      secrets: () => o.secrets?.() ?? [],
      maxSteps: workerMaxSteps(task.kind),
      contextBudgetTokens: WORKER_CONTEXT_TOKENS,
      maxOutputTokens: o.maxOutputTokens ?? 8000,
      temperature: o.temperature ?? 0.3,
    };
    entry.session = o.createSession(deps);
    return entry;
  }

  /** The tools of a kind: from the pool, plus `finish_task` and `review`. */
  private toolsFor(kind: TaskKind, entry: TaskSession): Tool[] {
    const pool = new Map<string, Tool>();
    for (const t of skillTools()) pool.set(t.name, t);
    for (const t of this.opts.tools) pool.set(t.name, t);
    pool.set('finish_task', finishTaskTool(entry));
    pool.set('review', reviewTool(entry));
    const out: Tool[] = [];
    for (const name of workerToolNames(kind)) {
      const t = pool.get(name);
      if (t) out.push(t);
    }
    return out;
  }

  /** Reads the session's events: usage, written files, the end of a task. */
  private onSessionEvent(e: SeqEvent, entry: TaskSession): void {
    const st = entry.state;
    switch (e.type) {
      case 'usage': {
        const usage: Extract<AgentEvent, { type: 'usage' }> = {
          type: 'usage',
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
        };
        if (e.costUsd !== undefined) usage.costUsd = e.costUsd;
        this.opts.bus.emit(usage);
        return;
      }
      case 'tool_call':
        st.calls.set(e.callId, { name: e.name, args: e.args });
        return;
      case 'tool_result': {
        const call = st.calls.get(e.callId);
        if (
          call &&
          e.ok &&
          (call.name === 'write_file' || call.name === 'edit_file')
        ) {
          const p = this.cleanPath(call.args);
          if (p && !st.filesWritten.includes(p)) st.filesWritten.push(p);
        }
        // The task is over: stop the session after this tool result.
        if (st.finish && !st.cancelRequested) {
          st.cancelRequested = true;
          entry.session.cancel();
        }
        return;
      }
      case 'turn_end':
        if (e.error !== undefined) st.error = e.error;
        return;
      default:
        // Text, reasoning and the other events stay inside the worker: the
        // UI shows tasks, not worker text, and tool events have no task id.
        return;
    }
  }

  private cleanPath(args: unknown): string | null {
    if (typeof args !== 'object' || args === null) return null;
    const p = (args as Record<string, unknown>)['path'];
    if (typeof p !== 'string' || p === '') return null;
    const rel = isAbsolute(p) ? relative(this.opts.problemDir, p) : p;
    return rel.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  }
}

/** `finish_task`: stores the summary and the patch, then the task stops. */
function finishTaskTool(entry: TaskSession): Tool {
  const tool: Tool<{ summary: string; configPatch?: ConfigPatch }> = {
    name: 'finish_task',
    description:
      'Call this once when your task is done. It ends the task. summary: 1 to 3 lines of what you did. configPatch: the Config.json change, if your task has one.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '1 to 3 lines.' },
        configPatch: {
          type: 'object',
          description: 'The Config.json change, like in your instructions.',
        },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    risk: 'read',
    needsProblem: false,
    describe: () => ({ title: 'Finish the task' }),
    run(args): Promise<ToolOutput> {
      const finish: RunState['finish'] = {
        summary: String(args.summary ?? '').trim() || 'done',
      };
      const patch: unknown = args.configPatch;
      if (
        typeof patch === 'object' &&
        patch !== null &&
        !Array.isArray(patch)
      ) {
        finish.configPatch = patch;
      }
      entry.state.finish = finish;
      return Promise.resolve({ content: 'Task finished. Stop now.' });
    },
  };
  return tool;
}

/** `review` (critic only): the review is the outcome of the task. */
function reviewTool(entry: TaskSession): Tool {
  const tool: Tool<{ ok: boolean; issues: string[] }> = {
    name: 'review',
    description:
      'Give your review of the statement. ok: true only when there is no issue. issues: short lines. It ends the task.',
    parameters: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        issues: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'issues'],
      additionalProperties: false,
    },
    risk: 'read',
    needsProblem: true,
    describe: () => ({ title: 'Review the statement' }),
    run(args): Promise<ToolOutput> {
      const issues = Array.isArray(args.issues)
        ? args.issues.filter(i => typeof i === 'string' && i.trim() !== '')
        : [];
      const ok = args.ok === true && issues.length === 0;
      entry.state.finish = {
        summary: ok
          ? 'review ok: the statement matches the spec'
          : `review found ${issues.length} issue(s): ${issues.join('; ') || 'not ok'}`,
      };
      return Promise.resolve({ content: 'Review saved. Stop now.' });
    },
  };
  return tool;
}

/** The first line of the last assistant text in the session. */
function lastText(session: AgentSessionApi): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (!m || m.role !== 'assistant') continue;
    for (const p of m.parts) {
      if (p.type === 'text' && p.text.trim() !== '') {
        return (p.text.trim().split(/\r?\n/)[0] ?? '').slice(0, 200);
      }
    }
  }
  return '';
}

/** A small bus for one worker session. Its events stay in the worker. */
class LocalBus implements EventBus {
  private seq = 0;
  private readonly listeners = new Set<(e: SeqEvent) => void>();

  emit(e: AgentEvent): void {
    this.seq += 1;
    const ev = { ...e, seq: this.seq };
    for (const fn of [...this.listeners]) {
      try {
        fn(ev);
      } catch {
        // One listener must not stop the others.
      }
    }
  }

  on(fn: (e: SeqEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
