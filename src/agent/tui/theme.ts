/**
 * Colors of the chat. `NO_COLOR` turns them all off (https://no-color.org).
 *
 * The helpers return props to spread (`<Text {...fg('agent')}>`), because
 * `exactOptionalPropertyTypes` does not let us pass `color={undefined}`.
 */

const PALETTE = {
  /** The agent: the bullet of its messages and the approval box. */
  agent: 'blue',
  ok: 'green',
  error: 'red',
  /** Warnings and TL. */
  warn: '#f5a623',
  /** The TO tag. */
  info: 'cyan',
  /** Inline code and code blocks. */
  code: 'magenta',
  /** Added lines of a diff. */
  added: 'green',
  /** Removed lines of a diff. */
  removed: 'red',
} as const;

export type ColorName = keyof typeof PALETTE;

/** True when the user asked for no colors. */
export function noColor(): boolean {
  const value = process.env['NO_COLOR'];
  return value !== undefined && value !== '';
}

/** The color value, or undefined when colors are off. */
export function colorOf(name: ColorName): string | undefined {
  return noColor() ? undefined : PALETTE[name];
}

/** `color` prop for `<Text>`. */
export function fg(name: ColorName): { color?: string } {
  const color = colorOf(name);
  return color === undefined ? {} : { color };
}

/** `borderColor` prop for `<Box>`. */
export function border(name: ColorName): { borderColor?: string } {
  const color = colorOf(name);
  return color === undefined ? {} : { borderColor: color };
}

/** `google/gemma-4-31b-it:free` becomes `gemma-4-31b:free`. */
export function modelShortName(model: string): string {
  const name = model.slice(model.lastIndexOf('/') + 1);
  return name.replace(/-it(?=$|:)/, '');
}

/** 12345 tokens become `12.3k`. */
export function formatTokens(tokens: number): string {
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * 0.0123 becomes `$0.01`. Small costs keep 3 digits: `$0.004`. A cost under
 * $0.001 is `<$0.001`, so a paid call never looks free (`$0.000`).
 */
export function formatCost(costUsd: number): string {
  if (costUsd > 0 && costUsd < 0.001) return '<$0.001';
  const digits = costUsd > 0 && costUsd < 0.01 ? 3 : 2;
  return `$${costUsd.toFixed(digits)}`;
}
