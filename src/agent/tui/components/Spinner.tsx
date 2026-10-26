import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { fg, type ColorName } from '../theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A small spinner for running tools and the working line. */
export function Spinner({ color = 'agent' }: { color?: ColorName }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);
  return <Text {...fg(color)}>{FRAMES[frame]}</Text>;
}
