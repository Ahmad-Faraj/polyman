// The page talks to the API and renders the newline-delimited JSON events
// that /api/verify streams back while it works, as a plain-English report in
// the result card. Components are Basecoat (shadcn/ui for plain HTML).
const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  demo: $('#demo'),
  own: $('#own'),
  form: $('#upload'),
  file: $('#file'),
  pick: $('#pick'),
  samples: $('#sample-list'),
  run: $('#run'),
  head: $('#run > header'),
  title: $('#run-title'),
  verdict: $('#run-verdict'),
  sub: $('#run-sub'),
  status: $('#run-status'),
  announce: $('#announce'),
  problems: $('#problems'),
  actions: $('#run-actions'),
  start: $('#start'),
  stop: $('#stop'),
  instead: $('#instead'),
  again: $('#again'),
  next: $('#next'),
  choose: $('#choose'),
  download: $('#download'),
  log: $('#run-log'),
  facts: $('#run-facts'),
  tpl: $('#problem-tpl'),
};

const GITLAB = 'https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase';
const MAX_BYTES = 20 * 1024 * 1024;
/** The sample the big button runs: it has one planted mistake for the check to find. */
const DEMO = 'wrong-tag';
/** The sample that passes, offered after one that doesn't. */
const PASSING = 'even-sum';
/** How many times a run waits for a free slot before it gives up. */
const MAX_TRIES = 5;
/**
 * Each sample in words for someone who has never set a contest problem, the solution its story
 * is about (if one), and each solution's tag as the sample's Config.json sets it.
 */
const EVEN_SUM_TAGS = { main: 'MA', correct2: 'OK', tle_solution: 'TL', first_only: 'WA' };
const SAMPLES = {
  'even-sum': ['A problem that is ready', 'Every solution behaves as labelled and every contest guideline is met.', null, EVEN_SUM_TAGS],
  'not-ready': ['Correct, but not contest-ready', 'All solutions behave as labelled, but it has too few tests and no tutorial.', null, EVEN_SUM_TAGS],
  'sandbox-check': ['A solution needing admin rights', 'One solution only works when run as root. The sandbox never grants that, so it fails as labelled.', 'not_root', { ...EVEN_SUM_TAGS, not_root: 'WA' }],
  'wrong-tag': ['A solution with the wrong label', 'One solution is labelled correct but gives wrong answers.', 'first_only', { ...EVEN_SUM_TAGS, first_only: 'OK' }],
};
/** What a solution's label promises, and what a test's verdict means. */
const TAG_WORDS = { MA: 'main correct solution', OK: 'correct', WA: 'wrong answer', TL: 'too slow', ML: 'too much memory', RE: 'crashes', PE: 'badly formatted output', TO: 'correct, may be slow', RJ: 'fails somehow' };
const VERDICT_WORDS = { OK: 'passed', WA: 'wrong answer', TLE: 'too slow', MLE: 'too much memory', RE: 'crashed', PE: 'badly formatted output', CE: 'did not compile' };
const RELABEL = { WA: 'a wrong answer', TLE: 'too slow', MLE: 'using too much memory', RE: 'crashing', PE: 'badly formatted output' };
/** polyman's ten steps in the order it runs them, said plainly. */
const STEP_WORDS = {
  'Compiling Generators': 'Building the test generators',
  'Generating Tests': 'Generating the tests',
  'Compiling Validator': 'Building the input validator',
  'Testing Validator': 'Testing the input validator',
  'Validating Generated Tests': 'Checking that every test is valid',
  'Compiling Checker': 'Building the answer checker',
  'Testing Checker': 'Testing the answer checker',
  'Compiling Solutions': 'Compiling every solution',
  'Running Solutions': 'Running every solution',
  'Verifying Solutions Against Main Correct': 'Comparing results with labels',
};
const STEPS = Object.keys(STEP_WORDS);
/** The same ten steps by the names polyman's report gives them. */
const STEP_TITLE = {
  'compile-generators': 'Compiling Generators',
  'generate-tests': 'Generating Tests',
  'compile-validator': 'Compiling Validator',
  'test-validator': 'Testing Validator',
  'validate-tests': 'Validating Generated Tests',
  'compile-checker': 'Compiling Checker',
  'test-checker': 'Testing Checker',
  'compile-solutions': 'Compiling Solutions',
  'run-solutions': 'Running Solutions',
  'verify-solutions': 'Verifying Solutions Against Main Correct',
};
/** Where the project publishes its own records (GitLab Pages), and its public API. */
const PAGES = 'https://showcase-ce2cdc.gitlab.io';
const API = `https://gitlab.com/api/v4/projects/${encodeURIComponent('gitlab-ai-hackathon/transcend-october-2026/30770856/showcase')}`;
/** The contest guidelines, said plainly. */
const GUIDE_WORDS = {
  statement_completeness: 'The statement has a story, input and output',
  test_coverage: 'At least 10 tests',
  checker_presence: 'Has an answer checker',
  validator_presence: 'Has an input validator',
  checker_correctness: 'The answer checker passes its own tests',
  solution_presence: 'Has a main correct solution',
  solution_diversity: 'Correct solutions in C++ and Java, plus a wrong one',
  tags_presence: 'Has topic tags',
  tutorial_presence: 'Has a written tutorial',
};
/** What to do about each guideline that isn't met. */
const GUIDE_FIX = {
  statement_completeness: 'give the statement a story, an input and an output section',
  test_coverage: 'add tests until there are at least 10',
  checker_presence: 'add an answer checker',
  validator_presence: 'add an input validator',
  checker_correctness: 'make the answer checker pass its own tests',
  solution_presence: 'add a main correct solution',
  solution_diversity: 'add correct solutions in C++ and Java, plus a wrong one',
  tags_presence: 'add topic tags',
  tutorial_presence: 'write a tutorial',
};
/** What a solution did on a test, as a verb phrase: "got a wrong answer". */
const DID_WORDS = { OK: 'passed', WA: 'got a wrong answer', TLE: 'was too slow', MLE: 'used too much memory', RE: 'crashed', PE: 'printed badly formatted output', CE: 'did not compile' };
/** Each sample on its switch: its name and a few words on what it holds, never its outcome. */
const SAMPLE_HINT = {
  'wrong-tag': 'a planted mistake',
  'even-sum': 'the baseline',
  'not-ready': 'missing pieces',
  'sandbox-check': 'asks for root',
};
/** What each sample asks before it runs: a question, never its outcome. */
const SAMPLE_ASK = {
  'even-sum': 'Is this problem ready for a contest?',
  'not-ready': 'Every solution works. Is it ready for a round?',
  'sandbox-check': 'One solution needs root. Does the sandbox hold?',
};
const SEVERITY_WORDS = { critical: 'must fix', warning: 'recommended', info: 'nice to have' };
const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

