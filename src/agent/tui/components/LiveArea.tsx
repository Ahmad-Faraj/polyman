import { Box, Text } from 'ink';
import { tailLines } from '../layout.js';
import type { UiState } from '../store.js';
import { AssistantText } from './MessageView.js';
import { Spinner } from './Spinner.js';
import { ToolBlock } from './ToolBlock.js';

/** The last line of the reasoning, cut to fit one line. */
function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return lines[lines.length - 1] ?? '';
}

/**
 * The part that is redrawn: the answer while it streams, the running tools
 * with their last progress line, and a working line while the agent thinks.
 */
export function LiveArea({
  live,
  busy,
  maxLines = Infinity,
  width = 80,
}: {
  live: UiState['live'];
  busy: boolean;
  /**
   * Most lines the streamed answer may use. A longer answer shows its end
   * only; the whole answer is printed when it is done.
   */
  maxLines?: number;
  /** The terminal width. */
  width?: number;
}) {
  const streaming = live.streamingText.trim();
  const idle = streaming.length === 0 && live.runningTools.length === 0;
  // The bullet takes 2 columns, the "lines above" line takes 1 line.
  let tail = { text: streaming, hidden: 0 };
  if (Number.isFinite(maxLines)) {
    tail = tailLines(streaming, maxLines, width - 2);
    if (tail.hidden > 0) tail = tailLines(streaming, maxLines - 1, width - 2);
  }
  return (
    <Box flexDirection="column">
      {tail.hidden > 0 && (
        <Text dimColor>{`  … ${tail.hidden} lines above`}</Text>
      )}
      {streaming.length > 0 && (
        <Box marginBottom={1}>
          <AssistantText text={tail.text} />
        </Box>
      )}
      {live.runningTools.map(t => (
        <Box key={t.callId} marginBottom={1}>
          <ToolBlock
            state="running"
            name={t.name}
            args={t.args}
            lastLine={t.lastLine}
          />
        </Box>
      ))}
      {busy && idle && (
        <Box marginBottom={1}>
          <Spinner />
          <Text dimColor wrap="truncate-end">
            {live.reasoning.trim().length > 0
              ? ` Thinking: ${lastLine(live.reasoning)}`
              : ' Working…'}
          </Text>
        </Box>
      )}
    </Box>
  );
}
