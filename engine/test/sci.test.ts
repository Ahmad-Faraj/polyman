import { describe, expect, it } from 'vitest';
import { DEFAULT_SCI, footprint } from '../src/sci.ts';

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
