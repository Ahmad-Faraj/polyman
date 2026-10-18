import type { Counters, GuardRun, Ledger, NoteRef, OpenPush } from './ledger.ts';

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
}

export function renderLedgerPage({ ledger, open, runs, counters: c, web, generatedAt, commit }: PageInput): string {
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
<td><a href="${esc(r.mr_url)}">!${r.mr}</a>${r.closes.length ? `<br><span class="muted">closes ${r.closes.map((i) => `<a href="${esc(web)}/-/issues/${i}">#${i}</a>`).join(', ')}</span>` : ''}</td>
<td>${esc(r.flow)}<br><span class="muted">${esc(r.pushed_at.replace('T', ' ').replace('Z', ''))}</span></td>
<td>${r.commits.map((s) => sha(s, web)).join('<br>') || `<span class="muted">none, head</span> ${sha(r.head, web)}`}</td>
<td>${note(r.proposal, 'note')}</td>
<td>${note(r.go_ahead, 'note')}</td>
<td>${r.requesters.map(user).join('<br>') || '<span class="muted">nobody on record</span>'}</td>
<td>${r.approver_not_requester === null ? '<span class="muted">n/a</span>' : r.approver_not_requester ? '<span class="ok">holds</span>' : '<span class="bad">broken</span>'}</td>
<td>${esc(r.tier)}${r.rollback ? ' (rollback)' : ''}<br><span class="muted">${esc(r.allowed)}: ${r.allowed_approvers.map(esc).join(', ') || 'nobody'}</span></td>
<td>${r.accepted ? '<span class="ok">let through</span>' : `<span class="bad">refused</span><br><span class="muted">${r.reasons.map(esc).join('<br>')}</span>`}<br><a class="muted" href="${esc(web)}/-/pipelines/${r.guard.pipeline}">guard: ${esc(r.guard.status)}</a></td>
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
