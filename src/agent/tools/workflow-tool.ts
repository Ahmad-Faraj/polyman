/**
 * The `start_workflow` tool: the chat agent hands the spec to the workflow
 * manager (doc 10). It reads the spec from the notes, builds a
 * {@link WorkflowScheduler} with Gemma as manager and workers, and runs it
 * inside the chat turn, so esc stops the whole workflow.
 */

import { AgentSession } from '../core/session';
import type { EventBus } from '../core/events';
import type { Provider } from '../providers/types';
import type { CliRunner } from '../runner/types';
import { skillTools } from '../skills';
import { CliCheckpoints } from '../workflow/checkpoints';
import { GemmaManager } from '../workflow/manager';
import {
  WorkflowScheduler,
  type WorkflowRunResult,
} from '../workflow/scheduler';
import { parseSpec } from '../workflow/spec';
import type { Plan, Spec } from '../workflow/types';
import { checkpointPrecheck, GemmaWorker } from '../workflow/worker';
import { cliTools } from './cli-tools';
import { fsTools } from './fs-tools';
import { DefaultPermissionGate } from './permissions';
import { DefaultToolRegistry } from './registry';
import { FolderSandbox } from './sandbox';
import type { PermissionGate, Tool, ToolOutput } from './types';

/** Time limit of one whole workflow. */
export const WORKFLOW_TIMEOUT_MS = 30 * 60 * 1000;

/** The error when the spec is not ready. */
export const NO_SPEC_ERROR =
  'Write the spec first with write_notes (see the format in your instructions).';

/** Sections a spec must have before a workflow can start. */
const REQUIRED_SECTIONS = ['Idea', 'Constraints', 'Samples'] as const;

/** What the tool runs. `WorkflowScheduler` in the real chat. */
export interface WorkflowRunner {
  run(
    spec: Spec,
    recipe: Plan['recipe'],
    signal: AbortSignal
  ): Promise<WorkflowRunResult>;
}

/** What {@link workflowTool} needs. */
export interface WorkflowToolOptions {
  /** The spec text, '' when there is none. */
  readSpec(): Promise<string>;
  /** Builds the scheduler for one run in `problemDir`. */
  createScheduler(problemDir: string, runner: CliRunner): WorkflowRunner;
}

/** True when the spec has a non-empty Idea, Constraints and Samples. */
export function specIsReady(spec: string): boolean {
  const { sections } = parseSpec(spec);
  return REQUIRED_SECTIONS.every(name => (sections[name] ?? '').trim() !== '');
}

/** The `start_workflow` tool. */
export function workflowTool(
  opts: WorkflowToolOptions
): Tool<{ recipe: Plan['recipe'] }> {
  return {
    name: 'start_workflow',
    description:
      'Build or fix the whole problem with a team of workers, from the spec in the notes. build_problem builds everything, fix_verify fixes a failing verify, strengthen_tests adds tests. The user approves the plan first.',
    parameters: {
      type: 'object',
      properties: {
        recipe: {
          type: 'string',
          enum: ['build_problem', 'fix_verify', 'strengthen_tests'],
          description: 'Which workflow to run.',
        },
      },
      required: ['recipe'],
      additionalProperties: false,
    },
    risk: 'write',
    needsProblem: true,
    timeoutMs: WORKFLOW_TIMEOUT_MS,
    describe: args => ({ title: `Start the ${args.recipe} workflow` }),
    async run(args, ctx): Promise<ToolOutput> {
      const spec = await opts.readSpec();
      if (!specIsReady(spec)) return { content: NO_SPEC_ERROR, isError: true };
      if (ctx.problemDir === null) {
        return {
          content: 'There is no problem folder yet. Call create_problem first.',
          isError: true,
        };
      }
      const scheduler = opts.createScheduler(ctx.problemDir, ctx.runner);
      const result = await scheduler.run(spec, args.recipe, ctx.signal);
      return {
        content: result.summary,
        ...(result.ok ? {} : { isError: true }),
        data: result.results,
      };
    },
  };
}

/** What the real scheduler needs from the chat. */
export interface GemmaSchedulerOptions {
  provider: Provider;
  model: string;
  /** The chat bus: plan, task and usage events go to the UI. */
  bus: EventBus;
  /** The chat gate: it asks the user to approve the plan. */
  gate: PermissionGate;
  secrets(): string[];
}

/**
 * The real {@link WorkflowToolOptions.createScheduler}: Gemma manager and
 * workers, the real session, registry, sandbox and gate classes, and the
 * CLI checkpoints.
 */
export function gemmaSchedulerFactory(
  o: GemmaSchedulerOptions
): WorkflowToolOptions['createScheduler'] {
  return (problemDir, runner) => {
    const checkpoints = new CliCheckpoints(runner);
    return new WorkflowScheduler({
      manager: new GemmaManager({
        provider: o.provider,
        model: o.model,
        bus: o.bus,
      }),
      worker: new GemmaWorker({
        provider: o.provider,
        model: o.model,
        problemDir,
        runner,
        bus: o.bus,
        tools: [...fsTools(), ...cliTools(), ...skillTools()],
        createSession: deps => new AgentSession(deps),
        createRegistry: permissions => new DefaultToolRegistry({ permissions }),
        createSandbox: (root, allowWrite) =>
          new FolderSandbox(root, { allowWrite }),
        createGate: (bus, mode) => new DefaultPermissionGate(bus, mode),
        secrets: () => o.secrets(),
        precheck: checkpointPrecheck(checkpoints, problemDir),
      }),
      checkpoints,
      permissions: o.gate,
      bus: o.bus,
      problemDir,
    });
  };
}
