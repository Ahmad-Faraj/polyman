import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asList,
  asMap,
  asString,
  parseYaml,
  readWorkflow,
  stepsOf,
  strings,
  type Workflow,
} from './workflow-yaml';

// Checks every workflow for what GitHub only reports when it runs: a `needs`
// to a missing job, an action on another major version, no least-privilege
// permissions. Also pins the Dependabot config.
const DIR = resolve(__dirname, '../../.github/workflows');
const FILES = readdirSync(DIR).filter(f => /\.ya?ml$/.test(f));

const ALLOWED_ACTIONS = new Set([
  'actions/checkout@v7',
  'actions/setup-node@v7',
  'actions/setup-java@v6',
  'actions/setup-python@v7',
  'actions/upload-artifact@v7',
  'actions/download-artifact@v8',
  'actions/upload-pages-artifact@v5',
  'actions/deploy-pages@v5',
  'codecov/codecov-action@v7',
  'github/codeql-action/init@v4',
  'github/codeql-action/analyze@v4',
]);

const jobs = (wf: Workflow) => asMap(wf['jobs'], 'jobs');
const needsOf = (job: Workflow): string[] =>
  job['needs'] === undefined
    ? []
    : typeof job['needs'] === 'string'
      ? [job['needs']]
      : strings(job['needs']);

describe('every workflow', () => {
  for (const file of FILES) {
    const wf = readWorkflow(file);

    it(`${file}: needs only jobs that exist`, () => {
      const ids = Object.keys(jobs(wf));
      for (const id of ids)
        for (const need of needsOf(asMap(jobs(wf)[id])))
          expect(ids, `${id} needs ${need}`).toContain(need);
    });

    it(`${file}: uses actions on the pinned major versions`, () => {
      for (const id of Object.keys(jobs(wf)))
        for (const step of stepsOf(asMap(jobs(wf)[id])))
          if (step['uses'] !== undefined)
            expect(
              ALLOWED_ACTIONS,
              `${id}: ${asString(step['uses'])}`
            ).toContain(step['uses']);
    });

    it(`${file}: sets the token's permissions`, () => {
      expect(wf['permissions'], file).toBeDefined();
    });
  }
});

describe('dependabot', () => {
  it('has Dependabot updates for npm and the actions, weekly', () => {
    const config = asMap(
      parseYaml(readFileSync(resolve(DIR, '../dependabot.yml'), 'utf8')),
      'dependabot.yml'
    );
    const updates = asList(config['updates']).map(u => asMap(u));
    expect(
      updates.map(u => [
        u['package-ecosystem'],
        asMap(u['schedule'])['interval'],
      ])
    ).toEqual([
      ['npm', 'weekly'],
      ['github-actions', 'weekly'],
    ]);
  });
});
