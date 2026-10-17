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
