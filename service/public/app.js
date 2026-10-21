// The page talks to the API and renders the newline-delimited JSON events
// that /api/verify streams back while it works, as a plain-English report.
// Components are Basecoat (shadcn/ui for plain HTML): .card, .alert, .table, .badge, .btn.
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
  sub: $('#run-sub'),
  status: $('#run-status'),
  announce: $('#announce'),
  problems: $('#problems'),
  actions: $('#run-actions'),
  download: $('#download'),
  again: $('#again'),
  tpl: $('#problem-tpl'),
};

/** The sample the big button runs: it has one mistake for the check to find. */
const DEMO = 'wrong-tag';
/** What each sample shows, in words for someone who has never set a contest problem. */
const SAMPLE_TITLES = {
  'even-sum': 'A problem that is ready',
  'not-ready': 'Correct, but too few tests',
  'sandbox-check': 'A solution that tries to break out',
  'wrong-tag': 'A solution with the wrong label',
};
/** What a solution's label promises, and what a test's verdict means. */
const TAG_WORDS = { MA: 'Main correct solution', OK: 'Correct', WA: 'Wrong answer', TL: 'Too slow', ML: 'Too much memory', RE: 'Crashes', PE: 'Badly formatted output', TO: 'Correct, may be slow', RJ: 'Fails somehow' };
const VERDICT_WORDS = { OK: 'passed', WA: 'wrong answer', TLE: 'too slow', MLE: 'too much memory', RE: 'crashed', PE: 'badly formatted output', CE: 'did not compile' };
const RELABEL = { WA: 'a wrong answer', TLE: 'too slow', MLE: 'using too much memory', RE: 'crashing', PE: 'badly formatted output' };
const SEVERITY_WORDS = { critical: 'must fix', warning: 'recommended', info: 'nice to have' };
const STEPS = 10;

const tagWords = (t) => TAG_WORDS[t] ?? t;
const verdictWords = (v) => VERDICT_WORDS[v] ?? v;
const verdictKind = (v) => (v === 'OK' ? 'ok' : /^(TLE|MLE|TL|ML|IL|ILE)$/.test(v) ? 'limit' : 'bad');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const seconds = (s) => `${s.toFixed(1)} s`;
const icon = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let events = [];
let running = false;
let label = '';
let polymanVersion = '';

fetch('/api/version')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((v) => {
    polymanVersion = v.polyman;
    $('#version').textContent = `Live on Google Cloud Run · polyman ${v.polyman}`;
    $('#commit').textContent = `polyman ${v.polyman} · commit ${String(v.commit).slice(0, 7)}`;
  })
  .catch((err) => console.warn('version unavailable', err));

fetch('/api/samples')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((samples) => {
    for (const s of samples) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sample card';
      b.dataset.size = 'sm';
      b.innerHTML = `<header><h3></h3><p></p></header><footer><span class="badge" data-variant="secondary"></span><span class="sample-go">Run ${icon('i-arrow')}</span></footer>`;
      $('h3', b).textContent = SAMPLE_TITLES[s.name] ?? s.name;
      $('p', b).textContent = s.description;
      $('.badge', b).textContent = s.name;
      b.addEventListener('click', () => start(`/api/samples/${encodeURIComponent(s.name)}/verify`, null, s.name));
      els.samples.append(b);
    }
  })
  .catch((err) => {
    console.error(err);
    els.samples.textContent = 'The sample problems could not be loaded. You can still check your own.';
  });

els.demo.addEventListener('click', () => start(`/api/samples/${DEMO}/verify`, null, DEMO));
els.own.addEventListener('click', () => els.file.click());
els.pick.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  const f = els.file.files[0];
  // clear it, so choosing the same file again (after fixing it) still starts a run
  els.file.value = '';
  if (f) upload(f);
});
for (const ev of ['dragenter', 'dragover']) {
  els.form.addEventListener(ev, (e) => {
    e.preventDefault();
    els.form.classList.add('over');
  });
}
for (const ev of ['dragleave', 'drop']) els.form.addEventListener(ev, () => els.form.classList.remove('over'));
els.form.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) upload(f);
});
els.form.addEventListener('submit', (e) => e.preventDefault());
els.again.addEventListener('click', () => {
  els.run.hidden = true;
  window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  els.demo.focus({ preventScroll: true });
});
els.download.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'polyman-verify-report.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

