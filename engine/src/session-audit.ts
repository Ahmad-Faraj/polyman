import { type LedgerRecord, flowOf } from './ledger.ts';
import { mrOf } from './tokens.ts';

/**
 * The session audit: a check with no model in it of what the Duo agents did.
 * It reads what GitLab recorded about each agent session (the session list,
 * each session's trace and its checkpoint), finds every push an agent made,
 * and holds each one against the go-ahead ledger and the go-ahead guard's
 * runs. An agent push that neither accepted is a broken rule.
 *
 * The trace (REST .../workflows/:id/trace.jsonl) is the session's log as the
 * UI shows it: the goal, and the lead agent's tool calls with their output
 * and a time. It leaves out the specialists a lead delegates to, and those
 * push too (the reviewer's fixes): only the checkpoint (GraphQL
 * duoWorkflowEvents) holds every agent's tool calls, without times. So both
 * are read, and a call in both is counted once.
 */

/** A session as GraphQL's duoWorkflowWorkflows lists it: the fields the audit reads. */
export interface SessionNode {
  /** gid://gitlab/Ai::DuoWorkflows::Workflow/<id> */
  id: string;
  createdAt: string;
  updatedAt: string;
  /** FINISHED, FAILED, STOPPED, RUNNING, ... */
  status: string | null;
  /** ai_catalog_agent for our flows, code_review/v1 for GitLab's own review */
  workflowDefinition: string | null;
  /** the catalog item's name: "mr-reviewer", "issue-builder", ... */
  agentName: string | null;
  title: string | null;
  /** created, but no checkpoint was ever written */
  stalled?: boolean | null;
  mergeRequest?: { iid: string } | null;
  workItem?: { iid: string } | null;
  preApprovedAgentPrivilegesNames?: string[] | null;
  webUrl?: string | null;
}

/** One line of trace.jsonl: a channel's value ("goal", "status") or a ui_chat_log entry. */
export interface TraceLine {
  channel?: string;
  value?: unknown;
  message_type?: string;
  message_id?: string;
  timestamp?: string;
  status?: string;
  component_name?: string | null;
  tool_info?: { name: string; args?: Record<string, unknown>; tool_response?: unknown } | string | null;
}

/** One tool call an agent made, from the trace, the checkpoint or both. */
export interface ToolCall {
  id: string;
  /** the agent that made it: "builder", "lead_reviewer__code_reviewer__1" */
  agent: string;
  name: string;
  args: Record<string, unknown>;
  /** what the tool answered, as text */
  response: string;
  ok: boolean;
  /** when the trace logged it; null for a call only the checkpoint has */
  at: string | null;
}

/** The trace's lines; a line that isn't JSON is counted, not guessed at. */
export function parseTrace(text: string): { lines: TraceLine[]; bad: number } {
  const lines: TraceLine[] = [];
  let bad = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as TraceLine);
    } catch {
      bad += 1;
    }
  }
  return { lines, bad };
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c === 'string' ? c : ((c as { text?: string })?.text ?? ''))).join('')
      : content === undefined || content === null
        ? ''
        : JSON.stringify(content);

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const listOf = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isObject) : []);

const objectOf = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      return objectOf(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
};

interface CheckpointMessage {
  type?: string;
  content?: unknown;
  status?: string;
  tool_call_id?: string;
  tool_calls?: { id?: string; name?: string; args?: unknown }[];
  additional_kwargs?: unknown;
}

/**
 * Every tool call in a session: the checkpoint's (every agent, no times) and
 * the trace's (the lead, with times), joined on the call's id, which both use.
 */
export function callsOf(trace: TraceLine[], checkpoint: object | null): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  // calls the checkpoint has without their result: the trace's answer is the one to go by
  const unanswered = new Set<string>();
  // what GitLab stored is read as it comes: an entry that isn't the shape expected is left out, not a crash
  const history = objectOf(objectOf(objectOf(checkpoint).channel_values).conversation_history);
  for (const [agent, value] of Object.entries(history)) {
    if (!Array.isArray(value)) continue;
    const messages = value.filter(isObject) as CheckpointMessage[];
    const results = new Map<string, CheckpointMessage>();
    for (const m of messages) if (typeof m.tool_call_id === 'string') results.set(m.tool_call_id, m);
    for (const m of messages) {
      // newer checkpoints list tool_calls; older ones only additional_kwargs (as in tokens.ts's fixture)
      const listed = Array.isArray(m.tool_calls) && m.tool_calls.length
        ? (m.tool_calls.filter(isObject) as { id?: unknown; name?: unknown; args?: unknown }[]).map((t) => ({ id: t.id, name: t.name, args: objectOf(t.args) }))
        : (listOf(objectOf(m.additional_kwargs).tool_calls) as { id?: unknown; function?: unknown }[]).map((t) => ({
            id: t.id,
            name: objectOf(t.function).name,
            args: objectOf(objectOf(t.function).arguments),
          }));
      for (const t of listed) {
        if (typeof t.id !== 'string' || typeof t.name !== 'string' || !t.id || !t.name) continue;
        const result = results.get(t.id);
        if (!result) unanswered.add(t.id);
        calls.set(t.id, { id: t.id, agent, name: t.name, args: t.args, response: textOf(result?.content), ok: (result?.status ?? 'success') === 'success', at: null });
      }
    }
  }
  for (const line of trace) {
    if (!isObject(line) || !line.tool_info || typeof line.message_id !== 'string' || !line.message_id) continue;
    const info = objectOf(line.tool_info) as { name?: unknown; args?: unknown; tool_response?: unknown };
    if (typeof info.name !== 'string' || !info.name) continue;
    const at = typeof line.timestamp === 'string' ? line.timestamp : null;
    const known = calls.get(line.message_id);
    if (known) {
      known.at = at;
      if (unanswered.has(known.id)) {
        known.response = textOf(info.tool_response);
        known.ok = (line.status ?? 'success') === 'success';
      }
      continue;
    }
    calls.set(line.message_id, {
      id: line.message_id,
      agent: typeof line.component_name === 'string' ? line.component_name : '',
      name: info.name,
      args: objectOf(info.args),
      response: textOf(info.tool_response),
      ok: (line.status ?? 'success') === 'success',
      at,
    });
  }
  return [...calls.values()];
}

