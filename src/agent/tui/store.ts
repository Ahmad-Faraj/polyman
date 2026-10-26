/**
 * The screen state of the chat, and the reducer that turns agent events into
 * it. No Ink here: this file is pure and tested alone.
 */

import type { SeqEvent } from '../core/events.js';
import type { PermissionMode } from '../tools/types.js';
import type { Plan, TaskResult } from '../workflow/types.js';

/** A finished line of the transcript. Printed once, never changed. */
export type Item =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string }
  | {
      kind: 'tool';
      id: number;
      callId: string;
      name: string;
      args: string;
      ok: boolean;
      summary: string;
    }
  | {
      kind: 'notice';
      id: number;
      text: string;
      level: 'info' | 'warn' | 'error';
    };

/** A tool that runs now. */
export interface ToolView {
  callId: string;
  name: string;
  /** Short form of the arguments, like `validator/val.cpp`. */
  args: string;
  /** The last progress line, or null before the first one. */
  lastLine: string | null;
}

/** A tool approval the user must answer. */
export interface ApprovalView {
  approvalId: string;
  callId: string;
  /** The tool name, for "do not ask again for <tool>". */
  toolName: string;
  title: string;
  command?: string;
  preview?: string;
}

/** The state of one workflow task. */
export interface TaskView {
  taskId: string;
  title: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  attempt: number;
  checkpoint: { name: string; ok: boolean; digest: string } | null;
  result: TaskResult | null;
}

/** Everything the screen shows. */
export interface UiState {
  /** Printed once into the scrollback. */
  finished: Item[];
  /** Redrawn on every change. */
  live: { streamingText: string; reasoning: string; runningTools: ToolView[] };
  approval: ApprovalView | null;
  planApproval: { approvalId: string; plan: Plan } | null;
  workflow: { plan: Plan; tasks: Record<string, TaskView> } | null;
  status: {
    problem: string | null;
    model: string;
    mode: PermissionMode;
    tokens: number;
    costUsd: number;
    busy: boolean;
  };
  /** The id of the next finished item. */
  nextId: number;
}

/** Things the UI itself adds, next to the agent events. */
export type LocalAction =
  /** The user sent a message. */
  | { type: 'user_message'; text: string }
  /** A line from the UI, like the help text. */
  | { type: 'notice'; text: string; level?: 'info' | 'warn' | 'error' }
  /** The permission mode changed (shift+tab). */
  | { type: 'set_mode'; mode: PermissionMode }
  /** The user answered an approval, hide it before the session confirms. */
  | { type: 'approval_answered'; approvalId: string }
  /** `session.send()` returned, the turn is surely over. */
  | { type: 'turn_settled' };

/** What the reducer accepts. */
export type UiAction = SeqEvent | LocalAction;

/** The state before anything happened. */
export function initialState(info: {
  problem: string | null;
  model: string;
  mode?: PermissionMode;
}): UiState {
  return {
    finished: [],
    live: { streamingText: '', reasoning: '', runningTools: [] },
    approval: null,
    planApproval: null,
    workflow: null,
    status: {
      problem: info.problem,
      model: info.model,
      mode: info.mode ?? 'ask',
      tokens: 0,
      costUsd: 0,
      busy: false,
    },
    nextId: 1,
  };
}

/** Keys we show first when we make the short form of tool arguments. */
const ARG_KEYS = [
  'path',
  'file',
  'command',
  'name',
  'solution',
  'target',
  'section',
  'title',
  'recipe',
  'query',
];

