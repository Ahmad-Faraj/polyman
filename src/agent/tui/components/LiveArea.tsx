import { Box, Text } from 'ink';
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
}: {
  live: UiState['live'];
  busy: boolean;
}) {
  const streaming = live.streamingText.trim();
  const idle = streaming.length === 0 && live.runningTools.length === 0;
  return (
    <Box flexDirection="column">
      {streaming.length > 0 && (
        <Box marginBottom={1}>
          <AssistantText text={streaming} />
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
