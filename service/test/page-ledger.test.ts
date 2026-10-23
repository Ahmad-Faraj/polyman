import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/app.js's ledgerCounts, run from the page's own source: the front
// page's ledger line, counted from ledger.json's records.
const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const piece = (re: RegExp) => {
  const m = SRC.match(re);
  if (!m) throw new Error(`not found in app.js: ${re}`);
  return m[0];
};
type Counts = { total: number; approved: number; agents: number; approvers: number; newest: string } | null;
const ledgerCounts = runInNewContext(
  `${piece(/^const isDate = .*$/m)}\n${piece(/^function ledgerCounts\(l\) \{[\s\S]*?^\}$/m)}\nledgerCounts`
) as (l: unknown) => Counts;

const rec = (over: Record<string, unknown> = {}) => ({
  merged_at: '2026-10-22T10:00:00Z',
  agent: 'ai-issue-builder',
  accepted: true,
  approver_not_requester: true,
  go_ahead: { by: 'HamzaHassanain' },
  ...over,
});

describe('ledgerCounts', () => {
  it('counts pushes, agents, approvers and the newest merge', () => {
    const c = ledgerCounts({
      records: [
        rec(),
        rec({ go_ahead: { by: 'Mazen-Ghanaym' }, merged_at: '2026-10-22T12:00:00Z' }),
        rec({ agent: 'ai-pipeline-fixer' }),
      ],
    });
    expect({ ...c }).toEqual({ total: 3, approved: 3, agents: 2, approvers: 2, newest: '2026-10-22T12:00:00Z' });
  });

  it('keeps a go-ahead that did not count and has no go-ahead on record', () => {
    // (the shape refused records have in ledger.json: go_ahead is null)
    const c = ledgerCounts({ records: [rec(), rec({ accepted: false, approver_not_requester: false, go_ahead: null })] });
    expect({ ...c }).toMatchObject({ total: 2, approved: 1, approvers: 1 });
  });

  it('does not count an accepted go-ahead from the requester as approved', () => {
    const c = ledgerCounts({ records: [rec(), rec({ approver_not_requester: false, go_ahead: { by: 'Mazen-Ghanaym' } })] });
    expect({ ...c }).toMatchObject({ total: 2, approved: 1, approvers: 2 });
  });

  it('refuses an accepted go-ahead with no approver', () => {
    expect(ledgerCounts({ records: [rec({ go_ahead: {} })] })).toBeNull();
  });

  it('refuses an empty ledger, a bad date or a missing agent', () => {
    expect(ledgerCounts({ records: [] })).toBeNull();
    expect(ledgerCounts({})).toBeNull();
    expect(ledgerCounts({ records: [rec({ merged_at: 'soon' })] })).toBeNull();
    expect(ledgerCounts({ records: [rec({ agent: undefined })] })).toBeNull();
  });
});
