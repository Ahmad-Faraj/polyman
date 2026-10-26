import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { Plan, PlanTask } from '../../workflow/types.js';
import {
  shownStatus,
  type Item,
  type TaskView,
  type WorkflowView,
} from '../store.js';
import { fg, formatCost, type ColorName } from '../theme.js';
import { Spinner } from './Spinner.js';

/** Most title columns of the task tree. Longer titles are cut. */
const MAX_TITLE = 34;

/** Most digest lines per checkpoint in the task details. */
const MAX_DIGEST_LINES = 6;

/** The color of a solution tag: MA green, TO cyan, WA red, TL amber. */
export function tagColor(tag: string): ColorName {
  switch (tag) {
    case 'MA':
    case 'OK':
      return 'ok';
    case 'TO':
      return 'info';
    case 'TL':
      return 'warn';
    default:
      return 'error';
  }
}

const TAGS = new Set(['MA', 'OK', 'WA', 'TL', 'TO', 'ML', 'RE', 'PE', 'RJ']);

/**
 * The title of a task and its solution tag, if it has one. The tag comes
 * from `params.tag`, or from the last word of the title (`main solution MA`).
 */
export function splitTag(task: Pick<PlanTask, 'title' | 'params'>): {
  title: string;
  tag: string | null;
} {
  const fromParams = task.params?.['tag'];
  const tag =
    fromParams !== undefined && TAGS.has(fromParams) ? fromParams : null;
  const match = /^(.*?)\s+\(?([A-Z]{2})\)?$/.exec(task.title);
  if (match && match[2] && TAGS.has(match[2]) && (!tag || tag === match[2])) {
    return { title: match[1] ?? task.title, tag: match[2] };
  }
  return { title: task.title, tag };
}

/** A task title with the tag in its color. */
export function TaskTitle({ task }: { task: PlanTask }) {
  const { title, tag } = splitTag(task);
  return (
    <Text wrap="truncate-end">
      {title}
      {tag && <Text {...fg(tagColor(tag))}> {tag}</Text>}
    </Text>
  );
}

/** The width of the title column for these tasks. */
export function titleWidth(tasks: PlanTask[]): number {
  let widest = 8;
  for (const t of tasks) {
    const { title, tag } = splitTag(t);
    widest = Math.max(widest, title.length + (tag ? tag.length + 1 : 0));
  }
  return Math.min(widest, MAX_TITLE) + 2;
}

/** 108000 ms becomes `1:48`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The first non-empty line of a text. */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map(l => l.trim())
      .find(l => l.length > 0) ?? ''
  );
}

/**
 * The dim text after a task title: `attempt <n> · <digest>` for a running
 * or failed task, the digest for a passed one, `waits for <titles>` for a
 * pending task with deps that did not pass yet.
 */
export function taskDetail(
  task: PlanTask,
  view: TaskView,
  plan: Plan,
  tasks: Record<string, TaskView>
): string {
  const digest = firstLine(
    view.result?.checkpoint.digest ?? view.checkpoint?.digest ?? ''
  );
  switch (view.status) {
    case 'pending': {
      const waits = task.dependsOn
        .filter(id => {
          const s = tasks[id]?.status;
          return s !== 'passed' && s !== 'skipped';
        })
        .map(id => {
          const dep = plan.tasks.find(t => t.id === id);
          return dep ? splitTag(dep).title : id;
        });
      return waits.length > 0 ? `waits for ${waits.join(', ')}` : '';
    }
    case 'skipped':
      return 'skipped';
    case 'passed':
      if (view.attempt > 1) {
        return digest ? `attempt ${view.attempt} · ${digest}` : '';
      }
      return digest;
    default: {
      const attempt = `attempt ${Math.max(view.attempt, 1)}`;
      return digest ? `${attempt} · ${digest}` : attempt;
    }
  }
}

