import { Box, Static } from 'ink';
import type { Item } from '../store.js';
import { Header } from './Header.js';
import { MessageView } from './MessageView.js';

type Row = { kind: 'header'; id: 0 } | Item;

/**
 * The finished part of the chat, in Ink `<Static>`: each row is printed once
 * into the normal scrollback and never drawn again.
 */
export function Transcript({
  items,
  problem,
  model,
}: {
  items: Item[];
  problem: string | null;
  model: string;
}) {
  const rows: Row[] = [{ kind: 'header', id: 0 }, ...items];
  return (
    <Static items={rows} style={{ width: '100%' }}>
      {row =>
        row.kind === 'header' ? (
          <Header key="header" problem={problem} model={model} />
        ) : (
          <Box key={row.id} marginBottom={1}>
            <MessageView item={row} />
          </Box>
        )
      }
    </Static>
  );
}
