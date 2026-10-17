import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type AutonomyConfig } from '../src/config.ts';
import { matches } from '../src/glob.ts';
import { assessRisk, type ChangedFile, type Finding } from '../src/risk.ts';

const config: AutonomyConfig = {
  ...DEFAULT_CONFIG,
  paths: {
    critical: ['src/routes/auth.ts', 'src/routes/payments.ts'],
    high: ['src/store.ts', 'Dockerfile'],
    medium: ['src/routes/**'],
    low: ['**/*.md', 'docs/**'],
  },
};

const file = (path: string, added = 5, deleted = 1, status: ChangedFile['status'] = 'M'): ChangedFile => ({
  path,
  status,
  added,
  deleted,
});

describe('glob', () => {
  it.each([
    ['src/a/b.ts', 'src/**', true],
    ['src/b.ts', 'src/**/*.ts', true],
    ['docs/x/y.md', '*.md', true],
    ['README.md', '**/*.md', true],
    ['srcx/b.ts', 'src/**', false],
    ['src/routes/auth.ts', 'src/routes/*.ts', true],
    ['src/routes/v2/auth.ts', 'src/routes/*.ts', false],
  ])('%s vs %s', (path, pattern, expected) => {
    expect(matches(path, pattern)).toBe(expected);
  });
});