const tagWords = (t) => TAG_WORDS[t] ?? t;
const verdictWords = (v) => VERDICT_WORDS[v] ?? v;
const verdictKind = (v) => (v === 'OK' ? 'ok' : /^(TLE|MLE|TL|ML|IL|ILE)$/.test(v) ? 'limit' : 'bad');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A count that opens a sentence: "One solution", "12 solutions". */
const Plural = (n, one, many = `${one}s`) => `${NUMBER_WORDS[n] ?? n} ${n === 1 ? one : many}`;
const seconds = (s) => `${s.toFixed(1)} s`;
const ms = (n) => (n >= 1000 ? seconds(n / 1000) : `${n} ms`);
const icon = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** The service's own detail text, with "(s)" plurals and "./" paths tidied. */
const tidy = (s = '') =>
  s
    .replace(/(\d+) ((?:[a-z]+ )*)([a-z]+)\(s\)/gi, (_, n, words, w) => `${n} ${words}${Number(n) === 1 ? w : `${w}s`}`)
    .replace(/\.\//g, '')
    .replace(/compile-checker: ok, test-checker: ok/, 'it builds and passes its own tests');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let events = [];
let running = false;
let label = '';
let lastRun = null;
let controller = null;
let timer = 0;
let retry = 0;
let step = 0;
let runStart = 0;
/** The step each problem has reached, so a contest's hero parts follow the slowest. */
const reached = new Map();
/** The run as it happened: each event as it arrived, timed from the click. */
let runLog = [];
/** When each of a problem's steps began, on the same clock. */
const stepAt = new Map();
/** When the (single) problem's result arrived, on the same clock. */
let resultAt = 0;
let lastVerdict = '';
/** Each sample's solution names, so a run shows who is being judged before results arrive. */
const expected = new Map();
const demoLabel = els.demo.innerHTML;
/** The sample the card's own button runs, and the card's words before the demo has run. */
let pending = DEMO;
const demoHead = [els.title.textContent, els.verdict.textContent, els.sub.textContent];

fetch('/api/version')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((v) => {
    $('#version').textContent = `Live on Google Cloud Run · polyman ${v.polyman}`;
    const commit = $('#commit');
    commit.textContent = `Deployed commit ${String(v.commit).slice(0, 7)}`;
    if (/^[0-9a-f]{7,40}$/i.test(String(v.commit))) commit.href = `${GITLAB}/-/commit/${v.commit}`;
  })
  .catch((err) => console.warn('version unavailable', err));

/** The GitLab records with a line of real figures each, read from the project's own published data; the plain text stays if a source can't be read. */
const getJSON = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
/** How many items a GitLab list has, from its X-Total header. */
const getTotal = (url) =>
  fetch(url).then((r) => {
    const n = Number(r.headers.get('x-total'));
    return r.ok && Number.isInteger(n) && n >= 0 ? n : Promise.reject(new Error(`HTTP ${r.status}`));
  });
// (dates as the sources write them, in UTC, so every viewer sees the same day)
const isDate = (iso) => typeof iso === 'string' && !Number.isNaN(Date.parse(iso));
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const count = (n) => Number.isInteger(n) && n >= 0;
const grams = (g) => (g < 10 ? g.toFixed(1) : String(Math.round(g)));
/** A record's line of figures; a source that can't be read, or reads oddly, leaves the plain text alone. */
function stat(name, text) {
  const el = $(`[data-stat="${name}"]`);
  el.textContent = text;
  el.classList.remove('loading');
}
function noStat(name, err) {
  console.warn(`${name} figures unavailable`, err);
  $(`[data-stat="${name}"]`).hidden = true;
}
const bad = (what) => Promise.reject(new Error(`unexpected ${what}`));
/** The ledger's counts, or null when its records read oddly. */
function ledgerCounts(l) {
  const recs = Array.isArray(l?.records) ? l.records : [];
  // (a go-ahead that didn't count may have no approver on record; only an accepted one needs one)
  if (!recs.length || !recs.every((r) => isDate(r?.merged_at) && typeof r?.agent === 'string' && (r?.accepted !== true || typeof r?.go_ahead?.by === 'string'))) return null;
  return {
    total: recs.length,
    approved: recs.filter((r) => r.accepted === true && r.approver_not_requester === true).length,
    agents: new Set(recs.map((r) => r.agent)).size,
    approvers: new Set(recs.filter((r) => r.accepted === true).map((r) => r.go_ahead.by)).size,
    newest: recs.map((r) => r.merged_at).sort().at(-1),
  };
}
getJSON(`${PAGES}/ledger/ledger.json`)
  .then((l) => {
    const c = ledgerCounts(l);
    if (!c) return bad('ledger');
    const { total, approved, agents, approvers, newest } = c;
    // (counts only: who approved stays on the ledger's own page)
    stat('ledger', `${approved === total ? total : `${approved} of ${total}`} agent pushes, each approved by a teammate who didn't ask for it · ${plural(agents, 'agent')}, ${plural(approvers, 'approver')} · newest ${day(newest)}`);
    if (typeof l.head === 'string') $('[data-stat="ledger"]').title = `Chain head ${l.head.slice(0, 12)}`;
  })
  .catch((err) => noStat('ledger', err));
// the deploys: pipelines a push to main started (the nightly judges run on a schedule and are left out)
getJSON(`${API}/pipelines?ref=main&source=push&per_page=20`)
  .then((list) => {
    if (!Array.isArray(list) || !list.length || !list.every((p) => count(p?.iid) && typeof p?.status === 'string')) return bad('pipelines');
    const done = list.find((p) => ['success', 'failed'].includes(p.status) && isDate(p.updated_at));
    const latest = list[0];
    const parts = [];
    if (latest.status === 'manual') parts.push(`Pipeline #${latest.iid} on main: waiting for a person`);
    else if (['running', 'pending', 'created'].includes(latest.status)) parts.push(`Pipeline #${latest.iid} on main: running`);
    if (done) parts.push(`last deploy pipeline #${done.iid} ${done.status === 'success' ? 'passed' : 'failed'}, ${day(done.updated_at)}`);
    if (!parts.length) return bad('pipelines');
    parts[0] = cap(parts[0]);
    stat('pipelines', parts.join(' · '));
  })
  .catch((err) => noStat('pipelines', err));
getJSON(`${PAGES}/sci/sci-report.json`)
  .then((s) => {
    const tiers = Array.isArray(s?.tiers) ? s.tiers : [];
    const tier = (name) => tiers.find((t) => t?.tier === name && Number.isFinite(t?.grams?.low) && Number.isFinite(t?.grams?.high) && count(t?.reviews));
    const high = tier('high');
    const low = tier('low');
    if (!high || !low || !isDate(s.from) || !isDate(s.to)) return bad('carbon report');
    const reviews = tiers.reduce((n, t) => n + (count(t?.reviews) ? t.reviews : 0), 0);
    // (the report's medians per review, each a low-high range)
    stat('sci', `High-risk review ${grams(high.grams.low)}–${grams(high.grams.high)} g CO₂e, low-risk ${grams(low.grams.low)}–${grams(low.grams.high)} g (medians) · ${plural(reviews, 'review')}, ${day(s.from)} to ${day(s.to)}`);
  })
  .catch((err) => noStat('sci', err));
// the judges: bugs their issues are labelled as found by, and the incidents the nightly runs and drills filed
Promise.all([
  getTotal(`${API}/issues?labels=found-by::corpus,bug&state=all&per_page=1`),
  getTotal(`${API}/issues?labels=found-by::polygon,bug&state=all&per_page=1`),
  getTotal(`${API}/issues?labels=found-by::mutation&state=all&per_page=1`),
  getJSON(`${API}/issues?issue_type=incident&state=all&per_page=100`),
])
  .then(([corpus, polygon, mutation, incidents]) => {
    if (!Array.isArray(incidents) || !incidents.every((i) => typeof i?.state === 'string' && typeof i?.title === 'string')) return bad('issues');
    if (!corpus && !polygon) return bad('issues');
    const closed = incidents.filter((i) => i.state === 'closed').length;
    const drills = incidents.filter((i) => /^drill\b/i.test(i.title)).length;
    const parts = [`${plural(corpus + polygon, 'bug')} found: ${corpus} by the corpus, ${polygon} by the Polygon round trip`];
    if (mutation) parts.push(`${plural(mutation, 'issue')} from mutation testing`);
    if (incidents.length) parts.push(`${plural(incidents.length, 'incident')}${drills ? ` (${drills} ${drills === 1 ? 'drill' : 'drills'})` : ''}, ${closed === incidents.length ? 'all closed' : `${closed} closed`}`);
    stat('judges', parts.join(' · '));
  })
  .catch((err) => noStat('judges', err));

fetch('/api/samples')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((samples) => {
    for (const s of samples) expected.set(s.name, Object.keys(s.expected?.solutions ?? {}));
    // a link with ?sample=<name> sets that sample up in the card, ready to run (a reload doesn't start a check)
    const linked = new URLSearchParams(location.search).get('sample');
    if (!running && !events.length) {
      if (linked && expected.has(linked)) showIdle(linked);
      else if (expected.has(DEMO)) showIdle(DEMO);
    }
    // one tab per sample along the top of the card, the demo first; pressing one checks it live
    for (const s of [...samples].sort((a, b) => Number(b.name === DEMO) - Number(a.name === DEMO))) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sample';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', 'run');
      b.dataset.sample = s.name;
      b.textContent = s.name;
      const hint = SAMPLE_HINT[s.name] ?? s.description;
      b.dataset.tooltip = hint;
      b.dataset.side = 'bottom';
      b.setAttribute('aria-description', hint);
      b.addEventListener('click', () => {
        // (the tooltip of the tab just pressed would sit over the card for the whole run)
        b.classList.add('quiet');
        b.addEventListener('pointerleave', () => b.classList.remove('quiet'), { once: true });
        runSample(s.name);
      });
      els.samples.append(b);
    }
    markSample(pending);
    els.samples.addEventListener('scroll', edge, { passive: true });
    addEventListener('resize', edge);
    edge();
  })
  .catch((err) => {
    console.error(err);
    els.samples.innerHTML = '<p class="switcher-error">The samples could not be loaded right now.</p>';
    if (!running && !events.length) {
      setHead('Live check', 'The samples are unavailable right now.', 'You can still check your own problem: choose a .zip below.');
      els.start.hidden = true;
    }
  });

const runSample = (name) => start(`/api/samples/${encodeURIComponent(name)}/verify`, null, name);

