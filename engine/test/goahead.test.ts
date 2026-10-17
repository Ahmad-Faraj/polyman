import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
import { type Note, type PushEvent, type Step, attribute, branchPushes, goAheadFor, isPerson, isProposal, isProjectPerson, notAllowed, saysGoAhead, tierFrom } from '../src/goahead.ts';
import { flowValues } from '../src/render.ts';

const AGENT = 'ai-mr-reviewer-group_e50080';
const config = { ...DEFAULT_CONFIG, goAhead: { maintainers: ['HamzaHassanain'], people: [], byTier: DEFAULT_CONFIG.goAhead.byTier } };
const listed = { ...config, goAhead: { ...config.goAhead, people: ['HamzaHassanain', 'Ahmad-Faraj', 'Mazen-Ghanaym'] } };
const low: Step = { requesters: ['Mazen-Ghanaym'], tier: 'low', rollback: false };

let id = 0;
const note = (at: string, author: string, body: string, system = false): Note => ({ id: ++id, body, system, created_at: `2026-10-17T${at}:00Z`, author: { username: author } });
describe('what counts as a go-ahead comment', () => {
  it('needs the mention and a line that says exactly go-ahead', () => {
    expect(saysGoAhead(`@${AGENT} go-ahead`, AGENT)).toBe(true);
    expect(saysGoAhead(`@${AGENT} Go-ahead.`, AGENT)).toBe(true);
    // the mention and the word go on one line, so a go-ahead can't borrow a mention from elsewhere
    expect(saysGoAhead(`@${AGENT}\ngo-ahead`, AGENT)).toBe(false);
    expect(saysGoAhead(`Looks right.\n\n@${AGENT} go-ahead`, AGENT)).toBe(true);
  });

  it('is not fooled by the word inside a sentence, a missing mention or a look-alike account', () => {
    expect(saysGoAhead(`@${AGENT} no go-ahead yet, the corpus is still red`, AGENT)).toBe(false);
    expect(saysGoAhead('go-ahead', AGENT)).toBe(false);
    expect(saysGoAhead(`@${AGENT}x go-ahead`, AGENT)).toBe(false);
    expect(saysGoAhead(`@${AGENT} go-ahead and also fix the docs`, AGENT)).toBe(false);
  });

  it("doesn't count a go-ahead shown in a code block, quoted or hidden in an HTML comment", () => {
    expect(saysGoAhead(`To approve, write:\n\n\`\`\`\n@${AGENT} go-ahead\n\`\`\``, AGENT)).toBe(false);
    expect(saysGoAhead(`~~~\n@${AGENT} go-ahead\n~~~`, AGENT)).toBe(false);
    expect(saysGoAhead(`> @${AGENT} go-ahead\n\nNot yet.`, AGENT)).toBe(false);
    expect(saysGoAhead(`<!--\n@${AGENT} go-ahead\n-->`, AGENT)).toBe(false);
    expect(saysGoAhead(`<!-- unclosed\n@${AGENT} go-ahead`, AGENT)).toBe(false);
    // a fence closes only on its own character, at least as long
    expect(saysGoAhead(`~~~\n\`\`\`\n@${AGENT} go-ahead\n~~~`, AGENT)).toBe(false);
    expect(saysGoAhead(`\`\`\`\`\n\`\`\`\n@${AGENT} go-ahead\n\`\`\`\``, AGENT)).toBe(false);
    // an indented code block after a blank line, also over several lines
    expect(saysGoAhead(`To approve:\n\n    @${AGENT} go-ahead`, AGENT)).toBe(false);
    expect(saysGoAhead(`To approve:\n\n    example\n\t@${AGENT} go-ahead`, AGENT)).toBe(false);
    // an indented line that continues a paragraph is not code
    expect(saysGoAhead(`Looks right,\n    @${AGENT} go-ahead`, AGENT)).toBe(true);
    // after the block closes, a real one still counts
    expect(saysGoAhead(`\`\`\`\nexample\n\`\`\`\n@${AGENT} go-ahead`, AGENT)).toBe(true);
  });

  it("knows each flow's proposal, and not GitLab's own start note under the agent's account", () => {
    for (const body of ['Proposal for #22: ...', 'Pipeline fix proposal for abc123', 'Review of abc123: not ready', 'Rollback proposal for 1.2.3']) {
      expect(isProposal(body)).toBe(true);
    }
    expect(isProposal('✅ mr-reviewer has started. You can view progress here.')).toBe(false);
    expect(isProposal('Pipeline fix: no fix from me')).toBe(false);
  });

  it("doesn't let a go-ahead to one agent count for another mentioned elsewhere", () => {
    expect(saysGoAhead(`@${AGENT} no go-ahead yet\n@other-agent go-ahead`, AGENT)).toBe(false);
    expect(saysGoAhead(`@other-agent go-ahead\ncc @${AGENT}`, AGENT)).toBe(false);
    expect(saysGoAhead(`@other-agent @${AGENT} go-ahead`, AGENT)).toBe(true);
  });
});