/** A push an agent made, read from a tool call and what it answered. */
export interface AgentPush {
  session: number;
  flow: string;
  agent: string;
  tool: string;
  call: string;
  /** the branch it moved (null: the command didn't say and git's output didn't either) */
  branch: string | null;
  /** the branch head after the push, as short as git printed it (null: not printed) */
  head: string | null;
  /** the push created the branch */
  created: boolean;
  /** git (or GitLab) took it; a rejected push is listed but moved nothing */
  landed: boolean;
  /** when the trace logged the call; null for a specialist's call, known only from the checkpoint */
  at: string | null;
  /** the line of output, or the command, the push was read from */
  evidence: string;
}

/**
 * One ref line of git push's output: "   a1aae58..0064ed4  main -> main", " * [new branch]  x -> x".
 * The flag (none for a plain update) is the first character that isn't a space,
 * so a run of spaces is read once: tool output is the agent's to write, and an
 * ambiguous pattern takes seconds on a long one.
 */
const REF = /^\s*(?:([+\-*!=])\s+)?(\[[^\]]+\]|[0-9a-f]{7,40}\.\.\.?[0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)/;
/** Longer than two of the longest branch names GitLab takes and two full shas: not a line git wrote. */
const REF_MAX = 1024;

/** The refs a git push's output says it moved (or refused), from each "To <remote>" block. */
export function pushedRefs(output: string): { branch: string; head: string | null; created: boolean; landed: boolean; line: string }[] {
  const refs: { branch: string; head: string | null; created: boolean; landed: boolean; line: string }[] = [];
  let inBlock = false;
  for (const line of output.split(/\r?\n/)) {
    if (/^To \S+/.test(line)) {
      inBlock = true;
      continue;
    }
    const m = inBlock && line.length <= REF_MAX ? REF.exec(line) : null;
    if (!m) {
      inBlock = false;
      continue;
    }
    const [, flag, summary, , to] = m;
    const refused = flag === '!' || /rejected/.test(summary);
    if (flag === '=') continue; // up to date: nothing moved
    refs.push({
      branch: to.replace(/^refs\/heads\//, ''),
      head: /\.\./.test(summary) ? summary.split(/\.\.\.?/)[1] : null,
      created: summary === '[new branch]',
      landed: !refused,
      line: line.trim(),
    });
  }
  return refs;
}

/** A shell word as written, quotes and all: `-m "a b"` is two, `x"y z"` one. */
const WORD = /(?:"(?:[^"\\]|\\[\s\S])*"|'[^']*'|\\[\s\S]|[^\s"'\\])+/g;
const unquote = (word: string) =>
  word.replace(/"((?:[^"\\]|\\[\s\S])*)"|'([^']*)'|\\([\s\S])/g, (_, dq?: string, sq?: string, esc?: string) => dq?.replace(/\\([\s\S])/g, '$1') ?? sq ?? esc ?? '');

/**
 * A shell command's simple commands: split at ; & && || | ( ) and newlines
 * outside quotes, with what $( ) and backticks run (inside double quotes too,
 * where the shell runs them as well) as commands of their own.
 */