/** The ten steps as daisyUI Steps, a ready-made stepper: a line of steps joined by connectors, each lit as the run reaches it.
 * Each step has a short name and, on hover or focus, what it does. */
const STEP_SHORT = {
  'Compiling Generators': 'Build generators',
  'Generating Tests': 'Generate tests',
  'Compiling Validator': 'Build validator',
  'Testing Validator': 'Test validator',
  'Validating Generated Tests': 'Check every test',
  'Compiling Checker': 'Build checker',
  'Testing Checker': 'Test checker',
  'Compiling Solutions': 'Compile',
  'Running Solutions': 'Run',
  'Verifying Solutions Against Main Correct': 'Compare labels',
};
/** What each step does, in the words of the "What the check does" section. */
const STEP_INFO = {
  'Compiling Generators': 'Builds the problem’s test generators.',
  'Generating Tests': 'Runs the generators to write every test.',
  'Compiling Validator': 'Builds the validator, the program that says whether a test input is allowed.',
  'Testing Validator': 'Runs the validator on its own tests.',
  'Validating Generated Tests': 'Checks that every generated test is valid.',
  'Compiling Checker': 'Builds the answer checker, the program that decides every answer.',
  'Testing Checker': 'Runs the checker on its own tests, because it decides every answer that follows.',
  'Compiling Solutions': 'Compiles every solution with its own language.',
  'Running Solutions': 'Runs each solution on the tests with the time and memory limits, in a sandbox with no internet.',
  'Verifying Solutions Against Main Correct': 'Compares what each solution did with the main correct solution and with its label.',
};
const STEP_CLASS = { done: 'step-primary', now: 'step-primary', failed: 'step-error', stopped: 'step-neutral', pending: '' };
const STEP_ICON = { done: 'i-check', now: 'i-spin', failed: 'i-x', stopped: 'i-stop', pending: 'i-dot' };

/** Build the pipeline once, every step waiting. (The tooltip sits on the label: the step's own ::before is its connector.) */
function buildPipeline(node) {
  const el = $('.pipeline', node);
  if (!el || el.children.length) return;
  for (const title of STEPS) {
    const li = document.createElement('li');
    li.className = 'step';
    li.dataset.title = title;
    li.dataset.state = 'pending';
    li.innerHTML = `<span class="step-icon">${icon('i-dot')}</span><span class="step-label" tabindex="0" data-align="center"><span></span><small></small></span>`;
    const label = $('.step-label', li);
    label.dataset.tooltip = `${STEP_WORDS[title]}. ${STEP_INFO[title]}`;
    $('.step-label > span', li).textContent = STEP_SHORT[title];
    el.append(li);
  }
}

/** One step in a state: its class (the colour), its icon, and the time it took once it is known. */
function paintStep(li, state, time = '') {
  if (li.dataset.state !== state) {
    li.dataset.state = state;
    li.className = `step ${STEP_CLASS[state]}`.trim();
    $('.step-icon', li).innerHTML = icon(STEP_ICON[state]);
  }
  $('small', li).textContent = time;
}

/** Light the pipeline to step `at` (0-9): the ones before it done, that one under way, the rest waiting. */
function setPipeline(node, at) {
  buildPipeline(node);
  node.querySelectorAll('.pipeline .step').forEach((li, i) => paintStep(li, i < at ? 'done' : i === at ? 'now' : 'pending'));
}

/** The run is over: each step as its report has it (passed, failed or not reached), with the time it took. */
function finishPipeline(node, steps, took) {
  buildPipeline(node);
  const byTitle = new Map(steps.map((s) => [s.title, s]));
  const time = (ms) => (ms < 100 ? `${Math.max(1, Math.round(ms))} ms` : seconds(ms / 1000));
  for (const li of node.querySelectorAll('.pipeline .step')) {
    const title = li.dataset.title;
    const s = byTitle.get(title);
    const state = !s ? 'pending' : s.state === 'ok' ? 'done' : s.state === 'failed' ? 'failed' : 'stopped';
    const dur = s ? took(title) : null;
    const text = dur === null ? '' : time(dur);
    paintStep(li, state, text);
    $('.step-label', li).dataset.tooltip = `${STEP_WORDS[title]}. ${STEP_INFO[title]}${state === 'failed' ? ' It failed.' : state === 'pending' ? ' Not reached.' : text ? ` Took ${text}.` : ''}`;
  }
}

/** All ten steps up front, the first under way, so the wait shows how far along it is. */
function runningSteps(node) {
  setPipeline(node, 0);
}

/** Empty the card's body for what comes next, the guidelines too (after a result they sit below its actions). */
function clearProblems(...nodes) {
  els.run.querySelector(':scope > .more')?.remove();
  els.problems.replaceChildren(...nodes);
}

/** Before any run: the demo sample's real solution names, waiting to be judged. */
function showPreview(name) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  $('.problem-name', node).classList.add('sr-only');
  $('.problem-name', node).textContent = name;
  setPipeline(node, -1);
  waitingRows(node, name);
  clearProblems(node);
}

/** Before a sample runs: its solutions in the card, its story in the head, and the card's own button. */
function showIdle(name) {
  pending = name;
  markSample(name);
  showPreview(name);
  if (name === DEMO) setHead(...demoHead);
  else {
    const [title, desc] = SAMPLES[name] ?? [name, ''];
    // the verdict slot only ever holds what a check found: before one, it asks
    setHead(`Live check · sample problem “${name}”`, SAMPLE_ASK[name] ?? `Is ${title.toLowerCase()} ready to use?`, 'Each solution below is labelled with how it should behave. Run the check to see what it finds. It takes about 20 seconds.');
  }
  setStatus('Not run yet', 'secondary');
  els.actions.hidden = false;
  for (const b of [els.stop, els.instead, els.again, els.next, els.choose, els.download]) b.hidden = true;
  els.start.hidden = false;
}

/** The tab for the sample in the result card is the selected one, and the one Tab lands on. */
function markSample(name) {
  const tabs = [...els.samples.querySelectorAll('.sample')];
  for (const b of tabs) {
    b.setAttribute('aria-selected', String(b.dataset.sample === name));
    b.tabIndex = b.dataset.sample === name ? 0 : -1;
  }
  // (an upload is none of them: then the first tab takes Tab)
  if (tabs.length && !tabs.some((b) => b.tabIndex === 0)) tabs[0].tabIndex = 0;
  showTab(tabs.find((b) => b.dataset.sample === name));
}

/** On a phone the tabs scroll sideways: the row fades at its edge while more tabs are off to the right. */
function edge() {
  els.samples.classList.toggle('more-right', els.samples.scrollLeft + els.samples.clientWidth < els.samples.scrollWidth - 2);
}

/** Scroll the tab row (not the page) so a tab and its icon are clear of the edge fade. */
function showTab(tab) {
  if (!tab) return;
  const list = els.samples.getBoundingClientRect();
  const r = tab.getBoundingClientRect();
  // (the fade is 40px wide)
  if (r.right > list.right - 40) els.samples.scrollLeft += r.right - list.right + 40;
  else if (r.left < list.left) els.samples.scrollLeft -= list.left - r.left;
  edge();
}

/** A solution's label under its name; the word "labelled" only where no column heading says so (a phone). */
function labelText(el, tag) {
  el.innerHTML = '<span class="label-word">labelled </span><span></span>';
  el.lastChild.textContent = `${tagWords(tag)} (${tag})`;
}

/** A row per solution the sample is known to have, with an empty strip where its tests will go. */
function waitingRows(node, name) {
  const tbody = $('tbody', node);
  // the solution the sample is about comes first, where its result will be
  const about = SAMPLES[name]?.[2];
  // (not for the demo: putting its planted mistake first would give the answer away)
  const lead = name === DEMO ? null : about;
  for (const sol of [...(expected.get(name) ?? [])].sort((a, b) => Number(b === lead) - Number(a === lead))) {
    const tr = document.createElement('tr');
    tr.className = 'waiting';
    tr.innerHTML = `<td class="sol"><b class="sol-name"></b><span class="sol-label"></span></td><td class="tests"><span class="skeleton" aria-hidden="true"></span></td><td class="slow"><span class="skeleton" aria-hidden="true"></span></td><td class="res"><span class="skeleton" aria-hidden="true"></span></td>`;
    $('.sol-name', tr).textContent = sol;
    const tag = SAMPLES[name]?.[3]?.[sol];
    if (tag) labelText($('.sol-label', tr), tag);
    else $('.sol-label', tr).remove();
    tbody.append(tr);
  }
  $('.table-container', node).hidden = !tbody.children.length;
}