describe('who may give it', () => {
  it('never an agent, a bot or GitLabDuo', () => {
    for (const u of [AGENT, 'service_account_group_1', 'group_1_bot_abc', 'GitLabDuo', 'duo-developer-gitlab-ai-hackathon', 'support-bot', 'GitLab-Security-Bot', 'ghost']) {
      expect(isPerson(u)).toBe(false);
    }
    expect(isPerson('abbott')).toBe(true);
    expect(isPerson('Ahmad-Faraj')).toBe(true);
  });

  it('with go_ahead.people set, only those people count: not a new bot, not a stranger', () => {
    expect(isProjectPerson('helper-robot', config)).toBe(true); // a name alone can't tell
    expect(isProjectPerson('helper-robot', listed)).toBe(false);
    expect(isProjectPerson('ahmad-faraj', listed)).toBe(true);
    expect(notAllowed('random-stranger', low, listed)).toMatch(/not one of the people who may give a go-ahead/);
    expect(notAllowed('Ahmad-Faraj', low, listed)).toBeNull();
  });

  it('never anyone who asked: the MR author or the issue author', () => {
    expect(notAllowed('Mazen-Ghanaym', low, config)).toMatch(/asked for this work/);
    expect(notAllowed('Ahmad-Faraj', { ...low, requesters: ['Mazen-Ghanaym', 'Ahmad-Faraj'] }, config)).toMatch(/asked for this work/);
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

  it('one go-ahead covers one push: a second push needs a new one', () => {
    const first = '2026-10-17T10:10:00Z';
    expect(goAheadFor({ at: first, pusher: AGENT }, [proposal, goAhead], low, config).ok).toBe(true);
    const v = goAheadFor({ at: '2026-10-19T10:00:00Z', pusher: AGENT }, [proposal, goAhead], low, config, first);
    expect(!v.ok && v.reason).toMatch(/between its previous push at 2026-10-17T10:10:00Z and the push/);
  });

  it('fails when the agent wrote no proposal at all, however old the go-ahead', () => {
    const v = goAheadFor({ at: '2026-12-01T10:00:00Z', pusher: AGENT }, [note('09:00', 'Ahmad-Faraj', `@${AGENT} go-ahead`)], low, config);
    expect(!v.ok && v.reason).toMatch(/wrote no proposal before the push/);
  });

  it('a proposal edited after the go-ahead needs a new go-ahead', () => {
    const edited = { ...proposal, updated_at: '2026-10-17T10:07:00Z' };
    expect(goAheadFor({ at: '2026-10-17T10:10:00Z', pusher: AGENT }, [edited, goAhead], low, config).ok).toBe(false);
  });

  it("doesn't count a comment that was edited into a go-ahead after the push", () => {
    const later = { ...note('10:05', 'Ahmad-Faraj', `@${AGENT} go-ahead`), updated_at: '2026-10-17T10:30:00Z' };
    expect(goAheadFor({ at: '2026-10-17T10:10:00Z', pusher: AGENT }, [proposal, later], low, config).ok).toBe(false);
  });

  it('fails when the go-ahead came from another agent or GitLabDuo, not a person', () => {
    for (const bot of ['ai-pipeline-fixer-group_b1d814', 'GitLabDuo']) {
      const fake = note('10:05', bot, `@${AGENT} go-ahead`);
      const v = goAheadFor({ at: '2026-10-17T10:10:00Z', pusher: AGENT }, [proposal, fake], low, config);
      expect(!v.ok && v.reason).toMatch(/is not one of the people/);
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
  const event = (at: string, by: string, ref: string, from: string | null, to: string | null): PushEvent => ({
    created_at: `2026-10-17T${at}:00Z`,
    author: { username: by },
    push_data: { ref, ref_type: 'branch', action: from ? 'pushed' : 'created', commit_from: from, commit_to: to },
  });

  it("takes this branch's pushes from GitLab's push events, oldest first", () => {
    const events = [event('10:10', AGENT, 'fix', 'b', 'c'), event('09:00', 'Ahmad-Faraj', 'other', null, 'x'), event('09:30', AGENT, 'fix', null, 'b'), event('11:00', 'Mazen-Ghanaym', 'fix', 'c', null)];
    expect(branchPushes(events, 'fix')).toEqual([
      { at: '2026-10-17T09:30:00Z', pusher: AGENT, from: null, to: 'b' },
      { at: '2026-10-17T10:10:00Z', pusher: AGENT, from: 'b', to: 'c' },
    ]);
  });

  it('gives each commit to the push that brought it, and reports commits no push brought', () => {
    // history a <- b <- c; d is unrelated
    const order = ['a', 'b', 'c'];
    const isAncestor = (x: string, y: string) => order.includes(x) && order.includes(y) && order.indexOf(x) <= order.indexOf(y);
    const pushes = [
      { at: '2026-10-17T09:30:00Z', pusher: AGENT, from: null, to: 'b' },
      { at: '2026-10-17T10:10:00Z', pusher: 'Ahmad-Faraj', from: 'b', to: 'c' },
    ];
    const { by, unaccounted } = attribute(['a', 'b', 'c', 'd'], pushes, isAncestor);
    expect(by.get('a')?.pusher).toBe(AGENT);
    expect(by.get('b')?.pusher).toBe(AGENT);
    expect(by.get('c')?.pusher).toBe('Ahmad-Faraj');
    expect(unaccounted).toEqual(['d']);
  });

  it("doesn't credit a push with commits its branch already had (they were pushed before the events we read)", () => {
    const order = ['a', 'b', 'c'];
    const isAncestor = (x: string, y: string) => order.indexOf(x) <= order.indexOf(y);
    const { by, unaccounted } = attribute(['a', 'b', 'c'], [{ at: '2026-10-17T10:10:00Z', pusher: AGENT, from: 'b', to: 'c' }], isAncestor);
    expect([...by.keys()]).toEqual(['c']);
    expect(unaccounted).toEqual(['a', 'b']);
  });

  it('gives the flows the maintainers to name', () => {
    expect(flowValues(config, {}).maintainers).toBe('@HamzaHassanain');
    expect(flowValues(DEFAULT_CONFIG, {}).maintainers).toMatch(/none set/);
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
    expect(loadConfig('../.autonomy.yml').goAhead).toEqual({
      maintainers: ['HamzaHassanain'],
      people: ['HamzaHassanain', 'Ahmad-Faraj', 'Mazen-Ghanaym'],
      byTier: { low: 'anyone', medium: 'anyone', high: 'maintainers' },
    });
  });

  it('refuses names that are not usernames and tiers that are not anyone or maintainers', () => {
    expect(load('go_ahead:\n  maintainers: "@hamza"\n')).toThrow('need a list of GitLab usernames');
    expect(load('go_ahead:\n  maintainers: ["@hamza"]\n')).toThrow('need a list of GitLab usernames');
    expect(load('go_ahead:\n  high: everyone\n')).toThrow('go_ahead.high: need "anyone" or "maintainers"');
    expect(load('go_ahead: maintainers\n')).toThrow('need a map');
    expect(load('go_ahead:\n  maintainers: [hamza, Hamza]\n')).toThrow('listed twice');
    expect(load('go_ahead:\n  maintainers: [ai-mr-reviewer-x]\n')).toThrow('is an agent or bot account');
    expect(load('go_ahead:\n  people: [a, ai-bot]\n')).toThrow('people: ai-bot is an agent or bot account');
    expect(load('go_ahead:\n  maintainers: [hamza]\n  people: [ahmad]\n')).toThrow('hamza is not in go_ahead.people');
  });
});

describe('governance globs', () => {
  it('match paths with newlines and non-ASCII names', async () => {
    const { matches } = await import('../src/glob.ts');
    expect(matches('engine/a\nb.ts', 'engine/**')).toBe(true);
    expect(matches('engine/é.ts', 'engine/**')).toBe(true);
    expect(matches('docs/a\nb/c.md', '*.md')).toBe(true);
    expect(matches('enginex/a.ts', 'engine/**')).toBe(false);
  });
});
