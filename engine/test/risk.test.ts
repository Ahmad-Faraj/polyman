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
