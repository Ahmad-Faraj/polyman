import { describe, expect, it } from 'vitest';
import { DEFAULT_SCI, INFERENCE_WH_PER_CALL, footprint, inferenceGrams, modelCalls } from '../src/sci.ts';

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
  const at = (t: string) => `2026-10-17T23:17:${t}Z 01E [DuoWorkflowNodeExecutor][1] Received new checkpoint: {}`;

  it('bounds the model calls: every checkpoint at most, the ones 3 s or more after the last at least', () => {
    // start, a model call (+5 s), a tool step (+0.2 s), a model call (+4 s), finish (+0.1 s)
    const log = [at('00.000000'), at('05.000000'), at('05.200000'), at('09.200000'), 'other line', at('09.300000')].join('\n');
    expect(modelCalls(log)).toEqual({ low: 2, high: 5 });
    expect(modelCalls('no checkpoints here')).toEqual({ low: 0, high: 0 });
  });

  it('pairs the fewest calls with the lower energy figure and the most with the higher', () => {
    // 50 x 0.24 Wh = 12 Wh, 100 x 2.5 Wh = 250 Wh; at 560 g/kWh: 6.72 and 140 g
    const g = inferenceGrams({ low: 50, high: 100 }, 560);
    expect(g.low).toBeCloseTo(6.72, 5);
    expect(g.high).toBeCloseTo(140, 5);
    expect(INFERENCE_WH_PER_CALL).toEqual({ low: 0.24, high: 2.5 });
  });
});
