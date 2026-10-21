// The page talks to the API and renders the newline-delimited JSON events
// that /api/verify streams back while it works. The board stays frozen while
// polyman runs, then every solution × test cell resolves to its verdict.
const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  form: $('#upload'),
  file: $('#file'),
  pick: $('#pick'),
  samples: $('#sample-list'),
  run: $('#run'),
  title: $('#run-title'),
  status: $('#run-status'),
  announce: $('#announce'),
  idle: $('#idle'),
  problems: $('#problems'),
  actions: $('#run-actions'),
  download: $('#download'),
  again: $('#again'),
  tpl: $('#problem-tpl'),
};

const VERDICT_NAMES = { OK: 'Accepted', WA: 'Wrong Answer', TLE: 'Time Limit Exceeded', MLE: 'Memory Limit Exceeded', RE: 'Runtime Error', PE: 'Presentation Error', CE: 'Compilation Error' };
const verdictName = (v) => VERDICT_NAMES[v] ?? v;
const verdictClass = (v) => (v === 'OK' ? 'v-ok' : /^(TLE|MLE|TL|ML|IL|ILE)$/.test(v) ? 'v-limit' : 'v-bad');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let events = [];
let running = false;
let label = '';
/** When the board's resolve ends; the verdict, stamps and actions wait for it. */
let revealAt = 0;
const afterResolve = (fn) => {
  const wait = revealAt - performance.now();
  if (wait > 0) setTimeout(fn, wait);
  else fn();
};
const RETAG = { WA: 'WA', TLE: 'TL', MLE: 'ML', RE: 'RE', PE: 'PE' };
const STEPS = 10;
const seconds = (s) => `${s.toFixed(1)} s`;

fetch('/api/version')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((v) => ($('#version').textContent = `polyman ${v.polyman} · ${String(v.commit).slice(0, 7)}`))
  .catch((err) => console.warn('version unavailable', err));

fetch('/api/samples')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((samples) => {
    samples.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sample';
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = '<span class="letter" aria-hidden="true"></span><span class="name"></span><span class="desc"></span><span class="expect"></span>';
      $('.letter', b).textContent = String.fromCharCode(65 + (i % 26));
      $('.name', b).textContent = s.name;
      $('.desc', b).textContent = s.description;
      const expect = expectation(s.expected);
      $('.expect', b).textContent = expect.text;
      if (!expect.ok) $('.expect', b).classList.add('no');
      b.addEventListener('click', () => start(`/api/samples/${encodeURIComponent(s.name)}/verify`, null, s.name, b));
      els.samples.append(b);
    });
    renderGolden(samples);
  })
  .catch((err) => {
    console.error(err);
    const p = document.createElement('p');
    p.className = 'samples-error';
    p.textContent = 'The sample problems could not be loaded. You can still upload your own.';
    els.samples.replaceChildren(p);
  });

/** What the golden set says a sample should give, in a few words. */
function expectation(expected) {
  if (!expected) return { ok: true, text: 'expected result not listed' };
  const broken = Object.values(expected.solutions ?? {}).filter((ok) => !ok).length;
  if (broken) return { ok: false, text: `expect ${plural(broken, 'broken tag')}` };
  const gaps = expected.readinessFailures?.length ?? 0;
  if (gaps) return { ok: false, text: `expect ${plural(gaps, 'guideline gap')}` };
  return { ok: expected.ok, text: expected.ok ? 'expect ready' : 'expect problems' };
}

const GUIDELINES = {
  statement_completeness: 'Statement complete',
  test_coverage: 'At least 10 tests',
  checker_presence: 'Has a checker',
  validator_presence: 'Has a validator',
  checker_correctness: 'Checker passes its tests',
  solution_presence: 'Has a main correct solution',
  solution_diversity: 'C++ and Java, plus a wrong one',
  tags_presence: 'Has tags',
  tutorial_presence: 'Has a tutorial',
};

