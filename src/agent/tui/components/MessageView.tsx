import { Box, Text } from 'ink';
import type { Item } from '../store.js';
import { fg } from '../theme.js';
import { Markdown } from './Markdown.js';
import { ToolBlock } from './ToolBlock.js';

/** An assistant message: a blue `●` and the markdown text. */
export function AssistantText({ text }: { text: string }) {
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text {...fg('agent')}>●</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown text={text} />
      </Box>
    </Box>
  );
}

/** One finished item of the transcript. */
export function MessageView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return (
        <Box>
          <Box width={2} flexShrink={0}>
            <Text bold>{'>'}</Text>
          </Box>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case 'assistant':
      return <AssistantText text={item.text} />;
    case 'tool':
      return (
        <ToolBlock
          state="done"
          name={item.name}
          args={item.args}
          ok={item.ok}
          summary={item.summary}
        />
      );
    case 'notice': {
      const color =
        item.level === 'error'
          ? fg('error')
          : item.level === 'warn'
            ? fg('warn')
            : {};
      return (
        <Text dimColor={item.level === 'info'} {...color}>
          {item.text}
        </Text>
      );
    }
  }
}
