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
  title: $('#run-title'),
  verdict: $('#run-verdict'),
  sub: $('#run-sub'),
  status: $('#run-status'),
  announce: $('#announce'),
  problems: $('#problems'),
  actions: $('#run-actions'),
  stop: $('#stop'),
  again: $('#again'),
  next: $('#next'),
  choose: $('#choose'),
  download: $('#download'),
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
/** Each sample in words for someone who has never set a contest problem. */
const SAMPLES = {
  'even-sum': ['A problem that is ready', 'Every solution behaves as labelled and every contest guideline is met.'],
  'not-ready': ['Correct, but not contest-ready', 'All solutions behave as labelled, but it has too few tests and no tutorial.'],
  'sandbox-check': ['A solution that needs admin rights', 'One solution only works when run as root. The sandbox never grants that, so it fails as labelled.'],
  'wrong-tag': ['A solution with the wrong label', 'One solution is labelled correct but gives wrong answers.'],
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
    .replace(/(\d+) ([a-z]+)\(s\)/gi, (_, n, w) => plural(Number(n), w))
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
/** Each sample's solution names, so a run shows who is being judged before results arrive. */
const expected = new Map();
const demoLabel = els.demo.innerHTML;

fetch('/api/version')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((v) => {
    $('#version').textContent = `Live on Google Cloud Run · polyman ${v.polyman}`;
    const commit = $('#commit');
    commit.textContent = `Deployed commit ${String(v.commit).slice(0, 7)}`;
    if (/^[0-9a-f]{7,40}$/i.test(String(v.commit))) commit.href = `${GITLAB}/-/commit/${v.commit}`;
  })
  .catch((err) => console.warn('version unavailable', err));

fetch('/api/samples')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((samples) => {
    for (const s of samples) expected.set(s.name, Object.keys(s.expected?.solutions ?? {}));
    // a link with ?sample=<name> runs that sample straight away
    const linked = new URLSearchParams(location.search).get('sample');
    if (linked && expected.has(linked) && !running) runSample(linked);
    else if (expected.has(DEMO) && !running && !events.length) showPreview(DEMO);
    for (const s of samples) {
      if (s.name === DEMO) continue;
      const [title, desc] = SAMPLES[s.name] ?? [s.name, s.description];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sample card';
      b.dataset.size = 'sm';
      b.innerHTML = `<header><h3></h3><p></p></header><footer><span class="badge" data-variant="secondary"></span><span class="sample-go">Run ${icon('i-arrow')}</span></footer>`;
      $('h3', b).textContent = title;
      $('p', b).textContent = desc;
      $('.badge', b).textContent = s.name;
      b.addEventListener('click', () => runSample(s.name));
      els.samples.append(b);
    }
  })
  .catch((err) => {
    console.error(err);
    els.samples.textContent = 'The sample problems could not be loaded. You can still check your own.';
  });

const runSample = (name) => start(`/api/samples/${encodeURIComponent(name)}/verify`, null, name);

/** Before any run: the demo sample's real solution names, waiting to be judged. */
function showPreview(name) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  $('.problem-name', node).classList.add('sr-only');
  $('.problem-name', node).textContent = name;
  waitingRows(node, name);
  els.problems.replaceChildren(node);
}

/** A row per solution the sample is known to have, with an empty strip where its tests will go. */
function waitingRows(node, name) {
  const tbody = $('tbody', node);
  for (const sol of expected.get(name) ?? []) {
    const tr = document.createElement('tr');
    tr.className = 'waiting';
    tr.innerHTML = `<td class="sol"><b class="sol-name"></b></td><td class="tests"><span class="skeleton" aria-hidden="true"></span></td><td class="res"></td>`;
    $('.sol-name', tr).textContent = sol;
    tbody.append(tr);
  }
  $('.table-container', node).hidden = !tbody.children.length;
}

