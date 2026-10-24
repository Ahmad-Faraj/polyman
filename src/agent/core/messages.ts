/**
 * Provider-neutral message types for the agent. Providers translate these to
 * and from their own wire formats; the agent loop only sees these.
 */

/** One piece of a message's content. */
export type ContentPart =
  /** Plain text from the user or the model. */
  | { type: 'text'; text: string }
  /**
   * Model reasoning, shown in the UI. Only Anthropic needs it back: a part
   * with a `signature` or `redacted` data is sent back unchanged, the rest is
   * never sent back.
   */
  | {
      type: 'reasoning';
      text: string;
      /** Anthropic thinking block signature. */
      signature?: string;
      /** Opaque data of an Anthropic `redacted_thinking` block. */
      redacted?: string;
    }
  /** The model asks to run a tool. `args` is the parsed JSON arguments. */
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  /** The outcome of a tool call, matched to it by `callId`. */
  | { type: 'tool_result'; callId: string; content: string; isError: boolean };

/** A single message in a conversation. */
export interface Message {
  /** Unique id of the message within the conversation. */
  id: string;
  /** Who produced the message. Tool results use the `tool` role. */
  role: 'user' | 'assistant' | 'tool';
  /** The content, in order. */
  parts: ContentPart[];
  /** ISO 8601 creation time. */
  createdAt: string;
}
