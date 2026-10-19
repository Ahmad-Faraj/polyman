import type { Counters, GuardRun, Ledger, NoteRef, OpenPush } from './ledger.ts';
import { type Loop, type LoopGrams, type LoopSummary, gramsRange, summaryLine } from './loops.ts';

/** The ledger as a static page for Pages: the counters, then every record. */

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const user = (u: string) => `<a href="https://gitlab.com/${esc(u)}">@${esc(u)}</a>`;
const note = (n: NoteRef | null, label: string) => (n ? `<a href="${esc(n.url)}">${esc(label)} ${n.note}</a><br><span class="muted">${user(n.by)} · ${esc(n.at.replace('T', ' ').replace('Z', ''))}</span>` : '<span class="muted">none</span>');
const sha = (s: string, web: string) => `<a href="${esc(web)}/-/commit/${esc(s)}"><code>${esc(s.slice(0, 8))}</code></a>`;

export interface PageInput {
  ledger: Ledger;
  open: OpenPush[];
  runs: GuardRun[];
  counters: Counters;
  web: string;
  generatedAt: string;
  commit: string;
  /** one row per loop; the agent sessions' counts, when there are any */
  loops?: {
    rows: (Loop & { grams: LoopGrams | null })[];
    summary: LoopSummary;
    sessions: { countedUpTo: string; source: string } | null;
    grid: number;
  };
}

const when = (iso: string) => iso.replace('T', ' ').replace(/:\d\dZ$/, '').replace('Z', '');
export const duration = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`);

/** The loops: the summary line, then one row per agent-built change a person merged. */
export function renderLoops(loops: NonNullable<PageInput['loops']>, web: string): string {
  const { rows, summary, sessions, grid } = loops;
  const mr = (iid: number) => `<a href="${esc(web)}/-/merge_requests/${iid}">!${iid}</a>`;
  const body = rows
    .map((l) => {
      const fixGivers = [...new Set(l.go_aheads.slice(1).map((g) => g.by))].filter((by) => by !== l.go_ahead.by);
      const refused = [
        l.refused_pushes.length ? `${l.refused_pushes.length} push${l.refused_pushes.length === 1 ? '' : 'es'} <span class="muted">(${[...new Set(l.refused_pushes.map((p) => p.mr))].map(mr).join(', ')})</span>` : '',
        l.refused_go_aheads.length ? `${l.refused_go_aheads.length} go-ahead${l.refused_go_aheads.length === 1 ? '' : 's'} <span class="muted">(${l.refused_go_aheads.map((n) => `<a href="${esc(n.url)}">@${esc(n.by)}</a>`).join(', ')})</span>` : '',
      ].filter(Boolean);
      const g = l.grams;
      const flows = g ? Object.entries(g.byFlow).map(([f, n]) => `${n} ${esc(f)}`).join(', ') : '';
      return `<tr>