els.demo.addEventListener('click', () => runSample(pending));
// Esc stops a running check, as the Stop button does
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && running && !els.stop.hidden) els.stop.click();
});
els.start.addEventListener('click', () => runSample(pending));
// the sample tabs read like tabs to the keyboard too: arrows move along them
els.samples.addEventListener('keydown', (e) => {
  const tabs = [...els.samples.querySelectorAll('.sample')];
  const at = tabs.indexOf(document.activeElement);
  const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (to === undefined || at < 0) return;
  e.preventDefault();
  const next = tabs[(to + tabs.length) % tabs.length];
  // (the focused tab is the one Tab leaves from, as in the APG tabs pattern)
  for (const b of tabs) b.tabIndex = b === next ? 0 : -1;
  next.focus();
  showTab(next);
});
els.instead.addEventListener('click', () => runSample(pending));
// the hero's button leads to the upload box first: it says what to zip before the file picker opens
els.own.addEventListener('click', () => {
  els.form.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'center' });
  els.pick.focus({ preventScroll: true });
  els.form.classList.remove('flash');
  requestAnimationFrame(() => els.form.classList.add('flash'));
});
for (const b of [els.pick, els.choose]) b.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  const f = els.file.files[0];
  // clear it, so choosing the same file again (after fixing it) still starts a run
  els.file.value = '';
  if (f) upload(f);
});
// a zip dropped anywhere on the page is checked, not opened by the browser
const carriesFiles = (e) => e.dataTransfer?.types.includes('Files');
for (const ev of ['dragenter', 'dragover']) {
  addEventListener(ev, (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    els.form.classList.add('over');
  });
}
addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) els.form.classList.remove('over');
});
addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  els.form.classList.remove('over');
  if (running) return notice('A check is already running. Drop the zip again when it ends.');
  const files = e.dataTransfer.files;
  if (files.length > 1) {
    label = 'Your upload';
    return showError(`You dropped ${files.length} files.`, null, 'local', 'Drop one .zip. For a contest, put every problem in that one zip.');
  }
  if (files[0]) upload(files[0]);
});
els.form.addEventListener('submit', (e) => e.preventDefault());
els.stop.addEventListener('click', () => {
  if (!retry) return controller?.abort();
  cancelRetry();
  stopped();
  setBusy(false);
});
els.again.addEventListener('click', () => lastRun && start(lastRun.url, lastRun.body, lastRun.name));
els.next.addEventListener('click', () => els.next.dataset.sample && runSample(els.next.dataset.sample));
els.download.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `polyman-verify-${String(label).replace(/\.zip$/i, '').replace(/[^\w.-]+/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function upload(file) {
  label = file.name;
  if (!/\.zip$/i.test(file.name)) return showError(`${file.name} isn't a .zip.`, null, 'local', 'Nothing was sent. Zip the problem folder and choose the zip.');
  if (file.size > MAX_BYTES) return showError(`${file.name} is over the 20 MB limit.`, null, 'local', `It is ${(file.size / 1024 / 1024).toFixed(1)} MB, and nothing was sent. Leave out compiled files and generated tests; they are made fresh.`);
  const body = new FormData();
  body.append('problem', file);
  start('/api/verify', body, file.name);
}

function setBusy(on) {
  running = on;
  for (const b of document.querySelectorAll('.sample, #pick, #demo, #own')) b.disabled = on;
  els.demo.innerHTML = on ? `${icon('i-spin')}Checking…` : demoLabel;
}

function say(text) {
  els.announce.textContent = text;
}

let noticeTimer = 0;
/** A passing message, as a Basecoat toast for a few seconds, and announced. */
function notice(text) {
  say(text);
  const toaster = $('#toaster');
  toaster.innerHTML = `<div class="toast" aria-hidden="false"><div class="toast-content">${icon('i-alert')}<section><h2></h2></section></div></div>`;
  $('h2', toaster).textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => $('.toast', toaster)?.setAttribute('aria-hidden', 'true'), 5000);
}

/** Where the card's top sits once its tabs are scrolled up under the page's header. */
function cardTop() {
  const col = els.samples.parentElement;
  return parseFloat(getComputedStyle(col).scrollMarginTop) + els.run.getBoundingClientRect().top - col.getBoundingClientRect().top;
}

/** Bring the samples and the card's head into view unless they already are, so the chosen sample shows. */
function showCard() {
  const col = els.samples.parentElement;
  const top = col.getBoundingClientRect().top;
  if (top < 64 || top > window.innerHeight * 0.5) col.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
}

function setHead(meta, verdict, sub) {
  if (meta !== null) els.title.textContent = meta;
  els.verdict.textContent = verdict;
  els.sub.textContent = sub;
}

function showActions(state) {
  els.actions.hidden = false;
  els.start.hidden = true;
  els.instead.hidden = state !== 'refused' || !expected.has(pending);
  els.next.hidden = true;
  els.stop.hidden = state !== 'running';
  els.again.dataset.variant = 'outline';
  els.again.hidden = state === 'running' || state === 'refused';
  els.choose.hidden = state !== 'refused';
  els.download.hidden = state === 'running' || state === 'refused';
}

/** "Step 3 of 10 · 7 s so far": what the wait is for, and how long it has been. */
function progress(t0) {
  const so = `${Math.round((performance.now() - t0) / 1000)} s so far · usually about 20 s.`;
  if (cards.size > 1) return `${Math.round((performance.now() - t0) / 1000)} s so far · usually about 20 s a problem.`;
  // (the first step builds the generators, and takes the longest)
  if (step === 1) return `Step 1 of ${STEPS.length} · ${so} This first step takes the longest.`;
  return step ? `Step ${step} of ${STEPS.length} · ${so}` : `Starting the sandbox · ${so}`;
}

async function start(url, body, name, tries = 1) {
  if (running) return;
  // from a sample waiting to run, the card keeps its height while the run fills it in
  // (after a result, only the running card's own: a long report's height would leave a gap)
  // (after a result, no taller than the screen under the tabs: a long report's height would leave a gap)
  const below = cardTop();
  const held = Math.min(els.run.offsetHeight, innerHeight - below);
  els.title.classList.remove('own-line');
  els.facts.hidden = true;
  // the run's own clock starts at the click; the log has its place from here
  runStart = performance.now();
  runLog = [];
  stepAt.clear();
  resultAt = 0;
  els.log.replaceChildren();
  els.log.hidden = false;
  logLine(null, body ? `Sent ${name} to the service` : `Asked the service to check the ${name} sample`);
  els.run.classList.remove('has-found');
  // the sample cards mark the one in the result card; an upload is none of them
  if (!body) pending = name;
  markSample(body ? null : name);
  setBusy(true);
  lastRun = { url, body, name };
  events = [];
  cards.clear();
  reached.clear();
  finished = false;
  step = 0;
  label = name;
  // the address names the sample, so a reload or a shared link sets it up again
  history.replaceState(null, '', body ? location.pathname : `?sample=${encodeURIComponent(name)}`);
  // a sample's rows stay in view until the service says what it is checking
  els.run.style.minHeight = '';
  if (!body && expected.has(name)) {
    showPreview(name);
    // the progress bar and the step under way have their place from the click
    runningSteps($('.problem', els.problems));
  } else clearProblems();
  els.run.classList.remove('is-bad', 'is-good', 'has-found');
  lastVerdict = '';
  els.run.classList.add('is-running');
  setHead(`Checking ${label}`, 'Checking the problem…', 'Usually about 20 seconds.');
  setStatus('Running', 'secondary', true);
  showActions('running');
  // hold the card's height, so the page doesn't jump while the run fills it in
  // (on a phone the card, scrolled up under its tabs, reaches the screen's foot, so the result grows into it, not into the page below)
  const h = `${Math.max(held, els.run.offsetHeight)}px`;
  els.run.style.minHeight = matchMedia('(max-width: 960px)').matches ? `max(${h}, calc(100svh - ${below}px))` : h;
  // (the head is held at its longest progress line, the first step's, so it doesn't grow mid-run)
  els.head.style.minHeight = '';
  els.sub.textContent = `Step 1 of ${STEPS.length} · 10 s so far · usually about 20 s. This first step takes the longest.`;
  holdHead();
  els.sub.textContent = 'Usually about 20 seconds.';
  say(`Checking ${label}. This usually takes about 20 seconds.`);
  showCard();
  // the button that started the run is now disabled or hidden; keep focus where the answer will be
  els.verdict.focus({ preventScroll: true });
  clearInterval(timer);
  timer = setInterval(() => {
    if (!finished) {
      els.sub.textContent = progress(runStart);
      holdHead();
      tickLog();
    }
  }, 1000);
  controller = new AbortController();

  try {
    const res = await fetch(url, { method: 'POST', body, signal: controller.signal });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (res.status === 429 || res.status === 503) return queue(Number(res.headers.get('retry-after')) || 10, tries);
      if (res.status === 413) return showError('This file is over the 20 MB limit. Leave out compiled files and generated tests; they are made fresh.');
      return showError(err.error, err.issues);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (err.name === 'AbortError') return stopped();
        return failMidway(`The connection broke: ${err.message}`);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);
    if (!finished) failMidway('The check stopped before it finished, so this report is incomplete. Try again.');
  } catch (err) {
    if (err.name === 'AbortError') return stopped();
    showError(err.message, null, 'offline');
  } finally {
    clearInterval(timer);
    // a run waiting for its turn keeps the page busy until it starts or is stopped
    if (!retry) setBusy(false);
  }
}

