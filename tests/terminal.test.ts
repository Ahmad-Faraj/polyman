import { afterEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { colorDisabled, configureTerminal, isAgentMode } from '../src/terminal';

describe('isAgentMode', () => {
  it('is true only for POLYMAN_AGENT=1', () => {
    expect(isAgentMode({ POLYMAN_AGENT: '1' })).toBe(true);
    expect(isAgentMode({ POLYMAN_AGENT: '0' })).toBe(false);
    expect(isAgentMode({ POLYMAN_AGENT: '' })).toBe(false);
    expect(isAgentMode({})).toBe(false);
  });
});

describe('colorDisabled', () => {
  it('keeps colors on for a terminal with a clean environment', () => {
    expect(colorDisabled({}, true)).toBe(false);
  });

  it('disables colors when stdout is not a terminal', () => {
    expect(colorDisabled({}, false)).toBe(true);
  });

  it('disables colors for a non-empty NO_COLOR', () => {
    expect(colorDisabled({ NO_COLOR: '1' }, true)).toBe(true);
    expect(colorDisabled({ NO_COLOR: 'anything' }, true)).toBe(true);
  });

  it('ignores an empty NO_COLOR', () => {
    expect(colorDisabled({ NO_COLOR: '' }, true)).toBe(false);
  });

  it('disables colors in agent mode', () => {
    expect(colorDisabled({ POLYMAN_AGENT: '1' }, true)).toBe(true);
  });
});

describe('configureTerminal', () => {
  const original = chalk.level;

  afterEach(() => {
    chalk.level = original;
  });

  it('sets chalk.level to 0 for NO_COLOR', () => {
    chalk.level = 3;
    configureTerminal({ NO_COLOR: '1' }, true);
    expect(chalk.level).toBe(0);
    expect(chalk.red('x')).toBe('x');
  });

  it('sets chalk.level to 0 for POLYMAN_AGENT=1', () => {
    chalk.level = 3;
    configureTerminal({ POLYMAN_AGENT: '1' }, true);
    expect(chalk.level).toBe(0);
  });

  it('sets chalk.level to 0 when stdout is not a terminal', () => {
    chalk.level = 3;
    configureTerminal({}, false);
    expect(chalk.level).toBe(0);
  });

  it('leaves chalk alone on a plain terminal', () => {
    chalk.level = 3;
    configureTerminal({}, true);
    expect(chalk.level).toBe(3);
  });
});