function commandsOf(command: string): string[] {
  const parts: string[] = [];
  const outer = command.replace(/\$\(([^()]*)\)|`([^`]*)`/g, (_, sub?: string, tick?: string) => {
    for (const part of commandsOf(sub ?? tick ?? '')) parts.push(part);
    return ' ';
  });
  let part = '';
  let quote = '';
  for (let i = 0; i < outer.length; i++) {
    const ch = outer[i];
    if (ch === '\\' && quote !== "'") part += ch + (outer[++i] ?? '');
    else if (quote) {
      part += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      part += ch;
      quote = ch;
    } else if (';|()\n'.includes(ch) || (ch === '&' && outer[i - 1] !== '>' && outer[i + 1] !== '>')) {
      // `2>&1` and `&>file` are redirections, not a command run in the background
      parts.push(part);
      part = '';
    } else part += ch;
  }
  parts.push(part);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Words that only run the command after them. */
const RUNNERS = ['env', 'command', 'exec', 'nohup', 'time', 'sudo'];
/** git subcommands that print nothing a push's output could be taken for: no message or file content at the start of a line. */
const QUIET_GIT = ['add', 'commit', 'push', 'fetch', 'pull', 'checkout', 'switch', 'status', 'branch', 'rebase', 'reset', 'stash', 'rm', 'mv', 'merge', 'restore'];
/** Commands that run code given in their arguments, where a push can sit in a string. */
const INTERPRETERS = /(^|\/)(python[0-9.]*|node|perl|ruby|php|xargs)$/;

/** What a shell command does about pushing. */
interface CommandRead {
  /** the branch each git push names (null: the current branch) */
  branches: (string | null)[];
  /** it has a git push in a form not read here (`python -c "..."`, `xargs git push`) */
  unparsed: boolean;
  /** something other than git (or cd, tail, head) runs in it, and could print what it likes */
  prints: boolean;
  /** something other than git prints in it (echo, printf, a script): it could write a ref line git never did */
  forges: boolean;
}

function readCommand(command: string, depth = 0): CommandRead {
  const read: CommandRead = { branches: [], unparsed: false, prints: false, forges: false };
  for (const segment of commandsOf(command)) {
    const raw = segment.match(WORD) ?? [];
    // VAR=1, { and !, and the runners with their options (env -u NAME)
    let k = 0;
    while (k < raw.length) {
      if (/^\w+=/.test(raw[k]) || ['{', '}', '!'].includes(raw[k])) k++;
      else if (RUNNERS.includes(raw[k])) {
        k++;
        while (k < raw.length && raw[k].startsWith('-')) k += raw[k] === '-u' ? 2 : 1;
      } else break;
    }
    const words = raw.slice(k).map(unquote);
    const cmd = words[0] ?? '';
    // a shell given the command as a string (sh -c "...", bash -lc '...') or eval: the string is a command too
    const c = /(^|\/)(ba|da|k|z)?sh$/.test(cmd) ? words.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w)) : -1;
    const script = c > 0 ? words[c + 1] : cmd === 'eval' ? words.slice(1).join(' ') : undefined;
    if (script !== undefined && depth < 4) {
      const inner = readCommand(script, depth + 1);
      for (const b of inner.branches) read.branches.push(b);
      read.unparsed ||= inner.unparsed;
      read.prints ||= inner.prints;
      read.forges ||= inner.forges;
      continue;
    }
    const isGit = /(^|\/)git$/.test(cmd);
    const pushed = isGit ? gitPush(words) : null;
    if (pushed) {
      for (const b of pushed) read.branches.push(b);
      continue;
    }
    // git and push as words of their own, not in a commit message or a pattern to grep for
    const bare = raw.slice(k).filter((w) => !/["']/.test(w));
    if ((bare.some((w) => /(^|\/)git$/.test(w)) && bare.includes('push')) || (INTERPRETERS.test(cmd) && /\bgit\b[\s\S]*\bpush\b/.test(segment))) read.unparsed = true;
    const filter = ['tail', 'head'].includes(cmd) && words.slice(1).every((w, i) => w.startsWith('-') || (/^\d+$/.test(w) && words[i] === '-n'));
    if (cmd && cmd !== 'cd' && !filter && !(isGit && QUIET_GIT.includes(words[gitSubcommand(words)]))) {
      read.prints = true;
      if (!isGit) read.forges = true;
    }
  }
  return read;
}

/** Where a git command's subcommand is, after git's own options: -C <dir>, -c <key=value>, --no-pager. */
function gitSubcommand(words: string[]): number {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += words[i] === '-C' || words[i] === '-c' ? 2 : 1;
  return i;
}

/** The branches a `git push` names (null: the current branch); null for any other git command. */
function gitPush(words: string[]): (string | null)[] | null {
  const i = gitSubcommand(words);
  if (words[i] !== 'push') return null;
  const positional: string[] = [];
  for (let j = i + 1; j < words.length; j++) {
    if (['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(words[j])) j++;
    else if (!words[j].startsWith('-') && !/^[0-9&]?>/.test(words[j])) positional.push(words[j]);
    else if (/^[0-9&]?>>?$/.test(words[j])) j++; // a redirection's target
  }
  const refspecs = positional.slice(1).filter((r) => !/^--/.test(r));
  if (!refspecs.length) return [null];
  return refspecs.map((r) => {
    const dst = r
      .replace(/^\+/, '')
      .split(':')
      .pop()!
      .replace(/^refs\/heads\//, '');
    return dst && dst !== 'HEAD' ? dst : null;
  });
}

/**
 * The branches each `git push` in a shell command names (null where it names
 * none: the current branch), also through `sh -c "..."`, `eval`, `env`,
 * `VAR=1`, `command`, a subshell and `$( )`.
 */
export const pushesInCommand = (command: string): (string | null)[] => readCommand(command).branches;

const failed = (output: string) => /\[(remote )?rejected\]|^fatal: |^error: |failed to push/m.test(output);

/**
 * A command or a line of output with its credentials taken out: a token in a
 * remote's URL (https://oauth2:glpat-...@host), a GitLab token anywhere, an // gitleaks:allow
 * auth header. What a push was read from goes into the report, a public artifact.
 */
export const redact = (text: string) =>
  text
    // userinfo up to the last @ before the host: a password can hold / or @
    .replace(/:\/\/\S*@(?=[^\s@]*(?:\s|$))/g, '://[redacted]@')
    .replace(/:\/\/[^\s/@:]+(?::[^\s/@]*)?@/g, '://[redacted]@')
    .replace(/\b(glpat|gldt|glptt|glcbt|glrt|gloas|glsoat|glffct|glimt|glagent|glft|glwt)[-_][\w-]{8,}/g, '$1-[redacted]')
    .replace(/\b(ghp|gho|ghs|ghu|ghr|github_pat)_\w{10,}/g, '$1_[redacted]')
    .replace(/\b(authorization|private-token|job-token)(\\?["']?\s*[:=]\s*\\?["']?)((?:bearer|basic)\s+)?[^\s"'\\]+/gi, '$1$2$3[redacted]')
    .replace(/\b(bearer|basic)(\s+)(?!\[redacted\])[^\s"'\\]+/gi, '$1$2[redacted]')
    // NAME_TOKEN=..., export AUDIT_TOKEN=..., ?private_token=..., access_token=...
    .replace(/\b(\w*(?:token|secret|password|passwd|api_?key)\w*)=("[^"]*"|'[^']*'|[^\s&"';]+)/gi, '$1=[redacted]');

/** The pushes among a session's tool calls: git push in a shell, GitLab's git tool, and its commit API. */
export function pushesOf(calls: ToolCall[], session: { id: number; flow: string }): AgentPush[] {
  const pushes: AgentPush[] = [];
  const base = (c: ToolCall) => ({ session: session.id, flow: session.flow, agent: c.agent, tool: c.name, call: c.id, at: c.at });
  for (const c of calls) {
    if (c.name === 'create_commit') {
      // GitLab's commits API: it makes the commit on the branch itself, so it is a push
      const branch = typeof c.args.branch === 'string' ? c.args.branch : null;
      const head = /"id":\s*"([0-9a-f]{40})"/.exec(c.response)?.[1] ?? null;
      const landed = c.ok && !/^\s*(error|failed)/i.test(c.response);
      pushes.push({ ...base(c), branch, head, created: typeof c.args.start_branch === 'string', landed, evidence: redact(`create_commit on ${branch ?? '?'}`) });
      continue;
    }
    const command =
      c.name === 'run_command' && typeof c.args.command === 'string'
        ? c.args.command
        : c.name === 'run_git_command' && c.args.command === 'push'
          ? `git push ${typeof c.args.args === 'string' ? c.args.args : ''}`
          : null;
    if (command === null) continue;
    const refs = pushedRefs(c.response);
    const read = readCommand(command);
    // when something besides git could have printed (echo, printf, a script),
    // a ref line may be forged: its branch still counts as a push, but its head
    // and its "rejected" don't, so it is matched by time and judged
    for (const r of refs) pushes.push({ ...base(c), branch: r.branch, head: read.forges ? null : r.head, created: r.created, landed: read.forges || r.landed, evidence: redact(r.line) });
    // the output says what a push did, but a push with -q prints nothing, and
    // anything else in the command can print a push's lines: so each push the
    // command asks for counts too, unless the output shows it. A branch
    // shows by name; the current branch only as a ref no named push claims,
    // and only when nothing but git (and cd, tail, head) could have printed it.
    const named = new Set(read.branches.filter((b) => b !== null));
    const shown = new Set(refs.map((r) => r.branch));
    let unclaimed = read.prints ? 0 : refs.filter((r) => !named.has(r.branch)).length;
    const asked = read.branches.filter((b) => {
      if (b !== null) return !shown.has(b);
      unclaimed -= 1;
      return unclaimed < 0;
    });
    // git says "Everything up-to-date" once for each push that moved nothing
    const upToDate = read.prints ? 0 : (c.response.match(/^Everything up-to-date\r?$/gm) ?? []).length;
    // Only git's own failure text says a quiet push didn't land, and only when
    // nothing else ran: the command's exit code, or an "error:" line, can come
    // from anything after it (`&& npm test`, `; echo "error: x"`). When unsure
    // it landed: a false "unjudged" is cheap, a missed push is not.
    const landed = read.prints || !failed(c.response);
    const evidence = redact(command.split('\n')[0]).slice(0, 200);
    if (asked.length > upToDate) for (const branch of asked) pushes.push({ ...base(c), branch, head: null, created: false, landed, evidence });
    // a push in a form not read here (python -c "...", xargs git push): nothing can be matched to it, so it is unjudged
    if (read.unparsed) pushes.push({ ...base(c), branch: null, head: null, created: false, landed: true, evidence });
  }
  return pushes;
}

/** Privileges that let an agent change something: files, GitLab, a shell, git, other flows, MCP tools (which can do anything their server allows). */
export const WRITE_PRIVILEGES = ['read_write_files', 'read_write_gitlab', 'run_commands', 'use_git', 'run_mcp_tools', 'start_flows'];

export const writePrivileges = (names: string[] | null | undefined) => (names ?? []).filter((n) => WRITE_PRIVILEGES.includes(n));

export const workflowId = (gid: string) => Number(gid.split('/').pop());

/** What GitLab recorded about one session, and what the audit read of it. */
export interface SessionReport {
  id: number;
  url: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  /** the catalog agent ("mr-reviewer") or, for GitLab's own flows, the definition ("code_review/v1") */
  flow: string;
  mr: number | null;
  issue: number | null;
  /** privileges GitLab let the agent use without asking a person for each tool call */
  preApproved: string[];
  /** where its tool calls were read from */
  read: { trace: boolean; checkpoint: boolean };
  /** the session delegated to specialists but has no checkpoint, so their calls weren't seen */
  unseen: boolean;
  calls: number;
  pushes: AgentPush[];
}

/** One session's report, from its list entry, its trace and its checkpoint (null where GitLab gave none). */
export function sessionReport(node: SessionNode, web: string, trace: TraceLine[] | null, checkpoint: object | null): SessionReport {
  const id = workflowId(node.id);
  const flow = node.agentName && node.workflowDefinition === 'ai_catalog_agent' ? node.agentName : (node.workflowDefinition ?? node.agentName ?? 'unknown');
  const calls = callsOf(trace ?? [], checkpoint);
  const goal = trace?.find((l) => isObject(l) && l.channel === 'goal')?.value;
  const text = typeof goal === 'string' ? goal : '';
  // what GitLab linked, else what it wrote into the goal: "Context: {Issue IID: 27}"
  // after a mention, or the pipeline event that started the session
  const issue = Number(node.workItem?.iid) || Number(/Context: \{Issue IID: (\d+)\}/.exec(text)?.[1]) || null;
  const mr = Number(node.mergeRequest?.iid) || Number(/Context: \{MergeRequest IID: (\d+)\}/.exec(text)?.[1]) || (text && !issue ? mrOf(text) : null);
  return {
    id,
    url: node.webUrl ?? `${web}/-/automate/agent-sessions/${id}`,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    status: (node.status ?? 'UNKNOWN').toUpperCase(),
    flow,
    mr,
    issue,
    preApproved: node.preApprovedAgentPrivilegesNames ?? [],
    read: { trace: trace !== null, checkpoint: checkpoint !== null },
    unseen: checkpoint === null && calls.some((c) => c.name === 'delegate_task'),
    calls: calls.length,
    pushes: pushesOf(calls, { id, flow }),
  };
}

const MINUTE = 60_000;
const time = (iso: string) => Date.parse(iso);
const OUR_FLOWS = ['issue-builder', 'mr-reviewer', 'pipeline-fixer', 'incident-responder'];

/**
 * The ledger record for a push: the same branch and, when git printed it, the
 * same head. Without a head, the same flow and a record time near the push
 * (within 10 minutes of the trace's time, or inside the session for a
 * specialist's push, which has no time).
 */
export function ledgerRecordFor(push: AgentPush, session: Pick<SessionReport, 'createdAt' | 'updatedAt'>, records: LedgerRecord[], used: Set<number>): LedgerRecord | undefined {
  const head = headOf(push);
  return records.find((r) => {
    if (used.has(r.seq) || !push.branch || r.branch !== push.branch) return false;
    if (head) return sameSha(r.head, head);
    if (OUR_FLOWS.includes(push.flow) && r.flow !== push.flow) return false;
    const at = time(r.pushed_at);
    return push.at ? Math.abs(at - time(push.at)) <= 10 * MINUTE : at >= time(session.createdAt) - MINUTE && at <= time(session.updatedAt) + MINUTE;
  });
}

const sameSha = (a: string, b: string) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));
/** The push's head if it is long enough to name a commit (git prints at least 7 characters): a shorter one is no head. */
const headOf = (push: AgentPush) => (push.head && push.head.length >= 7 ? push.head : null);

/**
 * The order to judge pushes in: those with a head first, so a push the guard
 * names by sha gets its own line before a headless push could take it by time.
 * Indexes into `pushes`, stable otherwise.
 */
export const judgingOrder = (pushes: AgentPush[]): number[] =>
  pushes.map((p, i) => [headOf(p) ? 0 : 1, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, i]) => i);

/** A guard line's identity: every run re-lists the pushes before it, so the same line comes back as a new object in each run's log. */
const lineKey = (l: GuardLine) => `${l.at}|${l.pusher}|${l.shas.join(',')}`;

/** One push the guard judged, as its job log says: "push at T by @agent (shas): go-ahead in note N by @person", or the reason it refused it. */
export interface GuardLine {
  at: string;
  pusher: string;
  /** the commits the push brought (8 characters), or the head it left for a push that brought none */
  shas: string[];
  accepted: boolean;
  text: string;
}

const PUSH_LINE = /push at (\S+) by @(\S+) \(([^)]*)\)(.*)$/;
const COMMIT_LINE = /commit ([0-9a-f]{8}) pushed by @(\S+) (is a merge commit|changes files only people may change)/;

/**
 * The pushes an autonomy:goahead log judges (goahead-mr.ts writes these
 * lines). A push it accepted can still be refused for a commit it brought (a
 * merge, a file only people may change): that line names the commit.
 */
export function guardLines(log: string): GuardLine[] {
  const lines: GuardLine[] = [];
  const problems: { sha: string; pusher: string; text: string }[] = [];
  // a job log can carry carriage returns (progress lines): a line ends at either
  for (const raw of log.split(/\r?\n|\r/)) {
    const commit = COMMIT_LINE.exec(raw);
    if (commit) {
      problems.push({ sha: commit[1], pusher: commit[2], text: raw.slice(commit.index).trim() });
      continue;
    }
    const m = PUSH_LINE.exec(raw);
    if (!m) continue;
    const [, at, pusher, shas, rest] = m;
    lines.push({
      at,
      pusher,
      shas: shas.startsWith('no new commits, head ') ? [shas.slice(21)] : shas.split(', '),
      accepted: /^(?: on #\d+)?: go-ahead in note \d+/.test(rest),
      text: raw.slice(m.index).trim(),
    });
  }
  for (const p of problems) {
    const line = lines.find((l) => l.pusher === p.pusher && l.shas.includes(p.sha));
    if (line) {
      line.accepted = false;
      line.text += `; ${p.text}`;
    }
  }
  return lines;
}

/** The guard's line for a push: the same head when git printed one, else the same flow near the same time (or inside the session). */
export function guardLineFor(push: AgentPush, session: Pick<SessionReport, 'createdAt' | 'updatedAt'>, lines: GuardLine[], used = new Set<string>()): GuardLine | undefined {
  const head = headOf(push);
  const fits = lines.filter((l) => !used.has(lineKey(l)) && (!OUR_FLOWS.includes(push.flow) || flowOf(l.pusher) === push.flow));
  let line: GuardLine | undefined;
  if (head) line = fits.find((l) => l.shas.some((s) => sameSha(s, head)));
  else {
    // without a head, the nearest line in time; but if any line in reach
    // refuses, that is the answer: a neighbouring push's go-ahead doesn't cover
    // this one, and a refusal wrongly given costs a person a look, not a miss
    const away = (l: GuardLine) => (push.at ? Math.abs(time(l.at) - time(push.at)) : 0);
    const near = fits
      .filter((l) => (push.at ? away(l) <= 10 * MINUTE : time(l.at) >= time(session.createdAt) - MINUTE && time(l.at) <= time(session.updatedAt) + MINUTE))
      .sort((a, b) => away(a) - away(b));
    line = near.find((l) => !l.accepted) ?? near[0];
  }
  // a go-ahead covers one push: once matched it is used (a refusal stays for every push it reaches)
  if (line?.accepted) used.add(lineKey(line));
  return line;
}

/** An autonomy:goahead job on a pipeline of the MR whose branch the push moved. */
export interface GuardRun {
  pipeline: number;
  sha: string;
  status: string;
  /** when the pipeline was created */
  at: string;
  /** when the autonomy:goahead job started (null: it didn't): it reads the MR's pushes then */
  started: string | null;
  /** the pushes its log judges (null: the log wasn't read) */
  lines: GuardLine[] | null;
}

/** What GitLab says about the branch a push moved: its newest MR (null: none) and the guard's runs on it. */
export interface GuardFacts {
  mr: { iid: number; state: string; closedAt: string | null } | null;
  runs: GuardRun[];
}

export type Verdict = 'ledger' | 'guard' | 'before guard' | 'pending' | 'not landed' | 'refused' | 'unjudged';

/** Verdicts that break the rule: an agent push that nothing accepted. */
export const BREAKS: Verdict[] = ['refused', 'unjudged'];

export interface PushCheck extends AgentPush {
  mr: number | null;
  verdict: Verdict;
  why: string;
}

/** How long an open MR's guard may take to judge a push before the audit stops waiting: a pipeline that never ran it is not "pending" forever. */
export const GRACE_MS = 2 * 60 * MINUTE;

const DECIDED = ['success', 'failed'];
const RUNNING = ['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled'];

export interface Evidence {
  /** the ledger record that matches the push */
  record?: LedgerRecord;
  /** the guard's runs on the push's MR, for a push the ledger doesn't have */
  facts?: GuardFacts;
  /** when the guard reached the default branch (the ledger's since): pushes before it weren't asked to wait */
  guardSince?: string | null;
  /** the guard's go-ahead lines already matched to a push, by what the line says: each covers one */
  used?: Set<string>;
  now: Date;
}

/**
 * A push's verdict. A ledger record says it all for a merged MR. Otherwise
 * the guard's own line for the push in its newest decided run since the push
 * (each run judges every agent push of the MR again, one by one).
 */
export function judge(push: AgentPush, session: Pick<SessionReport, 'createdAt' | 'updatedAt'>, e: Evidence): PushCheck {
  const { record, facts } = e;
  // the branch is matched as written, but reported redacted: an agent can name a branch after a token
  const out = (verdict: Verdict, why: string): PushCheck => ({ ...push, branch: push.branch === null ? null : redact(push.branch), mr: record?.mr ?? facts?.mr?.iid ?? null, verdict, why: redact(why) });
  if (!push.landed) return out('not landed', `the push was refused: ${push.evidence}`);
  if (record) {
    return record.accepted
      ? out('ledger', `ledger record ${record.seq}: go-ahead in note ${record.go_ahead?.note} by @${record.go_ahead?.by}`)
      : out('refused', `ledger record ${record.seq} refuses it: ${record.reasons.join('; ')}`);
  }
  // a specialist's push has no time of its own: the session's end bounds it
  const latest = time(push.at ?? session.updatedAt);
  if (e.guardSince && latest < time(e.guardSince)) return out('before guard', `pushed before the go-ahead guard reached the default branch (${e.guardSince})`);
  if (!push.branch) return out('unjudged', `the push names no branch (${push.evidence}), so nothing can be matched to it`);
  const from = time(push.at ?? session.createdAt) - 2 * MINUTE;
  const since = (facts?.runs ?? []).filter((r) => time(r.at) >= from).sort((a, b) => time(b.at) - time(a.at));
  const decided = since.filter((r) => DECIDED.includes(r.status));
  for (const run of decided) {
    // a log GitLab didn't give (expired after 30 days, refused): what that run said of the push isn't known
    if (run.lines === null) return out('unjudged', `autonomy:goahead ${run.status === 'success' ? 'passed' : 'failed'} on pipeline ${run.pipeline}, but its log was not readable`);
    const line = guardLineFor(push, session, run.lines, e.used);
    if (line) return out(line.accepted ? 'guard' : 'refused', `autonomy:goahead on pipeline ${run.pipeline}: ${line.text}`);
  }
  const newest = decided[0];
  // a newer run still going will judge the push: wait for it, but not for ever (a run stuck in "created" never will)
  const newer = newest && since.find((r) => RUNNING.includes(r.status) && time(r.at) > time(newest.at) && e.now.getTime() - time(r.at) < GRACE_MS);
  if (newer) return out('pending', `autonomy:goahead is ${newer.status} on pipeline ${newer.pipeline}, newer than the run that ${newest.status === 'success' ? 'passed' : 'failed'}`);
  if (newest?.status === 'success') {
    // a passed run whose log judges no push saw no agent push to judge: that
    // covers this one only if it ran after the push, at its head or with its
    // job started after it (the guard reads the MR's pushes when it starts)
    const head = headOf(push);
    const after = (head !== null && sameSha(newest.sha, head)) || (newest.started !== null && time(newest.started) >= latest);
    if (!newest.lines?.length && after) return out('guard', `autonomy:goahead passed on pipeline ${newest.pipeline}, after the push, and its log judges no agent push`);
    return out(
      'unjudged',
      newest.lines?.length
        ? `autonomy:goahead passed on pipeline ${newest.pipeline}, but no run's log names this push`
        : `autonomy:goahead passed on pipeline ${newest.pipeline}, which judges no push and started before this one, not at its head`,
    );
  }
  if (decided.length) return out('unjudged', `autonomy:goahead failed on pipeline ${newest.pipeline}, and no run's log names this push`);
  const running = since.find((r) => RUNNING.includes(r.status));
  if (running) return out('pending', `autonomy:goahead is ${running.status} on pipeline ${running.pipeline}`);
  if (!facts?.mr) return out('unjudged', `no merge request has ${push.branch} as its branch, so no guard judged this push`);
  const { mr } = facts;
  if (mr.closedAt && time(mr.closedAt) < from) return out('unjudged', `!${mr.iid} was ${mr.state} at ${mr.closedAt}, before the push, so no guard ran for it; no later MR has this branch`);
  const others = since.length ? ` (it was ${[...new Set(since.map((r) => r.status))].join(', ')})` : '';
  if (mr.state === 'opened' && e.now.getTime() - from < GRACE_MS) return out('pending', `!${mr.iid} is open and autonomy:goahead hasn't judged it since the push yet${others}`);
  const state = mr.closedAt ? `${mr.state} at ${mr.closedAt}` : mr.state;
  return out('unjudged', `autonomy:goahead never passed or failed on !${mr.iid} (${state}) after the push${others}, and no ledger record has it`);
}

