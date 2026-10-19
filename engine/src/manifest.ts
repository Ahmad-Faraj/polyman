/**
 * The agent footprint as an Impact Framework manifest (Green Software
 * Foundation, MIT), so anyone can recompute it with `if-run` from the same
 * inputs: per review, the runner hours and the bounded model calls, and the
 * coefficients from .autonomy.yml and sci.ts. Only builtin Multiply and Sum
 * plugins, so every step of the arithmetic is in the file.
 */
import { stringify } from 'yaml';
import { INFERENCE_WH_PER_CALL, type SciCoefficients } from './sci.ts';

export interface ManifestRun {
  at: string;
  seconds: number;
  calls: { low: number; high: number };
}

const multiply = (inputs: string[], output: string) => ({ method: 'Multiply', path: 'builtin', config: { 'input-parameters': inputs, 'output-parameter': output } });
const sum = (inputs: string[], output: string) => ({
  method: 'Sum',
  path: 'builtin',
  config: { 'input-parameters': inputs, 'output-parameter': output },
  'parameter-metadata': {
    outputs: { [output]: { unit: 'gCO2e', description: `${output} for one review`, 'aggregation-method': { time: 'sum', component: 'sum' } } },
  },
});

/** One review as agent-tokens.ts saved it (--json): its tier and its counted model calls. */
export interface CountedSession {
  at: string;
  flow: string;
  tier: string;
  skipped: boolean;
  seconds: number;
  total: { calls: number };
}

/**
 * The reviews to put in the manifest, from counted sessions: mr-reviewer
 * sessions that did review (not skipped) and have a known tier, grouped by
 * tier, each with its counted calls as both the low and the high end.
 */
export function countedRuns(sessions: CountedSession[]): Map<string, ManifestRun[]> {
  const byTier = new Map<string, ManifestRun[]>();
  for (const tier of ['high', 'medium', 'low']) {
    const runs = sessions
      .filter((s) => s.flow === 'mr-reviewer' && !s.skipped && s.tier === tier)
      .map((s) => ({ at: s.at, seconds: s.seconds, calls: { low: s.total.calls, high: s.total.calls } }));
    if (runs.length) byTier.set(tier, runs);
  }
  return byTier;
}

export function ifManifest(byTier: Map<string, ManifestRun[]>, c: SciCoefficients, calls: 'bounded' | 'counted' = 'bounded'): string {
  const wattsPerVcpu = c.minWattsPerVcpu + c.utilization * (c.maxWattsPerVcpu - c.minWattsPerVcpu);
  const runnerKw = ((wattsPerVcpu * c.vcpus) / 1000 + c.memoryGb * c.memoryKwhPerGbHour) * c.pue;
  const children: Record<string, unknown> = {};
  for (const [tier, runs] of byTier) {
    children[`${tier}-risk-reviews`] = {
      pipeline: {
        compute: ['runner-energy', 'runner-carbon', 'runner-embodied', 'model-energy-low', 'model-energy-high', 'model-carbon-low', 'model-carbon-high', 'carbon-low', 'carbon-high'],
      },
      defaults: {
        'runner-kw': runnerKw,
        'embodied-g-per-hour': c.embodiedGramsPerVcpuHour * c.vcpus,
        'grid-g-per-kwh': c.gridGramsPerKwh,
        'kwh-per-call-low': INFERENCE_WH_PER_CALL.low / 1000,
        'kwh-per-call-high': INFERENCE_WH_PER_CALL.high / 1000,
      },
      inputs: runs.map((r) => ({
        timestamp: r.at,
        duration: Math.round(r.seconds),
        'runner-hours': r.seconds / 3600,
        'model-calls-low': r.calls.low,
        'model-calls-high': r.calls.high,
      })),
    };
  }
  return stringify({
    name: 'agent review footprint',
    description:
      `One merge request review by our Duo flows: runner time (measured) and model calls (${calls === 'counted' ? "counted from each session's checkpoint" : 'bounded from the session log'}), turned into gCO2e. ` +
      `Energy per model call is a cited range (${INFERENCE_WH_PER_CALL.low}-${INFERENCE_WH_PER_CALL.high} Wh), not a measurement; see SUSTAINABILITY.md.`,
    tags: { kind: 'agents' },
    // per tier, summed over its reviews ("horizontal": the tiers' reviews don't share timestamps)
    aggregation: { metrics: ['carbon-low', 'carbon-high'], type: 'horizontal' },
    initialize: {
      plugins: {
        'runner-energy': multiply(['runner-hours', 'runner-kw'], 'runner-energy'),
        'runner-carbon': multiply(['runner-energy', 'grid-g-per-kwh'], 'runner-carbon'),
        'runner-embodied': multiply(['runner-hours', 'embodied-g-per-hour'], 'runner-embodied'),
        'model-energy-low': multiply(['model-calls-low', 'kwh-per-call-low'], 'model-energy-low'),
        'model-energy-high': multiply(['model-calls-high', 'kwh-per-call-high'], 'model-energy-high'),
        'model-carbon-low': multiply(['model-energy-low', 'grid-g-per-kwh'], 'model-carbon-low'),
        'model-carbon-high': multiply(['model-energy-high', 'grid-g-per-kwh'], 'model-carbon-high'),
        'carbon-low': sum(['runner-carbon', 'runner-embodied', 'model-carbon-low'], 'carbon-low'),
        'carbon-high': sum(['runner-carbon', 'runner-embodied', 'model-carbon-high'], 'carbon-high'),
      },
    },
    tree: { children },
  });
}

/**
 * agent-footprint's arguments: [project] [--json] [--manifest FILE | --manifest=FILE].
 * Read before any network call, so a bad option fails at once.
 */
export function footprintArgs(argv: string[]): { project?: string; json: boolean; manifest?: string } {
  const out: { project?: string; json: boolean; manifest?: string } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--manifest' || a.startsWith('--manifest=')) {
      const file = a === '--manifest' ? argv[++i] : a.slice('--manifest='.length);
      if (!file || file.startsWith('--')) throw new Error('--manifest needs a file name');
      out.manifest = file;
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (out.project) throw new Error(`one project only, got ${out.project} and ${a}`);
    else out.project = a;
  }
  return out;
}