<td>${l.issues.length ? l.issues.map((i) => `<a href="${esc(web)}/-/issues/${i}">#${i}</a>`).join(', ') : '<span class="muted">none: the MR was the request</span>'}</td>
<td>${l.requesters.map(user).join('<br>') || '<span class="muted">nobody on record</span>'}</td>
<td>${user(l.go_ahead.by)}<br><a class="muted" href="${esc(l.go_ahead.url)}">${esc(when(l.go_ahead.at))}</a>${fixGivers.length ? `<br><span class="muted">fix rounds: ${fixGivers.map(user).join(', ')}</span>` : ''}</td>
<td>${mr(l.mr)}${l.moved_from.length ? `<br><span class="muted">moved from ${l.moved_from.map(mr).join(', ')}</span>` : ''}<br><span class="muted">${esc(l.flow)}</span></td>
<td>${l.merged_by ? user(l.merged_by) : '<span class="muted">not given</span>'}${l.giver_merged ? '<br><span class="muted">also gave a go-ahead</span>' : ''}<br><span class="muted">${esc(when(l.merged_at))}</span></td>
<td class="num">${esc(duration(l.minutes))}</td>
<td class="num">${l.fix_rounds}</td>
<td>${refused.join('<br>') || '<span class="muted">none</span>'}</td>
<td style="min-width: 180px">${g && g.sessions ? `<span class="num">${esc(gramsRange(g.low, g.high))}</span><br><span class="muted">${g.sessions} session${g.sessions === 1 ? '' : 's'}: ${flows}${g.uncounted ? `; ${g.uncounted} without a count` : ''}${g.partial ? '; later sessions not counted yet' : ''}</span>` : '<span class="muted">not counted</span>'}</td>
</tr>`;
    })
    .join('\n');
  const method = sessions
    ? `Grams: every agent session on the loop's issue and MRs up to the merge (the proposal, the build, each review, each fix round, the pipeline fixer), as counted from each session's checkpoint: the runner's measured time plus the counted model calls at 0.24-2.5 Wh each, at ${grid} gCO2e/kWh (<a href="${esc(web)}/-/blob/main/SUSTAINABILITY.md">SUSTAINABILITY.md</a>). The counts come from <a href="${esc(web)}/-/blob/main/sustainability/loop-sessions.json">sustainability/loop-sessions.json</a>, counted up to <strong>${esc(sessions.countedUpTo.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC'))}</strong>: CI can't read the session checkpoints with its job token, so a person's token counts them and the file is committed. A session that started from a pipeline event and isn't tied to the issue or MR (the one that opened an incident) isn't counted, so these lean low.`
    : 'No agent session counts are committed, so the loops are shown without grams.';
  return `<p class="summary">${esc(summaryLine(summary))}.</p>