export interface Audit {
  project: string;
  window: { from: string; to: string };
  ledger: { url: string; records: number; head: string } | null;
  /** why the ledger wasn't used, if it wasn't */
  ledgerProblem: string | null;
  sessions: SessionReport[];
  pushes: PushCheck[];
  /** sessions whose trace or checkpoint GitLab didn't give when asked: a push in them may not be seen */
  unread: number[];
}

export interface Summary {
  sessions: number;
  byFlow: Record<string, number>;
  byStatus: Record<string, number>;
  failed: number[];
  stopped: number[];
  pushes: number;
  breaks: PushCheck[];
  pending: number;
  /** sessions not read in full */
  unread: number;
  /** sessions that ran with a write privilege pre-approved, and how many had each */
  writable: { sessions: number; byPrivilege: Record<string, number> };
}

const tally = (xs: string[]) => xs.reduce<Record<string, number>>((n, x) => ({ ...n, [x]: (n[x] ?? 0) + 1 }), {});

export function summarize(audit: Audit): Summary {
  const s = audit.sessions;
  const writable = s.filter((x) => writePrivileges(x.preApproved).length);
  return {
    sessions: s.length,
    byFlow: tally(s.map((x) => x.flow)),
    byStatus: tally(s.map((x) => x.status)),
    failed: s.filter((x) => x.status === 'FAILED').map((x) => x.id),
    stopped: s.filter((x) => x.status === 'STOPPED').map((x) => x.id),
    pushes: audit.pushes.length,
    breaks: audit.pushes.filter((p) => BREAKS.includes(p.verdict)),
    pending: audit.pushes.filter((p) => p.verdict === 'pending').length,
    unread: audit.unread.length,
    writable: { sessions: writable.length, byPrivilege: tally(writable.flatMap((x) => writePrivileges(x.preApproved))) },
  };
}

