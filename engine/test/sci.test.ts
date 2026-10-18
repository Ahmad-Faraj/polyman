import { describe, expect, it } from 'vitest';
import { DEFAULT_SCI, INFERENCE_WH_PER_CALL, callsOf, checkpointsMissing, footprint, inferenceGrams, modelCalls, sessionGrams } from '../src/sci.ts';

describe('footprint', () => {
  it('is zero for no jobs', () => {
    expect(footprint([]).totalGrams).toBe(0);
  });

  it('matches a hand calculation for one hour on the default runner', () => {
    const f = footprint([{ name: 'test', duration: 3600 }]);
    // 2 vCPU at (0.71 + 0.5 * 3.55) W, plus 8 GB * 0.392 W, times PUE 1.1
    const kwh = ((2 * (0.71 + 0.5 * 3.55)) / 1000 + 8 * 0.000392) * 1.1;
    expect(f.energyKwh).toBeCloseTo(kwh, 9);
    expect(f.operationalGrams).toBeCloseTo(kwh * DEFAULT_SCI.gridGramsPerKwh, 6);
    expect(f.embodiedGrams).toBeCloseTo(2 * DEFAULT_SCI.embodiedGramsPerVcpuHour, 6);
  });

  it('scales linearly with runner time', () => {
    const one = footprint([{ name: 'a', duration: 600 }]);
    const two = footprint([{ name: 'a', duration: 600 }, { name: 'b', duration: 600 }]);
    expect(two.totalGrams).toBeCloseTo(one.totalGrams * 2, 9);
  });
});

describe('model inference per session', () => {
  // a checkpoint line as the runner writes it
  const at = (t: string) => `2026-10-17T23:17:${t}Z 01E 2026-10-17T23:17:39:970 [debug]: [DuoWorkflowNodeExecutor][9644451] Received new checkpoint: {"workflowStatus":"CREATED"}`;

  it('bounds the model calls: every checkpoint at most, the ones 3 s or more after the last at least', () => {
    // start, a model call (+5 s), a tool step (+0.2 s), a model call (+4 s), finish (+0.1 s)
    const log = [at('00.000000'), at('05.000000'), at('05.200000'), at('09.200000'), 'other line', at('09.300000')].join('\n');
    expect(modelCalls(log)).toEqual({ low: 2, high: 5 });
    expect(modelCalls('no checkpoints here')).toEqual({ low: 0, high: 0 });
    expect(modelCalls(at('00.000000'))).toEqual({ low: 0, high: 1 });
  });

  it('counts a gap of exactly 3 s, not 2.999 s', () => {
    expect(modelCalls([at('00.000'), at('03.000')].join('\n')).low).toBe(1);
    expect(modelCalls([at('00.000'), at('02.999')].join('\n')).low).toBe(0);
  });

  it('reads timestamps of any precision, and CRLF logs', () => {
    expect(modelCalls([at('00'), at('05'), at('10')].join('\n'))).toEqual({ low: 2, high: 3 });
    expect(modelCalls([at('00.123'), at('05.123')].join('\r\n'))).toEqual({ low: 1, high: 2 });
  });

  it("doesn't count text that only quotes the phrase: unstamped lines, tool results, a diff of sci.ts", () => {
    const log = [
      at('00.000000'),
      'Received new checkpoint: 1',
      '2026-10-17T23:17:02.000000Z 01O+ "content": "...Received new checkpoint: {..."',
      "+    .filter((line) => line.includes('Received new checkpoint'))",
      at('05.000000'),
    ].join('\n');
    expect(modelCalls(log)).toEqual({ low: 1, high: 2 });
  });

  it('matches only at the start of a line and with the runner\'s stream marker', () => {
    // the same text after a prefix, or with a different marker, isn't a checkpoint line
    expect(modelCalls(`x ${at('00.000')}`)).toEqual({ low: 0, high: 0 });
    expect(modelCalls(at('00.000').replace(' 01E ', ' xx '))).toEqual({ low: 0, high: 0 });
    // a CRLF line still counts (the \\r is not part of the match)
    expect(modelCalls(`${at('00.000')}\r\n${at('05.000')}\r\n`)).toEqual({ low: 1, high: 2 });
  });

  it('pairs the fewest calls with the lower energy figure and the most with the higher', () => {
    // 50 x 0.24 Wh = 12 Wh, 100 x 2.5 Wh = 250 Wh; at 560 g/kWh: 6.72 and 140 g
    const g = inferenceGrams({ low: 50, high: 100 }, 560);
    expect(g.low).toBeCloseTo(6.72, 5);
    expect(g.high).toBeCloseTo(140, 5);
    expect(INFERENCE_WH_PER_CALL).toEqual({ low: 0.24, high: 2.5 });
    expect(inferenceGrams({ low: 0, high: 0 }, 100)).toEqual({ low: 0, high: 0 });
  });

  it('adds up and averages a group of sessions, and puts runner and inference together', () => {
    const xs = [{ calls: { low: 4, high: 10 } }, { calls: { low: 2, high: 5 } }];
    expect(callsOf(xs)).toEqual({ low: 6, high: 15 });
    expect(callsOf(xs, 2)).toEqual({ low: 3, high: 7.5 });
    expect(callsOf([])).toEqual({ low: 0, high: 0 });
    const runner = footprint([{ name: 'agent', duration: 600 }], DEFAULT_SCI).totalGrams;
    const g = sessionGrams(600, { low: 3, high: 7.5 }, DEFAULT_SCI);
    expect(g.low).toBeCloseTo(runner + inferenceGrams({ low: 3, high: 7.5 }, DEFAULT_SCI.gridGramsPerKwh).low, 12);
    expect(g.high).toBeCloseTo(runner + inferenceGrams({ low: 3, high: 7.5 }, DEFAULT_SCI.gridGramsPerKwh).high, 12);
    expect(sessionGrams(0, { low: 0, high: 0 }, DEFAULT_SCI)).toEqual({ low: 0, high: 0 });
  });
});

describe('a session whose log shows no checkpoints', () => {
  it('is flagged when it ran for a while, not when it was only a few seconds or has checkpoints', () => {
    expect(checkpointsMissing(120, { low: 0, high: 0 })).toBe(true);
    expect(checkpointsMissing(5, { low: 0, high: 0 })).toBe(false);
    expect(checkpointsMissing(120, { low: 0, high: 3 })).toBe(false);
  });
});
