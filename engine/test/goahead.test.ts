import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
import { type Note, type Step, goAheadFor, isPerson, linkedIssue, notAllowed, pushesFrom, saysGoAhead, tierFrom } from '../src/goahead.ts';

const AGENT = 'ai-mr-reviewer-group_e50080';
const config = { ...DEFAULT_CONFIG, goAhead: { maintainers: ['HamzaHassanain'], byTier: DEFAULT_CONFIG.goAhead.byTier } };
const low: Step = { requester: 'Mazen-Ghanaym', tier: 'low', rollback: false };

let id = 0;
const note = (at: string, author: string, body: string, system = false): Note => ({ id: ++id, body, system, created_at: `2026-10-17T${at}:00Z`, author: { username: author } });
const pushNote = (at: string, shas: string[], by = AGENT) =>
  note(at, by, `added ${shas.length} commit${shas.length > 1 ? 's' : ''}\n\n<ul>${shas.map((s) => `<li>${s} - fix</li>`).join('')}</ul>`, true);

describe('what counts as a go-ahead comment', () => {
  it('needs the mention and a line that says exactly go-ahead', () => {
    expect(saysGoAhead(`@${AGENT} go-ahead`, AGENT)).toBe(true);
    expect(saysGoAhead(`@${AGENT}\nGo-ahead.`, AGENT)).toBe(true);
    expect(saysGoAhead(`Looks right.\n\n@${AGENT} go-ahead`, AGENT)).toBe(true);
  });

  it('is not fooled by the word inside a sentence, a missing mention or a look-alike account', () => {
    expect(saysGoAhead(`@${AGENT} no go-ahead yet, the corpus is still red`, AGENT)).toBe(false);
    expect(saysGoAhead('go-ahead', AGENT)).toBe(false);
    expect(saysGoAhead(`@${AGENT}x go-ahead`, AGENT)).toBe(false);
    expect(saysGoAhead(`@${AGENT} go-ahead and also fix the docs`, AGENT)).toBe(false);
  });
});

describe('who may give it', () => {
  it('never an agent, a bot or GitLabDuo', () => {
    for (const u of [AGENT, 'service_account_group_1', 'group_1_bot_abc', 'GitLabDuo', 'duo-developer-gitlab-ai-hackathon']) expect(isPerson(u)).toBe(false);
    expect(isPerson('Ahmad-Faraj')).toBe(true);
  });

  it('never the requester', () => {
    expect(notAllowed('Mazen-Ghanaym', low, config)).toMatch(/asked for this work/);
    expect(notAllowed('Ahmad-Faraj', low, config)).toBeNull();
  });

  it('only a maintainer for high risk and for rollbacks', () => {
    expect(notAllowed('Ahmad-Faraj', { ...low, tier: 'high' }, config)).toMatch(/not a maintainer; high risk needs @HamzaHassanain/);
    expect(notAllowed('HamzaHassanain', { ...low, tier: 'high' }, config)).toBeNull();
    expect(notAllowed('Ahmad-Faraj', { ...low, rollback: true }, config)).toMatch(/a rollback needs/);
  });

  it('with no maintainer set, high risk has nobody who can say go-ahead (it fails closed)', () => {
    expect(notAllowed('HamzaHassanain', { ...low, tier: 'high' }, DEFAULT_CONFIG)).toMatch(/none set in go_ahead.maintainers/);
  });
});

