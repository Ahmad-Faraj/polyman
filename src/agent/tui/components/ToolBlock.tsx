import { Box, Text } from 'ink';
import { fg } from '../theme.js';
import { Spinner } from './Spinner.js';

/** Most lines of a tool summary we show. */
const MAX_LINES = 4;

/** `name(args)`, or only `name` when there are no arguments. */
export function callText(name: string, args: string): string {
  return args.length > 0 ? `${name}(${args})` : name;
}

/**
 * One tool call: `● name(args)` and `  ⎿ summary` under it. While it runs,
 * a spinner and the last progress line.
 */
export function ToolBlock(
  props:
    | { state: 'running'; name: string; args: string; lastLine: string | null }
    | {
        state: 'done';
        name: string;
        args: string;
        ok: boolean;
        summary: string;
      }
) {
  const call = callText(props.name, props.args);
  if (props.state === 'running') {
    return (
      <Box flexDirection="column">
        <Box>
          <Spinner />
          <Text bold> {call}</Text>
        </Box>
        {props.lastLine !== null && (
          <Text dimColor wrap="truncate-end">
            {'  ⎿ '}
            {props.lastLine}
          </Text>
        )}
      </Box>
    );
  }
  const lines = props.summary.trimEnd().split('\n');
  const shown = lines.slice(0, MAX_LINES);
  const more = lines.length - shown.length;
  const summaryColor = props.ok ? {} : fg('error');
  return (
    <Box flexDirection="column">
      <Text>
        <Text {...fg(props.ok ? 'ok' : 'error')}>●</Text>
        <Text bold> {call}</Text>
      </Text>
      {shown.map((line, i) => (
        <Text key={i} dimColor={props.ok} {...summaryColor}>
          {i === 0 ? '  ⎿ ' : '    '}
          {line}
        </Text>
      ))}
      {more > 0 && <Text dimColor>{`    … +${more} lines`}</Text>}
    </Box>
  );
}