/** The icon of a task. `live` false draws a still tree, no spinner. */
function TaskIcon({ view, live }: { view: TaskView; live: boolean }) {
  switch (shownStatus(view)) {
    case 'passed':
      return <Text {...fg('ok')}>✔</Text>;
    case 'failed':
      return <Text {...fg('error')}>✗</Text>;
    case 'retrying':
      return <Text {...fg('warn')}>↻</Text>;
    case 'running':
      return live ? <Spinner /> : <Text dimColor>◻</Text>;
    case 'skipped':
      return <Text dimColor>-</Text>;
    default:
      return <Text dimColor>◻</Text>;
  }
}

/** The task rows: icon, title, dim detail. */
export function PlanTree({
  plan,
  tasks,
  live,
  selected = null,
}: {
  plan: Plan;
  tasks: Record<string, TaskView>;
  live: boolean;
  /** The row with the ❯ cursor (task details open), or null. */
  selected?: number | null;
}) {
  const width = titleWidth(plan.tasks);
  return (
    <Box flexDirection="column">
      {plan.tasks.map((task, i) => {
        const view: TaskView = tasks[task.id] ?? {
          taskId: task.id,
          title: task.title,
          status: 'pending',
          attempt: 0,
          checkpoint: null,
          result: null,
          attempts: [],
        };
        const stopped = !live && view.status === 'running';
        const detail = stopped
          ? 'stopped'
          : taskDetail(task, view, plan, tasks);
        return (
          <Box key={task.id}>
            <Box width={2} flexShrink={0}>
              <Text {...fg('agent')}>{selected === i ? '❯' : ' '}</Text>
            </Box>
            <Box width={2} flexShrink={0}>
              <TaskIcon view={view} live={live} />
            </Box>
            <Box width={width} flexShrink={0}>
              <TaskTitle task={task} />
            </Box>
            <Box flexGrow={1}>
              <Text dimColor wrap="truncate-end">
                {detail}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** `● Workflow: <recipe> (<problem>)` on the left, cost and time on the right. */
function WorkflowHeader({
  recipe,
  problem,
  costUsd,
  elapsedMs,
  bullet,
  suffix = '',
}: {
  recipe: string;
  problem: string | null;
  costUsd: number;
  elapsedMs: number;
  bullet: ColorName;
  suffix?: string;
}) {
  return (
    <Box justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text {...fg(bullet)}>●</Text>{' '}
        <Text bold>
          Workflow: {recipe} ({problem ?? 'new problem'})
        </Text>
        {suffix}
      </Text>
      <Box flexShrink={0} marginLeft={2}>
        <Text dimColor>
          {formatCost(costUsd)} · {formatElapsed(elapsedMs)}
        </Text>
      </Box>
    </Box>
  );
}

/** The time now, updated every second. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The live task tree of the running workflow (sample screen 3), like the
 * Claude Code todo list.
 */
export function PlanView({
  workflow,
  problem,
  costUsd,
  selected = null,
}: {
  workflow: WorkflowView;
  problem: string | null;
  /** The session cost now. The header shows the part since the plan. */
  costUsd: number;
  selected?: number | null;
}) {
  const now = useNow();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <WorkflowHeader
        recipe={workflow.plan.recipe}
        problem={problem}
        costUsd={Math.max(0, costUsd - workflow.costAtStart)}
        elapsedMs={now - workflow.startedAt}
        bullet="agent"
      />
      <PlanTree
        plan={workflow.plan}
        tasks={workflow.tasks}
        live
        selected={selected}
      />
      {selected === null && (
        <Text dimColor>{'  ctrl+o shows the details of a task'}</Text>
      )}
    </Box>
  );
}

/** A finished workflow in the transcript: the final tree and the summary. */
export function WorkflowSummary({
  item,
}: {
  item: Extract<Item, { kind: 'workflow' }>;
}) {
  const lines = item.summary.trim().split('\n');
  return (
    <Box flexDirection="column">
      <WorkflowHeader
        recipe={item.plan.recipe}
        problem={item.problem}
        costUsd={item.costUsd}
        elapsedMs={item.elapsedMs}
        bullet={item.ok ? 'ok' : 'error'}
        suffix={item.ok ? ' done' : ' failed'}
      />
      <PlanTree plan={item.plan} tasks={item.tasks} live={false} />
      {lines.map((line, i) => (
        <Text key={i} {...(item.ok ? {} : fg('error'))}>
          {i === 0 ? '  ⎿ ' : '    '}
          {line}
        </Text>
      ))}
    </Box>
  );
}

/** The status word of a task in its details. */
function statusWord(view: TaskView): string {
  switch (shownStatus(view)) {
    case 'retrying':
      return `attempt ${view.attempt} failed, waits for the next try`;
    case 'running':
      return `running, attempt ${view.attempt}`;
    case 'passed':
      return `passed after ${view.attempt} attempt${view.attempt === 1 ? '' : 's'}`;
    case 'failed':
      return `failed after ${view.attempt} attempt${view.attempt === 1 ? '' : 's'}`;
    case 'skipped':
      return 'skipped';
    default:
      return 'not started';
  }
}

/**
 * The details of one task (ctrl+o, sample screen 4): its files, brief,
 * attempts with their checkpoint digests, and the result.
 */
export function TaskDetails({
  workflow,
  index,
}: {
  workflow: WorkflowView;
  /** Index into `plan.tasks`. */
  index: number;
}) {
  const task = workflow.plan.tasks[index];
  if (!task) return null;
  const view = workflow.tasks[task.id];
  const attempts = view?.attempts ?? [];
  const live = view?.status === 'running';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text>
          <Text bold>{task.id}</Text> <TaskTitle task={task} />
          <Text dimColor> · {view ? statusWord(view) : 'not started'}</Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          files: {task.ownsFiles.length > 0 ? task.ownsFiles.join(', ') : '-'}
        </Text>
        {task.brief.trim().length > 0 && (
          <Text dimColor wrap="truncate-end">
            brief: {firstLine(task.brief)}
          </Text>
        )}
        <Box flexDirection="column" marginTop={1}>
          {attempts.length === 0 && <Text dimColor>No attempts yet.</Text>}
          {attempts.map((a, ai) => (
            <Box key={a.attempt} flexDirection="column">
              <Text>attempt {a.attempt}</Text>
              {a.checkpoints.length === 0 && (
                <Text dimColor>
                  {'  '}
                  {live && ai === attempts.length - 1
                    ? 'working, no checkpoint yet'
                    : 'no checkpoint'}
                </Text>
              )}
              {a.checkpoints.map((cp, ci) => {
                const digest = cp.digest.trim().split('\n');
                const shown = digest.slice(0, MAX_DIGEST_LINES);
                return (
                  <Box key={ci} flexDirection="column">
                    <Text>
                      {'  '}
                      <Text {...fg(cp.ok ? 'ok' : 'error')}>
                        {cp.ok ? '✔' : '✗'}
                      </Text>{' '}
                      {cp.name}
                    </Text>
                    {cp.digest.trim().length > 0 &&
                      shown.map((line, li) => (
                        <Text key={li} dimColor wrap="truncate-end">
                          {'    '}
                          {line}
                        </Text>
                      ))}
                    {digest.length > shown.length && (
                      <Text dimColor>
                        {'    '}… +{digest.length - shown.length} lines
                      </Text>
                    )}
                  </Box>
                );
              })}
            </Box>
          ))}
        </Box>
        {view?.result && (
          <Box marginTop={1}>
            <Text wrap="truncate-end">
              <Text dimColor>result: </Text>
              {firstLine(view.result.summary)}
            </Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>
            tool calls: not available yet (worker tool events have no task id)
          </Text>
        </Box>
      </Box>
      <Text dimColor>{' ↑/↓ choose a task · esc or ctrl+o to close'}</Text>
    </Box>
  );
}
