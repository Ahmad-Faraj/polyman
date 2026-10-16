import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { DEFAULT_SCI, type SciCoefficients } from './sci.ts';

/**
 * How risky a change is. Every MR still needs one approval either way; the
 * tier only decides how much review it gets before that.
 */
export type Tier = 'low' | 'medium' | 'high';
export const TIERS: readonly Tier[] = ['low', 'medium', 'high'];

export interface AutonomyConfig {
  /** Score at or above which a change is medium / high risk. */
  thresholds: { medium: number; high: number };
  /** Path sensitivity tiers. The highest tier touched sets the base score. */
  paths: { critical: string[]; high: string[]; medium: string[]; low: string[] };
  /** Changes to these files modify the automation itself and are always high risk. */
  governance: string[];
  dependencies: { manifests: string[]; lockfiles: string[] };
  source: string[];
  tests: string[];
  /** File where learned incident weights are stored (written by the monitor flow). */
  incidentsFile: string;
  /** Coefficients for the carbon estimate of each change. */
  sustainability: SciCoefficients;
  /** What the Duo flows need to know about this project. */
  agents: {
    /** A few lines on what the project is and where things live. */
    about: string;
    /** Command an agent runs before it pushes (install, type check, tests). */
    checks: string;
    /** One or two sentences on how tests are written here. */
    testGuide: string;
    /** What the security reviewer should look at hardest in this project. */
    securityFocus: string;
    /** Exact usernames of the service accounts GitLab made for the flows. */
    reviewerAccount: string;
    fixerAccount: string;
  };
  monitor: {
    /** Routes the production traffic run exercises; anything else is "not measured". */
    measuredRoutes: string[];
  };
}

export const DEFAULT_CONFIG: AutonomyConfig = {
  thresholds: { medium: 25, high: 60 },
  paths: { critical: [], high: [], medium: [], low: ['**/*.md', 'docs/**'] },
  governance: ['.gitlab-ci.yml', '.autonomy.yml', '.autonomy/**', '.gitlab/**'],
  dependencies: {
    manifests: ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml'],
    lockfiles: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'go.sum', 'Cargo.lock', 'Gemfile.lock'],
  },
  source: ['src/**', 'lib/**', 'app/**'],
  tests: ['test/**', 'tests/**', '**/*.test.*', '**/*_test.*', '**/*.spec.*'],
  incidentsFile: '.autonomy/incidents.json',
  sustainability: DEFAULT_SCI,
  agents: {
    about: 'See the README.',
    checks: 'npm ci && npm test',
    testGuide: 'Follow the test layout and framework the project already uses.',
    securityFocus: 'anything that handles credentials, user input or money.',
    reviewerAccount: '',
    fixerAccount: '',
  },
  monitor: { measuredRoutes: [] },
};

type Raw = Partial<{
  thresholds: Partial<AutonomyConfig['thresholds']>;
  paths: Partial<AutonomyConfig['paths']>;
  governance: string[];
  dependencies: Partial<AutonomyConfig['dependencies']>;
  source: string[];
  tests: string[];
  incidents_file: string;
  sustainability: Partial<{
    vcpus: number;
    memory_gb: number;
    min_watts_per_vcpu: number;
    max_watts_per_vcpu: number;
    utilization: number;
    memory_kwh_per_gb_hour: number;
    pue: number;
    grid_gco2e_per_kwh: number;
    embodied_gco2e_per_vcpu_hour: number;
  }>;
  agents: Partial<{ about: string; checks: string; test_guide: string; security_focus: string; reviewer_account: string; fixer_account: string }>;
  monitor: Partial<{ measured_routes: string[] }>;
}>;

export function loadConfig(path = process.env.AUTONOMY_CONFIG || '.autonomy.yml'): AutonomyConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const raw = (parse(readFileSync(path, 'utf8')) ?? {}) as Raw;
  const d = DEFAULT_CONFIG;
  const config: AutonomyConfig = {
    thresholds: { ...d.thresholds, ...raw.thresholds },
    paths: { ...d.paths, ...raw.paths },
    // Governance files are additive: a project can protect more, never less.
    governance: [...new Set([...d.governance, ...(raw.governance ?? [])])],
    dependencies: { ...d.dependencies, ...raw.dependencies },
    source: raw.source ?? d.source,
    tests: raw.tests ?? d.tests,
    incidentsFile: raw.incidents_file ?? d.incidentsFile,
    sustainability: sustainabilityFrom(raw.sustainability ?? {}),
    agents: {
      about: raw.agents?.about?.trim().replace(/\s+/g, ' ') || d.agents.about,
      checks: raw.agents?.checks?.trim() || d.agents.checks,
      testGuide: raw.agents?.test_guide?.trim() || d.agents.testGuide,
      securityFocus: raw.agents?.security_focus?.trim().replace(/\s+/g, ' ') || d.agents.securityFocus,
      reviewerAccount: raw.agents?.reviewer_account?.trim() ?? '',
      fixerAccount: raw.agents?.fixer_account?.trim() ?? '',
    },
    monitor: { measuredRoutes: raw.monitor?.measured_routes ?? [] },
  };
  const { medium, high } = config.thresholds;
  if (!(medium > 0 && high > medium && high <= 100)) {
    throw new Error(`invalid thresholds in ${path}: need 0 < medium < high <= 100`);
  }
  return config;
}

function sustainabilityFrom(raw: NonNullable<Raw['sustainability']>): SciCoefficients {
  const d = DEFAULT_SCI;
  return {
    vcpus: raw.vcpus ?? d.vcpus,
    memoryGb: raw.memory_gb ?? d.memoryGb,
    minWattsPerVcpu: raw.min_watts_per_vcpu ?? d.minWattsPerVcpu,
    maxWattsPerVcpu: raw.max_watts_per_vcpu ?? d.maxWattsPerVcpu,
    utilization: raw.utilization ?? d.utilization,
    memoryKwhPerGbHour: raw.memory_kwh_per_gb_hour ?? d.memoryKwhPerGbHour,
    pue: raw.pue ?? d.pue,
    gridGramsPerKwh: raw.grid_gco2e_per_kwh ?? d.gridGramsPerKwh,
    embodiedGramsPerVcpuHour: raw.embodied_gco2e_per_vcpu_hour ?? d.embodiedGramsPerVcpuHour,
  };
}