/** The service checks one upload at a time: wait for the slot, then start again by itself. */
function queue(wait, tries) {
  settle();
  clearProblems();
  // nothing is under way while it waits its turn
  if (tries >= MAX_TRIES) {
    setHead(`Not started: ${label}`, 'The service is still busy.', 'Other checks have kept it busy for a few minutes. Run it again in a minute.');
    setStatus('Busy', 'secondary');
    showActions('done');
    els.download.hidden = true;
    say('The service is still busy. Run it again in a minute.');
    return;
  }
  // keep the card as it was: the sample's solutions are still the ones about to be judged
  if (expected.has(label) && !lastRun.body) showPreview(label);
  els.run.style.minHeight = `${els.run.offsetHeight}px`;
  let left = wait;
  const tick = () => {
    els.sub.textContent = `It checks one problem at a time. Yours starts by itself in ${plural(left, 'second')}.`;
  };
  setHead(`Waiting to check ${label}`, 'Another check is running right now.', '');
  tick();
  setStatus('In line', 'secondary');
  showActions('running');
  say(`Another check is running. Yours starts by itself in ${plural(left, 'second')}.`);
  retry = setInterval(() => {
    left -= 1;
    if (left > 0) return tick();
    cancelRetry();
    setBusy(false);
    start(lastRun.url, lastRun.body, lastRun.name, tries + 1);
  }, 1000);
}

function cancelRetry() {
  clearInterval(retry);
  retry = 0;
}

const cards = new Map();
let finished = false;

function handleLine(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch (err) {
    console.error('unreadable event', line, err);
    return failMidway('The service sent something this page could not read; the report may be incomplete.');
  }
  try {
    handle(ev);
  } catch (err) {
    console.error('could not show event', ev, err);
  }
}

function card(name) {
  const c = cards.get(name);
  if (!c) throw new Error(`no card for problem ${name}`);
  return c;
}

function handle(ev) {
  events.push(ev);
  if (ev.type === 'start') {
    logLine(null, `Started · polyman ${ev.polyman}${ev.problems.length > 1 ? ` · ${plural(ev.problems.length, 'problem')}` : ''}`);
    clearProblems();
    for (const name of ev.problems) {
      const node = els.tpl.content.firstElementChild.cloneNode(true);
      $('.problem-name', node).textContent = name;
      // one problem: the card's head already names it; the heading stays for screen readers
      if (ev.problems.length === 1) $('.problem-name', node).classList.add('sr-only');
      runningSteps(node);
      waitingRows(node, name);
      els.problems.append(node);
      node.id = `problem-${ev.problems.indexOf(name)}`;
      cards.set(name, node);
    }
  } else if (ev.type === 'step') {
    const c = card(ev.problem);
    const at = STEPS.includes(ev.title) ? STEPS.indexOf(ev.title) : ev.step - 1;
    setPipeline(c, at);
    $('.sols', c).classList.toggle('is-running', ev.title === 'Running Solutions');
    reached.set(ev.problem, at);
    if (!stepAt.has(ev.problem)) stepAt.set(ev.problem, []);
    stepAt.get(ev.problem).push({ title: ev.title, t: performance.now() - runStart });
    logLine(ev.problem, STEP_WORDS[ev.title] ?? ev.title);
    if (cards.size === 1) {
      step = at + 1;
      els.sub.textContent = progress(runStart);
      holdHead();
      say(`Step ${step} of ${STEPS.length}: ${STEP_WORDS[ev.title] ?? ev.title}.`);
    }
  } else if (ev.type === 'problem') {
    const t = performance.now() - runStart;
    resultAt = t;
    logLine(ev.problem, `Result: ${renderProblem(card(ev.problem), ev, t)}`);
  } else if (ev.type === 'done') {
    // (every time on the page is on one clock, the page's, from the click)
    const took = (cards.size === 1 && resultAt) || performance.now() - runStart;
    logLine(null, 'Done');
    // the log folds into each problem's "How it was checked"
    for (const [name, c] of cards) {
      // (one problem's details sit after the card's actions)
      const pre = cards.size === 1 ? $(':scope > .more .how-log', els.run) : $('.how-log', c);
      if (pre) writeLog(pre, runLog.filter((l) => !l.problem || l.problem === name), cards.size > 1 ? name : null);
    }
    settle();
    // scripts wait on this line: it reads "Checked <name> in <s> s" when the run is over
    els.title.textContent = `Checked ${label} in ${seconds(took / 1000)}`;
    if (cards.size > 1) {
      const ready = events.filter((e) => e.type === 'problem' && e.ok).length;
      els.verdict.textContent = ev.ok
        ? `All ${plural(cards.size, 'problem')} are ready to use.`
        : `${ready ? NUMBER_WORDS[ready] ?? ready : 'None'} of the ${plural(cards.size, 'problem')} ${ready === 1 ? 'is' : 'are'} ready to use.`;
      // one line per problem, each a link to its report (the meta takes its own line after them)
      els.sub.replaceChildren();
      els.title.classList.add('own-line');
      [...cards.keys()].forEach((name, i) => {
        const ok = events.find((e) => e.type === 'problem' && e.problem === name)?.ok;
        const a = document.createElement('a');
        a.href = `#problem-${i}`;
        a.textContent = `${name}: ${ok ? 'ready' : 'needs work'}`;
        if (i) els.sub.append(' · ');
        els.sub.append(a);
      });
    }
    // a check that ended without a report (a timeout) judged nothing: it didn't finish, the problem isn't to blame
    const reports = events.filter((e) => e.type === 'problem');
    const unfinished = !reports.length || reports.every((e) => !e.report);
    showActions('done');
    if (!unfinished) suggestNext(ev.ok);
    else if (lastRun?.body) els.choose.hidden = false;
    // a sample's point, answered first: the demo asked "can the check find it?", sandbox-check "does the sandbox hold?"
    const [, , about] = (!unfinished && !lastRun?.body && SAMPLES[label]) || [];
    const sol = about && reports[0]?.report?.solutions.find((s) => s.name === about);
    const win = !sol ? '' : !sol.matchesTag ? `Found it: ${about} is the planted mistake.` : sol.tests.some((t) => t.verdict !== 'OK') ? `The sandbox held: ${about} never got root, so it failed as labelled.` : '';
    // a timed-out check gets its own way back: running it again is the main action
    if (unfinished) els.again.removeAttribute('data-variant');
    // the sample's answer is the card's title; the problem's own verdict is in the badge and the announcement
    if (win) {
      els.verdict.innerHTML = `${icon('i-ok')}<span></span>`;
      $('span', els.verdict).textContent = win;
      els.run.classList.add('has-found');
    } else if (ev.ok && cards.size === 1) {
      const said = els.verdict.textContent;
      els.verdict.innerHTML = `${icon('i-ok')}<span></span>`;
      $('span', els.verdict).textContent = said;
    }
    els.run.classList.add(ev.ok ? 'is-good' : 'is-bad');
    // the sample's tab keeps its last answer, as an icon (shadcn tabs with icons)
    const tab = !lastRun?.body && !unfinished && [...els.samples.querySelectorAll('.sample')].find((b) => b.dataset.sample === label);
    const status = ev.ok ? 'All good' : unfinished ? 'Did not finish' : 'Needs work';
    if (tab) {
      for (const old of tab.querySelectorAll('.tab-result')) old.remove();
      tab.insertAdjacentHTML('beforeend', icon(ev.ok ? 'i-check' : 'i-x').replace('<svg', `<svg class="tab-result ${ev.ok ? 'ok' : 'bad'}"`));
      tab.setAttribute('aria-label', `${label}, ${status.toLowerCase()}`);
      tab.dataset.tooltip = `${SAMPLE_HINT[label] ?? tab.dataset.tooltip.split(' · ')[0]} · ${status.toLowerCase()}`;
      showTab(tab);
    }
    setStatus(status, ev.ok ? 'success' : win ? 'outline' : 'destructive');
    // (the sample's answer is read once, as focus lands on it, so the announcement leaves it out)
    say(`Checked ${label} in ${(took / 1000).toFixed(1)} seconds. ${lastVerdict || els.verdict.textContent}`);
    els.verdict.focus({ preventScroll: true });
    if (unfinished && reports.some((e) => /time|timed out/i.test(e.error ?? ''))) {
      els.title.textContent = `Checked ${label}: stopped at the time limit`;
      // (the sentence ends on a link: the meta takes its own line)
      els.title.classList.add('own-line');
    }
  } else if (ev.type === 'error') {
    logLine(null, `Error: ${ev.message}`);
    failMidway(ev.message);
  }
}