function upload(file) {
  if (!/\.zip$/i.test(file.name)) {
    label = file.name;
    return showError(`${file.name} is not a .zip file. Zip the problem folder and try again.`);
  }
  const body = new FormData();
  body.append('problem', file);
  start('/api/verify', body, file.name);
}

function setBusy(on) {
  running = on;
  for (const b of document.querySelectorAll('.sample, #pick, #demo, #own')) b.disabled = on;
}

function say(text) {
  els.announce.textContent = text;
}

async function start(url, body, name) {
  if (running) return;
  setBusy(true);
  events = [];
  cards.clear();
  finished = false;
  els.problems.replaceChildren();
  els.actions.hidden = true;
  els.download.hidden = false;
  els.run.hidden = false;
  label = name;
  els.title.textContent = `Checking ${label}`;
  els.sub.textContent = 'Compiling and running every solution on every test.';
  setStatus('Working', 'secondary');
  say(`Checking ${label}.`);
  els.run.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });

  try {
    const res = await fetch(url, { method: 'POST', body });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after'));
        return showError(`The service is busy with another check.${wait ? ` Try again in ${plural(wait, 'second')}.` : ' Try again in a moment.'}`);
      }
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
    showError(`Could not reach the service: ${err.message}`);
  } finally {
    setBusy(false);
  }
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
      // one problem: the run title already names it; the heading stays for screen readers
      if (ev.problems.length === 1) $('.problem-name', node).classList.add('sr-only');
      els.problems.append(node);
      cards.set(name, node);
    }
  } else if (ev.type === 'step') {
    const c = card(ev.problem);
    const bar = $('.progress', c);
    bar.setAttribute('aria-valuenow', ev.step);
    $('span', bar).style.width = `${Math.min(100, (ev.step / STEPS) * 100)}%`;
    $('.progress-label', c).textContent = `Step ${ev.step} of ${STEPS}: ${ev.title}`;
    if (cards.size === 1) say(`Step ${ev.step}: ${ev.title}.`);
  } else if (ev.type === 'problem') {
    renderProblem(card(ev.problem), ev);
  } else if (ev.type === 'done') {
    finished = true;
    setStatus(ev.ok ? 'All good' : 'Needs work', ev.ok ? 'success' : 'destructive');
    els.title.textContent = `Checked ${label} in ${seconds(ev.seconds)}`;
    els.actions.hidden = false;
    say(`Checked ${label} in ${ev.seconds.toFixed(1)} seconds: ${ev.ok ? 'all good' : 'needs work'}.`);
  } else if (ev.type === 'error') {
    finished = true;
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
  const tests = new Set(solutions.flatMap((s) => s.tests.map((t) => `${t.testset}#${t.index}`))).size;
  $('.running', card).hidden = true;
  $('.outcome', card).hidden = false;
  if (cards.size === 1 && solutions.length) els.sub.textContent = `${plural(solutions.length, 'solution')} on ${plural(tests, 'test')}${polymanVersion ? ` · polyman ${polymanVersion}` : ''}`;

  // the answer first: one alert that says what is wrong and what to do
  const alert = $('.verdict', card);
  let title;
  let body;
  if (!report) {
    title = 'The check could not finish.';
    body = 'What polyman reported is below.';
  } else if (broken.length) {
    title = `${plural(broken.length, 'solution')} ${broken.length === 1 ? "doesn't" : "don't"} behave as labelled.`;
    body = broken.map((s) => `${s.name} is labelled ${tagWords(s.tag).toLowerCase()}, but ${outcome(s)}. ${nextStep(s)}`).join(' ');
  } else if (!report.ok) {
    title = 'One of the checks failed.';
    body = 'What polyman reported is below.';
  } else if (critical.length) {
    title = "Every solution behaves as labelled, but it isn't ready for a contest yet.";
    body = `Fix first: ${critical.map((c) => c.title).join(', ')}.`;
  } else {
    title = 'Ready to use.';
    body = `Every solution behaves exactly as labelled${checks.length ? `, and all ${checks.length} contest guidelines are met` : ''}.`;
  }
  const bad = !ev.ok;
  if (bad) alert.dataset.variant = 'destructive';
  alert.innerHTML = `${icon(bad ? 'i-alert' : 'i-ok')}<h2></h2><section></section>`;
  $('h2', alert).textContent = title;
  $('section', alert).textContent = body;

  const tbody = $('.sols tbody', card);
  for (const s of solutions) tbody.append(solutionRow(s));
  if (!solutions.length) $('.table-container', card).hidden = true;

  $('.guides-title', card).textContent = checks.length ? `Contest guidelines · ${checks.length - gaps.length} of ${checks.length} met` : 'Contest guidelines';
  if (!checks.length) $('.guides', card).hidden = true;
  if (gaps.length) $('.guides', card).open = true;
  const list = $('.checks', card);
  for (const c of checks) {
    const li = document.createElement('li');
    li.className = c.ok ? 'ok' : c.severity;
    li.innerHTML = `${icon(c.ok ? 'i-check' : 'i-x')}<span><span class="t"></span><small></small></span>`;
    $('.t', li).textContent = c.title;
    $('small', li).textContent = c.ok ? c.detail : `${SEVERITY_WORDS[c.severity] ?? c.severity}: ${c.detail}`;
    list.append(li);
  }

  const failed = report?.steps.filter((s) => !s.ok) ?? [];
  const error = ev.error ?? failed.map((s) => `${s.name}: ${s.errors.join('; ') || 'failed'}`).join('\n');
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

/** One table row: name, label, a dot per test, and whether it behaved as labelled. */
function solutionRow(s) {
  const tr = document.createElement('tr');
  if (!s.matchesTag) tr.className = 'broken';
  tr.innerHTML = `<td class="name"></td><td class="tagged"></td><td><div class="dots" role="img"></div><small class="dots-note"></small></td><td class="res"></td>`;
  $('.name', tr).textContent = s.name;
  $('.tagged', tr).textContent = tagWords(s.tag);
  const dots = $('.dots', tr);
  dots.setAttribute('aria-label', s.tests.map((t) => `test ${t.index} ${verdictWords(t.verdict)}`).join(', '));
  s.tests.forEach((t, i) => {
    const d = document.createElement('span');
    const kind = verdictKind(t.verdict);
    d.className = `dot ${kind}`;
    d.title = `Test ${t.index}: ${verdictWords(t.verdict)}, ${t.timeMs} ms${t.message ? `. ${t.message}` : ''}`;
    d.style.setProperty('--i', i);
    if (kind !== 'ok') d.innerHTML = icon(kind === 'limit' ? 'i-clock' : 'i-x');
    dots.append(d);
  });
  $('.dots-note', tr).textContent = cap(outcome(s));
  const res = $('.res', tr);
  res.innerHTML = s.matchesTag ? `<span class="badge" data-variant="outline">${icon('i-check')}As labelled</span>` : `<span class="badge" data-variant="destructive">${icon('i-x')}Mislabelled</span>`;
  res.firstElementChild.title = s.reason;
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

/** An error after results started arriving: keep what came, add the error below it. */
function failMidway(message) {
  finished = true;
  setStatus('Failed', 'destructive');
  const box = document.createElement('div');
  box.className = 'alert';
  box.dataset.variant = 'destructive';
  box.setAttribute('role', 'alert');
  box.innerHTML = `${icon('i-alert')}<h2>The check did not finish</h2><section></section>`;
  $('section', box).textContent = message;
  els.problems.append(box);
  els.actions.hidden = false;
  setBusy(false);
}

/** The service's refusal as one sentence anyone can act on. */
function plainReason(message = '') {
  if (/central directory|not a zip|invalid zip|zip.*(corrupt|truncat)/i.test(message)) return "This file isn't a zip, or it was cut short.";
  if (/config\.json/i.test(message) && /not found|missing|no /i.test(message)) return 'There is no Config.json at the top of the zip, or in one folder per problem.';
  return cap(message);
}

function showError(message, issues) {
  els.run.hidden = false;
  els.title.textContent = label || 'Your upload';
  els.sub.textContent = 'Nothing was run.';
  setStatus('Refused', 'destructive');
  const box = document.createElement('div');
  box.className = 'alert';
  box.dataset.variant = 'destructive';
  box.setAttribute('role', 'alert');
  box.innerHTML = `${icon('i-alert')}<h2></h2><section><p class="raw"></p><ul></ul><p>See <a href="/docs#prepare">how to prepare the zip</a>, then try again.</p></section>`;
  $('h2', box).textContent = plainReason(message);
  if (plainReason(message) !== message) $('.raw', box).textContent = message;
  else $('.raw', box).remove();
  const ul = $('ul', box);
  for (const i of issues ?? []) {
    const li = document.createElement('li');
    li.textContent = i;
    ul.append(li);
  }
  if (!issues?.length) ul.remove();
  els.problems.replaceChildren(box);
  // nothing ran, so there is no report to download
  els.download.hidden = true;
  els.actions.hidden = false;
  setBusy(false);
}
