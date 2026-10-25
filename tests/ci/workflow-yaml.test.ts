import { describe, expect, it } from 'vitest';
import { globToRegExp, parseYaml } from './workflow-yaml';

// The YAML reader the CI tests use (tests/ci/workflow-yaml.ts). It must read
// the workflows as GitHub does, or the tests pin something else.
describe('parseYaml', () => {
  it('reads mappings, sequences and flow sequences as strings', () => {
    expect(
      parseYaml(
        [
          'name: CI # trailing comment',
          'on:',
          '  push:',
          '    branches: [ main, "ma, ster" ]',
          '  workflow_dispatch:',
          'jobs:',
          '  a:',
          '    timeout-minutes: 5',
          '    continue-on-error: true',
          '    steps:',
          '    - uses: actions/checkout@v4',
          '    - run: echo "a: b # not a comment"',
          '      if: ${{ !cancelled() }}',
          "    - name: 'it''s'",
        ].join('\n')
      )
    ).toEqual({
      name: 'CI',
      on: { push: { branches: ['main', 'ma, ster'] }, workflow_dispatch: '' },
      jobs: {
        a: {
          'timeout-minutes': '5',
          'continue-on-error': 'true',
          steps: [
            { uses: 'actions/checkout@v4' },
            { run: 'echo "a: b # not a comment"', if: '${{ !cancelled() }}' },
            { name: "it's" },
          ],
        },
      },
    });
  });

  it('reads block scalars, keeping their lines and comments', () => {
    expect(
      parseYaml(
        [
          'steps:',
          '  - run: |',
          '      # a shell comment',
          '      if [ -n "$X" ]; then',
          '        echo x',
          '',
          '      fi',
          '  - run: >-',
          '      one',
          '      two',
        ].join('\r\n')
      )
    ).toEqual({
      steps: [
        { run: '# a shell comment\nif [ -n "$X" ]; then\n  echo x\n\nfi\n' },
        { run: 'one two' },
      ],
    });
  });

  it('reads nested sequences of mappings', () => {
    expect(
      parseYaml(
        [
          'include:',
          '  - lane: a',
          '    extra:',
          '      - x',
          '      - y',
          '  - lane: b',
        ].join('\n')
      )
    ).toEqual({ include: [{ lane: 'a', extra: ['x', 'y'] }, { lane: 'b' }] });
  });

  it('refuses what it does not read, instead of misreading it', () => {
    expect(() => parseYaml('a: &x [1]\nb: *x')).toThrow(/unsupported/);
    expect(() => parseYaml('a: {b: 1}')).toThrow(/unsupported/);
    expect(() => parseYaml('a: 1\na: 2')).toThrow(/duplicate key a/);
    expect(() => parseYaml('a: 1\n   b: 2')).toThrow(/unexpected indent/);
    expect(() => parseYaml('a: "open')).toThrow(/unterminated/);
  });
});

describe('globToRegExp', () => {
  it('matches like a GitHub paths filter', () => {
    expect(globToRegExp('src/**').test('src/helpers/solution.ts')).toBe(true);
    expect(globToRegExp('tsconfig*.json').test('tsconfig.eslint.json')).toBe(
      true
    );
    expect(globToRegExp('corpus/*.mjs').test('corpus/a/b.mjs')).toBe(false);
  });
});