/** One line of the run's log, timed from the click; shown live while the run is on. */
function logLine(problem, text) {
  runLog.push({ t: performance.now() - runStart, problem, text });
  if (!els.log.hidden) writeLog(els.log, runLog);
}

/** While a step runs long, its line counts the seconds, so a slow step doesn't look stalled. */
function tickLog() {
  const last = els.log.lastElementChild;
  const line = runLog.at(-1);
  if (els.log.hidden || !last || !line) return;
  const s = Math.floor((performance.now() - runStart - line.t) / 1000);
  let tick = $('.log-tick', last);
  if (s < 2) return tick?.remove();
  if (!tick) {
    tick = document.createElement('span');
    tick.className = 'log-tick';
    $('.log-x', last).append(tick);
  }
  tick.textContent = ` · ${s} s`;
}

/** The log as lines of "4.2 s  Building the test generators", newest at the foot and in view. */
function writeLog(pre, lines, only = null) {
  const many = cards.size > 1;
  pre.replaceChildren(
    ...lines.map((l) => {
      const line = document.createElement('span');
      line.className = 'log-line';
      const t = document.createElement('span');
      t.className = 'log-t';
      t.textContent = `${(l.t / 1000).toFixed(1)} s`;
      const x = document.createElement('span');
      x.className = 'log-x';
      x.textContent = `${many && l.problem && !only ? `${l.problem}: ` : ''}${l.text}`;
      line.append(t, x);
      return line;
    }),
  );
  if (pre === els.log) pre.scrollTop = pre.scrollHeight;
}

/** What the run did, counted from its report: only what the report shows. */
function runFacts(report, checks) {
  const ok = (name) => report.steps.some((s) => s.name === name && s.ok);
  const sols = report.solutions;
  const runs = sols.reduce((n, s) => n + s.tests.length, 0);
  // (the tests are numbered: the highest number any solution ran is how many there are)
  const tests = Math.max(0, ...sols.flatMap((s) => s.tests.map((t) => t.index)));
  return [
    tests && ok('validate-tests') && [tests, `${tests === 1 ? 'test' : 'tests'} generated and validated`],
    ok('test-checker') && [null, 'checker tested'],
    sols.length && [sols.length, `${sols.length === 1 ? 'solution' : 'solutions'}${ok('compile-solutions') ? ' compiled' : ''}`],
    runs && [runs, `sandbox ${runs === 1 ? 'run' : 'runs'}`],
    checks.length && [checks.length, `${checks.length === 1 ? 'guideline' : 'guidelines'} checked`],
  ].filter(Boolean);
}

/** The facts as a line: each a number and its words (the numbers are counts, nothing from outside). */
function writeFacts(el, facts) {
  // (a screen reader hears the facts as their own sentence, after the line before them)
  const stop = document.createElement('span');
  stop.className = 'sr-only';
  stop.textContent = '. ';
  el.replaceChildren(
    stop,
    ...facts.map(([n, words], i) => {
      const f = document.createElement('span');
      f.className = 'fact';
      if (n !== null) {
        const b = document.createElement('b');
        b.textContent = n;
        f.append(b, ' ');
      }
      // (the facts wrap between each other; the dot that parts them is drawn, and heard as a comma)
      f.append(words, i < facts.length - 1 ? Object.assign(document.createElement('span'), { className: 'sr-only', textContent: ', ' }) : '');
      return f;
    }),
  );
  el.hidden = !facts.length;
}

