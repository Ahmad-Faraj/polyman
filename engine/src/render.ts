/**
 * The flow files are shared between projects; what differs (how to run the
 * checks, the agents' account names, which flow IDs to hand over to, what the
 * monitor measures, which files agents may not touch) comes from .autonomy.yml
 * and the project's AI Catalog. `@@name@@` markers in a flow are filled in when
 * it's published, so the prompt an agent sees is concrete.
 */
import type { AutonomyConfig } from './config.ts';

export type FlowValues = Record<string, string>;

/** Flow names whose catalog consumer ID other flows hand over to. */
export const HANDOFF_FLOWS = ['mr-reviewer', 'pipeline-fixer', 'issue-builder'] as const;

export function flowValues(config: AutonomyConfig, consumerIds: Record<string, string>): FlowValues {
  const values: FlowValues = {
    about: config.agents.about,
    checks: config.agents.checks,
    test_guide: config.agents.testGuide,
    security_focus: config.agents.securityFocus,
    reviewer_account: config.agents.reviewerAccount,
    fixer_account: config.agents.fixerAccount,
    protected_paths: config.governance.map((p) => p.replace(/\/\*\*$/, '/')).join(', '),
    measured_routes: config.monitor.measuredRoutes.join(', ') || 'none (the monitor only runs its default checks)',
    production_jobs: config.monitor.productionJobs.join(', '),
    rollback_job: config.monitor.rollbackJob,
    // Assisted: whose go-ahead counts for high risk and rollbacks
    maintainers: config.goAhead.maintainers.map((m) => `@${m}`).join(', ') || 'a maintainer (none set in go_ahead.maintainers)',
    // who a proposal mentions so GitLab notifies them (people never start a flow)
    people: config.goAhead.people.map((m) => `@${m}`).join(', ') || 'nobody (go_ahead.people is empty, so mention no one)',
  };
  for (const name of HANDOFF_FLOWS) {
    const id = consumerIds[name];
    if (id) values[`${name.replace('-', '_')}_flow_id`] = id;
  }
  return values;
}

const MARKER = /@@(\w+)@@/g;

export function markersIn(source: string): string[] {
  return [...new Set([...source.matchAll(MARKER)].map((m) => m[1]))];
}

/** Fills every marker; a marker with no value is an error, never left in a prompt. */
export function renderFlow(source: string, values: FlowValues): string {
  const missing = markersIn(source).filter((k) => !values[k]);
  if (missing.length) throw new Error(`no value for ${missing.map((k) => `@@${k}@@`).join(', ')}`);
  return source.replace(MARKER, (_, k: string) => values[k]);
}

/** The .autonomy.yml setting each marker is filled from (the flow IDs come from the catalog). */
export const MARKER_SETTINGS: Record<string, string> = {
  about: 'agents.about',
  checks: 'agents.checks',
  test_guide: 'agents.test_guide',
  security_focus: 'agents.security_focus',
  reviewer_account: 'agents.reviewer_account',
  fixer_account: 'agents.fixer_account',
  protected_paths: 'governance',
  measured_routes: 'monitor.measured_routes',
  production_jobs: 'monitor.production_jobs',
  rollback_job: 'monitor.rollback_job',
  maintainers: 'go_ahead.maintainers',
  people: 'go_ahead.people',
};

export interface FlowChange {
  flow: string;
  /** the .autonomy.yml settings this flow uses whose filled-in value changed */
  settings: string[];
  /** the flow file itself was added or changed */
  fileChanged: boolean;
}

/**
 * The flows whose published version would no longer be what the repo says
 * once `after` replaces `before`: a setting they use changed (go_ahead.people,
 * say), or the file itself did. GitLab keeps running what was published, so
 * each of these needs sync-flows. A flow that was removed needs nothing.
 */
export function flowChanges(
  before: { sources: Map<string, string>; values: FlowValues },
  after: { sources: Map<string, string>; values: FlowValues },
): FlowChange[] {
  const changes: FlowChange[] = [];
  for (const [flow, source] of [...after.sources].sort(([a], [b]) => a.localeCompare(b))) {
    const settings = markersIn(source)
      .filter((m) => before.values[m] !== after.values[m])
      .map((m) => MARKER_SETTINGS[m] ?? `@@${m}@@`);
    const fileChanged = before.sources.get(flow) !== source;
    if (settings.length || fileChanged) changes.push({ flow, settings: [...new Set(settings)], fileChanged });
  }
  return changes;
}
