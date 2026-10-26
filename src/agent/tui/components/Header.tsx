import { Box, Text } from 'ink';
import { fg, modelShortName } from '../theme.js';

/** The first line of the chat, printed once. */
export function Header({
  problem,
  model,
}: {
  problem: string | null;
  model: string;
}) {
  return (
    <Box marginBottom={1}>
      <Text>
        {' '}
        <Text bold {...fg('agent')}>
          polyman chat
        </Text>
        <Text dimColor>
          {' · '}
          {problem ?? 'new problem'}
          {' · '}
          {modelShortName(model)} (OpenRouter)
          {' · '}
          /help for commands
        </Text>
      </Text>
    </Box>
  );
}
