// The page talks to the API and renders the newline-delimited JSON events
// that /api/verify streams back while it works, as a plain-English report.
const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  demo: $('#demo'),
  form: $('#upload'),
  file: $('#file'),
  pick: $('#pick'),
  samples: $('#sample-list'),
  run: $('#run'),
  title: $('#run-title'),
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
const TAG_WORDS = { MA: 'the main correct solution', OK: 'correct', WA: 'a wrong answer', TL: 'too slow', ML: 'using too much memory', RE: 'crashing', PE: 'badly formatted output', TO: 'correct, but maybe too slow', RJ: 'failing somehow' };
const VERDICT_WORDS = { OK: 'passed', WA: 'wrong answer', TLE: 'too slow', MLE: 'too much memory', RE: 'crashed', PE: 'badly formatted output', CE: 'did not compile' };
const RELABEL = { WA: 'a wrong answer', TLE: 'too slow', MLE: 'using too much memory', RE: 'crashing', PE: 'badly formatted output' };
const SEVERITY_WORDS = { critical: 'must fix', warning: 'recommended', info: 'nice to have' };
const STEPS = 10;

const tagWords = (t) => TAG_WORDS[t] ?? t;
const verdictWords = (v) => VERDICT_WORDS[v] ?? v;
const verdictKind = (v) => (v === 'OK' ? 'ok' : /^(TLE|MLE|TL|ML|IL|ILE)$/.test(v) ? 'limit' : 'bad');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const seconds = (s) => `${s.toFixed(1)} s`;
const icon = (id) => `<svg class="icon" aria-hidden="true"><use href="#${id}"/></svg>`;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let events = [];
let running = false;
let label = '';

fetch('/api/version')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((v) => ($('#version').textContent = `polyman ${v.polyman} · ${String(v.commit).slice(0, 7)}`))
  .catch((err) => console.warn('version unavailable', err));

fetch('/api/samples')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((samples) => {
    for (const s of samples) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sample';
      b.innerHTML = '<span class="title"></span><span class="name"></span><span class="desc"></span>';
      $('.title', b).textContent = SAMPLE_TITLES[s.name] ?? s.name;
      $('.name', b).textContent = s.name;
      $('.desc', b).textContent = s.description;
      b.addEventListener('click', () => start(`/api/samples/${encodeURIComponent(s.name)}/verify`, null, s.name));
      els.samples.append(b);
    }
  })
  .catch((err) => {
    console.error(err);
    els.samples.textContent = 'The sample problems could not be loaded. You can still check your own.';
  });

