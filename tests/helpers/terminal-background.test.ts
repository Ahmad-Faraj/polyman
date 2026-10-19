import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DA1_QUERY,
  OSC11_QUERY,
  QUERY_TIMEOUT_MS,
  backgroundFromRgb,
  detectBackground,
  parseColorFgBg,
  parseForeground,
  parseOsc11Reply,
  queryBackground,
  relativeLuminance,
  type DetectOptions,
} from '../../src/helpers/terminal-background';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;
const DA1_REPLY = `${ESC}[?62;22c`;
const WHITE_REPLY = `${ESC}]11;rgb:ffff/ffff/ffff${ST}`;
const BLACK_REPLY = `${ESC}]11;rgb:0000/0000/0000${ST}`;

/** Stdin of a terminal; records raw mode changes and listeners. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  rawModes: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModes.push(mode);
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  /** Sends bytes as if the terminal wrote them. */
  reply(data: string): void {
    this.emit('data', Buffer.from(data, 'latin1'));
  }
}

/** Stdout of a terminal; calls `onWrite` so tests can answer queries. */
class FakeStdout {
  isTTY = true;
  written = '';
  onWrite: (data: string) => void = () => {};

  write(data: string): boolean {
    this.written += data;
    this.onWrite(data);
    return true;
  }
}

function expectRestored(stdin: FakeStdin, wasRaw = false): void {
  expect(stdin.isRaw).toBe(wasRaw);
  expect(stdin.listenerCount('data')).toBe(0);
  expect(stdin.paused).toBe(true);
}

describe('parseColorFgBg', () => {
  it('reads the last field as the background', () => {
    expect(parseColorFgBg('0;15')).toBe('light');
    expect(parseColorFgBg('0;7')).toBe('light');
    expect(parseColorFgBg('15;0')).toBe('dark');
    expect(parseColorFgBg('7;8')).toBe('dark');
  });

  it('handles the three-field rxvt form', () => {
    expect(parseColorFgBg('0;default;15')).toBe('light');
    expect(parseColorFgBg('15;default;0')).toBe('dark');
  });

  it('ignores values it cannot parse', () => {
    expect(parseColorFgBg(undefined)).toBeNull();
    expect(parseColorFgBg('')).toBeNull();
    expect(parseColorFgBg('garbage')).toBeNull();
    expect(parseColorFgBg('15;default')).toBeNull();
    expect(parseColorFgBg('0;1.5')).toBeNull();
  });
});

describe('parseOsc11Reply', () => {
  it('reads 4 hex digits per channel with an ST terminator', () => {
    expect(parseOsc11Reply(`${ESC}]11;rgb:ffff/8080/0000${ST}`)).toEqual([
      1,
      0x8080 / 0xffff,
      0,
    ]);
  });

  it('reads 2 hex digits per channel with a BEL terminator', () => {
    expect(parseOsc11Reply(`${ESC}]11;rgb:ff/80/00${BEL}`)).toEqual([
      1,
      0x80 / 0xff,
      0,
    ]);
  });

  it('reads 1 and 3 hex digits per channel', () => {
    expect(parseOsc11Reply(`${ESC}]11;rgb:f/0/f${BEL}`)).toEqual([1, 0, 1]);
    expect(parseOsc11Reply(`${ESC}]11;rgb:fff/000/fff${BEL}`)).toEqual([
      1, 0, 1,
    ]);
  });

  it('accepts rgba replies and upper case hex', () => {
    expect(parseOsc11Reply(`${ESC}]11;rgba:FFFF/FFFF/FFFF/FFFF${ST}`)).toEqual([
      1, 1, 1,
    ]);
  });

  it('finds the reply among other bytes', () => {
    expect(parseOsc11Reply(`x${WHITE_REPLY}${DA1_REPLY}`)).toEqual([1, 1, 1]);
  });

  it('returns null for garbage or unfinished replies', () => {
    expect(parseOsc11Reply('')).toBeNull();
    expect(parseOsc11Reply('rgb:ffff/ffff/ffff')).toBeNull();
    expect(parseOsc11Reply(`${ESC}]11;rgb:ffff/ffff/ffff`)).toBeNull();
    expect(parseOsc11Reply(`${ESC}]11;rgb:ggg/000/000${ST}`)).toBeNull();
    expect(parseOsc11Reply(`${ESC}]11;rgb:fffff/0/0${ST}`)).toBeNull();
    expect(parseOsc11Reply(`${ESC}]10;rgb:ffff/ffff/ffff${ST}`)).toBeNull();
    expect(parseOsc11Reply(DA1_REPLY)).toBeNull();
  });
});

