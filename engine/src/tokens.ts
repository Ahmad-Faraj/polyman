/**
 * Token counts per model call, read from a Duo session's checkpoint (GraphQL
 * duoWorkflowEvents). Every model reply in the agent graph's conversation
 * history carries its usage: input tokens, split into the part written to the
 * prompt cache, the part read from it and the rest, plus output tokens. The
 * specialists a lead delegates to keep their own history in the same
 * checkpoint ("lead_reviewer__code_reviewer__2"), so one checkpoint holds the
 * whole session.
 *
 * SCI for AI (Green Software Foundation) counts a language model's functional
 * unit per token and an agentic workload's per workflow execution; it doesn't
 * weight token classes. The classes are kept here as activity data: a cache
 * read costs far less compute than an uncached input token, and most of an
 * agent's input is cache reads.
 */

export interface TokenClasses {
  /** model replies that carried usage: the session's model calls, counted, not bounded */
  calls: number;
  /** input tokens neither read from nor written to the prompt cache */
  uncached: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface AgentTokens extends TokenClasses {
  /** the history's key: "lead_reviewer", "lead_reviewer__test_reviewer__3", "issue_builder" */
  agent: string;
  models: string[];
}

export interface SessionTokens {
  status: string | null;
  agents: AgentTokens[];
  /** the text of the first agent's last reply (a skip says "skipped: ...") */
  lastText: string;
  /** the merge request the session worked on, if its history names one */
  mr: number | null;
}

export const NONE: TokenClasses = { calls: 0, uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

export const add = (a: TokenClasses, b: TokenClasses): TokenClasses => ({
  calls: a.calls + b.calls,
  uncached: a.uncached + b.uncached,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
});

export const totalTokens = (t: TokenClasses) => t.uncached + t.cacheWrite + t.cacheRead + t.output;

interface Message {
  type?: string;
  content?: unknown;
  usage_metadata?: { input_tokens?: number; output_tokens?: number; input_token_details?: { cache_creation?: number; cache_read?: number } } | null;
  response_metadata?: { model_name?: string };
}

const text = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : ((c as { text?: string })?.text ?? ''))).join('') : '';

/** The token counts of one session, from its checkpoint (the JSON string GraphQL returns, or parsed). */
export function tokensOf(checkpoint: string | object): SessionTokens {
  const c = (typeof checkpoint === 'string' ? JSON.parse(checkpoint) : checkpoint) as { channel_values?: { status?: string; conversation_history?: Record<string, Message[]> } };
  const history = c.channel_values?.conversation_history ?? {};
  const agents: AgentTokens[] = [];
  let lastText = '';
  for (const [agent, messages] of Object.entries(history)) {
    const t: AgentTokens = { agent, models: [], ...NONE };
    for (const m of messages) {
      const u = m.usage_metadata;
      if (!u) continue;
      const write = u.input_token_details?.cache_creation ?? 0;
      const read = u.input_token_details?.cache_read ?? 0;
      t.calls += 1;
      t.cacheWrite += write;
      t.cacheRead += read;
      t.uncached += Math.max(0, (u.input_tokens ?? 0) - write - read);
      t.output += u.output_tokens ?? 0;
      const model = m.response_metadata?.model_name;
      if (model && !t.models.includes(model)) t.models.push(model);
    }
    agents.push(t);
    if (agents.length === 1) {
      const replies = messages.filter((m) => m.usage_metadata);
      lastText = text(replies.at(-1)?.content).trim();
    }
  }
  return { status: c.channel_values?.status ?? null, agents, lastText, mr: mrOf(typeof checkpoint === 'string' ? checkpoint : JSON.stringify(checkpoint)) };
}

/**
 * The MR a session worked on: the merge_request_iid of its first MR tool call,
 * or the merge request in the pipeline event that started it. Both sit in JSON
 * inside JSON, so quotes come with any number of backslashes.
 */
export function mrOf(raw: string): number | null {
  const q = '[\\\\"]*';
  const fromCall = raw.match(new RegExp(`merge_request_iid${q}:\\s*${q}(\\d+)`))?.[1];
  const fromEvent = raw.match(new RegExp(`merge_request${q}:\\s*\\{${q}id${q}:\\s*\\d+,\\s*${q}iid${q}:\\s*(\\d+)`))?.[1];
  return Number(fromCall ?? fromEvent) || null;
}

// our flows' first agents, as their checkpoints name them; anything else is one of GitLab's own flows
const FLOWS: Record<string, string> = {
  lead_reviewer: 'mr-reviewer',
  builder: 'issue-builder',
  fixer: 'pipeline-fixer',
  responder: 'incident-responder',
};

/** The flow a session belongs to, from its first agent's name ("gitlab: developer_agent" for GitLab's own). */
export function flowOf(agents: AgentTokens[]): string {
  const first = agents[0]?.agent.split('__')[0] ?? '';
  return FLOWS[first] ?? (first ? `gitlab: ${first}` : 'other');
}

/** An agent's role in its session: "lead", or the specialist's name ("code_reviewer"). */
export function roleOf(agent: string): string {
  const parts = agent.split('__');
  return parts.length > 1 ? parts[1] : 'lead';
}

/** The median of a list (0 for none). */
export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
