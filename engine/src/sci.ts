/**
 * Software Carbon Intensity (Green Software Foundation, ISO/IEC 21031:2024):
 *
 *   SCI = (E * I + M) per R
 *
 *   E  energy used by the pipeline jobs, in kWh
 *   I  location-based grid carbon intensity, in gCO2e/kWh
 *   M  embodied emissions of the runner hardware for the time we used it
 *   R  functional unit: one merged change
 *
 * Energy follows the Cloud Carbon Footprint method: per vCPU, power is
 * interpolated between idle and max watts by average utilisation, plus a fixed
 * cost per GB of memory, times the data centre PUE. All coefficients come from
 * the project's .autonomy.yml so they can be checked and changed.
 */

export interface SciCoefficients {
  vcpus: number;
  memoryGb: number;
  /** Watts per vCPU at idle and at 100% (CCF, GCP). */
  minWattsPerVcpu: number;
  maxWattsPerVcpu: number;
  /** Assumed average CPU utilisation of a CI job (0-1). */
  utilization: number;
  /** kWh per GB of memory per hour (CCF). */
  memoryKwhPerGbHour: number;
  pue: number;
  /** Grid intensity for the runner region, gCO2e/kWh. */
  gridGramsPerKwh: number;
  /** Embodied emissions per vCPU-hour, gCO2e. */
  embodiedGramsPerVcpuHour: number;
}

export const DEFAULT_SCI: SciCoefficients = {
  // GitLab.com hosted runner saas-linux-small-amd64 (2 vCPU, 8 GB) on GCP us-east1
  vcpus: 2,
  memoryGb: 8,
  minWattsPerVcpu: 0.71,
  maxWattsPerVcpu: 4.26,
  utilization: 0.5,
  memoryKwhPerGbHour: 0.000392,
  pue: 1.1,
  // GCP us-east1, Google's 2025 region data (579.44; 560 in 2023)
  gridGramsPerKwh: 579,
  embodiedGramsPerVcpuHour: 1.2,
};

export interface JobRun {
  name: string;
  /** Seconds the job ran on a runner. */
  duration: number;
}

export interface Footprint {
  runnerSeconds: number;
  energyKwh: number;
  operationalGrams: number;
  embodiedGrams: number;
  totalGrams: number;
  byJob: { name: string; seconds: number; grams: number }[];
}

export function footprint(jobs: JobRun[], c: SciCoefficients = DEFAULT_SCI): Footprint {
  const wattsPerVcpu = c.minWattsPerVcpu + c.utilization * (c.maxWattsPerVcpu - c.minWattsPerVcpu);
  const kwhPerHour = ((wattsPerVcpu * c.vcpus) / 1000 + c.memoryGb * c.memoryKwhPerGbHour) * c.pue;
  const gramsPerHour = kwhPerHour * c.gridGramsPerKwh + c.embodiedGramsPerVcpuHour * c.vcpus;

  const byJob = jobs.map((j) => ({ name: j.name, seconds: j.duration, grams: (j.duration / 3600) * gramsPerHour }));
  const runnerSeconds = jobs.reduce((n, j) => n + j.duration, 0);
  const hours = runnerSeconds / 3600;
  const energyKwh = hours * kwhPerHour;
  const operationalGrams = energyKwh * c.gridGramsPerKwh;
  const embodiedGrams = hours * c.embodiedGramsPerVcpuHour * c.vcpus;
  return { runnerSeconds, energyKwh, operationalGrams, embodiedGrams, totalGrams: operationalGrams + embodiedGrams, byJob };
}

export function formatFootprint(f: Footprint): string {
  const minutes = (f.runnerSeconds / 60).toFixed(1);
  return `${minutes} runner-min, ${(f.energyKwh * 1000).toFixed(1)} Wh, ${f.totalGrams.toFixed(1)} gCO2e`;
}

/**
 * Model inference per agent session. It runs on GitLab's side, so its energy
 * can't be measured here. What the session log shows is the agent graph's
 * checkpoints: one after every step (a model call, a tool step, the start and
 * the finish). So the model calls are given as a range, not counted:
 *   at most  every checkpoint;
 *   typically the checkpoints that came 3 s or more after the one before (a
 *            model completion takes seconds; most tool steps and bookkeeping
 *            checkpoints arrive within a second, but a slow tool step can
 *            pass for a call, so this isn't a strict floor).
 * Energy per call is a cited range, not a measurement, and neither figure is
 * for the Claude model our flows use:
 *   0.24 Wh: Google's median Gemini Apps text prompt, serving overhead
 *            included (Elsworth et al. 2025, arXiv:2508.15734)
 *   2.5 Wh:  Epoch AI's rough estimate for a GPT-4o query with ~10k input
 *            tokens ("How much energy does ChatGPT use?", 2025); agent calls
 *            carry the prompt, the event and the work so far
 * The low end pairs the fewest calls with the lower figure, the high end the
 * most calls with the higher one. Grid intensity is the runner's; no embodied
 * emissions are included for the model's hardware.
 */
export const INFERENCE_WH_PER_CALL = { low: 0.24, high: 2.5 } as const;

/**
 * A checkpoint line as the runner writes it: the job log's own timestamp, the
 * stream marker, then the executor's log line. Anchored, so text that only
 * quotes the phrase (a tool result, a diff of this file) isn't counted.
 */
const CHECKPOINT = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) \d+[OE]\+? \S+ \[\w+\]: \[DuoWorkflowNodeExecutor\]\[\d+\] Received new checkpoint: \{/;

/** Model calls in a session's job log, bounded from its checkpoints' times. */
export function modelCalls(log: string): { low: number; high: number } {
  const times = log
    .split(/\r?\n/)
    .map((line) => CHECKPOINT.exec(line)?.[1])
    .filter((t): t is string => !!t)
    .map((t) => Date.parse(t));
  const spaced = times.slice(1).filter((t, i) => t - times[i] >= 3000).length;
  return { low: spaced, high: times.length };
}

export function inferenceGrams(calls: { low: number; high: number }, gridGramsPerKwh: number): { low: number; high: number } {
  return {
    low: (calls.low * INFERENCE_WH_PER_CALL.low * gridGramsPerKwh) / 1000,
    high: (calls.high * INFERENCE_WH_PER_CALL.high * gridGramsPerKwh) / 1000,
  };
}

export type Calls = { low: number; high: number };

/** The model calls of a group of sessions, divided by `per` (1 for a total, the count for an average). */
export function callsOf(sessions: { calls: Calls }[], per = 1): Calls {
  return {
    low: sessions.reduce((n, s) => n + s.calls.low, 0) / per,
    high: sessions.reduce((n, s) => n + s.calls.high, 0) / per,
  };
}

/** Runner (measured time, modelled energy) plus inference (bounded calls, cited energy), in gCO2e. */
export function sessionGrams(seconds: number, calls: Calls, c: SciCoefficients): Calls {
  const runner = footprint([{ name: 'agent', duration: seconds }], c).totalGrams;
  const model = inferenceGrams(calls, c.gridGramsPerKwh);
  return { low: runner + model.low, high: runner + model.high };
}

/** A session that ran a while but shows no checkpoint: the runner's log layout changed, and its calls would count as 0. */
export function checkpointsMissing(seconds: number, calls: Calls): boolean {
  return seconds > 10 && calls.high === 0;
}