describe('a push needs a go-ahead after the agent proposed and before it pushed', () => {
  const proposal = note('10:00', AGENT, 'Review of abc1234: not ready to approve\n\nProposed fixes: ...');
  const goAhead = note('10:05', 'Ahmad-Faraj', `@${AGENT} go-ahead`);

  it('passes the normal order: proposal, go-ahead, push', () => {
    const v = goAheadFor({ at: '2026-10-17T10:10:00Z', pusher: AGENT }, [proposal, goAhead], low, config);
    expect(v.ok && v.note.id).toBe(goAhead.id);
  });

  it('fails a push with no go-ahead at all', () => {
    const v = goAheadFor({ at: '2026-10-17T10:10:00Z', pusher: AGENT }, [proposal], low, config);
    expect(!v.ok && v.reason).toMatch(/no go-ahead mentioning @ai-mr-reviewer.* between its proposal at .* and the push at/);
  });

  it('fails when the go-ahead came after the push (the push time is GitLab\'s, not the commit date)', () => {
    const late = note('10:20', 'Ahmad-Faraj', `@${AGENT} go-ahead`);
    expect(goAheadFor({ at: '2026-10-17T10:10:00Z', pusher: AGENT }, [proposal, late], low, config).ok).toBe(false);
  });

  it('fails when the go-ahead answered an older proposal (one go-ahead, one step)', () => {
    const newer = note('10:07', AGENT, 'Review of def5678: not ready to approve');
    expect(goAheadFor({ at: '2026-10-17T10:10:00Z', pusher: AGENT }, [proposal, goAhead, newer], low, config).ok).toBe(false);
  });

  it('fails when the only go-ahead is from the requester, and says why', () => {
    const self = note('10:05', 'Mazen-Ghanaym', `@${AGENT} go-ahead`);
    const v = goAheadFor({ at: '2026-10-17T10:10:00Z', pusher: AGENT }, [proposal, self], low, config);
    expect(!v.ok && v.reason).toMatch(/Mazen-Ghanaym asked for this work/);
  });

  it('fails when the go-ahead came from another agent or GitLabDuo, not a person', () => {
    for (const bot of ['ai-pipeline-fixer-group_b1d814', 'GitLabDuo']) {
      const fake = note('10:05', bot, `@${AGENT} go-ahead`);
      const v = goAheadFor({ at: '2026-10-17T10:10:00Z', pusher: AGENT }, [proposal, fake], low, config);
      expect(!v.ok && v.reason).toMatch(/is not a person/);
    }
  });

  it('on a high-risk MR only the maintainer\'s go-ahead counts', () => {
    const high = { ...low, tier: 'high' as const };
    expect(goAheadFor({ at: '2026-10-17T10:10:00Z', pusher: AGENT }, [proposal, goAhead], high, config).ok).toBe(false);
    const hamza = note('10:06', 'HamzaHassanain', `@${AGENT} go-ahead`);
    expect(goAheadFor({ at: '2026-10-17T10:10:00Z', pusher: AGENT }, [proposal, goAhead, hamza], high, config).ok).toBe(true);
  });
});

describe('reading GitLab\'s records', () => {
  it('takes pushes from "added N commits" system notes, with who pushed and when', () => {
    const notes = [note('09:00', 'Ahmad-Faraj', 'a comment'), pushNote('10:10', ['1af099a0', '2b0aa1b1']), pushNote('09:30', ['00b09007'], 'Mazen-Ghanaym')];
    expect(pushesFrom(notes)).toEqual([
      { at: '2026-10-17T09:30:00Z', pusher: 'Mazen-Ghanaym', shas: ['00b09007'] },
      { at: '2026-10-17T10:10:00Z', pusher: AGENT, shas: ['1af099a0', '2b0aa1b1'] },
    ]);
  });

  it('finds the issue an MR closes', () => {
    expect(linkedIssue('Fixes the parser.\n\nCloses #22')).toBe(22);
    expect(linkedIssue('resolves #2 too')).toBe(2);
    expect(linkedIssue('See #22')).toBeNull();
  });

  it('treats a missing or unknown tier as high, so it needs a maintainer', () => {
    expect(tierFrom('medium')).toBe('medium');
    expect(tierFrom(undefined)).toBe('high');
    expect(tierFrom('risk::low')).toBe('high');
  });
});

describe('go_ahead in .autonomy.yml', () => {
  const load = (yaml: string) => {
    const file = join(mkdtempSync(join(tmpdir(), 'autonomy-')), '.autonomy.yml');
    writeFileSync(file, yaml);
    return () => loadConfig(file);
  };

  it("reads this project's maintainers and tiers", () => {
    expect(loadConfig('../.autonomy.yml').goAhead).toEqual({ maintainers: ['HamzaHassanain'], byTier: { low: 'anyone', medium: 'anyone', high: 'maintainers' } });
  });

  it('refuses names that are not usernames and tiers that are not anyone or maintainers', () => {
    expect(load('go_ahead:\n  maintainers: "@hamza"\n')).toThrow('need a list of GitLab usernames');
    expect(load('go_ahead:\n  maintainers: ["@hamza"]\n')).toThrow('need a list of GitLab usernames');
    expect(load('go_ahead:\n  high: everyone\n')).toThrow('go_ahead.high: need "anyone" or "maintainers"');
  });
});
