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
  gridGramsPerKwh: 560,
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
