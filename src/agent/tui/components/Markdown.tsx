import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { lexer, type Token, type Tokens } from 'marked';
import { fg } from '../theme.js';

/** Draws inline tokens (bold, code, links, ...) as nested `<Text>`. */
function inline(tokens: Token[] | undefined, keyBase: string): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    const key = `${keyBase}.${i}`;
    switch (t.type) {
      case 'strong':
        return (
          <Text key={key} bold>
            {inline((t as Tokens.Strong).tokens, key)}
          </Text>
        );
      case 'em':
        return (
          <Text key={key} italic>
            {inline((t as Tokens.Em).tokens, key)}
          </Text>
        );
      case 'del':
        return (
          <Text key={key} strikethrough>
            {inline((t as Tokens.Del).tokens, key)}
          </Text>
        );
      case 'codespan':
        return (
          <Text key={key} {...fg('code')}>
            {(t as Tokens.Codespan).text}
          </Text>
        );
      case 'link': {
        const link = t as Tokens.Link;
        return (
          <Text key={key} underline>
            {inline(link.tokens, key)}
          </Text>
        );
      }
      case 'image':
        return <Text key={key}>{(t as Tokens.Image).text}</Text>;
      case 'br':
        return <Text key={key}>{'\n'}</Text>;
      case 'text': {
        const text = t as Tokens.Text;
        return (
          <Text key={key}>
            {text.tokens ? inline(text.tokens, key) : text.text}
          </Text>
        );
      }
      default:
        return <Text key={key}>{'text' in t ? String(t.text) : t.raw}</Text>;
    }
  });
}

/** Draws one block token (heading, paragraph, list, code, ...). */
function block(t: Token, key: string): ReactNode {
  switch (t.type) {
    case 'space':
      return null;
    case 'heading':
      return (
        <Text key={key} bold>
          {inline((t as Tokens.Heading).tokens, key)}
        </Text>
      );
    case 'paragraph':
      return (
        <Text key={key}>{inline((t as Tokens.Paragraph).tokens, key)}</Text>
      );
    case 'text': {
      const text = t as Tokens.Text;
      return (
        <Text key={key}>
          {text.tokens ? inline(text.tokens, key) : text.text}
        </Text>
      );
    }
    case 'code':
      return (
        <Box key={key} paddingLeft={2}>
          <Text {...fg('code')}>{(t as Tokens.Code).text}</Text>
        </Box>
      );
    case 'list': {
      const list = t as Tokens.List;
      const start = typeof list.start === 'number' ? list.start : 1;
      return (
        <Box key={key} flexDirection="column">
          {list.items.map((item, i) => (
            <Box key={`${key}.${i}`}>
              <Text>{list.ordered ? `${start + i}. ` : '- '}</Text>
              <Box flexDirection="column" flexGrow={1}>
                {item.tokens.map((child, j) =>
                  block(child, `${key}.${i}.${j}`)
                )}
              </Box>
            </Box>
          ))}
        </Box>
      );
    }
    case 'blockquote':
      return (
        <Box key={key} flexDirection="column" paddingLeft={2}>
          <Text dimColor>{(t as Tokens.Blockquote).text}</Text>
        </Box>
      );
    case 'hr':
      return (
        <Text key={key} dimColor>
          ────────
        </Text>
      );
    default:
      return <Text key={key}>{t.raw.replace(/\n+$/, '')}</Text>;
  }
}

/**
 * A small terminal markdown renderer on the `marked` lexer: bold headings,
 * lists, inline code and code blocks in another color. No highlighting.
 */
export function Markdown({ text }: { text: string }) {
  // Ink counts a tab as one column but the terminal moves to the next tab
  // stop, so lines get longer than Ink thinks and the redraw breaks.
  const blocks = lexer(text.replace(/\t/g, '    ')).filter(
    t => t.type !== 'space'
  );
  return (
    <Box flexDirection="column" gap={1}>
      {blocks.map((t, i) => block(t, String(i)))}
    </Box>
  );
}
