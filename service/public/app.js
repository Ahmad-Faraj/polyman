// The page talks to the API and renders the newline-delimited JSON events
// that /api/verify streams back while it works.
const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  form: $('#upload'),
  file: $('#file'),
  pick: $('#pick'),
  samples: $('#sample-list'),
  run: $('#run'),
  title: $('#run-title'),
  status: $('#run-status'),
  problems: $('#problems'),
  actions: $('#run-actions'),
  download: $('#download'),
  again: $('#again'),
  tpl: $('#problem-tpl'),
};

let events = [];
let running = false;

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
      b.innerHTML = '<b></b><span></span>';
      b.querySelector('b').textContent = s.name;
      b.querySelector('span').textContent = s.description;
      b.addEventListener('click', () => start(`/api/samples/${encodeURIComponent(s.name)}/verify`, null, s.name));
      els.samples.append(b);
    }
  })
  .catch((err) => {
    console.error(err);
    els.samples.textContent = 'The sample problems could not be loaded.';
  });

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
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
  if (!/\.zip$/i.test(file.name)) return showError('That is not a .zip file.');
  const body = new FormData();
  body.append('problem', file);
  start('/api/verify', body, file.name);
}

function setBusy(on) {
  running = on;
  for (const b of document.querySelectorAll('.sample, #pick')) b.disabled = on;
}

async function start(url, body, label) {
  if (running) return;
  setBusy(true);
  events = [];
  cards.clear();
  finished = false;
  els.problems.replaceChildren();
  els.actions.hidden = true;
  els.run.hidden = false;
  els.title.textContent = `Verifying ${label}`;
  setStatus('working', '');
  els.run.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const res = await fetch(url, { method: 'POST', body });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
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
    for (const name of ev.problems) {
      const node = els.tpl.content.firstElementChild.cloneNode(true);
      $('.problem-name', node).textContent = name;
      els.problems.append(node);
      cards.set(name, node);
    }
  } else if (ev.type === 'step') {
    const c = card(ev.problem);
    $('.problem-state', c).textContent = 'running';
    const steps = $('.steps', c);
    for (const li of steps.children) li.className = 'done';
    const li = document.createElement('li');
    li.className = 'now';
    li.textContent = ev.title;
    steps.append(li);
  } else if (ev.type === 'problem') {
    renderProblem(card(ev.problem), ev);
  } else if (ev.type === 'done') {
    finished = true;
    setStatus(ev.ok ? 'all good' : 'needs work', ev.ok ? 'ok' : 'bad');
    els.title.textContent += ` · ${ev.seconds.toFixed(1)} s`;
    els.actions.hidden = false;
  } else if (ev.type === 'error') {
    finished = true;
    failMidway(ev.message);
  }
}

function renderProblem(card, ev) {
  const state = $('.problem-state', card);
  // polyman passed but a critical guideline failed: say so, it isn't the same as broken
  state.textContent = ev.ok ? 'ready' : ev.report?.ok ? 'runs correctly, not contest-ready' : 'problems found';
  state.classList.add(ev.ok ? 'ok' : 'bad');
  for (const li of $('.steps', card).children) li.className = 'done';
  const result = $('.result', card);
  result.hidden = false;

  const failed = ev.report?.steps.filter((s) => !s.ok) ?? [];
  const error = ev.error ?? failed.map((s) => `${s.name}: ${s.errors.join('; ') || 'failed'}`).join('\n');
  if (error) {
    const p = $('.problem-error', card);
    p.hidden = false;
    p.textContent = error;
  }

  const tbody = $('.solutions tbody', card);
  for (const s of ev.report?.solutions ?? []) {
    const verdicts = [...new Set(s.tests.map((t) => t.verdict))].join(', ') || 'not run';
    const slowest = s.tests.length ? `${Math.max(...s.tests.map((t) => t.timeMs))} ms` : '-';
    const tr = document.createElement('tr');
    for (const [text, cls] of [[s.name], [s.tag], [verdicts], [slowest], [s.matchesTag ? 'yes' : `no: ${s.reason}`, s.matchesTag ? 'yes' : 'no']]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.append(td);
    }
    tbody.append(tr);
  }

  const list = $('.checks', card);
  for (const c of ev.readiness ?? []) {
    const li = document.createElement('li');
    li.className = c.ok ? 'ok' : c.severity;
    li.innerHTML = '<span class="mark"></span><span><span class="t"></span><small></small></span>';
    $('.mark', li).textContent = c.ok ? '✓' : c.severity === 'info' ? 'i' : '!';
    $('.t', li).textContent = c.title;
    $('small', li).textContent = c.ok ? c.detail : `${c.severity}: ${c.detail}`;
    list.append(li);
  }
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
  box.className = 'error-box';
  box.textContent = message;
  els.problems.append(box);
  els.actions.hidden = false;
  setBusy(false);
}

function showError(message, issues) {
  els.run.hidden = false;
  setStatus('refused', 'bad');
  const box = document.createElement('div');
  box.className = 'error-box';
  box.textContent = message;
  if (issues?.length) {
    const ul = document.createElement('ul');
    for (const i of issues) {
      const li = document.createElement('li');
      li.textContent = i;
      ul.append(li);
    }
    box.append(ul);
  }
  els.problems.replaceChildren(box);
  setBusy(false);
}
