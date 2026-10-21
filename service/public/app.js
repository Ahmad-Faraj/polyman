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
  start: $('#start'),
  note: $('#run-note'),
  stop: $('#stop'),
  instead: $('#instead'),
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
/** The verdict waits for the rows to land; this holds it until then. */
let headTimer = 0;
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
    // one switch per sample along the top of the card, the demo first; pressing one checks it live
    for (const s of [...samples].sort((a, b) => Number(b.name === DEMO) - Number(a.name === DEMO))) {
      const [title] = SAMPLES[s.name] ?? [s.name];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sample';
      b.dataset.sample = s.name;
      b.title = title;
      b.innerHTML = `<b></b><span></span>`;
      $('b', b).textContent = s.name;
      $('span', b).textContent = SAMPLE_HINT[s.name] ?? s.description;
      b.addEventListener('click', () => runSample(s.name));
      els.samples.append(b);
    }
    markSample(pending);
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

/** Before any run: the demo sample's real solution names, waiting to be judged. */
function showPreview(name) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  $('.problem-name', node).classList.add('sr-only');
  $('.problem-name', node).textContent = name;
  waitingRows(node, name);
  els.problems.replaceChildren(node);
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

/** The sample card for the sample in the result card says so. */
function markSample(name) {
  for (const b of els.samples.querySelectorAll('.sample')) {
    b.setAttribute('aria-pressed', String(b.dataset.sample === name));
  }
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
    tr.innerHTML = `<td class="sol"><b class="sol-name"></b><span class="sol-label"></span></td><td class="tests"><span class="skeleton" aria-hidden="true"></span></td><td class="res"></td>`;
    $('.sol-name', tr).textContent = sol;
    const tag = SAMPLES[name]?.[3]?.[sol];
    if (tag) $('.sol-label', tr).textContent = `labelled ${tagWords(tag)} (${tag})`;
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
  tabs[(to + tabs.length) % tabs.length].focus();
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
/** A passing message, shown under the verdict for a few seconds as well as announced. */
function notice(text) {
  say(text);
  els.note.classList.remove('found');
  els.note.textContent = text;
  els.note.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (els.note.hidden = true), 5000);
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
  els.start.hidden = true;
  els.instead.hidden = state !== 'refused' || !expected.has(pending);
  els.next.hidden = true;
  els.stop.hidden = state !== 'running';
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
  els.note.hidden = true;
  els.note.classList.remove('found');
  els.run.classList.remove('has-found');
  clearTimeout(noticeTimer);
  // the sample cards mark the one in the result card; an upload is none of them
  if (!body) pending = name;
  markSample(body ? null : name);
  setBusy(true);
  lastRun = { url, body, name };
  events = [];
  cards.clear();
  finished = false;
  step = 0;
  label = name;
  // the address names the sample, so a reload or a shared link sets it up again
  history.replaceState(null, '', body ? location.pathname : `?sample=${encodeURIComponent(name)}`);
  // hold the card's height so the page doesn't jump while the run fills it back in
  els.run.style.minHeight = `${els.run.offsetHeight}px`;
  // a sample's rows stay in view until the service says what it is checking
  if (!body && expected.has(name)) showPreview(name);
  else els.problems.replaceChildren();
  els.run.classList.remove('is-bad', 'is-good', 'revealing', 'has-found', 'landed');
  clearTimeout(headTimer);
  lastVerdict = '';
  document.querySelector('.hero').classList.remove('answered');
  els.run.classList.add('is-running');
  setHead(`Checking ${label}`, 'Checking the problem…', 'Usually about 20 seconds.');
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
    els.problems.replaceChildren();
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
      // on a phone the ten steps fold into one line and a bar of ten
      list.insertAdjacentHTML('afterend', `<div class="step-bar" aria-hidden="true">${'<span></span>'.repeat(STEPS.length)}</div>`);
      waitingRows(node, name);
      els.problems.append(node);
      node.id = `problem-${ev.problems.indexOf(name)}`;
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
    [...$('.step-bar', c).children].forEach((seg, i) => (seg.className = i < at ? 'done' : i === at ? 'now' : ''));
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
      // one line per problem, each a link to its report
      els.sub.replaceChildren();
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
    els.run.classList.add(ev.ok ? 'is-good' : 'is-bad');
    setStatus(ev.ok ? 'All good' : unfinished ? 'Did not finish' : 'Needs work', ev.ok ? 'success' : 'destructive');
    showActions('done');
    if (!unfinished) suggestNext(ev.ok);
    else if (lastRun?.body) els.choose.hidden = false;
    // a sample's point, answered first: the demo asked "can the check find it?", sandbox-check "does the sandbox hold?"
    const [, , about] = (!unfinished && !lastRun?.body && SAMPLES[label]) || [];
    const sol = about && reports[0]?.report?.solutions.find((s) => s.name === about);
    const win = !sol ? '' : !sol.matchesTag ? `Found it: ${about} is the planted mistake.` : sol.tests.some((t) => t.verdict !== 'OK') ? `The sandbox held: ${about} never got root, so it failed as labelled.` : '';
    if (win) {
      // a stamp in the mark's own hexagon draws itself in, then the answer
      els.note.innerHTML = `<svg class="stamp" viewBox="0 0 32 32" aria-hidden="true"><path class="hex" d="M16 2.6 27.6 9.3v13.4L16 29.4 4.4 22.7V9.3Z"/><path class="tick" d="m10.5 16.6 3.9 3.9 7.3-8.2"/></svg><span></span>`;
      $('span', els.note).textContent = win;
      els.note.classList.add('found');
      els.run.classList.add('has-found');
      els.note.hidden = false;
    }
    // the page has answered its own question: the hero's question steps back
    if (!unfinished) document.querySelector('.hero').classList.add('answered');
    if (unfinished && reports.some((e) => /time|timed out/i.test(e.error ?? ''))) els.title.textContent = `Checked ${label}: stopped at the time limit`;
    say(`Checked ${label} in ${ev.seconds.toFixed(1)} seconds. ${win} ${lastVerdict || els.verdict.textContent}`);
    (win ? els.note : els.verdict).focus({ preventScroll: true });
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
  const fix = (list) => list.map((c) => GUIDE_FIX[c.id] ?? (GUIDE_WORDS[c.id] ?? c.title).toLowerCase()).join('; ');
  const recommended = gaps.filter((c) => c.severity !== 'critical');
  const also = recommended.length ? ` Also recommended: ${fix(recommended)}.` : '';
  $('.steps-live', card).hidden = true;
  $('.step-bar', card)?.remove();

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
  if (cards.size === 1) {
    lastVerdict = title;
    const land = () => {
      setHead(null, title, body);
      if (/see the limits in the docs:$/.test(body)) {
        const a = document.createElement('a');
        a.href = '/docs#limits';
        a.textContent = 'Limits and privacy';
        els.sub.append(' ', a);
      }
      els.run.classList.add('landed');
    };
    // the evidence lands first, row by row; the verdict follows as the last beat (at once if motion is reduced)
    clearTimeout(headTimer);
    const landing = solutions.length && !reducedMotion.matches ? Math.min(solutions.length * 160 + 420, 1500) : 0;
    if (landing) headTimer = setTimeout(land, landing);
    else land();
  }
  else {
    const alert = $('.verdict', card);
    if (!ev.ok) alert.dataset.variant = 'destructive';
    alert.innerHTML = `${icon(ev.ok ? 'i-ok' : 'i-alert')}<h2></h2><section></section>`;
    $('h2', alert).textContent = title;
    $('section', alert).textContent = body;
    $('.outcome', card).hidden = false;
  }

  $('.sols', card).classList.remove('is-running');
  // the ones that broke their label first, then the one the sample is about, the clean passes, and those that fail as labelled
  const focus = lastRun?.body ? null : SAMPLES[label]?.[2];
  // (a result that passes doesn't open on red: solutions that fail on purpose come last)
  const rank = (s) => (!s.matchesTag ? 0 : s.name === focus ? 0.5 : s.tests.some((t) => t.verdict !== 'OK') ? 2 : 1);
  const rows = [...solutions].sort((a, b) => rank(a) - rank(b));
  // the reveal: each solution's squares land in turn, and a broken label (listed first) lands last
  const order = [...rows.filter((s) => s.matchesTag), ...rows.filter((s) => !s.matchesTag)];
  // (no report: the solutions it was about to judge stay listed, not judged)
  if (rows.length) {
    $('.sols tbody', card).replaceChildren(...rows.map((s) => {
      const tr = solutionRow(s);
      if (s.name === focus && s.matchesTag) tr.classList.add('focus');
      tr.classList.add('reveal');
      tr.style.setProperty('--r', order.indexOf(s));
      return tr;
    }));
  }
  // the sample's answer in the card's head waits until the last row has landed
  els.run.style.setProperty('--landed', `${Math.min(order.length * 160 + 420, 1500)}ms`);
  if (cards.size === 1 && rows.length) els.run.classList.add('revealing');
  $('.table-container', card).hidden = !$('.sols tbody', card).children.length;
  // when the problem fails on its guidelines, not its solutions, the guidelines come first
  if (critical.length && !broken.length) card.insertBefore($('.more', card), $('.legend', card));
  $('.legend', card).hidden = !solutions.length;
  legendFor(card, solutions);
  $('.more', card).hidden = false;

  $('.guides-title', card).textContent = checks.length ? `Contest guidelines · ${checks.length - gaps.length} of ${checks.length} met` : 'Contest guidelines';
  if (!checks.length) $('.guides', card).hidden = true;
  if (gaps.length) $('.guides', card).open = true;
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
  $('.legend', card).innerHTML = `<span class="legend-note">One square per test:</span>${items.map(([, cls, glyph, words]) => `<span><span class="${cls}" aria-hidden="true">${glyph ? icon(glyph) : ''}</span>${words}</span>`).join('')}`;
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

/** One table row: the name and its label, a dot per test, and whether it behaved as labelled. */
function solutionRow(s) {
  const tr = document.createElement('tr');
  const expectedToFail = s.matchesTag && s.tests.some((t) => t.verdict !== 'OK');
  if (!s.matchesTag) tr.className = 'broken';
  if (expectedToFail) tr.className = 'expected-fail';
  tr.innerHTML = `<td class="sol"><b class="sol-name"></b><span class="sol-label"></span></td><td class="tests"><div class="dots" role="group"></div><p class="dot-detail"></p><small class="dots-note"></small><ul class="fails"></ul></td><td class="res"></td>`;
  $('.sol-name', tr).textContent = s.name;
  // the setter's own tag letters stay visible beside the plain words
  $('.sol-label', tr).textContent = `labelled ${tagWords(s.tag)} (${s.tag})`;
  const dots = $('.dots', tr);
  dots.setAttribute('aria-label', `${s.name}: one square per test. Use the arrow keys to read each one.`);
  s.tests.forEach((t, i) => {
    const d = document.createElement('button');
    const kind = verdictKind(t.verdict);
    d.type = 'button';
    d.className = `dot ${kind}`;
    d.tabIndex = i ? -1 : 0;
    d.dataset.detail = testDetail(t);
    d.setAttribute('aria-label', d.dataset.detail);
    d.style.setProperty('--i', i);
    if (kind !== 'ok') d.innerHTML = icon(kind === 'limit' ? 'i-clock' : 'i-x');
    dots.append(d);
  });
  wireSquares(dots, $('.dot-detail', tr));
  const stoppedEarly = s.tests.length === 1 && s.tests[0].verdict !== 'OK';
  // the slowest test in words, since a dot's own time is only in its tooltip
  // (only for a solution that passed: on a failing one the time says nothing)
  const slowest = s.tests.length > 1 && s.tests.every((t) => t.verdict === 'OK') ? `, slowest ${ms(Math.max(...s.tests.map((t) => t.timeMs)))}` : '';
  // a solution meant to fail that fails is fine: say so, so its red dots don't read as a problem
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
    $('span', li).textContent = detail || said;
    fails.append(li);
  }
  if (failing.length > 6) fails.insertAdjacentHTML('beforeend', `<li class="more-fails">and ${failing.length - 6} more in the report below</li>`);
  if (!failing.length) fails.remove();
  $('.res', tr).innerHTML = s.matchesTag ? `<span class="res-ok">${icon('i-check')}${expectedToFail ? 'Fails as labelled' : 'As labelled'}</span>` : `<span class="res-bad">${icon('i-x')}Not as labelled</span>`;
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
 * A strip of squares reads like a list: hover, tap or arrow to a square and its test is spelled out
 * underneath. One square at a time takes Tab (roving focus), so a long strip is one stop.
 */
function wireSquares(strip, line) {
  const squares = [...strip.children];
  // focus and hover preview a square; a click or tap pins it, one pinned square per report
  const show = (d) => {
    const pinned = $('.dot.picked', strip);
    const at = d ?? pinned;
    // the line is always there (no jump), and says what the squares are for until one is chosen
    line.textContent = at ? at.dataset.detail : 'Hover, tap or arrow to a square to read that test.';
    line.classList.toggle('hint', !at);
  };
  show(null);
  const pin = (d) => {
    for (const other of strip.closest('.problem').querySelectorAll('.dot.picked')) {
      other.classList.remove('picked');
      const otherLine = $('.dot-detail', other.closest('td'));
      otherLine.textContent = '';
      otherLine.classList.remove('on');
    }
    d.classList.add('picked');
    show(d);
  };
  strip.addEventListener('click', (e) => {
    const d = e.target.closest('.dot');
    if (d) pin(d);
  });
  strip.addEventListener('pointerover', (e) => show(e.target.closest('.dot')));
  strip.addEventListener('pointerleave', () => show(null));
  strip.addEventListener('focusin', (e) => {
    const d = e.target.closest('.dot');
    // one ring at a time: moving by keyboard lets go of a pinned square
    for (const q of strip.closest('.problem').querySelectorAll('.dot.picked')) q.classList.remove('picked');
    for (const q of squares) q.tabIndex = q === d ? 0 : -1;
    show(d);
  });
  strip.addEventListener('focusout', () => show(null));
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
  // a sample keeps its solutions in view, as before it ran
  if (!lastRun?.body && expected.has(label)) showPreview(label);
  else els.problems.replaceChildren();
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
  for (const li of els.problems.querySelectorAll('.steps-live li.now')) {
    li.className = 'stopped';
    $('svg', li).outerHTML = icon('i-dot');
    $('span', li).append(' (stopped here)');
  }
  for (const seg of els.problems.querySelectorAll('.step-bar .now')) seg.className = 'stopped';
  els.run.classList.add('is-bad');
  setStatus('Did not finish', 'destructive');
  showActions('done');
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
  els.problems.replaceChildren(box);
  showActions(offline ? 'done' : 'refused');
  els.download.hidden = true;
  setBusy(false);
  showCard();
  say(`Not checked. ${plain}`);
  els.verdict.focus({ preventScroll: true });
}