describe('assessRisk', () => {
  it('docs-only changes are low risk', () => {
    const r = assessRisk([file('README.md', 20, 2)], [], config);
    expect(r.tier).toBe('low');
    expect(r.score).toBeLessThan(config.thresholds.medium);
  });

  it('a small medium-path change with tests stays low risk', () => {
    const r = assessRisk([file('src/routes/orders.ts'), file('tests/api.test.ts')], [], config);
    expect(r.tier).toBe('low');
  });

  it('touching payments is at least medium risk', () => {
    const r = assessRisk([file('src/routes/payments.ts'), file('tests/api.test.ts')], [], config);
    expect(r.tier).not.toBe('low');
    expect(r.factors.map((f) => f.id)).toContain('paths.critical');
  });

  it('critical path without tests is high risk', () => {
    const r = assessRisk([file('src/routes/auth.ts', 80, 10)], [], config);
    expect(r.tier).toBe('high');
  });

  it('changing the pipeline is always high risk, whatever the score', () => {
    const r = assessRisk([file('.gitlab-ci.yml', 1, 1)], [], config);
    expect(r.tier).toBe('high');
    expect(r.forcedBy).toMatch(/gitlab-ci/);
  });

  it('a detected secret forces high risk', () => {
    const secret: Finding = { scanner: 'secret_detection', severity: 'Critical', name: 'AWS key' };
    const r = assessRisk([file('README.md')], [secret], config);
    expect(r.tier).toBe('high');
  });

  it('ignores findings in files the change does not touch (the scanners report the whole repo)', () => {
    const elsewhere: Finding = { scanner: 'sast', severity: 'High', name: 'SSRF', file: 'src/other.ts' };
    const noFile: Finding = { scanner: 'dependency_scanning', severity: 'High', name: 'CVE' };
    const changed = [file('src/routes/orders.ts'), file('tests/api.test.ts')];
    const clean = assessRisk(changed, [], config);
    expect(assessRisk(changed, [elsewhere], config).score).toBe(clean.score);
    expect(assessRisk(changed, [elsewhere], config).stats.findings.High).toBe(0);
    expect(assessRisk(changed, [noFile], config).score).toBeGreaterThan(clean.score);
  });

  it('counts a finding in a touched file only on a line the change added', () => {
    // !26 touched src/helpers/utils.ts at lines 507-553; its six old findings sit at 303-486
    const changed = [{ ...file('src/routes/orders.ts'), addedLines: [[507, 553]] as [number, number][] }, file('tests/api.test.ts')];
    const old: Finding = { scanner: 'sast', severity: 'High', name: 'path traversal', file: 'src/routes/orders.ts', line: 303 };
    const added: Finding = { ...old, line: 520 };
    const clean = assessRisk(changed, [], config);
    expect(assessRisk(changed, [old], config).score).toBe(clean.score);
    expect(assessRisk(changed, [added], config).score).toBeGreaterThan(clean.score);
  });

  it('counts a finding over several lines if the change added any of them', () => {
    const changed = [{ ...file('src/routes/orders.ts'), addedLines: [[505, 510]] as [number, number][] }, file('tests/api.test.ts')];
    const spans: Finding = { scanner: 'sast', severity: 'High', name: 'x', file: 'src/routes/orders.ts', line: 500, endLine: 506 };
    const before: Finding = { ...spans, line: 490, endLine: 504 };
    expect(assessRisk(changed, [spans], config).stats.findings.High).toBe(1);
    expect(assessRisk(changed, [before], config).stats.findings.High).toBe(0);
  });

  it('counts a finding anywhere in a touched file when its line or the added lines are unknown', () => {
    const unknownLines = [file('src/routes/orders.ts'), file('tests/api.test.ts')];
    const knownLines = [{ ...file('src/routes/orders.ts'), addedLines: [[10, 12]] as [number, number][] }, file('tests/api.test.ts')];
    const noLine: Finding = { scanner: 'sast', severity: 'High', name: 'x', file: 'src/routes/orders.ts' };
    const withLine: Finding = { ...noLine, line: 300 };
    expect(assessRisk(unknownLines, [withLine], config).stats.findings.High).toBe(1);
    expect(assessRisk(knownLines, [noLine], config).stats.findings.High).toBe(1);
  });

  it('counts a secret anywhere in a touched file, whatever line it is on', () => {
    const changed = [{ ...file('README.md'), addedLines: [[1, 2]] as [number, number][] }];
    const secret: Finding = { scanner: 'secret_detection', severity: 'Critical', name: 'AWS key', file: 'README.md', line: 90 };
    expect(assessRisk(changed, [secret], config).tier).toBe('high');
  });

  it('matches a scanner path written "./src/x.ts" to the changed file', () => {
    const changed = [{ ...file('src/routes/orders.ts'), addedLines: [[10, 12]] as [number, number][] }, file('tests/api.test.ts')];
    const dotted: Finding = { scanner: 'sast', severity: 'Medium', name: 'x', file: './src/routes/orders.ts', line: 11 };
    expect(assessRisk(changed, [dotted], config).stats.findings.Medium).toBe(1);
  });

  it('treats a change to .gitattributes as governance: it can hide line counts from assess', () => {
    const report = assessRisk([file('.gitattributes')], [], DEFAULT_CONFIG);
    expect(report.factors.map((f) => f.id)).toContain('governance');
  });

  it('counts a finding that spans lines when any of them was added', () => {
    const changed = [{ ...file('src/routes/orders.ts'), addedLines: [[505, 510]] as [number, number][] }, file('tests/api.test.ts')];
    const across: Finding = { scanner: 'sast', severity: 'Medium', name: 'Path Traversal', file: 'src/routes/orders.ts', line: 500, endLine: 506 };
    expect(assessRisk(changed, [across], config).stats.findings.Medium).toBe(1);
    expect(assessRisk(changed, [{ ...across, endLine: 504 }], config).stats.findings.Medium).toBe(0);
    // an end before the start is read as a single line
    expect(assessRisk(changed, [{ ...across, line: 506, endLine: 1 }], config).stats.findings.Medium).toBe(1);
  });

  it('high severity findings raise the score', () => {
    const vuln: Finding = { scanner: 'sast', severity: 'High', name: 'SQL injection', file: 'src/routes/orders.ts' };
    const clean = assessRisk([file('src/routes/orders.ts'), file('tests/api.test.ts')], [], config);
    const dirty = assessRisk([file('src/routes/orders.ts'), file('tests/api.test.ts')], [vuln], config);
    expect(dirty.score).toBeGreaterThan(clean.score);
    expect(dirty.tier).not.toBe('low');
  });

  it('learned incidents add weight to paths that broke production before', () => {
    const incidents = [{ paths: ['src/routes/orders.ts'], weight: 30, reason: 'caused 5xx spike', ref: '#12' }];
    const r = assessRisk([file('src/routes/orders.ts'), file('tests/api.test.ts')], [], config, incidents);
    expect(r.factors.find((f) => f.id === 'history')?.detail).toContain('#12');
    expect(r.tier).not.toBe('low');
  });

  it('caps the score at 100', () => {
    const findings: Finding[] = Array.from({ length: 10 }, () => ({ scanner: 'sast', severity: 'Critical', name: 'x' }));
    const r = assessRisk([file('src/routes/auth.ts', 900, 10), file('package.json')], findings, config);
    expect(r.score).toBe(100);
  });
});
