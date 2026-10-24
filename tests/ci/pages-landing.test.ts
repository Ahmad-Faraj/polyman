import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// The landing page at the root of GitLab Pages (pages/index.html) and the
// pages job that puts it there. The page's numbers code runs from the page's
// own source, the way service/test/page-ledger.test.ts runs app.js.
const html = readFileSync(
  resolve(__dirname, '../../pages/index.html'),
  'utf8'
).replace(/\r\n/g, '\n');
const ci = readFileSync(
  resolve(__dirname, '../../.gitlab-ci.yml'),
  'utf8'
).replace(/\r\n/g, '\n');

const piece = (re: RegExp): string => {
  const m = html.match(re);
  if (!m) throw new Error(`not found in pages/index.html: ${re}`);
  return m[0];
};

interface Counts {
  loops: number;
  loopsOk: number;
  pushes: number;
  pushesOk: number;
  people: number;
  newest: string;
}
const code = [
  piece(/^const isDate = .*$/m),
  piece(/^const count = .*$/m),
  piece(/^function landingCounts\(ledger, loops\) \{[\s\S]*?^\}$/m),
  piece(/^function when\(iso\) \{[\s\S]*?^\}$/m),
].join('\n');
const { landingCounts, when } = runInNewContext(
  `${code}\n({ landingCounts, when })`
) as {
  landingCounts: (ledger: unknown, loops: unknown) => Counts | null;
  when: (iso: string) => string;
};

const rec = (over: Record<string, unknown> = {}) => ({
  merged_at: '2026-10-22T10:00:00Z',
  accepted: true,
  approver_not_requester: true,
  go_ahead: { by: 'HamzaHassanain' },
  ...over,
});
const loops = (n: number, ok = n) => ({
  summary: { loops: n, approverNotRequester: ok },
});

describe('landingCounts', () => {
  it('counts loops, pushes, people and the newest merge', () => {
    const c = landingCounts(
      {
        records: [
          rec(),
          rec({
            go_ahead: { by: 'Mazen-Ghanaym' },
            merged_at: '2026-10-23T13:08:37Z',
          }),
          rec({ approver_not_requester: false }),
        ],
      },
      loops(2)
    );
    expect({ ...c }).toEqual({
      loops: 2,
      loopsOk: 2,
      pushes: 3,
      pushesOk: 2,
      people: 2,
      newest: '2026-10-23T13:08:37Z',
    });
  });

  it('keeps the written numbers when the files read oddly', () => {
    expect(landingCounts({ records: [] }, loops(1))).toBeNull();
    expect(landingCounts({}, loops(1))).toBeNull();
    expect(
      landingCounts({ records: [rec({ merged_at: 'soon' })] }, loops(1))
    ).toBeNull();
    expect(
      landingCounts({ records: [rec({ go_ahead: {} })] }, loops(1))
    ).toBeNull();
    expect(landingCounts({ records: [rec()] }, {})).toBeNull();
    expect(landingCounts({ records: [rec()] }, loops(0))).toBeNull();
    expect(landingCounts({ records: [rec()] }, loops(1, 2))).toBeNull();
  });
});

describe('when', () => {
  it('writes a UTC time the way README.md does', () => {
    expect(when('2026-10-23T13:08:37Z')).toBe('23 Oct 13:08 UTC');
    expect(when('2026-10-05T03:07:00Z')).toBe('5 Oct 03:07 UTC');
  });
});

describe('the landing page', () => {
  it('loads no script, style or image from another site', () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    expect(html).not.toMatch(/<img/);
  });

  it('links the ledger, SCI page and API docs relative to the root', () => {
    for (const href of ['./ledger/', './sci/', './docs/']) {
      expect(html).toContain(`href="${href}"`);
    }
  });
});

describe('the pages job', () => {
  const job = /^pages:\n(?: .*\n|\n)*/m.exec(ci)?.[0] ?? '';

  it('puts the landing page at the root and TypeDoc under /docs/', () => {
    expect(job).toContain('- npm run docs');
    expect(job).toContain('- mv docs public/docs');
    expect(job).toContain('- cp pages/index.html public/index.html');
    expect(job).toContain('- cp -r ledger public/ledger');
    expect(job).toContain('- cp -r sci public/sci');
    expect(job).not.toMatch(/- mv docs public$/m);
  });
});