/** "How it was checked": each step the report lists, passed or failed, with the time it took as this page saw it. */
function howChecked(card, ev, at) {
  const how = $('.how', card);
  if (!how) return;
  const seen = stepAt.get(ev.problem) ?? [];
  // a step's time is from when the service said it began to when the next one began (the last: to the result)
  const took = (title) => {
    const i = seen.findIndex((s) => s.title === title);
    if (i < 0) return null;
    return (seen[i + 1]?.t ?? at) - seen[i].t;
  };
  const diversity = (ev.readiness ?? []).find((c) => c.id === 'solution_diversity');
  const langs = /^([A-Za-z+#]+(?:(?:, | and )[A-Za-z+#]+)*) covered/.exec(diversity?.detail ?? '')?.[1] ?? '';
  const steps = ev.report
    ? ev.report.steps.filter((s) => STEP_TITLE[s.name]).map((s) => ({ title: STEP_TITLE[s.name], state: s.ok ? 'ok' : 'failed' }))
    : seen.map((s, i) => ({ title: s.title, state: i < seen.length - 1 ? 'ok' : 'stopped' }));
  if (!steps.length) return;
  const list = $('.how-steps', how);
  list.replaceChildren(
    ...steps.map((s) => {
      const li = document.createElement('li');
      li.className = s.state;
      li.innerHTML = `${icon(s.state === 'ok' ? 'i-check' : s.state === 'failed' ? 'i-x' : 'i-stop')}<span class="how-step"></span><span class="how-time"></span>`;
      $('.how-step', li).textContent = STEP_WORDS[s.title] ?? s.title;
      // (the languages the solutions were in, as the report's own guideline found them)
      if (s.title === 'Compiling Solutions' && langs) $('.how-step', li).append(Object.assign(document.createElement('span'), { className: 'how-note', textContent: ` · ${langs}` }));
      const dur = took(s.title);
      $('.how-time', li).textContent = dur === null ? '' : dur < 100 ? `${Math.max(1, Math.round(dur))} ms` : seconds(dur / 1000);
      return li;
    }),
  );
  // the same steps in the pipeline above the table, so the whole run reads without opening anything
  finishPipeline(card, steps, took);
  $('.how-title', how).textContent = `How it was checked · ${plural(steps.length, 'step')}, ${seconds(at / 1000)} from the click`;
  how.hidden = false;
}

function renderProblem(card, ev, at) {
  const report = ev.report;
  const solutions = report?.solutions ?? [];
  const checks = ev.readiness ?? [];
  const broken = solutions.filter((s) => !s.matchesTag);
  const gaps = checks.filter((c) => !c.ok);
  const critical = gaps.filter((c) => c.severity === 'critical');
  const fix = (list) => list.map((c) => GUIDE_FIX[c.id] ?? (GUIDE_WORDS[c.id] ?? c.title).toLowerCase()).join('; ');
  const recommended = gaps.filter((c) => c.severity !== 'critical');
  const also = recommended.length ? ` Also recommended: ${fix(recommended)}.` : '';

  // the answer first: what is wrong and what to do
  let title;
  let body;
  if (!report && /time|timed out/i.test(ev.error ?? '')) {
    // (the 120 s limit is the one the docs state)
    title = 'It ran past the time limit.';
    body = 'polyman stops a problem after 120 s. A solution may be stuck in a loop. Run it again, or see the limits in the docs:';
  } else if (!report) {
    title = 'The check could not finish.';
    body = 'What polyman reported is below.';
  } else if (broken.length) {
    title = `${Plural(broken.length, 'solution')} ${broken.length === 1 ? "doesn't" : "don't"} behave as labelled.`;
    body = broken.map((s) => `${s.name} is labelled ${tagWords(s.tag)}, but it ${did(s)}. ${nextStep(s)}`).join(' ');
  } else if (!report.ok) {
    title = 'One of the checks failed.';
    body = 'What polyman reported is below.';
  } else if (critical.length) {
    title = "Every solution behaves as labelled, but it isn't ready for a contest yet.";
    body = `Fix first: ${fix(critical)}.${also}`;
  } else {
    title = 'Ready to use.';
    body = gaps.length
      ? `Every solution behaves exactly as labelled, and every required contest guideline is met.${also}`
      : `Every solution behaves exactly as labelled${checks.length ? `, and all ${checks.length} contest guidelines are met` : ''}.`;
  }
  const facts = report ? runFacts(report, checks) : [];
  if (cards.size === 1) {
    lastVerdict = title;
    setHead(null, title, body);
    // what the run did, counted from its report, beside the run's own line
    writeFacts(els.facts, facts);
    // (the verdict takes the head's place in the same frame as the rows: the head sizes itself again)
    els.head.style.minHeight = '';
    if (/see the limits in the docs:$/.test(body)) {
      const a = document.createElement('a');
      a.href = '/docs#limits';
      a.textContent = 'Limits and privacy';
      els.sub.append(' ', a, '.');
    }
  }
  else {
    const alert = $('.verdict', card);
    if (!ev.ok) alert.dataset.variant = 'destructive';
    alert.innerHTML = `${icon(ev.ok ? 'i-ok' : 'i-alert')}<h2></h2><section></section>`;
    $('h2', alert).textContent = title;
    $('section', alert).textContent = body;
    if (facts.length) {
      const p = document.createElement('p');
      p.className = 'run-facts';
      writeFacts(p, facts);
      $('section', alert).append(p);
    }
    $('.outcome', card).hidden = false;
  }
  howChecked(card, ev, at);

  $('.sols', card).classList.remove('is-running');
  // the ones that broke their label first, then the one the sample is about, the clean passes, and those that fail as labelled
  const focus = lastRun?.body ? null : SAMPLES[label]?.[2];
  // (a result that passes doesn't open on red: solutions that fail on purpose come last)
  const rank = (s) => (!s.matchesTag ? 0 : s.name === focus ? 0.5 : s.tests.some((t) => t.verdict !== 'OK') ? 2 : 1);
  const rows = [...solutions].sort((a, b) => rank(a) - rank(b));
  // (no report: the solutions it was about to judge stay listed, not judged)
  if (rows.length) {
    $('.sols tbody', card).replaceChildren(...rows.map((s) => {
      const tr = solutionRow(s);
      if (s.name === focus && s.matchesTag) tr.classList.add('focus');
      tr.style.setProperty('--r', rows.indexOf(s));
      return tr;
    }));
  }
  $('.table-container', card).hidden = !$('.sols tbody', card).children.length;
  $('.legend', card).hidden = !solutions.length;
  legendFor(card, solutions);
  $('.more', card).hidden = false;

  $('.guides-title', card).textContent = checks.length ? `Contest guidelines · ${checks.length - gaps.length} of ${checks.length} met` : 'Contest guidelines';
  if (!checks.length) $('.guides', card).hidden = true;
  // every guideline with its evidence is the answer to "is it ready", so it opens with the result
  else $('.guides', card).open = true;
  const list = $('.checks', card);
  for (const c of [...checks].sort((a, b) => Number(a.ok) - Number(b.ok))) {
    const li = document.createElement('li');
    li.className = c.ok ? 'ok' : c.severity;
    li.innerHTML = `${icon(c.ok ? 'i-check' : c.severity === 'critical' ? 'i-x' : 'i-alert')}<span><span class="t"></span><small></small></span>`;
    $('.t', li).textContent = GUIDE_WORDS[c.id] ?? c.title;
    $('small', li).textContent = c.ok ? cap(tidy(c.detail)) : `${cap(SEVERITY_WORDS[c.severity] ?? c.severity)}. ${cap(tidy(c.detail))}`;
    list.append(li);
  }
  // when some guidelines aren't met, those lead and the met ones wait behind a toggle
  const met = checks.length - gaps.length;
  if (gaps.length && met) {
    list.classList.add('folded');
    const more = document.createElement('li');
    more.className = 'met-toggle';
    more.innerHTML = `<button type="button" class="btn" data-variant="link" data-size="sm"></button>`;
    $('button', more).textContent = `Show the ${plural(met, 'guideline')} met`;
    $('button', more).addEventListener('click', () => {
      list.classList.remove('folded');
      more.remove();
      // keep the keyboard's place: on the first guideline that was hidden
      const first = $('li.ok', list);
      first.tabIndex = -1;
      first.focus();
    });
    list.append(more);
  }

  const failed = report?.steps.filter((s) => !s.ok) ?? [];
  const error = ev.error ?? failed.map((s) => `${s.name}:\n${s.errors.map((e) => `  ${e}`).join('\n') || '  failed'}`).join('\n\n');
  // (a solution breaking its label fails only the comparing step, and the rows above already say it all)
  const onlyCompare = !ev.error && broken.length && failed.every((s) => s.name === 'verify-solutions');
  if (error && !onlyCompare) {
    const log = $('.log', card);
    log.hidden = false;
    $('.problem-error', card).textContent = error;
    if (!solutions.length) log.open = true;
  }
  // one problem: its guidelines come after the card's actions, so the actions stay on the first screen
  if (cards.size === 1) els.run.append($('.more', card));
  return title;
}

/** The legend lists only the kinds of mark this report shows. */
function legendFor(card, solutions) {
  const seen = new Set();
  for (const s of solutions) {
    const onPurpose = s.matchesTag && s.tests.some((t) => t.verdict !== 'OK');
    for (const t of s.tests) {
      const kind = verdictKind(t.verdict);
      seen.add(kind !== 'ok' && onPurpose ? `${kind}-hollow` : kind);
    }
  }
  const items = [
    ['ok', 'dot ok', '', 'passed'],
    ['bad', 'dot bad', 'i-x', 'wrong answer or crash'],
    ['limit', 'dot limit', 'i-clock', 'too slow'],
    ['bad-hollow', 'dot bad hollow', 'i-x', 'wrong, on purpose'],
    ['limit-hollow', 'dot limit hollow', 'i-clock', 'too slow, on purpose'],
  ].filter(([kind]) => seen.has(kind));
  $('.legend', card).innerHTML = `<span class="legend-note">${matchMedia('(hover: hover)').matches ? 'Each square is a test:' : 'Each square is a test, tap to read it:'}</span>${items.map(([, cls, glyph, words]) => `<span><span class="${cls}" aria-hidden="true">${glyph ? icon(glyph) : ''}</span>${words}</span>`).join('')}`;
}

/** What a solution got, in words: "wrong answer on 6 of 12 tests". */
function did(s) {
  const wrong = s.tests.filter((t) => t.verdict !== 'OK');
  if (!wrong.length) return `passed all ${plural(s.tests.length, 'test')}`;
  const kinds = [...new Set(wrong.map((t) => t.verdict))];
  return `${kinds.map((k) => `${DID_WORDS[k] ?? verdictWords(k)} on ${wrong.filter((t) => t.verdict === k).length}`).join(' and ')} of ${plural(s.tests.length, 'test')}`;
}

function outcome(s) {
  const wrong = s.tests.filter((t) => t.verdict !== 'OK');
  if (!wrong.length) return `passed all ${plural(s.tests.length, 'test')}`;
  const kinds = [...new Set(wrong.map((t) => t.verdict))];
  return `${kinds.map((k) => `${verdictWords(k)} on ${wrong.filter((t) => t.verdict === k).length}`).join(', ')} of ${plural(s.tests.length, 'test')}`;
}

/** Which tests a solution failed, by kind: "wrong answer on tests 4, 5 and 9". */
function failedOn(s) {
  const wrong = s.tests.filter((t) => t.verdict !== 'OK');
  const list = (ts) => (ts.length === 1 ? `test ${ts[0].index}` : `tests ${ts.slice(0, -1).map((t) => t.index).join(', ')} and ${ts.at(-1).index}`);
  return [...new Set(wrong.map((t) => t.verdict))].map((k) => `${verdictWords(k)} on ${list(wrong.filter((t) => t.verdict === k))}`).join('; ');
}

/** One table row: the name and its label, a dot per test, and whether it behaved as labelled. */
function solutionRow(s) {
  const tr = document.createElement('tr');
  const expectedToFail = s.matchesTag && s.tests.some((t) => t.verdict !== 'OK');
  // (shadcn's selected-row tint marks the one that broke its label)
  if (!s.matchesTag) {
    tr.className = 'broken';
    tr.dataset.state = 'selected';
  }
  if (expectedToFail) tr.className = 'expected-fail';
  tr.innerHTML = `<td class="sol"><b class="sol-name"></b><span class="sol-label"></span></td><td class="tests"><div class="dots"></div><small class="dots-note"></small></td><td class="slow"></td><td class="res"></td>`;
  $('.sol-name', tr).textContent = s.name;
  // the slowest test of the solution, as its own column (a failing solution's time is still the time it took)
  $('.slow', tr).textContent = s.tests.length ? ms(Math.max(...s.tests.map((t) => t.timeMs))) : '';
  // the setter's own tag letters stay visible beside the plain words
  labelText($('.sol-label', tr), s.tag);
  const dots = $('.dots', tr);
  dots.setAttribute('aria-label', `${s.name}: one square per test. Use the arrow keys to read each one.`);
  s.tests.forEach((t, i) => {
    const d = document.createElement('button');
    const kind = verdictKind(t.verdict);
    d.type = 'button';
    d.className = `dot ${kind}`;
    d.tabIndex = i ? -1 : 0;
    d.dataset.tooltip = testDetail(t);
    // (the tooltip opens away from the card's nearer edge)
    d.dataset.align = i < s.tests.length / 2 ? 'start' : 'end';
    // (below the square, over the row's own summary, so the solution's name and label stay in view)
    d.dataset.side = 'bottom';
    d.setAttribute('aria-label', d.dataset.tooltip);
    if (kind !== 'ok') d.innerHTML = icon(kind === 'limit' ? 'i-clock' : 'i-x');
    dots.append(d);
  });
  const stoppedEarly = s.tests.length === 1 && s.tests[0].verdict !== 'OK';
  // a solution meant to fail that fails is fine: say so, so its red dots don't read as a problem
  // (a solution that broke its label names its failing tests; what the checker saw on each is in its square)
  $('.dots-note', tr).textContent = !s.matchesTag ? `${cap(failedOn(s))}.` : stoppedEarly ? `${cap(verdictWords(s.tests[0].verdict))} on the first test, so it was stopped there.` : `${cap(outcome(s))}.`;
  wireSquares(dots);
  // whether it kept its label, as a shadcn badge
  $('.res', tr).innerHTML = s.matchesTag ? `<span class="badge" data-variant="outline">${icon('i-check')}${expectedToFail ? 'Fails as labelled' : 'As labelled'}</span>` : `<span class="badge" data-variant="destructive">${icon('i-x')}Not as labelled</span>`;
  return tr;
}

/** One test in words: "Test 4 · wrong answer · expected YES, found NO · 7 ms". */
function testDetail(t) {
  const said = verdictWords(t.verdict);
  const seen = (t.message ?? '')
    .replace(new RegExp(`^${said}\\s*`, 'i'), '')
    .replace(/^time limit exceeded after (\d+) ?ms$/i, 'over the $1 ms limit')
    .trim();
  return [`Test ${t.index}`, said, seen, `${t.timeMs} ms`].filter(Boolean).join(' · ');
}

/**
 * A strip of squares is a toolbar: each square's tooltip spells out its test, and one square at a
 * time takes Tab (roving focus), so a long strip is one stop and the arrow keys move along it.
 */
function wireSquares(strip) {
  const squares = [...strip.children];
  strip.setAttribute('role', 'toolbar');
  strip.addEventListener('focusin', (e) => {
    const d = e.target.closest('.dot');
    for (const q of squares) q.tabIndex = q === d ? 0 : -1;
  });
  strip.addEventListener('keydown', (e) => {
    const at = squares.indexOf(document.activeElement);
    const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: squares.length - 1 }[e.key];
    if (to === undefined || at < 0) return;
    e.preventDefault();
    squares[Math.max(0, Math.min(squares.length - 1, to))].focus();
  });
}

/** What to do about a solution that broke its label, from its verdicts. */
function nextStep(s) {
  const kinds = [...new Set(s.tests.filter((t) => t.verdict !== 'OK').map((t) => t.verdict))];
  const correct = ['MA', 'OK', 'TO'].includes(s.tag);
  if (correct && kinds.length === 1 && RELABEL[kinds[0]]) return `Fix it, or label it as ${RELABEL[kinds[0]]}.`;
  if (correct) return 'Fix it, or label it with how it really fails.';
  if (!kinds.length) return 'No test catches it: add a test that does, or label it correct.';
  return 'Relabel it, or change it so it fails the way its label says.';
}

/** The status Badge; while a run is on it carries a Spinner (shadcn Badge with Spinner). */
function setStatus(text, variant, spin = false) {
  els.status.innerHTML = spin ? icon('i-spin') : '';
  els.status.append(text);
  els.status.dataset.variant = variant;
}

/** After a sample's answer, offer the sample with the other outcome. */
function suggestNext(ok) {
  const name = lastRun?.body ? null : ok ? (label === DEMO ? null : DEMO) : PASSING;
  els.next.hidden = !name || !expected.has(name);
  if (els.next.hidden) return;
  els.next.dataset.sample = name;
  $('span', els.next).textContent = ok ? 'Now try one with a mistake' : 'Now try one that passes';
}

/** While a run is on, the card's head only ever grows (its progress line changes length), so the rows under it stay put. */
function holdHead() {
  els.head.style.minHeight = `${Math.max(els.head.offsetHeight, parseFloat(els.head.style.minHeight) || 0)}px`;
}

/** The run is over, with or without an answer: let the card size itself again. */
function settle() {
  finished = true;
  clearInterval(timer);
  els.run.classList.remove('is-running');
  els.run.style.minHeight = '';
  els.head.style.minHeight = '';
  els.log.hidden = true;
  // a passing message from the run (a file dropped mid-run) goes with it, so it doesn't cover the result
  clearTimeout(noticeTimer);
  $('#toaster .toast')?.setAttribute('aria-hidden', 'true');
}

function stopped() {
  settle();
  // a sample keeps its solutions in view, as before it ran
  if (!lastRun?.body && expected.has(label)) showPreview(label);
  else clearProblems();
  setHead(`Stopped ${label}`, 'You stopped the check.', 'Nothing was kept. Run it again whenever you like.');
  setStatus('Stopped', 'secondary');
  showActions('done');
  els.download.hidden = true;
  say('You stopped the check.');
  els.verdict.focus({ preventScroll: true });
}

/** An error after results started arriving: keep what came, say what broke. */
function failMidway(message) {
  settle();
  setHead(`Did not finish: ${label}`, 'The check did not finish.', message);
  // no step is still under way: the one that was stops, neutral (the connection broke, not that step)
  for (const li of els.problems.querySelectorAll('.pipeline .step[data-state=now]')) {
    paintStep(li, 'stopped');
    const label = $('.step-label', li);
    label.dataset.tooltip = `${label.dataset.tooltip} The run stopped here.`;
  }
  els.run.classList.add('is-bad');
  setStatus('Did not finish', 'destructive');
  showActions('done');
  els.again.removeAttribute('data-variant');
  els.download.hidden = true;
  setBusy(false);
  say(`The check did not finish. ${message}`);
  els.verdict.focus({ preventScroll: true });
}

/** The service's refusal as one sentence anyone can act on. */
const BROKEN_ZIP = /central directory|not a zip|invalid zip|zip.*(corrupt|truncat)/i;

function plainReason(message = '') {
  if (BROKEN_ZIP.test(message)) return "This file isn't a zip, or it was cut short.";
  if (/config\.json/i.test(message) && /not found|missing|no /i.test(message)) return 'There is no Config.json at the top of the zip, or in one folder per problem.';
  return cap(message);
}

function showError(message, issues, kind = 'refused', detail = '') {
  settle();
  const offline = kind === 'offline';
  // the browser's own checks: a short fact and what to do, and the service never saw the file
  const local = kind === 'local';
  const plain = offline ? 'Could not reach the service.' : local ? message : plainReason(message);
  const next = BROKEN_ZIP.test(message) ? 'Nothing was run. Zip the folder again and choose the new file.' : 'Nothing was run. See how to prepare the zip, then try again.';
  setHead(label ? `Not checked: ${label}` : 'Not checked', plain, offline ? 'Check your connection and run it again. If it still fails, the service may be restarting: try again in a minute.' : local ? detail : next);
  // nothing of an earlier result stays: its facts, its title layout, its pass/found look
  els.title.classList.remove('own-line');
  els.facts.hidden = true;
  els.run.classList.remove('is-good', 'has-found');
  els.run.classList.add('is-bad');
  // the browser's own check sent nothing, so the service refused nothing
  setStatus(offline ? 'Not reached' : local ? 'Not sent' : BROKEN_ZIP.test(message) ? 'Not a zip' : 'Refused', 'destructive');
  if (local) markSample(null);
  $('span', els.instead).textContent = `Run the ${pending} sample instead`;
  const box = document.createElement('div');
  box.className = 'refusal';
  box.innerHTML = `<p class="raw"></p><ul></ul><p class="prep"><a href="/docs#prepare">How to prepare the zip</a></p>`;
  if (offline) $('.prep', box).remove();
  if (plain !== message) $('.raw', box).textContent = `${offline ? 'Your browser said' : 'The service said'}: ${message.replace(/^the zip was refused:\s*/i, '')}`;
  else $('.raw', box).remove();
  const ul = $('ul', box);
  for (const i of issues ?? []) {
    const li = document.createElement('li');
    li.textContent = i;
    ul.append(li);
  }
  if (!issues?.length) ul.remove();
  clearProblems(box);
  showActions(offline ? 'done' : 'refused');
  if (offline) els.again.removeAttribute('data-variant');
  els.download.hidden = true;
  setBusy(false);
  showCard();
  say(`Not checked. ${plain}`);
  els.verdict.focus({ preventScroll: true });
}