<p class="muted">A loop is an agent-built change a person merged, from the request to the merge. Requester: who wrote the issue (or opened the MR, when there was no issue); their go-ahead never counts. Go-ahead to merge: from the go-ahead for the first push to the merge${summary.medianMinutes !== null ? `, median ${esc(duration(Math.round(summary.medianMinutes)))}` : ''}. Fix rounds: reviewer pushes a person gave a go-ahead to. Refused: agent pushes the guard refused on the loop's MRs, and go-aheads a person wrote that didn't count (from the requester, or not in the words the guard takes), after which the agent waited for another.</p>
<div class="scroll"><table>
<thead><tr><th>Issue</th><th>Requester</th><th>Go-ahead</th><th>MR</th><th>Merged by</th><th>Go-ahead → merge</th><th>Fix rounds</th><th>Refused</th><th>gCO2e, low-high</th></tr></thead>
<tbody>
${body || '<tr><td colspan="9" class="muted">No agent-built change merged yet.</td></tr>'}
</tbody>
</table></div>
<p class="muted">${method} As JSON: <a href="loops.json">loops.json</a>.</p>`;
}

export function renderLedgerPage({ ledger, open, runs, counters: c, web, generatedAt, commit, loops }: PageInput): string {
  const byWhom = Object.entries(c.byWhom)
    .sort(([, a], [, b]) => b - a)
    .map(([who, n]) => `${user(who)} ${n}`)
    .join(', ');
  const tiles = [
    ['Go-aheads given', String(c.goAheads), byWhom || 'nobody yet'],
    ['Approver is not the requester', `${c.approverNotRequester.holds}/${c.approverNotRequester.of}`, 'checked again on every record'],
    ['Agent pushes let through', `${c.accepted}/${c.records}`, 'each on its own go-ahead'],
    ['Agent pushes stopped', String(c.stopped), `refused by the guard's rules; autonomy:goahead also failed ${c.failedRuns} run${c.failedRuns === 1 ? '' : 's'} on agent MRs (below)`],
  ]
    .map(([label, value, sub]) => `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${sub}</div></div>`)
    .join('\n');

  const rows = ledger.records
    .map(
      (r) => `<tr class="${r.accepted ? '' : 'refused'}">
<td>${r.seq}</td>
<td><a href="${esc(r.mr_url)}">!${r.mr}</a>${r.carried_by ? `<br><span class="muted">merged in</span> <a href="${esc(r.carried_by.mr_url)}">!${esc(r.carried_by.mr)}</a>` : ''}${r.closes.length ? `<br><span class="muted">closes ${r.closes.map((i) => `<a href="${esc(web)}/-/issues/${i}">#${i}</a>`).join(', ')}</span>` : ''}</td>
<td>${esc(r.flow)}<br><span class="muted">${esc(r.pushed_at.replace('T', ' ').replace('Z', ''))}</span></td>
<td>${r.commits.map((s) => sha(s, web)).join('<br>') || `<span class="muted">none, head</span> ${sha(r.head, web)}`}</td>
<td>${note(r.proposal, 'note')}</td>
<td>${note(r.go_ahead, 'note')}</td>
<td>${r.requesters.map(user).join('<br>') || '<span class="muted">nobody on record</span>'}</td>
<td>${r.approver_not_requester === null ? '<span class="muted">n/a</span>' : r.approver_not_requester ? '<span class="ok">holds</span>' : '<span class="bad">broken</span>'}</td>
<td>${esc(r.tier)}${r.rollback ? ' (rollback)' : ''}<br><span class="muted">${esc(r.allowed)}: ${r.allowed_approvers.map(esc).join(', ') || 'nobody'}</span></td>
<td>${r.accepted ? '<span class="ok">let through</span>' : `<span class="bad">refused</span><br><span class="muted">${r.reasons.map(esc).join('<br>')}</span>`}<br>${r.guard.pipeline === null ? `<span class="muted">guard: ${esc(r.guard.status)}</span>` : `<a class="muted" href="${esc(web)}/-/pipelines/${r.guard.pipeline}">guard: ${esc(r.guard.status)}</a>`}</td>
<td><code title="SHA-256 of record ${r.seq - 1}">${esc(r.prev.slice(0, 12))}</code></td>
</tr>`,
    )
    .join('\n');

  const openRows = open
    .map(
      (p) => `<tr class="${p.accepted ? '' : 'refused'}"><td><a href="${esc(p.mr_url)}">!${p.mr}</a> <span class="muted">${esc(p.state)}</span></td><td>${esc(p.flow)}<br><span class="muted">${esc(p.pushed_at.replace('T', ' ').replace('Z', ''))}</span></td><td>${note(p.go_ahead, 'note')}</td><td>${p.accepted ? '<span class="ok">let through</span>' : `<span class="bad">refused</span><br><span class="muted">${p.reasons.map(esc).join('<br>')}</span>`}</td></tr>`,
    )
    .join('\n');
  const failed = runs.filter((r) => r.status === 'failed');
  const failedList = failed.map((r) => `<li><a href="${esc(r.url)}">pipeline ${r.pipeline}</a> on <a href="${esc(web)}/-/merge_requests/${r.mr}">!${r.mr}</a> (${esc(r.at.replace('T', ' ').replace('Z', ''))}, <code>${esc(r.sha.slice(0, 8))}</code>)</li>`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Go-ahead ledger</title>
<style>
:root { --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6b66; --line: #e2e1dc; --tile: #ffffff; --ok: #1a7f37; --bad: #b42318; --refused: #fdf1ef; --link: #1f5fbf; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe6; --muted: #a09f98; --line: #34332f; --tile: #1f1f1d; --ok: #4ac26b; --bad: #ff7b72; --refused: #2a1a18; --link: #7cacf8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1280px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; margin: 0 0 8px; }
h2 { font-size: 18px; margin: 40px 0 12px; }
p { max-width: 75ch; }
a { color: var(--link); }
code { font: 13px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
.muted { color: var(--muted); font-size: 13px; }
.ok { color: var(--ok); font-weight: 600; }
.bad { color: var(--bad); font-weight: 600; }
.summary { font-size: 18px; font-weight: 600; max-width: none; }
.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 24px 0; }
.tile { background: var(--tile); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.tile .label { color: var(--muted); font-size: 13px; }
.tile .value { font-size: 32px; font-weight: 650; font-variant-numeric: tabular-nums; margin: 4px 0; }
.tile .sub { color: var(--muted); font-size: 13px; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--tile); }
table { border-collapse: collapse; width: 100%; min-width: 1100px; }
th, td { text-align: left; vertical-align: top; padding: 10px 12px; border-bottom: 1px solid var(--line); }
th { font-size: 13px; color: var(--muted); font-weight: 600; white-space: nowrap; }
tr.refused td { background: var(--refused); }
tr:last-child td { border-bottom: 0; }
</style>
</head>
<body>
<main>
<h1>Go-ahead ledger</h1>
<p>Every push an agent made to a merged MR since the go-ahead guard (<code>autonomy:goahead</code>) reached <code>main</code> (${sha(ledger.since.commit, web)}, ${esc(ledger.since.at.replace('T', ' ').replace('Z', ' UTC'))}), judged again by the guard's own code from what GitLab recorded: who wrote each note and when, who pushed what and when. Each record holds the SHA-256 of the record before it. CI rebuilds the chain from the GitLab API on every pipeline on <code>main</code> and fails if this published ledger isn't the start of the rebuilt one, so a record can't be changed after the fact. The rules: <a href="${esc(web)}/-/wikis/Assisted">Assisted</a>.</p>
${loops ? `<h2>One row per loop</h2>\n${renderLoops(loops, web)}\n<h2>Every agent push</h2>` : ''}
<div class="tiles">
${tiles}
</div>
<h2>The chain</h2>
<div class="scroll"><table>
<thead><tr><th>#</th><th>MR</th><th>Agent, push</th><th>Commits</th><th>Proposal</th><th>Go-ahead</th><th>Requester</th><th>Approver ≠ requester</th><th>Risk, who may approve</th><th>Guard</th><th>Previous</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="11" class="muted">No agent push on a merged MR yet.</td></tr>'}
</tbody>
</table></div>
<p class="muted">${ledger.records.length} record${ledger.records.length === 1 ? '' : 's'}, head <code>${esc(ledger.head)}</code>, judged by rules ${ledger.rules}.${ledger.replaces ? ` This chain replaced one of ${ledger.replaces.records} records judged by rules ${ledger.replaces.rules}, head <code>${esc(ledger.replaces.head)}</code>.` : ''} The records as JSON: <a href="ledger.json">ledger.json</a>.</p>
<h2>MRs not merged (not in the chain yet)</h2>
<p class="muted">An MR that isn't merged can still change, so its agent pushes join the chain when it merges.</p>
${open.length ? `<div class="scroll"><table style="min-width: 640px"><thead><tr><th>MR</th><th>Agent, push</th><th>Go-ahead</th><th>Verdict</th></tr></thead><tbody>\n${openRows}\n</tbody></table></div>` : '<p class="muted">None.</p>'}
<h2>Guard runs that failed an agent MR's pipeline</h2>
${failed.length ? `<ul>\n${failedList}\n</ul>` : '<p class="muted">None.</p>'}
<p class="muted">${runs.length} autonomy:goahead run${runs.length === 1 ? '' : 's'} on MRs an agent pushed to. A failed run blocks the merge until it passes; the job log says why.</p>
<p class="muted">Built ${esc(generatedAt.replace('T', ' ').replace('Z', ' UTC'))} from <a href="${esc(web)}/-/commit/${esc(commit)}"><code>${esc(commit.slice(0, 8))}</code></a> by <code>engine/src/cli/ledger.ts</code>.</p>
</main>
</body>
</html>
`;
}