els.demo.addEventListener('click', () => start(`/api/samples/${DEMO}/verify`, null, DEMO));
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
  for (const b of document.querySelectorAll('.sample, #pick, #demo')) b.disabled = on;
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
  els.problems.classList.remove('many');
  els.actions.hidden = true;
  els.download.hidden = false;
  els.run.hidden = false;
  label = name;
  els.title.textContent = `Checking ${label}`;
  setStatus('working', 'live');
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
    els.problems.classList.toggle('many', ev.problems.length > 1);
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
    const bar = $('.meter', c);
    bar.setAttribute('aria-valuenow', ev.step);
    $('span', bar).style.width = `${Math.min(100, (ev.step / STEPS) * 100)}%`;
    $('.progress-label', c).textContent = `Step ${ev.step} of ${STEPS}: ${ev.title}`;
    if (cards.size === 1) say(`Step ${ev.step}: ${ev.title}.`);
  } else if (ev.type === 'problem') {
    renderProblem(card(ev.problem), ev);
  } else if (ev.type === 'done') {
    finished = true;
    setStatus(ev.ok ? 'all good' : 'needs work', ev.ok ? 'ok' : 'bad');
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
  $('.progress', card).hidden = true;
  $('.result', card).hidden = false;

  // the answer first, in one sentence
  const lead = $('.lead', card);
  if (!report) lead.textContent = 'The check could not finish. What polyman reported is below.';
  else if (broken.length) lead.textContent = `Needs a fix: ${plural(broken.length, 'solution')} ${broken.length === 1 ? "doesn't" : "don't"} behave as labelled.`;
  else if (!report.ok) lead.textContent = 'Needs a fix: one of the checks below failed.';
  else if (gaps.some((c) => c.severity === 'critical')) lead.textContent = "Every solution behaves as labelled, but the problem isn't ready for a contest yet.";
  else lead.textContent = 'Ready to use: every solution behaves exactly as labelled.';
  lead.className = `lead ${ev.ok ? 'ok' : 'bad'}`;

  const sols = $('.sols', card);
  for (const s of solutions) sols.append(solutionRow(s));

  const guides = $('.guides', card);
  if (checks.length && !gaps.length) guides.append(line('ok', 'i-check', `All ${checks.length} contest guidelines are met.`, ''));
  if (gaps.length) {
    const head = `${plural(gaps.length, 'contest guideline')} ${gaps.length === 1 ? 'is' : 'are'} not met.`;
    guides.append(line(gaps.some((c) => c.severity === 'critical') ? 'bad' : 'warn', 'i-alert', head, gaps.map((c) => `${c.title} (${SEVERITY_WORDS[c.severity] ?? c.severity})`).join(' · ')));
  }

  const list = $('.checks', card);
  if (!checks.length) $('.more-checks', card).hidden = true;
  $('.more-checks summary', card).lastChild.textContent = `See all ${plural(checks.length, 'contest check')}`;
  for (const c of checks) {
    const li = document.createElement('li');
    li.className = c.ok ? 'ok' : c.severity;
    li.innerHTML = `${icon(c.ok ? 'i-check' : c.severity === 'info' ? 'i-info' : 'i-alert')}<span><span class="t"></span><small></small></span>`;
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

/** One solution: what it is labelled, a dot per test, and what that means. */
function solutionRow(s) {
  const li = document.createElement('li');
  li.className = `sol ${s.matchesTag ? 'ok' : 'bad'}`;
  const total = s.tests.length;
  const wrong = s.tests.filter((t) => t.verdict !== 'OK');
  const kinds = [...new Set(wrong.map((t) => t.verdict))];
  let note;
  if (!wrong.length) note = `Passed all ${plural(total, 'test')}.`;
  else if (s.matchesTag) {
    const first = wrong[0];
    note = total === 1 ? `${cap(verdictWords(first.verdict))} on test ${first.index}, as its label says. The check stops a solution at its first failure.` : `${cap(verdictWords(kinds[0]))} on ${wrong.length} of ${plural(total, 'test')}, as its label says.`;
  } else note = `Labelled ${tagWords(s.tag)}, but ${kinds.map((k) => `${verdictWords(k)} on ${wrong.filter((t) => t.verdict === k).length}`).join(', ')} of ${plural(total, 'test')}.`;
  li.innerHTML = `<span class="mark">${icon(s.matchesTag ? 'i-check' : 'i-cross')}</span><div class="body"><p class="who"><b></b> <span class="tag"></span></p><div class="dots"></div><p class="note"></p></div>`;
  $('b', li).textContent = s.name;
  $('.tag', li).textContent = `labelled ${tagWords(s.tag)}`;
  $('.note', li).textContent = note;
  if (!s.matchesTag) {
    const fix = document.createElement('p');
    fix.className = 'fix';
    fix.textContent = nextStep(s, kinds);
    $('.body', li).append(fix);
  }
  const dots = $('.dots', li);
  dots.setAttribute('role', 'img');
  dots.setAttribute('aria-label', s.tests.map((t) => `test ${t.index} ${verdictWords(t.verdict)}`).join(', '));
  s.tests.forEach((t, i) => {
    const d = document.createElement('span');
    const kind = verdictKind(t.verdict);
    d.className = `dot ${kind}`;
    d.title = `Test ${t.index}: ${verdictWords(t.verdict)}, ${t.timeMs} ms${t.message ? `. ${t.message}` : ''}`;
    d.style.setProperty('--i', i);
    if (kind !== 'ok') d.innerHTML = icon(kind === 'limit' ? 'i-clock' : 'i-cross');
    dots.append(d);
  });
  return li;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** What to do about a solution that broke its label, from its verdicts. */
function nextStep(s, kinds) {
  const correct = ['MA', 'OK', 'TO'].includes(s.tag);
  if (correct && kinds.length === 1 && RELABEL[kinds[0]]) return `Fix it, or label it as ${RELABEL[kinds[0]]}.`;
  if (correct) return 'Fix it, or label it with how it really fails.';
  if (!kinds.length) return 'No test catches it: add a test that does, or label it correct.';
  return `It fails, but not as ${tagWords(s.tag)}: relabel it, or change it so it does.`;
}

function line(cls, iconId, head, detail) {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = `${icon(iconId)}<span><span class="t"></span><small></small></span>`;
  $('.t', li).textContent = head;
  $('small', li).textContent = detail;
  return li;
}

function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = `pill ${cls}`;
}

/** An error after results started arriving: keep what came, add the error below it. */
function failMidway(message) {
  finished = true;
  setStatus('failed', 'bad');
  const box = document.createElement('div');
  box.className = 'notice';
  box.setAttribute('role', 'alert');
  box.textContent = message;
  els.problems.append(box);
  els.actions.hidden = false;
  setBusy(false);
}

/** The service's refusal as one sentence anyone can act on. */
function plainReason(message = '') {
  if (/central directory|not a zip|invalid zip|zip.*(corrupt|truncat)/i.test(message)) return "This file isn't a zip, or it was cut short.";
  if (/config\.json/i.test(message) && /not found|missing|no /i.test(message)) return 'There is no Config.json at the top of the zip, or in one folder per problem.';
  return message.charAt(0).toUpperCase() + message.slice(1);
}

function showError(message, issues) {
  els.run.hidden = false;
  els.title.textContent = label || 'Your upload';
  setStatus('refused', 'bad');
  const box = document.createElement('div');
  box.className = 'notice';
  box.setAttribute('role', 'alert');
  const lead = document.createElement('strong');
  lead.textContent = plainReason(message);
  box.append(lead);
  if (lead.textContent !== message) {
    const raw = document.createElement('p');
    raw.className = 'raw';
    raw.textContent = message;
    box.append(raw);
  }
  if (issues?.length) {
    const ul = document.createElement('ul');
    for (const i of issues) {
      const li = document.createElement('li');
      li.textContent = i;
      ul.append(li);
    }
    box.append(ul);
  }
  const help = document.createElement('p');
  help.innerHTML = 'See <a href="/docs#prepare">how to prepare the zip</a>, then try again.';
  box.append(help);
  els.problems.replaceChildren(box);
  // nothing ran, so there is no report to download
  els.download.hidden = true;
  els.actions.hidden = false;
  setBusy(false);
}