/**
 * 1 when an agent push has no accepted go-ahead; 2 when there is none, but a
 * session wasn't read in full, so the audit couldn't finish; 0 when every
 * agent push has a go-ahead on record (or is still waiting for the guard).
 */
export const exitCode = (summary: Summary) => (summary.breaks.length ? 1 : summary.unread ? 2 : 0);

/**
 * Where the window starts: "48h" back from now, a date (its midnight UTC) or a
 * time. Nothing: the last 24 hours.
 */
export function windowStart(value: string | undefined, now: Date): string {
  if (!value) return new Date(now.getTime() - 24 * 60 * MINUTE).toISOString();
  const hours = /^(\d+)h$/.exec(value);
  if (hours) return new Date(now.getTime() - Number(hours[1]) * 60 * MINUTE).toISOString();
  if (/^\d{4}-\d\d-\d\d$/.test(value)) return `${value}T00:00:00.000Z`;
  if (/^\d{4}-\d\d-\d\dT/.test(value) && !Number.isNaN(time(value))) return new Date(time(value)).toISOString();
  throw new Error(`--since takes hours back (48h), a date (2026-10-17) or a time (2026-10-17T12:00:00Z), not ${value}`);
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const list = (r: Record<string, number>) =>
  Object.entries(r)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || 'none';

/** The audit as markdown: the verdict, every agent push, the counts, then every session. */
export function renderAudit(audit: Audit, summary: Summary = summarize(audit)): string {
  const out: string[] = [];
  out.push(`# Agent session audit: ${audit.project}`, '');
  out.push(
    `Sessions updated from ${audit.window.from} to ${audit.window.to}: ${summary.sessions} (${list(summary.byFlow)}). Read from what GitLab recorded: the session list, each session's trace and checkpoint, the go-ahead ledger and the autonomy:goahead jobs. No model was asked anything.`,
    '',
  );
  out.push(
    audit.ledger
      ? `Ledger: ${audit.ledger.url} (${audit.ledger.records} records, head ${audit.ledger.head.slice(0, 12)}).`
      : `Ledger: not used (${audit.ledgerProblem ?? 'none given'}); every push was checked against the guard's runs only.`,
    '',
  );
  out.push(
    summary.breaks.length
      ? `**Rule broken: ${summary.breaks.length} agent push(es) without an accepted go-ahead.**`
      : summary.unread
        ? `**Not finished: ${summary.unread} session(s) weren't read in full. Every agent push found has a go-ahead on record${summary.pending ? ` or is waiting for the guard (${summary.pending})` : ''}.**`
        : `**Every agent push has a go-ahead on record${summary.pending ? ` or is waiting for the guard (${summary.pending})` : ''}.**`,
    '',
  );

  out.push(`## Agent pushes (${summary.pushes})`, '');
  if (audit.pushes.length) {
    out.push('| Session | Flow | Agent | Branch | Head | At | MR | Verdict | Why |', '|---|---|---|---|---|---|---|---|---|');
    for (const p of audit.pushes) {
      out.push(
        `| ${p.session} | ${p.flow} | ${cell(p.agent)} | ${cell(p.branch ?? '?')}${p.created ? ' (new)' : ''} | ${p.head ?? ''} | ${p.at ? p.at.slice(0, 19) + 'Z' : 'in session'} | ${p.mr ? `!${p.mr}` : ''} | ${BREAKS.includes(p.verdict) ? `**${p.verdict}**` : p.verdict} | ${cell(p.why)} |`,
      );
    }
  } else out.push('No agent pushed in this window.');
  out.push('');

  out.push('## Counts', '');
  out.push(`- Status: ${list(summary.byStatus)}.`);
  out.push(
    `- Failed: ${summary.failed.length}${summary.failed.length ? ` (${summary.failed.join(', ')})` : ''}. Stopped: ${summary.stopped.length}${summary.stopped.length ? ` (${summary.stopped.join(', ')})` : ''}.`,
  );
  const unseen = audit.sessions.filter((s) => s.unseen).map((s) => s.id);
  if (audit.unread.length) out.push(`- Not read in full: ${audit.unread.length} session(s) whose trace or checkpoint GitLab didn't give (${audit.unread.join(', ')}); a push in them may not show here.`);
  if (unseen.length) out.push(`- Specialists not seen: ${unseen.length} session(s) delegated but have no checkpoint (${unseen.join(', ')}); only the lead's calls were read.`);
  out.push(
    `- For information: ${summary.writable.sessions} of ${summary.sessions} session(s) ran with write privileges pre-approved (${list(summary.writable.byPrivilege)}), so no person approved their tool calls one by one. Their pushes are what the go-ahead guard and this audit check.`,
  );
  out.push('');

  out.push(`## Sessions (${summary.sessions})`, '');
  out.push('| Session | Created | Flow | Status | MR / issue | Tool calls | Pushes | Read from |', '|---|---|---|---|---|---|---|---|');
  for (const s of audit.sessions) {
    const read = [s.read.trace && 'trace', s.read.checkpoint && 'checkpoint'].filter(Boolean).join(' + ') || 'nothing';
    out.push(
      `| [${s.id}](${s.url}) | ${s.createdAt.slice(0, 16)}Z | ${s.flow} | ${s.status} | ${s.mr ? `!${s.mr}` : s.issue ? `#${s.issue}` : ''} | ${s.calls} | ${s.pushes.length} | ${read}${s.unseen ? ' (specialists unseen)' : ''} |`,
    );
  }
  return out.join('\n') + '\n';
}