/** The golden set on the idle board: what CI holds each sample to. */
function renderGolden(samples) {
  const body = $('#golden tbody');
  samples.forEach((s, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<th scope="row"><span class="mini"></span><span class="n"></span></th><td data-label="Must keep their tag"><ul class="chips"></ul></td><td data-label="Guidelines that must fail"><ul class="chips"></ul></td>';
    $('.mini', tr).textContent = String.fromCharCode(65 + (i % 26));
    $('.n', tr).textContent = s.name;
    const [tags, guides] = tr.querySelectorAll('.chips');
    for (const [name, keeps] of Object.entries(s.expected?.solutions ?? {})) {
      tags.append(chip(keeps ? 'yes' : 'no', keeps ? 'i-check' : 'i-cross', name, keeps ? `${name} must keep its tag` : `${name} must break its tag`));
    }
    const gaps = s.expected?.readinessFailures ?? [];
    if (!gaps.length) guides.append(chip('none', 'i-check', 'none', 'Every guideline must pass'));
    for (const id of gaps) guides.append(chip('no', 'i-cross', GUIDELINES[id] ?? id.replaceAll('_', ' '), `${GUIDELINES[id] ?? id} must fail`));
    body.append(tr);
  });
  if (samples.length) $('#golden').hidden = false;
}