/** The short form of tool arguments, for `name(short args)`. */
export function shortArgs(args: unknown, max = 50): string {
  let text = '';
  if (typeof args === 'string') {
    text = args;
  } else if (args && typeof args === 'object' && !Array.isArray(args)) {
    const obj = args as Record<string, unknown>;
    const key =
      ARG_KEYS.find(k => typeof obj[k] === 'string') ??
      Object.keys(obj).find(k => typeof obj[k] === 'string');
    if (key !== undefined) {
      text = obj[key] as string;
    } else {
      const first = Object.values(obj)[0];
      if (typeof first === 'number' || typeof first === 'boolean') {
        text = String(first);
      }
    }
  }
  text = text.split('\n')[0] ?? '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The last name of a folder path. */
function baseName(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(p => p.length > 0);
  return parts[parts.length - 1] ?? dir;
}

/** Adds items to `finished`, with ids. */
function push(state: UiState, ...items: DistributiveOmit<Item, 'id'>[]) {
  let id = state.nextId;
  const added = items.map(item => ({ ...item, id: id++ }));
  return { finished: [...state.finished, ...added], nextId: id };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Moves the streamed text into `finished` as an assistant item. */
function flushText(state: UiState): UiState {
  const text = state.live.streamingText.trim();
  const live = { ...state.live, streamingText: '' };
  if (text.length === 0) {
    return { ...state, live };
  }
  return { ...state, live, ...push(state, { kind: 'assistant', text }) };
}

/** The notice for a turn that did not end well. */
function turnEndNotice(
  reason: 'done' | 'cancelled' | 'max_steps' | 'error',
  error?: string
): DistributiveOmit<Item, 'id'> | null {
  switch (reason) {
    case 'cancelled':
      return {
        kind: 'notice',
        level: 'warn',
        text: 'Interrupted by the user.',
      };
    case 'max_steps':
      return {
        kind: 'notice',
        level: 'warn',
        text: 'Stopped at the step limit of this turn. Say "continue" to go on.',
      };
    case 'error':
      return {
        kind: 'notice',
        level: 'error',
        text: `Error: ${error ?? 'the turn failed'}`,
      };
    default:
      return null;
  }
}

/** Updates one task of the workflow, if there is a workflow. */
function updateTask(
  state: UiState,
  taskId: string,
  change: (t: TaskView) => TaskView
): UiState {
  if (!state.workflow) {
    return state;
  }
  const old = state.workflow.tasks[taskId] ?? {
    taskId,
    title: taskId,
    status: 'pending',
    attempt: 0,
    checkpoint: null,
    result: null,
  };
  return {
    ...state,
    workflow: {
      ...state.workflow,
      tasks: { ...state.workflow.tasks, [taskId]: change(old) },
    },
  };
}

/** The task views of a new plan, all pending. */
function tasksOf(plan: Plan): Record<string, TaskView> {
  const tasks: Record<string, TaskView> = {};
  for (const t of plan.tasks) {
    tasks[t.id] = {
      taskId: t.id,
      title: t.title,
      status: 'pending',
      attempt: 0,
      checkpoint: null,
      result: null,
    };
  }
  return tasks;
}

/** Turns one event (or local action) into the next state. */
export function reduce(state: UiState, e: UiAction): UiState {
  switch (e.type) {
    case 'user_message':
      return {
        ...state,
        ...push(state, { kind: 'user', text: e.text }),
        status: { ...state.status, busy: true },
      };

    case 'notice':
      return {
        ...state,
        ...push(state, {
          kind: 'notice',
          text: e.text,
          level: e.level ?? 'info',
        }),
      };

    case 'set_mode':
      return { ...state, status: { ...state.status, mode: e.mode } };

    case 'approval_answered':
    case 'approval_resolved':
      return {
        ...state,
        approval:
          state.approval?.approvalId === e.approvalId ? null : state.approval,
        planApproval:
          state.planApproval?.approvalId === e.approvalId
            ? null
            : state.planApproval,
      };

    case 'turn_settled':
      return { ...state, status: { ...state.status, busy: false } };

    case 'turn_start':
      return { ...state, status: { ...state.status, busy: true } };

    case 'text_delta':
      return {
        ...state,
        live: {
          ...state.live,
          streamingText: state.live.streamingText + e.text,
        },
      };

    case 'reasoning_delta':
      return {
        ...state,
        live: { ...state.live, reasoning: state.live.reasoning + e.text },
      };

    case 'tool_call': {
      const flushed = flushText(state);
      return {
        ...flushed,
        live: {
          ...flushed.live,
          reasoning: '',
          runningTools: [
            ...flushed.live.runningTools,
            {
              callId: e.callId,
              name: e.name,
              args: shortArgs(e.args),
              lastLine: null,
            },
          ],
        },
      };
    }

    case 'tool_progress':
      return {
        ...state,
        live: {
          ...state.live,
          runningTools: state.live.runningTools.map(t =>
            t.callId === e.callId ? { ...t, lastLine: e.line } : t
          ),
        },
      };

    case 'tool_result': {
      const tool = state.live.runningTools.find(t => t.callId === e.callId);
      return {
        ...state,
        ...push(state, {
          kind: 'tool',
          callId: e.callId,
          name: tool?.name ?? 'tool',
          args: tool?.args ?? '',
          ok: e.ok,
          summary: e.summary,
        }),
        live: {
          ...state.live,
          runningTools: state.live.runningTools.filter(
            t => t.callId !== e.callId
          ),
        },
      };
    }

    case 'approval_needed': {
      const tool = state.live.runningTools.find(t => t.callId === e.callId);
      const approval: ApprovalView = {
        approvalId: e.approvalId,
        callId: e.callId,
        toolName: tool?.name ?? 'this tool',
        title: e.title,
      };
      if (e.command !== undefined) approval.command = e.command;
      if (e.preview !== undefined) approval.preview = e.preview;
      return { ...state, approval };
    }

    case 'usage':
      return {
        ...state,
        status: {
          ...state.status,
          tokens: state.status.tokens + e.inputTokens + e.outputTokens,
          costUsd: state.status.costUsd + (e.costUsd ?? 0),
        },
      };

    case 'turn_end': {
      const flushed = flushText(state);
      const notice = turnEndNotice(e.reason, e.error);
      return {
        ...flushed,
        ...(notice ? push(flushed, notice) : {}),
        live: { streamingText: '', reasoning: '', runningTools: [] },
        approval: null,
        status: { ...flushed.status, busy: false },
      };
    }

    case 'problem_dir_changed':
      return {
        ...state,
        status: { ...state.status, problem: baseName(e.problemDir) },
      };

    case 'compacted':
      return {
        ...state,
        ...push(state, {
          kind: 'notice',
          level: 'info',
          text: `Context compacted: ${e.removedMessages} old messages removed.`,
        }),
      };

    case 'notes_updated':
      return state;

    case 'plan_created':
      return {
        ...state,
        workflow: { plan: e.plan, tasks: tasksOf(e.plan) },
      };

    case 'plan_approval_needed':
      return {
        ...state,
        planApproval: { approvalId: e.approvalId, plan: e.plan },
        workflow: state.workflow ?? { plan: e.plan, tasks: tasksOf(e.plan) },
      };

    case 'task_started':
      return updateTask(state, e.taskId, t => ({
        ...t,
        status: 'running',
        attempt: e.attempt,
      }));

    case 'task_checkpoint':
      return updateTask(state, e.taskId, t => ({
        ...t,
        checkpoint: { name: e.name, ok: e.ok, digest: e.digest },
      }));

    case 'task_done':
      return updateTask(state, e.taskId, t => ({
        ...t,
        status: e.result.status,
        attempt: e.result.attempts,
        result: e.result,
      }));

    case 'workflow_done':
      return {
        ...state,
        ...push(state, {
          kind: 'notice',
          level: e.ok ? 'info' : 'error',
          text: `Workflow ${e.ok ? 'done' : 'failed'}: ${e.summary}`,
        }),
        workflow: null,
        planApproval: null,
      };

    default:
      return state;
  }
}