els.demo.addEventListener('click', () => runSample(DEMO));
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
  if (running) return say('A check is already running. Drop the zip again when it ends.');
  const files = e.dataTransfer.files;
  if (files.length > 1) {
    label = 'Your upload';
    return showError(`You dropped ${files.length} files. Drop one .zip; for a contest, put every problem in that one zip.`);
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
  a.download = 'polyman-verify-report.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

function upload(file) {
  label = file.name;
  if (!/\.zip$/i.test(file.name)) return showError(`${file.name} is not a .zip file. Zip the problem folder and choose the zip.`);
  if (file.size > MAX_BYTES) return showError(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the 20 MB limit. Leave out compiled files and generated tests; they are made fresh.`);
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

/** Bring the card's head into view unless it already is. */
function showCard() {
  const top = els.run.getBoundingClientRect().top;
  if (top < 64 || top > window.innerHeight * 0.5) els.run.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
}

function setHead(meta, verdict, sub) {
  if (meta !== null) els.title.textContent = meta;
  els.verdict.textContent = verdict;
  els.sub.textContent = sub;
}

function showActions(state) {
  els.actions.hidden = false;
  els.next.hidden = true;
  els.stop.hidden = state !== 'running';
  els.again.hidden = state === 'running' || state === 'refused';
  els.choose.hidden = state !== 'refused';
  els.download.hidden = state === 'running' || state === 'refused';
}

/** "Step 3 of 10 · 7 s so far": what the wait is for, and how long it has been. */
function progress(t0) {
  const so = `${Math.round((performance.now() - t0) / 1000)} s so far · usually about 20 s.`;
  return step && cards.size === 1 ? `Step ${step} of ${STEPS.length} · ${so}` : cap(so);
}

async function start(url, body, name, tries = 1) {
  if (running) return;
  setBusy(true);
  lastRun = { url, body, name };
  events = [];
  cards.clear();
  finished = false;
  step = 0;
  label = name;
  // the address names the sample, so a reload or a shared link runs it again
  history.replaceState(null, '', body ? location.pathname : `?sample=${encodeURIComponent(name)}`);
  // hold the card's height so the page doesn't jump while the run fills it back in
  els.run.style.minHeight = `${els.run.offsetHeight}px`;
  els.problems.replaceChildren();
  els.run.classList.remove('is-bad', 'is-good');
  els.run.classList.add('is-running');
  setHead(`Checking ${label}`, 'Judging the problem…', 'Usually about 20 seconds.');
  setStatus('Running', 'secondary');
  showActions('running');
  say(`Checking ${label}. This usually takes about 20 seconds.`);
  showCard();
  // the button that started the run is now disabled or hidden; keep focus where the answer will be
  els.verdict.focus({ preventScroll: true });
  runStart = performance.now();
  clearInterval(timer);
  timer = setInterval(() => {
    if (!finished) els.sub.textContent = progress(runStart);
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
  els.problems.replaceChildren();
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
    for (const name of ev.problems) {
      const node = els.tpl.content.firstElementChild.cloneNode(true);
      $('.problem-name', node).textContent = name;
      // one problem: the card's head already names it; the heading stays for screen readers
      if (ev.problems.length === 1) $('.problem-name', node).classList.add('sr-only');
      // all ten steps up front, so the wait shows how far along it is
      const list = $('.steps-live', node);
      for (const title of STEPS) {
        const li = document.createElement('li');
        li.innerHTML = `${icon('i-dot')}<span></span>`;
        $('span', li).textContent = STEP_WORDS[title];
        list.append(li);
      }
      waitingRows(node, name);
      els.problems.append(node);
      cards.set(name, node);
    }
  } else if (ev.type === 'step') {
    const c = card(ev.problem);
    const at = STEPS.includes(ev.title) ? STEPS.indexOf(ev.title) : ev.step - 1;
    [...$('.steps-live', c).children].forEach((li, i) => {
      const state = i < at ? 'done' : i === at ? 'now' : '';
      if (li.className === state) return;
      li.className = state;
      $('svg', li).outerHTML = icon(state === 'done' ? 'i-check' : state === 'now' ? 'i-spin' : 'i-dot');
    });
    $('.sols', c).classList.toggle('is-running', ev.title === 'Running Solutions');
    if (cards.size === 1) {
      step = at + 1;
      els.sub.textContent = progress(runStart);
      say(`Step ${step} of ${STEPS.length}: ${STEP_WORDS[ev.title] ?? ev.title}.`);
    }
  } else if (ev.type === 'problem') {
    renderProblem(card(ev.problem), ev);
  } else if (ev.type === 'done') {
    settle();
    // scripts wait on this line: it reads "Checked <name> in <s> s" when the run is over
    els.title.textContent = `Checked ${label} in ${seconds(ev.seconds)}`;
    if (cards.size > 1) {
      const ready = events.filter((e) => e.type === 'problem' && e.ok).length;
      els.verdict.textContent = ev.ok ? `All ${plural(cards.size, 'problem')} are ready to use.` : `${ready} of ${plural(cards.size, 'problem')} ready to use.`;
      els.sub.textContent = 'Each problem has its own report below.';
    }
    els.run.classList.add(ev.ok ? 'is-good' : 'is-bad');
    setStatus(ev.ok ? 'All good' : 'Needs work', ev.ok ? 'success' : 'destructive');
    showActions('done');
    suggestNext(ev.ok);
    say(`Checked ${label} in ${ev.seconds.toFixed(1)} seconds. ${els.verdict.textContent}`);
    els.verdict.focus({ preventScroll: true });
  } else if (ev.type === 'error') {
    failMidway(ev.message);
  }
}

function renderProblem(card, ev) {
  const report = ev.report;
  const solutions = report?.solutions ?? [];
  const checks = ev.readiness ?? [];
  const broken = solutions.filter((s) => !s.matchesTag);
  const gaps = checks.filter((c) => !c.ok);
  const critical = gaps.filter((c) => c.severity === 'critical');
  $('.steps-live', card).hidden = true;

  // the answer first: what is wrong and what to do
  let title;
  let body;
  if (!report) {
    title = 'The check could not finish.';
    body = 'What polyman reported is below.';
  } else if (broken.length) {
    title = `${Plural(broken.length, 'solution')} ${broken.length === 1 ? "doesn't" : "don't"} behave as labelled.`;
    body = broken.map((s) => `${s.name} is labelled ${tagWords(s.tag)}, but ${outcome(s)}. ${nextStep(s)}`).join(' ');
  } else if (!report.ok) {
    title = 'One of the checks failed.';
    body = 'What polyman reported is below.';
  } else if (critical.length) {
    title = "Every solution behaves as labelled, but it isn't ready for a contest yet.";
    body = `Fix first: ${critical.map((c) => (GUIDE_WORDS[c.id] ?? c.title).toLowerCase()).join(', ')}.`;
  } else {
    title = 'Ready to use.';
    body = `Every solution behaves exactly as labelled${checks.length ? `, and all ${checks.length} contest guidelines are met` : ''}.`;
  }
  if (cards.size === 1) setHead(null, title, body);
  else {
    const alert = $('.verdict', card);
    if (!ev.ok) alert.dataset.variant = 'destructive';
    alert.innerHTML = `${icon(ev.ok ? 'i-ok' : 'i-alert')}<h2></h2><section></section>`;
    $('h2', alert).textContent = title;
    $('section', alert).textContent = body;
    $('.outcome', card).hidden = false;
  }

  $('.sols', card).classList.remove('is-running');
  // the ones that broke their label first
  $('.sols tbody', card).replaceChildren(...[...solutions].sort((a, b) => Number(a.matchesTag) - Number(b.matchesTag)).map(solutionRow));
  $('.table-container', card).hidden = !solutions.length;
  $('.legend', card).hidden = !solutions.length;
  $('.more', card).hidden = false;

  $('.guides-title', card).textContent = checks.length ? `Contest guidelines · ${checks.length - gaps.length} of ${checks.length} met` : 'Contest guidelines';
  if (!checks.length) $('.guides', card).hidden = true;
  if (gaps.length) $('.guides', card).open = true;
  const list = $('.checks', card);
  for (const c of [...checks].sort((a, b) => Number(a.ok) - Number(b.ok))) {
    const li = document.createElement('li');
    li.className = c.ok ? 'ok' : c.severity;
    li.innerHTML = `${icon(c.ok ? 'i-check' : 'i-x')}<span><span class="t"></span><small></small></span>`;
    $('.t', li).textContent = GUIDE_WORDS[c.id] ?? c.title;
    $('small', li).textContent = c.ok ? cap(tidy(c.detail)) : `${cap(SEVERITY_WORDS[c.severity] ?? c.severity)}. ${cap(tidy(c.detail))}`;
    list.append(li);
  }

  const failed = report?.steps.filter((s) => !s.ok) ?? [];
  const error = ev.error ?? failed.map((s) => `${s.name}:\n${s.errors.map((e) => `  ${e}`).join('\n') || '  failed'}`).join('\n\n');
  if (error) {
    const log = $('.log', card);
    log.hidden = false;
    $('.problem-error', card).textContent = error;
    if (!solutions.length) log.open = true;
  }
}

/** What a solution got, in words: "wrong answer on 6 of 12 tests". */
function outcome(s) {
  const wrong = s.tests.filter((t) => t.verdict !== 'OK');
  if (!wrong.length) return `passed all ${plural(s.tests.length, 'test')}`;
  const kinds = [...new Set(wrong.map((t) => t.verdict))];
  return `${kinds.map((k) => `${verdictWords(k)} on ${wrong.filter((t) => t.verdict === k).length}`).join(', ')} of ${plural(s.tests.length, 'test')}`;
}

/** One table row: the name and its label, a dot per test, and whether it behaved as labelled. */
function solutionRow(s) {
  const tr = document.createElement('tr');
  if (!s.matchesTag) tr.className = 'broken';
  tr.innerHTML = `<td class="sol"><b class="sol-name"></b><span class="sol-label"></span></td><td class="tests"><div class="dots" role="img"></div><small class="dots-note"></small><ul class="fails"></ul></td><td class="res"></td>`;
  $('.sol-name', tr).textContent = s.name;
  $('.sol-label', tr).textContent = `labelled ${tagWords(s.tag)}`;
  const dots = $('.dots', tr);
  dots.setAttribute('aria-label', s.tests.map((t) => `test ${t.index} ${verdictWords(t.verdict)}`).join(', '));
  s.tests.forEach((t, i) => {
    const d = document.createElement('span');
    const kind = verdictKind(t.verdict);
    d.className = `dot ${kind}`;
    d.title = `Test ${t.index}: ${verdictWords(t.verdict)}, ${t.timeMs} ms`;
    d.style.setProperty('--i', i);
    if (kind !== 'ok') d.innerHTML = icon(kind === 'limit' ? 'i-clock' : 'i-x');
    dots.append(d);
  });
  const stoppedEarly = s.tests.length === 1 && s.tests[0].verdict !== 'OK';
  // the slowest test in words, since a dot's own time is only in its tooltip
  const slowest = s.tests.length > 1 ? `, slowest ${ms(Math.max(...s.tests.map((t) => t.timeMs)))}` : '';
  // a solution meant to fail that fails is fine: say so, so its red dots don't read as a problem
  const expectedToFail = s.matchesTag && s.tests.some((t) => t.verdict !== 'OK');
  const asLabelled = expectedToFail ? ' That is what its label expects.' : '';
  $('.dots-note', tr).textContent = stoppedEarly ? `${cap(verdictWords(s.tests[0].verdict))} on the first test, so it was stopped there.${asLabelled}` : `${cap(outcome(s))}${slowest}.${asLabelled}`;
  // the proof for a solution that broke its label: each failing test and what the checker saw
  const fails = $('.fails', tr);
  const failing = s.matchesTag ? [] : s.tests.filter((t) => t.verdict !== 'OK');
  for (const t of failing.slice(0, 6)) {
    const li = document.createElement('li');
    const said = verdictWords(t.verdict);
    const detail = (t.message ?? '').replace(new RegExp(`^${said}\\s*`, 'i'), '').trim();
    li.innerHTML = `<b></b><span></span>`;
    $('b', li).textContent = `Test ${t.index}`;
    $('span', li).textContent = detail ? `${said}: ${detail}` : said;
    fails.append(li);
  }
  if (failing.length > 6) fails.insertAdjacentHTML('beforeend', `<li class="more-fails">and ${failing.length - 6} more in the report below</li>`);
  if (!failing.length) fails.remove();
  $('.res', tr).innerHTML = s.matchesTag ? `<span class="badge" data-variant="outline">${icon('i-check')}As labelled</span>` : `<span class="badge" data-variant="destructive">${icon('i-x')}Not as labelled</span>`;
  return tr;
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

function setStatus(text, variant) {
  els.status.textContent = text;
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

/** The run is over, with or without an answer: let the card size itself again. */
function settle() {
  finished = true;
  clearInterval(timer);
  els.run.classList.remove('is-running');
  els.run.style.minHeight = '';
}

function stopped() {
  settle();
  els.problems.replaceChildren();
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
  setHead(null, 'The check did not finish.', message);
  els.run.classList.add('is-bad');
  setStatus('Failed', 'destructive');
  showActions('done');
  setBusy(false);
  say(`The check did not finish. ${message}`);
  els.verdict.focus({ preventScroll: true });
}

/** The service's refusal as one sentence anyone can act on. */
function plainReason(message = '') {
  if (/central directory|not a zip|invalid zip|zip.*(corrupt|truncat)/i.test(message)) return "This file isn't a zip, or it was cut short.";
  if (/config\.json/i.test(message) && /not found|missing|no /i.test(message)) return 'There is no Config.json at the top of the zip, or in one folder per problem.';
  return cap(message);
}

function showError(message, issues, kind = 'refused') {
  settle();
  const offline = kind === 'offline';
  const plain = offline ? 'Could not reach the service.' : plainReason(message);
  setHead(label ? `Not checked: ${label}` : 'Not checked', plain, offline ? 'Check your connection and run it again. If it still fails, the service may be restarting: try again in a minute.' : 'Nothing was run. See how to prepare the zip, then try again.');
  els.run.classList.add('is-bad');
  setStatus(offline ? 'Not reached' : 'Refused', 'destructive');
  const box = document.createElement('div');
  box.className = 'refusal';
  box.innerHTML = `<p class="raw"></p><ul></ul><p class="prep"><a href="/docs#prepare">How to prepare the zip</a></p>`;
  if (offline) $('.prep', box).remove();
  if (plain !== message) $('.raw', box).textContent = `${offline ? 'Your browser said' : 'The service said'}: ${message}`;
  else $('.raw', box).remove();
  const ul = $('ul', box);
  for (const i of issues ?? []) {
    const li = document.createElement('li');
    li.textContent = i;
    ul.append(li);
  }
  if (!issues?.length) ul.remove();
  els.problems.replaceChildren(box);
  showActions(offline ? 'done' : 'refused');
  els.download.hidden = true;
  setBusy(false);
  showCard();
  say(`Not checked. ${plain}`);
  els.verdict.focus({ preventScroll: true });
}
