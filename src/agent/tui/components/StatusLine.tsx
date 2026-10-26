import { Text } from 'ink';
import type { UiState } from '../store.js';
import { formatCost, formatTokens, modelShortName } from '../theme.js';

/** The last line: problem, model, mode, tokens, cost and the key hint. */
export function StatusLine({
  status,
  hint,
}: {
  status: UiState['status'];
  /** Replaces the end of the line, like "press ctrl+c again to exit". */
  hint?: string | null;
}) {
  const parts = [
    status.problem ?? 'new problem',
    modelShortName(status.model),
    `${status.mode} mode (shift+tab)`,
    `${formatTokens(status.tokens)} tok`,
    formatCost(status.costUsd),
  ];
  if (hint) {
    parts.push(hint);
  } else if (status.busy) {
    parts.push('esc to interrupt');
  }
  return (
    <Text dimColor wrap="truncate-end">
      {' '}
      {parts.join(' · ')}
    </Text>
  );
}