describe('relativeLuminance and backgroundFromRgb', () => {
  it('gives 0 for black and 1 for white', () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([1, 1, 1])).toBeCloseTo(1);
  });

  it('uses 0.5 as the light threshold', () => {
    expect(backgroundFromRgb([1, 1, 1])).toBe('light');
    expect(backgroundFromRgb([0, 0, 0])).toBe('dark');
    // #C0C0C0 has luminance 0.527, #B0B0B0 has 0.434
    expect(backgroundFromRgb([0xc0 / 255, 0xc0 / 255, 0xc0 / 255])).toBe(
      'light'
    );
    expect(backgroundFromRgb([0xb0 / 255, 0xb0 / 255, 0xb0 / 255])).toBe(
      'dark'
    );
  });

  it('classifies common terminal backgrounds', () => {
    const rgb = (hex: string): [number, number, number] => [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
    ];
    expect(backgroundFromRgb(rgb('fdf6e3'))).toBe('light'); // Solarized light
    expect(backgroundFromRgb(rgb('002b36'))).toBe('dark'); // Solarized dark
    expect(backgroundFromRgb(rgb('1e1e1e'))).toBe('dark');
    expect(backgroundFromRgb(rgb('0000ff'))).toBe('dark');
  });
});

describe('parseForeground', () => {
  it('reads /proc/self/stat', () => {
    const stat = (pgrp: number, tpgid: number) =>
      `1234 (node (x) y) S 1000 ${pgrp} 1000 34817 ${tpgid} 4194560 1 2 3`;
    expect(parseForeground(stat(1234, 1234))).toBe(true);
    expect(parseForeground(stat(1234, 999))).toBe(false);
    expect(parseForeground(stat(1234, -1))).toBe(false);
  });

  it('reads ps output', () => {
    expect(parseForeground(' 4321  4321\n')).toBe(true);
    expect(parseForeground(' 4321  1111\n')).toBe(false);
  });

  it('returns null for unknown text', () => {
    expect(parseForeground('')).toBeNull();
    expect(parseForeground('ps: error')).toBeNull();
  });
});