function chip(cls, icon, text, label) {
  const li = document.createElement('li');
  li.className = cls;
  li.title = label;
  li.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg><span></span>`;
  $('span', li).textContent = text;
  return li;
}

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
  reset();
  window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  els.pick.focus({ preventScroll: true });
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
    return showError(`${file.name} is not a .zip file. Zip the problem folder and drop the zip.`);
  }
  const body = new FormData();
  body.append('problem', file);
  start('/api/verify', body, file.name);
}

function setBusy(on) {
  running = on;
  for (const b of document.querySelectorAll('.sample, #pick')) b.disabled = on;
}

/** The board back to how it looks before any run. */
function reset() {
  events = [];
  cards.clear();
  finished = false;
  revealAt = 0;
  els.problems.replaceChildren();
  els.problems.classList.remove('many');
  els.actions.hidden = true;
  els.download.hidden = false;
  els.idle.hidden = false;
  els.title.textContent = 'The board';
  setStatus('waiting', '');
  for (const b of els.samples.querySelectorAll('.sample')) b.setAttribute('aria-pressed', 'false');
}

function say(text) {
  els.announce.textContent = text;
}

async function start(url, body, name, sampleButton) {
  if (running) return;
  reset();
  setBusy(true);
  sampleButton?.setAttribute('aria-pressed', 'true');
  els.idle.hidden = true;
  label = name;
  els.title.textContent = `Checking ${label}`;
  setStatus('working', 'live');
  say(`Checking ${label}.`);
  // bring the board's head into view unless it already is: below the fold when stacked,
  // above it when a sample low in the list was picked
  const top = els.run.getBoundingClientRect().top;
  if (top < 0 || top > window.innerHeight * 0.6) {
    els.run.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
  }

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
    if (!finished) failMidway('The check stopped before it finished, so the results above are incomplete. Try again.');
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
    return failMidway('The service sent something this page could not read; the results may be incomplete.');
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
      // one problem: the run title already names it, so the head stays for screen readers only (it keeps the heading order)
      if (ev.problems.length === 1) $('.problem-head', node).classList.add('sr-only');
      // polyman verify reports ten steps; the slots fill as they run
      for (let i = 0; i < STEPS; i++) $('.track', node).append(document.createElement('li'));
      els.problems.append(node);
      cards.set(name, node);
    }
  } else if (ev.type === 'step') {
    const c = card(ev.problem);
    setState($('.problem-state', c), 'running', 'live');
    const track = $('.track', c);
    while (track.children.length < ev.step) track.append(document.createElement('li'));
    [...track.children].forEach((li, i) => (li.className = i < ev.step - 1 ? 'done' : i === ev.step - 1 ? 'now' : ''));
    c.dataset.reached = ev.step;
    $('.track-label', c).innerHTML = `Step ${ev.step}: <b></b>`;
    $('.track-label b', c).textContent = ev.title;
    if (cards.size === 1) say(`Step ${ev.step}: ${ev.title}.`);
  } else if (ev.type === 'problem') {
    renderProblem(card(ev.problem), ev);
  } else if (ev.type === 'done') {
    finished = true;
    // the title changes at once (scripts wait on it); the answer waits for the board
    els.title.textContent = `Checked ${label} in ${seconds(ev.seconds)}`;
    afterResolve(() => {
      setStatus(ev.ok ? 'all good' : 'needs work', ev.ok ? 'ok' : 'bad');
      els.actions.hidden = false;
      say(`Checked ${label} in ${ev.seconds.toFixed(1)} seconds: ${ev.ok ? 'all good' : 'needs work'}.`);
    });
  } else if (ev.type === 'error') {
    finished = true;
    failMidway(ev.message);
  }
}

function renderProblem(card, ev) {
  const report = ev.report;
  // polyman passed but a critical guideline failed: say so, it isn't the same as broken
  const state = ev.ok ? ['ready', 'ok'] : report?.ok ? ['runs, not contest-ready', 'warn'] : ['problems found', 'bad'];

  // the step that was running when polyman stopped is the one that failed
  const stopped = !report || report.steps.some((s) => !s.ok);
  const track = $('.track', card);
  const reached = Number(card.dataset.reached ?? 0);
  // steps never reached stay empty: the run stopped before them; the failed one shows with the verdict
  [...track.children].forEach((li, i) => (li.className = i < reached ? 'done' : ''));
  const solutions = report?.solutions ?? [];
  const tests = new Set(solutions.flatMap((s) => s.tests.map((t) => `${t.testset}#${t.index}`))).size;
  // one problem: the run title already gives the time, so it isn't repeated here
  const time = cards.size > 1 ? ` in ${seconds(ev.seconds)}` : '';
  $('.track-label', card).textContent = !report
    ? `Stopped after ${plural(reached, 'step')}`
    : `${plural(reached, 'step')}${time} · generators, validator, checker${solutions.length ? `, ${plural(solutions.length, 'solution')} on ${plural(tests, 'test')}` : ''}`;
  $('.result', card).hidden = false;

  const failed = report?.steps.filter((s) => !s.ok) ?? [];
  const error = ev.error ?? failed.map((s) => `${s.name}: ${s.errors.join('; ') || 'failed'}`).join('\n');
  if (error) {
    const log = $('.log', card);
    log.hidden = false;
    $('.problem-error', card).textContent = error;
    // with no board to read, the log is the result: open it and put it first
    if (!solutions.length) {
      log.open = true;
      $('.result', card).prepend(log);
    }
  }

  const resolve = solutions.length ? renderGrid($('.grid', card), solutions) : 0;
  if (!solutions.length) $('.grid-wrap', card).hidden = true;
  revealAt = Math.max(revealAt, performance.now() + resolve);

  const verdicts = $('.verdicts', card);
  const broken = solutions.filter((s) => !s.matchesTag);
  for (const s of broken) {
    const wrong = s.tests.filter((t) => t.verdict !== 'OK');
    const byVerdict = new Map();
    for (const t of wrong) byVerdict.set(t.verdict, (byVerdict.get(t.verdict) ?? 0) + 1);
    const counts = [...byVerdict].map(([v, n]) => `${verdictName(v)} on ${n}`);
    const got = wrong.length ? `got ${counts.join(', ')} of ${plural(s.tests.length, 'test')}` : `passed all ${plural(s.tests.length, 'test')}`;
    const line = verdictLine('i-alert', `<b></b> is tagged ${s.tag} but ${got}.`, nextStep(s, [...byVerdict.keys()]), s.name);
    line.title = s.reason;
    verdicts.append(line);
  }
  if (solutions.length && !broken.length) verdicts.append(verdictLine('i-check', `Every solution got the verdict its tag promises.`, `${plural(solutions.length, 'solution')} held to their tags.`, null, 'clean'));
  const checks = ev.readiness ?? [];
  const gaps = checks.filter((c) => !c.ok);
  if (checks.length && !gaps.length) verdicts.append(verdictLine('i-check', `All ${checks.length} contest guidelines pass.`, '', null, 'clean'));
  if (gaps.length) {
    const head = `${ev.ok ? 'Ready for a round, with' : 'Not ready for a round:'} ${plural(gaps.length, 'guideline gap')}.`;
    verdicts.append(verdictLine('i-alert', head, gaps.map((c) => `${c.title} (${c.severity})`).join(' · ')));
  }

  const list = $('.checks', card);
  const rank = (c) => (c.ok ? 3 : { critical: 0, warning: 1, info: 2 }[c.severity] ?? 2);
  if (!checks.length) $('.checks-title', card).hidden = true;
  for (const c of [...checks].sort((a, b) => rank(a) - rank(b))) {
    const li = document.createElement('li');
    li.className = c.ok ? 'ok' : c.severity;
    const icon = c.ok ? 'i-check' : c.severity === 'info' ? 'i-info' : 'i-alert';
    li.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg><span><span class="t"></span><small></small></span>`;
    $('.t', li).textContent = c.title;
    $('small', li).textContent = c.ok ? c.detail : `${c.severity}: ${c.detail}`;
    list.append(li);
  }

  // the answer waits for the board: verdict, guidelines and stamp appear once the last tag is stamped
  const held = [verdicts, $('.checks-title', card), list, $('.log', card)];
  for (const el of held) el.classList.add('held');
  afterResolve(() => {
    for (const el of held) el.classList.remove('held');
    setState($('.problem-state', card), ...state);
    if (stopped && reached) track.children[reached - 1].className = 'failed';
  });
}

/** What the setter does next about a solution that broke its tag, from its verdicts. */
function nextStep(s, kinds) {
  const correct = ['MA', 'OK', 'TO'].includes(s.tag);
  if (correct && kinds.length === 1 && RETAG[kinds[0]]) return `Retag it ${RETAG[kinds[0]]}, or fix it.`;
  if (correct) return 'Fix it, or retag it with the verdict it should get.';
  if (!kinds.length) return `It never fails, so no test catches it: add one that does, or retag it OK.`;
  return `It fails, but not the way ${s.tag} promises: retag it, or change it so it does.`;
}

function verdictLine(icon, html, detail, name, cls = '') {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  li.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg><span>${html}</span><small></small>`;
  if (name) $('b', li).textContent = name;
  $('small', li).textContent = detail ?? '';
  return li;
}

/** Solutions as rows, tests as columns; cells resolve in reading order, the tag column last. */
function renderGrid(table, solutions) {
  const columns = [];
  const seen = new Set();
  for (const s of solutions) {
    for (const t of s.tests) {
      const key = `${t.testset}#${t.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push({ key, testset: t.testset, index: t.index });
    }
  }
  const testsets = [...new Set(columns.map((c) => c.testset))];
  const head = $('thead', table);
  if (testsets.length > 1) {
    const tr = document.createElement('tr');
    tr.append(th('', ''));
    for (const set of testsets) {
      const cell = th(set, 'group');
      cell.colSpan = columns.filter((c) => c.testset === set).length;
      tr.append(cell);
    }
    tr.append(th('', ''));
    head.append(tr);
  }
  const tr = document.createElement('tr');
  tr.append(th('Solution', 'sol'));
  for (const c of columns) tr.append(th(String(c.index), ''));
  tr.append(th('Tag', ''));
  head.append(tr);

  const dense = columns.length > 24;
  table.classList.toggle('dense', dense);
  const cells = solutions.length * columns.length;
  const step = Math.min(30, 1400 / Math.max(cells, 1));
  const body = $('tbody', table);
  solutions.forEach((s, r) => {
    const row = document.createElement('tr');
    if (!s.matchesTag) row.className = 'broken';
    const name = document.createElement('td');
    name.className = 'sol';
    name.innerHTML = '<span class="n"></span><span class="tag"></span>';
    $('.n', name).textContent = s.name;
    $('.tag', name).textContent = s.tag;
    row.append(name);
    const byKey = new Map(s.tests.map((t) => [`${t.testset}#${t.index}`, t]));
    columns.forEach((c, i) => {
      const t = byKey.get(c.key);
      const td = document.createElement('td');
      td.style.setProperty('--d', `${Math.round((r * columns.length + i) * step)}ms`);
      if (t) {
        td.className = `cell ${verdictClass(t.verdict)}`;
        // dense rows have no room for times: accepted stays empty, every other verdict keeps a letter, so colour is never alone
        td.textContent = dense ? (t.verdict === 'OK' ? '' : t.verdict.charAt(0)) : t.verdict === 'OK' ? t.timeMs : t.verdict;
        td.title = `${s.name}, test ${c.index}${testsets.length > 1 ? ` (${c.testset})` : ''}: ${verdictName(t.verdict)}, ${t.timeMs} ms${t.message ? `. ${t.message}` : ''}`;
      } else {
        td.className = 'cell v-none';
        td.textContent = '–';
        td.title = `${s.name}, test ${c.index}: not run`;
      }
      row.append(td);
    });
    const kept = document.createElement('td');
    kept.className = `kept ${s.matchesTag ? 'yes' : 'no'}`;
    kept.style.setProperty('--d', `${Math.round(cells * step + r * 90)}ms`);
    kept.innerHTML = `<span><svg class="icon" aria-hidden="true"><use href="#${s.matchesTag ? 'i-check' : 'i-cross'}"/></svg>${s.matchesTag ? 'kept' : 'broken'}</span>`;
    kept.title = s.reason;
    row.append(kept);
    body.append(row);
  });
  table.classList.add('resolving');
  // on a narrow screen the row runs past the edge: say so, once, under the grid
  requestAnimationFrame(() => {
    const wrap = table.parentElement;
    if (wrap.scrollWidth <= wrap.clientWidth + 1) return;
    const hint = document.createElement('p');
    hint.className = 'scroll-hint';
    hint.textContent = `Scroll sideways for all ${plural(columns.length, 'test')} and the Tag column.`;
    wrap.after(hint);
  });
  // when the last tag stamp has landed
  return reducedMotion.matches ? 0 : Math.round(cells * step + (solutions.length - 1) * 90 + 260);
}

function th(text, cls) {
  const cell = document.createElement('th');
  cell.scope = 'col';
  if (cls) cell.className = cls;
  cell.textContent = text;
  return cell;
}

function setState(node, text, cls) {
  node.textContent = text;
  node.className = `stamp problem-state ${cls}`;
}

function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = `stamp ${cls}`;
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

/** The service's refusal as one sentence a setter can act on. */
function plainReason(message = '') {
  if (/central directory|not a zip|invalid zip|zip.*(corrupt|truncat)/i.test(message)) return "This file isn't a zip, or it was cut short.";
  if (/config\.json/i.test(message) && /not found|missing|no /i.test(message)) return 'There is no Config.json at the top of the zip, or in one folder per problem.';
  return message.charAt(0).toUpperCase() + message.slice(1);
}

function showError(message, issues) {
  els.idle.hidden = true;
  if (label) els.title.textContent = label;
  setStatus('refused', 'bad');
  const box = document.createElement('div');
  box.className = 'notice';
  box.setAttribute('role', 'alert');
  const lead = document.createElement('strong');
  lead.textContent = plainReason(message);
  box.append(lead);
  // the service's own words stay, under the plain sentence
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
