import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { footprintArgs, ifManifest } from '../src/manifest.ts';
import { DEFAULT_SCI, sessionGrams } from '../src/sci.ts';

describe('Impact Framework manifest', () => {
  const runs = new Map([
    ['high', [{ at: '2026-10-17T10:00:00Z', seconds: 1152, calls: { low: 41, high: 99 } }]],
    ['low', [{ at: '2026-10-17T12:00:00Z', seconds: 102, calls: { low: 6, high: 15 } }]],
  ]);
  const m = parse(ifManifest(runs, DEFAULT_SCI));

  it('has one child per tier, one input per review, with the measured and bounded values', () => {
    expect(Object.keys(m.tree.children)).toEqual(['high-risk-reviews', 'low-risk-reviews']);
    expect(m.tree.children['high-risk-reviews'].inputs).toEqual([
      { timestamp: '2026-10-17T10:00:00Z', duration: 1152, 'runner-hours': 0.32, 'model-calls-low': 41, 'model-calls-high': 99 },
    ]);
  });

  it('carries the coefficients as defaults, so if-run gets the same arithmetic as sci.ts', () => {
    const d = m.tree.children['low-risk-reviews'].defaults;
    // (2 vCPU x (0.71 + 0.5 x (4.26 - 0.71)) W / 1000 + 8 GB x 0.000392) x PUE 1.1
    expect(d['runner-kw']).toBeCloseTo(((2 * (0.71 + 0.5 * 3.55)) / 1000 + 8 * 0.000392) * 1.1, 12);
    expect(d).toMatchObject({ 'embodied-g-per-hour': 2.4, 'grid-g-per-kwh': 560 });
    expect(d['kwh-per-call-low']).toBeCloseTo(0.00024, 12);
    expect(d['kwh-per-call-high']).toBeCloseTo(0.0025, 12);
  });

  it('uses only builtin Multiply and Sum, ending in carbon-low and carbon-high', () => {
    const plugins = Object.values(m.initialize.plugins) as { method: string; path: string }[];
    expect(new Set(plugins.map((p) => `${p.path}:${p.method}`))).toEqual(new Set(['builtin:Multiply', 'builtin:Sum']));
    expect(m.tree.children['high-risk-reviews'].pipeline.compute.slice(-2)).toEqual(['carbon-low', 'carbon-high']);
    expect(m.aggregation).toEqual({ metrics: ['carbon-low', 'carbon-high'], type: 'horizontal' });
  });

  it("gives, run through its own Multiply and Sum steps, the same grams as sessionGrams", () => {
    const child = m.tree.children['high-risk-reviews'];
    const plugins = m.initialize.plugins as Record<string, { method: string; config: { 'input-parameters': string[]; 'output-parameter': string } }>;
    const row: Record<string, number> = { ...child.defaults, ...child.inputs[0] };
    for (const step of child.pipeline.compute as string[]) {
      const { method, config } = plugins[step];
      const xs = config['input-parameters'].map((k) => row[k]);
      row[config['output-parameter']] = method === 'Multiply' ? xs.reduce((a, b) => a * b, 1) : xs.reduce((a, b) => a + b, 0);
    }
    const g = sessionGrams(1152, { low: 41, high: 99 }, DEFAULT_SCI);
    expect(row['carbon-low']).toBeCloseTo(g.low, 9);
    expect(row['carbon-high']).toBeCloseTo(g.high, 9);
  });

  it('writes nothing for no reviews, and keeps an unknown tier as its own child', () => {
    expect(parse(ifManifest(new Map(), DEFAULT_SCI)).tree.children).toEqual({});
    expect(Object.keys(parse(ifManifest(new Map([['unknown', []]]), DEFAULT_SCI)).tree.children)).toEqual(['unknown-risk-reviews']);
  });

  it('the committed manifest has the reviews the table in SUSTAINABILITY.md counts', () => {
    const committed = parse(readFileSync('../sustainability/agent-reviews.yml', 'utf8'));
    expect(committed.tree.children['high-risk-reviews'].inputs).toHaveLength(43);
    expect(committed.tree.children['low-risk-reviews'].inputs).toHaveLength(6);
  });
});

describe("agent-footprint's arguments", () => {
  it('takes a project, --json, and --manifest as FILE or =FILE', () => {
    expect(footprintArgs(['group/p', '--json', '--manifest', 'm.yml'])).toEqual({ project: 'group/p', json: true, manifest: 'm.yml' });
    expect(footprintArgs(['--manifest=m.yml'])).toEqual({ json: false, manifest: 'm.yml' });
    expect(footprintArgs([])).toEqual({ json: false });
  });

  it('refuses a missing manifest file, an option where the file should be, and unknown options', () => {
    expect(() => footprintArgs(['--manifest'])).toThrow('--manifest needs a file name');
    expect(() => footprintArgs(['--manifest', '--json'])).toThrow('--manifest needs a file name');
    expect(() => footprintArgs(['--manifest='])).toThrow('--manifest needs a file name');
    expect(() => footprintArgs(['--jsn'])).toThrow('unknown option --jsn');
    expect(() => footprintArgs(['a/b', 'c/d'])).toThrow('one project only');
  });
});
