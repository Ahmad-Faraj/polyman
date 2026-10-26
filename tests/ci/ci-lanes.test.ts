import { describe, expect, it } from 'vitest';
import { asMap, jobOf, readWorkflow, runsOf, stepsOf } from './workflow-yaml';

// Pins the Windows and macOS lanes in ci.yml: reported, never blocking, and
// not run on every pull request.
describe('Windows and macOS lanes (ci.yml)', () => {
  const ci = readWorkflow('ci.yml');

  it('can be started by hand on any branch', () => {
    expect(asMap(ci['on'], 'on')).toHaveProperty('workflow_dispatch');
  });

  for (const id of ['windows', 'macos'])
    it(`${id} is reported, not blocking, and skips pull requests`, () => {
      const job = jobOf(ci, id);
      expect(job['continue-on-error']).toBe('true');
      expect(job['if']).toBe("github.event_name != 'pull_request'");
    });

  it('runs the unit tests on Windows with Node 22', () => {
    const job = jobOf(ci, 'windows');
    expect(job['runs-on']).toBe('windows-latest');
    const steps = stepsOf(job);
    const node = steps.find(s => s['uses'] === 'actions/setup-node@v7');
    expect(asMap(node?.['with'])['node-version']).toBe('22.x');
    expect(steps.map(s => s['run'])).toContain(
      'npx vitest run --reporter=default --reporter=junit --outputFile.junit=junit-windows.xml'
    );
  });

  it('runs the corpus on macOS with GNU g++ first on PATH', () => {
    const job = jobOf(ci, 'macos');
    expect(asMap(job['env'])['POLYMAN_COMPILE_TIMEOUT_MS']).toBe('60000');
    const runs = runsOf(job);
    expect(runs.join('\n')).toMatch(/brew install gcc/);
    expect(runs.join('\n')).toMatch(/"\$GITHUB_PATH"/);
    expect(runs).toContain(
      'node corpus/run.mjs --junit corpus/out/junit-macos.xml'
    );
  });
});