describe('queryBackground', () => {
  let stdin: FakeStdin;
  let stdout: FakeStdout;

  beforeEach(() => {
    vi.useFakeTimers();
    stdin = new FakeStdin();
    stdout = new FakeStdout();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the OSC 11 query followed by DA1 in raw mode', async () => {
    let stateOnWrite = {};
    stdout.onWrite = () => {
      stateOnWrite = {
        isRaw: stdin.isRaw,
        paused: stdin.paused,
        listeners: stdin.listenerCount('data'),
      };
      stdin.reply(DA1_REPLY);
    };
    await queryBackground(stdin, stdout);
    expect(stateOnWrite).toEqual({ isRaw: true, paused: false, listeners: 1 });
    expect(stdout.written).toBe(OSC11_QUERY + DA1_QUERY);
    expect(stdout.written).toBe(`${ESC}]11;?${ESC}\\${ESC}[c`);
  });

  it('returns light for a white background', async () => {
    stdout.onWrite = () => stdin.reply(WHITE_REPLY + DA1_REPLY);
    await expect(queryBackground(stdin, stdout)).resolves.toBe('light');
    expectRestored(stdin);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns dark for a black background', async () => {
    stdout.onWrite = () => stdin.reply(BLACK_REPLY + DA1_REPLY);
    await expect(queryBackground(stdin, stdout)).resolves.toBe('dark');
    expectRestored(stdin);
  });

  it('handles replies split over several chunks', async () => {
    stdout.onWrite = () => {
      stdin.reply(`${ESC}]11;rgb:ff`);
      stdin.reply(`ff/ffff/ffff${BEL}${ESC}[?6`);
      stdin.reply('2;22c');
    };
    await expect(queryBackground(stdin, stdout)).resolves.toBe('light');
    expectRestored(stdin);
  });

  it('keeps reading after the OSC reply until DA1 arrives', async () => {
    const result = queryBackground(stdin, stdout);
    stdin.reply(WHITE_REPLY);
    expect(stdin.listenerCount('data')).toBe(1);
    stdin.reply(DA1_REPLY);
    await expect(result).resolves.toBe('light');
    expectRestored(stdin);
  });

  it('stops at once with null when only DA1 arrives', async () => {
    stdout.onWrite = () => stdin.reply(DA1_REPLY);
    await expect(queryBackground(stdin, stdout)).resolves.toBeNull();
    expectRestored(stdin);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up with null after the timeout when nothing arrives', async () => {
    let settled = false;
    const result = queryBackground(stdin, stdout).then(value => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(QUERY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(stdin.isRaw).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeNull();
    expectRestored(stdin);
  });

  it('uses an OSC reply that came without DA1 when the timeout ends', async () => {
    const result = queryBackground(stdin, stdout, 50);
    stdin.reply(WHITE_REPLY);
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBe('light');
    expectRestored(stdin);
  });

  it('restores raw mode that was already on', async () => {
    stdin.isRaw = true;
    stdout.onWrite = () => stdin.reply(DA1_REPLY);
    await queryBackground(stdin, stdout);
    expect(stdin.rawModes).toEqual([true, true]);
    expectRestored(stdin, true);
  });

  it('ignores bytes that arrive after it finished', async () => {
    stdout.onWrite = () => stdin.reply(DA1_REPLY);
    await queryBackground(stdin, stdout);
    stdin.reply(WHITE_REPLY);
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it('restores stdin when writing the query fails', async () => {
    stdout.onWrite = () => {
      throw new Error('EIO');
    };
    await expect(queryBackground(stdin, stdout)).resolves.toBeNull();
    expectRestored(stdin);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('detectBackground', () => {
  let stdin: FakeStdin;
  let stdout: FakeStdout;

  beforeEach(() => {
    stdin = new FakeStdin();
    stdout = new FakeStdout();
  });

  function options(extra: DetectOptions = {}): DetectOptions {
    return {
      platform: 'linux',
      colorLevel: 3,
      stdin,
      stdout,
      isForeground: () => true,
      ...extra,
    };
  }

  it('uses COLORFGBG before asking the terminal', async () => {
    await expect(
      detectBackground({ COLORFGBG: '0;15' }, options())
    ).resolves.toBe('light');
    await expect(
      detectBackground({ COLORFGBG: '15;0' }, options())
    ).resolves.toBe('dark');
    expect(stdout.written).toBe('');
  });

  it('asks the terminal when COLORFGBG is missing or unparsable', async () => {
    stdout.onWrite = () => stdin.reply(WHITE_REPLY + DA1_REPLY);
    await expect(detectBackground({}, options())).resolves.toBe('light');
    stdout.written = '';
    await expect(
      detectBackground({ COLORFGBG: 'garbage' }, options())
    ).resolves.toBe('light');
    expect(stdout.written).toBe(OSC11_QUERY + DA1_QUERY);
  });

  it('returns null when the terminal only answers DA1', async () => {
    stdout.onWrite = () => stdin.reply(DA1_REPLY);
    await expect(detectBackground({}, options())).resolves.toBeNull();
    expectRestored(stdin);
  });

  describe('skips detection', () => {
    const skipCases: [string, NodeJS.ProcessEnv, () => DetectOptions][] = [
      ['on Windows', {}, () => options({ platform: 'win32' })],
      ['when colors are off', {}, () => options({ colorLevel: 0 })],
      ['when TERM=dumb', { TERM: 'dumb' }, () => options()],
      [
        'when stdout is not a TTY',
        {},
        () => {
          stdout.isTTY = false;
          return options();
        },
      ],
      [
        'when stdin is not a TTY',
        {},
        () => {
          stdin.isTTY = false;
          return options();
        },
      ],
    ];

    for (const [name, env, makeOptions] of skipCases) {
      it(name, async () => {
        const result = await detectBackground(
          { ...env, COLORFGBG: '0;15' },
          makeOptions()
        );
        expect(result).toBeNull();
        expect(stdout.written).toBe('');
        expect(stdin.rawModes).toEqual([]);
      });
    }

    it('when stdin cannot switch to raw mode', async () => {
      const plain = {
        isTTY: true,
        on: vi.fn(),
        removeListener: vi.fn(),
        resume: vi.fn(),
        pause: vi.fn(),
      };
      await expect(
        detectBackground({}, options({ stdin: plain }))
      ).resolves.toBeNull();
      expect(stdout.written).toBe('');
    });

    it('sends no query from a background job', async () => {
      await expect(
        detectBackground({}, options({ isForeground: () => false }))
      ).resolves.toBeNull();
      expect(stdout.written).toBe('');
      expect(stdin.rawModes).toEqual([]);
    });
  });
});
