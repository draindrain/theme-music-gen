/** The web app, served as a single self-contained HTML string. Vanilla JS, no
 * build step. Profiles (descriptions, params, generation config) live in the
 * browser's localStorage; API keys are held in memory for the session only. The
 * server is a stateless renderer the page calls into. NOTE: this whole file is a
 * TS template literal, so the embedded script must avoid backticks and ${...}. */
export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Score — studio</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 system-ui, sans-serif; background: #14161a; color: #d8dce2; margin: 0; padding: 1.5rem 2rem 4rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #2a2e35; padding-bottom: .3rem; }
  h3 { font-size: .95rem; color: #9fc1ff; margin: .4rem 0; }
  .meta { color: #79818d; font-size: .8rem; }
  .bar { display: flex; align-items: center; gap: .6rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .card { background: #1a1d22; border: 1px solid #272b32; border-radius: 10px; padding: .8rem 1rem; margin-bottom: .8rem; }
  .cardhead { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .right { margin-left: auto; }
  .panel { margin-top: .5rem; } .panel:empty { display: none; }
  .btnrow { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin: .4rem 0; }
  .checks { display: flex; flex-direction: column; gap: .25rem; }
  .chk { display: flex; align-items: center; gap: .35rem; }
  .dim { color: #6b7280; }
  .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin: .6rem 0; }
  @media (max-width: 820px) { .grid4 { grid-template-columns: 1fr 1fr; } }
  table { border-collapse: collapse; width: 100%; }
  td, th { padding: .35rem .6rem; text-align: left; vertical-align: middle; }
  th { color: #8b93a0; font-weight: 500; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; }
  tr + tr td { border-top: 1px solid #23272e; }
  audio { width: 230px; height: 30px; vertical-align: middle; }
  .entity { background: #1a1d22; border: 1px solid #272b32; border-radius: 10px; padding: .8rem 1rem; margin-bottom: 1rem; }
  textarea { width: 100%; height: 120px; background: #101216; color: #cde0b8; border: 1px solid #2a2e35; border-radius: 6px; font: 12px/1.45 ui-monospace, monospace; padding: .6rem; box-sizing: border-box; }
  textarea.tall { height: 240px; }
  input[type=text], input:not([type]), input[type=password], select { background: #101216; color: #d8dce2; border: 1px solid #2a2e35; border-radius: 6px; padding: .35rem .5rem; font-size: .85rem; }
  button { background: #2e6bd6; color: white; border: 0; border-radius: 6px; padding: .45rem .9rem; cursor: pointer; font-size: .85rem; }
  button:disabled { opacity: .5; cursor: wait; }
  button.secondary { background: #343a44; }
  .dlbtn { display: inline-block; background: #2e6bd6; color: #fff; text-decoration: none; padding: .45rem .9rem; border-radius: 6px; margin-bottom: 1rem; }
  .status { font-size: .8rem; margin-left: .4rem; }
  .ok { color: #7fd17f; } .err { color: #ff8484; white-space: pre-wrap; }
  .badge { display: inline-block; background: #23272e; border-radius: 4px; padding: 0 .45rem; font-size: .75rem; color: #9aa3b0; }
  .badge.ok { color: #7fd17f; } .badge.err { color: #ffb45b; }
</style>
</head>
<body>
<h1>Score — studio</h1>
<p class="meta">Build a profile, add characters &amp; locations, produce their parameters, then generate and download everything. Profiles are saved in this browser; API keys are kept in memory only.</p>
<div id="root">loading…</div>
<script>
const LS_KEY = 'score.v1';
const sessionKeys = {};
let caps = null;
let store = null;
let lastJob = null;
let variantJob = null;
let variantMap = null;
let variantSel = null;
let variantCtx = null;

function el(tag, attrs, ...children) {
  attrs = attrs || {};
  const e = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === 'onclick') e.onclick = v;
    else if (k === 'onchange') e.onchange = v;
    else if (k === 'oninput') e.oninput = v;
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}
function uniq(arr) { return arr.filter((v, i) => arr.indexOf(v) === i); }

// ---------- character param fields (shared by editor + variants) ----------
// Each entry maps a character param to a dotted path and the enum that supplies
// its choices. caps.enums is filled from /api/capabilities. 'seed' is special.
function charFields() {
  const e = caps.enums;
  return [
    { path: 'key.tonic', label: 'tonic', values: e.pitchClasses },
    { path: 'key.mode', label: 'mode', values: e.modes },
    { path: 'baseTempo', label: 'tempo', values: e.tempos },
    { path: 'contour', label: 'contour', values: e.contours },
    { path: 'intervals', label: 'intervals', values: e.intervalStyles },
    { path: 'rhythm', label: 'rhythm', values: e.rhythmFeels },
    { path: 'brightness', label: 'brightness', values: e.brightness },
    { path: 'weight', label: 'weight', values: e.weights },
    { path: 'palette.lead', label: 'lead instrument', values: e.instruments },
    { path: 'palette.harmony', label: 'harmony instrument', values: e.instruments },
    { path: 'palette.bass', label: 'bass instrument', values: e.instruments },
    { path: 'palette.pad', label: 'pad instrument', values: e.instruments },
  ];
}
function getPath(obj, path) {
  let cur = obj;
  for (const k of path.split('.')) { if (cur == null) return undefined; cur = cur[k]; }
  return cur;
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
  cur[keys[keys.length - 1]] = value;
}
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

// ---------- store ----------
function loadStore() { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { return null; } }
function saveStore() { localStorage.setItem(LS_KEY, JSON.stringify(store)); }
function profile() { return store.profiles[store.active]; }
function defaultConfig() { return { formats: ['wav'], backends: ['dsp'], moods: [], provider: 'anthropic', model: '' }; }

function normalize() {
  if (!store || !store.profiles || !store.active || !store.profiles[store.active]) return false;
  for (const name in store.profiles) {
    const p = store.profiles[name];
    p.descriptions = p.descriptions || {};
    p.params = p.params || {};
    p.config = Object.assign(defaultConfig(), p.config || {});
  }
  return true;
}

async function ensureStore() {
  store = loadStore();
  if (normalize()) return;
  const seed = await fetch('/api/seed').then(r => r.json());
  const descriptions = {}, params = {};
  for (const d of seed.descriptions) descriptions[d.id] = d;
  for (const id in seed.params) params[id] = seed.params[id];
  store = { active: 'default', profiles: { default: { descriptions, params, config: defaultConfig() } } };
  saveStore();
}

// ---------- server calls ----------
async function validate(kind, content) {
  const res = await fetch('/api/validate', { method: 'POST', body: JSON.stringify({ kind, content }) });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'invalid'); }
}
async function setParams(desc, obj) {
  await validate('params', obj);
  if (obj.kind !== desc.kind) throw new Error('params kind "' + obj.kind + '" does not match description');
  if (obj.id !== desc.id) throw new Error('params id "' + obj.id + '" does not match description id "' + desc.id + '"');
  profile().params[desc.id] = obj; saveStore();
}

// ---------- render ----------
function render() {
  const root = document.getElementById('root');
  root.innerHTML = '';
  root.append(profileBar(), descriptionsSection(), generateSection(), variantsSection(), resultsSection());
}

function profileBar() {
  const sel = el('select', { onchange: (e) => { store.active = e.target.value; saveStore(); render(); } });
  for (const n of Object.keys(store.profiles)) {
    const o = el('option', { value: n }, n);
    if (n === store.active) o.setAttribute('selected', '');
    sel.append(o);
  }
  const newBtn = el('button', { class: 'secondary', onclick: onNewProfile }, 'New profile');
  const delBtn = el('button', { class: 'secondary', onclick: onDeleteProfile }, 'Delete');
  return el('div', { class: 'bar' }, el('strong', {}, 'Profile:'), sel, newBtn, delBtn);
}
function onNewProfile() {
  const name = (window.prompt('New profile name:') || '').trim();
  if (!name) return;
  if (store.profiles[name]) { window.alert('Profile already exists'); return; }
  store.profiles[name] = { descriptions: {}, params: {}, config: defaultConfig() };
  store.active = name; lastJob = null; saveStore(); render();
}
function onDeleteProfile() {
  if (Object.keys(store.profiles).length <= 1) { window.alert('Cannot delete the last profile'); return; }
  if (!window.confirm('Delete profile "' + store.active + '"?')) return;
  delete store.profiles[store.active];
  store.active = Object.keys(store.profiles)[0]; lastJob = null; saveStore(); render();
}

function descriptionsSection() {
  const wrap = el('div', {});
  wrap.append(el('h2', {}, 'Characters & Locations'));
  const p = profile();
  const ids = Object.keys(p.descriptions);
  if (ids.length === 0) wrap.append(el('p', { class: 'meta' }, 'None yet — add one below or import JSON.'));
  for (const id of ids) wrap.append(descriptionCard(p.descriptions[id]));
  wrap.append(addDescriptionForm());
  return wrap;
}

function descriptionCard(desc) {
  const p = profile();
  const has = !!p.params[desc.id];
  const head = el('div', { class: 'cardhead' },
    el('strong', {}, desc.name),
    el('span', { class: 'meta' }, ' ' + desc.id + ' · ' + desc.kind),
    el('span', { class: 'badge ' + (has ? 'ok' : 'err') }, has ? 'params ✓' : 'params missing'),
    el('button', { class: 'secondary right', onclick: () => {
      delete p.descriptions[desc.id]; delete p.params[desc.id]; saveStore(); render();
    } }, 'Remove'));
  return el('div', { class: 'card' }, head, paramsOptions(desc));
}

function paramsOptions(desc) {
  const panel = el('div', { class: 'panel' });
  const show = (node) => { panel.innerHTML = ''; if (node) panel.append(node); };
  return el('div', {},
    el('div', { class: 'meta' }, 'view / edit, or (re)set parameters:'),
    el('div', { class: 'btnrow' },
      el('button', { onclick: () => show(editPanel(desc)) }, 'Edit'),
      el('button', { class: 'secondary', onclick: () => show(uploadParamsPanel(desc)) }, 'Upload file'),
      el('button', { class: 'secondary', onclick: () => show(promptPanel(desc)) }, 'Copy-paste prompt'),
      el('button', { class: 'secondary', onclick: () => show(generatePanel(desc)) }, 'Generate via API')),
    panel);
}

// View/edit a character's description and (structured) params. Locations only
// get the description editor; their params keep the upload/prompt/API flow.
function editPanel(desc) {
  const p = profile();
  const status = el('span', { class: 'status' });

  // --- description ---
  const name = el('input', { type: 'text', value: desc.name });
  const prose = el('textarea', {}); prose.value = desc.description;
  const saveDesc = el('button', { onclick: async () => {
    const d = { kind: desc.kind, id: desc.id, name: name.value.trim(), description: prose.value.trim() };
    try {
      await validate('description', d);
      p.descriptions[desc.id] = d; saveStore();
      status.textContent = 'description saved'; status.className = 'status ok';
    } catch (e) { status.textContent = String(e.message || e); status.className = 'status err'; }
  } }, 'Save description');

  const wrap = el('div', {},
    el('div', { class: 'meta' }, 'id ' + desc.id + ' · ' + desc.kind + ' (id and kind are fixed)'),
    el('h3', {}, 'Description'),
    el('div', { class: 'btnrow' }, el('strong', {}, 'Name:'), name),
    prose,
    el('div', { class: 'btnrow' }, saveDesc));

  // --- params (characters only) ---
  if (desc.kind === 'character') {
    const params = p.params[desc.id];
    if (!params) {
      wrap.append(el('h3', {}, 'Parameters'),
        el('div', { class: 'meta' }, 'No params yet — set them with Upload / Copy-paste prompt / Generate via API.'));
    } else {
      const seed = el('input', { type: 'number', min: '0', max: String(0xffffffff), value: String(params.seed) });
      const controls = {};
      const grid = el('div', { class: 'grid4' });
      grid.append(el('div', {}, el('div', { class: 'meta' }, 'seed'), seed));
      for (const f of charFields()) {
        const sel = selectInput(f.values, getPath(params, f.path));
        controls[f.path] = sel;
        grid.append(el('div', {}, el('div', { class: 'meta' }, f.label), sel));
      }
      const saveParams = el('button', { onclick: async () => {
        const obj = clone(params);
        const s = parseInt(seed.value, 10);
        if (!Number.isFinite(s) || s < 0 || s > 0xffffffff) {
          status.textContent = 'seed must be 0..4294967295'; status.className = 'status err'; return;
        }
        obj.seed = s;
        for (const f of charFields()) setPath(obj, f.path, controls[f.path].value);
        try { await setParams(desc, obj); render(); }
        catch (e) { status.textContent = String(e.message || e); status.className = 'status err'; }
      } }, 'Save parameters');
      wrap.append(el('h3', {}, 'Parameters'), grid, el('div', { class: 'btnrow' }, saveParams));
    }
  }

  wrap.append(el('div', { class: 'btnrow' }, status));
  return wrap;
}

function uploadParamsPanel(desc) {
  const input = el('input', { type: 'file', accept: '.json' });
  const status = el('span', { class: 'status' });
  input.onchange = async () => {
    const f = input.files[0]; if (!f) return;
    try { await setParams(desc, JSON.parse(await f.text())); render(); }
    catch (e) { status.textContent = String(e.message || e); status.className = 'status err'; }
  };
  return el('div', {}, el('div', { class: 'meta' }, 'Upload a ' + desc.id + '.params.json file:'), input, status);
}

function promptPanel(desc) {
  const ta = el('textarea', { class: 'tall', readonly: '' });
  const paste = el('textarea', { placeholder: 'Paste the LLM JSON reply here, then Save' });
  const status = el('span', { class: 'status' });
  fetch('/api/prompt', { method: 'POST', body: JSON.stringify({ description: desc }) })
    .then(r => r.json()).then(j => { ta.value = j.prompt || j.error || ''; });
  const copy = el('button', { class: 'secondary', onclick: async () => {
    try { await navigator.clipboard.writeText(ta.value); status.textContent = 'copied'; status.className = 'status ok'; }
    catch (e) { ta.select(); document.execCommand('copy'); status.textContent = 'copied'; status.className = 'status ok'; }
  } }, 'Copy prompt');
  const save = el('button', { onclick: async () => {
    try { await setParams(desc, JSON.parse(paste.value)); render(); }
    catch (e) { status.textContent = String(e.message || e); status.className = 'status err'; }
  } }, 'Save params');
  return el('div', {},
    el('div', { class: 'meta' }, 'Paste this into any chatbot, then paste its JSON answer below:'),
    ta, el('div', { class: 'btnrow' }, copy), paste, el('div', { class: 'btnrow' }, save, status));
}

function generatePanel(desc) {
  const provSel = el('select', {});
  for (const c of caps.models) provSel.append(el('option', { value: c.provider }, c.provider));
  const modelSel = el('select', {});
  const key = el('input', { type: 'password', placeholder: 'API key (memory only)' });
  const status = el('span', { class: 'status' });
  function fillModels() {
    const cat = caps.models.find(c => c.provider === provSel.value);
    modelSel.innerHTML = '';
    for (const m of cat.models) modelSel.append(el('option', { value: m.id }, m.id + ' — ' + m.note));
    modelSel.value = cat.defaultModel;
    key.value = sessionKeys[provSel.value] || '';
  }
  provSel.onchange = fillModels;
  key.oninput = () => { sessionKeys[provSel.value] = key.value; };
  fillModels();
  const gen = el('button', { onclick: async () => {
    sessionKeys[provSel.value] = key.value;
    status.textContent = 'generating…'; status.className = 'status';
    try {
      const res = await fetch('/api/generate-params', { method: 'POST', body: JSON.stringify({
        description: desc, provider: provSel.value, model: modelSel.value, apiKey: key.value }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      await setParams(desc, j.params); render();
    } catch (e) { status.textContent = String(e.message || e); status.className = 'status err'; }
  } }, 'Generate');
  return el('div', {},
    el('div', { class: 'meta' }, 'The key is sent once to your local server and never stored.'),
    el('div', { class: 'btnrow' }, provSel, modelSel),
    el('div', { class: 'btnrow' }, key, gen, status));
}

function addDescriptionForm() {
  const kind = el('select', {});
  kind.append(el('option', { value: 'character' }, 'character'), el('option', { value: 'location' }, 'location'));
  const id = el('input', { placeholder: 'id (lowercase slug)' });
  const name = el('input', { placeholder: 'name' });
  const desc = el('textarea', { placeholder: 'description — a few sentences of prose' });
  const status = el('span', { class: 'status' });
  const add = el('button', { onclick: async () => {
    const d = { kind: kind.value, id: id.value.trim(), name: name.value.trim(), description: desc.value.trim() };
    try {
      await validate('description', d);
      profile().descriptions[d.id] = d; saveStore(); render();
    } catch (e) { status.textContent = String(e.message || e); status.className = 'status err'; }
  } }, 'Add description');
  const file = el('input', { type: 'file', accept: '.json', multiple: '' });
  file.onchange = async () => {
    let err = '';
    for (const f of file.files) {
      try { const d = JSON.parse(await f.text()); await validate('description', d); profile().descriptions[d.id] = d; }
      catch (e) { err = f.name + ': ' + (e.message || e); }
    }
    saveStore();
    if (err) { status.textContent = err; status.className = 'status err'; }
    render();
  };
  return el('div', { class: 'card' },
    el('div', { class: 'meta' }, 'Add a description (form) or import description JSON files'),
    el('div', { class: 'btnrow' }, kind, id, name),
    desc,
    el('div', { class: 'btnrow' }, add, el('span', { class: 'meta' }, 'or import:'), file, status));
}

function selectInput(values, current, onchange) {
  const sel = el('select', onchange ? { onchange } : {});
  for (const v of values) {
    const o = el('option', { value: v }, v);
    if (v === current) o.setAttribute('selected', '');
    sel.append(o);
  }
  if (current != null) sel.value = current;
  return sel;
}

function checklist(values, isChecked, isDisabled, labelOf, onChange) {
  const boxes = {};
  const list = el('div', { class: 'checks' });
  for (const v of values) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = isChecked(v); cb.disabled = isDisabled(v);
    if (onChange) cb.onchange = () => onChange();
    boxes[v] = cb;
    list.append(el('label', { class: 'chk' + (isDisabled(v) ? ' dim' : '') }, cb, ' ' + labelOf(v)));
  }
  return { boxes, list };
}

function generateSection() {
  const p = profile(), cfg = p.config;
  const wrap = el('div', {});
  wrap.append(el('h2', {}, 'Generate'));
  const ids = Object.keys(p.descriptions);
  if (ids.length === 0) { wrap.append(el('p', { class: 'meta' }, 'Add descriptions first.')); return wrap; }

  const subj = checklist(ids,
    (id) => !!p.params[id],
    (id) => !p.params[id],
    (id) => p.descriptions[id].name + ' (' + p.descriptions[id].kind + ')' + (p.params[id] ? '' : ' — no params'));

  // Persist checkbox settings to localStorage on every toggle, so selections
  // stick across reloads without needing to click Generate.
  function persist() {
    cfg.formats = caps.formats.filter(f => fmt.boxes[f].checked);
    cfg.backends = beNames.filter(n => be.boxes[n].checked);
    const m = caps.moods.filter(x => mood.boxes[x].checked);
    cfg.moods = m.length === caps.moods.length ? [] : m;
    saveStore();
  }

  const fmt = checklist(caps.formats,
    (f) => f === 'wav' ? true : (cfg.formats.indexOf(f) >= 0 && !(f === 'ogg' && !caps.haveFfmpeg)),
    (f) => f === 'wav' || (f === 'ogg' && !caps.haveFfmpeg),
    (f) => f + (f === 'ogg' && !caps.haveFfmpeg ? ' (needs ffmpeg)' : '') + (f === 'wav' ? ' (always)' : ''),
    persist);

  const beNames = caps.backends.map(b => b.name);
  const beOk = {}; for (const b of caps.backends) beOk[b.name] = b.ok;
  const beReason = {}; for (const b of caps.backends) beReason[b.name] = b.reason;
  const be = checklist(beNames,
    (n) => beOk[n] && cfg.backends.indexOf(n) >= 0,
    (n) => !beOk[n],
    (n) => n + (beOk[n] ? '' : ' — ' + beReason[n]),
    persist);

  const allMoods = cfg.moods.length === 0;
  const mood = checklist(caps.moods,
    (m) => allMoods || cfg.moods.indexOf(m) >= 0,
    () => false,
    (m) => m,
    persist);

  const status = el('span', { class: 'status' });
  const go = el('button', { onclick: async () => {
    const items = [];
    for (const id of ids) if (subj.boxes[id].checked && p.params[id]) items.push({ description: p.descriptions[id], params: p.params[id] });
    const formats = caps.formats.filter(f => fmt.boxes[f].checked);
    const backends = beNames.filter(n => be.boxes[n].checked);
    const moods = caps.moods.filter(m => mood.boxes[m].checked);
    cfg.formats = formats; cfg.backends = backends;
    cfg.moods = moods.length === caps.moods.length ? [] : moods;
    saveStore();
    if (items.length === 0) { status.textContent = 'select at least one subject that has params'; status.className = 'status err'; return; }
    if (items.some(it => it.description.kind === 'character') && backends.length === 0) {
      status.textContent = 'select at least one synth'; status.className = 'status err'; return;
    }
    if (moods.length === 0) { status.textContent = 'select at least one mood'; status.className = 'status err'; return; }
    go.disabled = true; status.textContent = 'generating… this can take a while'; status.className = 'status';
    try {
      const res = await fetch('/api/generate', { method: 'POST', body: JSON.stringify({ items, formats, backends, moods }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      lastJob = j; render();
      const r = document.getElementById('results'); if (r) r.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { status.textContent = String(e.message || e); status.className = 'status err'; go.disabled = false; }
  } }, 'Generate selected');

  wrap.append(
    el('div', { class: 'grid4' },
      el('div', {}, el('h3', {}, 'Subjects'), subj.list),
      el('div', {}, el('h3', {}, 'Formats'), fmt.list),
      el('div', {}, el('h3', {}, 'Synths'), be.list),
      el('div', {}, el('h3', {}, 'Moods'), mood.list)),
    el('div', { class: 'btnrow' }, go, status));
  return wrap;
}

// ---------- variants ----------
// Fix a character + mood and vary one input — the seed (a random batch) or one
// parameter (one render per possible value) — then pick a winner whose value is
// written back to the character. Built entirely on /api/generate by giving each
// variant a distinct synthetic id so renders don't collide.
function variantsSection() {
  const wrap = el('div', {});
  wrap.append(el('h2', {}, 'Variants'));
  wrap.append(el('p', { class: 'meta' }, 'Most single melodies are hit or miss — generate a batch over the seed or one parameter, audition them, and keep the best.'));
  const p = profile();
  const charIds = Object.keys(p.descriptions).filter(id => p.descriptions[id].kind === 'character' && p.params[id]);
  if (charIds.length === 0) {
    wrap.append(el('p', { class: 'meta' }, 'Add a character with parameters first.'));
    return wrap;
  }
  if (!variantSel) variantSel = {};
  if (charIds.indexOf(variantSel.char) < 0) variantSel.char = charIds[0];

  const okBackends = caps.backends.filter(b => b.ok).map(b => b.name);
  if (okBackends.indexOf(variantSel.synth) < 0) variantSel.synth = okBackends[0];
  if (caps.moods.indexOf(variantSel.mood) < 0) variantSel.mood = caps.moods[0];

  const charSel = selectInput(charIds, variantSel.char, (e) => { variantSel.char = e.target.value; });
  const moodSel = selectInput(caps.moods, variantSel.mood, (e) => { variantSel.mood = e.target.value; });
  const synthSel = okBackends.length
    ? selectInput(okBackends, variantSel.synth, (e) => { variantSel.synth = e.target.value; })
    : el('span', { class: 'err' }, 'no synth available');

  // Vary select: 'seed' plus each character param field (value = path).
  const fields = charFields();
  if (variantSel.vary == null) variantSel.vary = 'seed';
  const varySel = el('select', { onchange: (e) => { variantSel.vary = e.target.value; render(); } });
  const seedOpt = el('option', { value: 'seed' }, 'seed (random batch)');
  if (variantSel.vary === 'seed') seedOpt.setAttribute('selected', '');
  varySel.append(seedOpt);
  for (const f of fields) {
    const o = el('option', { value: f.path }, f.label);
    if (variantSel.vary === f.path) o.setAttribute('selected', '');
    varySel.append(o);
  }
  varySel.value = variantSel.vary;

  const count = el('input', { type: 'number', min: '1', max: '50', value: String(variantSel.count || 20) });
  count.oninput = () => { variantSel.count = parseInt(count.value, 10) || 20; };
  const countWrap = el('div', {}, el('div', { class: 'meta' }, 'count'), count);
  if (variantSel.vary !== 'seed') countWrap.style.display = 'none';

  const status = el('span', { class: 'status' });
  const go = el('button', { onclick: async () => {
    const baseDesc = p.descriptions[variantSel.char];
    const baseParams = p.params[variantSel.char];
    if (!okBackends.length) { status.textContent = 'no synth available'; status.className = 'status err'; return; }

    // Build the list of varied values and matching items with distinct ids.
    const field = variantSel.vary === 'seed' ? null : fields.find(f => f.path === variantSel.vary);
    let values;
    if (field) values = field.values.slice();
    else {
      const n = Math.max(1, Math.min(50, parseInt(count.value, 10) || 20));
      values = [];
      for (let i = 0; i < n; i++) values.push(Math.floor(Math.random() * 0xffffffff));
    }
    const items = [], map = {};
    values.forEach((val, i) => {
      const vid = baseDesc.id + '-var-' + String(i).padStart(2, '0');
      const d = clone(baseDesc); d.id = vid;
      const pr = clone(baseParams); pr.id = vid;
      if (field) setPath(pr, field.path, val); else pr.seed = val;
      items.push({ description: d, params: pr });
      map[vid] = { label: field ? String(val) : ('seed ' + val), value: val };
    });

    go.disabled = true; status.textContent = 'generating ' + items.length + ' variants… this can take a while'; status.className = 'status';
    try {
      const res = await fetch('/api/generate', { method: 'POST', body: JSON.stringify({
        items, formats: ['wav'], backends: [variantSel.synth], moods: [variantSel.mood] }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      variantJob = j; variantMap = map;
      variantCtx = { baseId: baseDesc.id, mood: variantSel.mood, path: field ? field.path : null };
      render();
      const r = document.getElementById('variant-results'); if (r) r.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { status.textContent = String(e.message || e); status.className = 'status err'; go.disabled = false; }
  } }, 'Generate variants');

  wrap.append(
    el('div', { class: 'grid4' },
      el('div', {}, el('h3', {}, 'Character'), charSel),
      el('div', {}, el('h3', {}, 'Mood'), moodSel),
      el('div', {}, el('h3', {}, 'Synth'), synthSel),
      el('div', {}, el('h3', {}, 'Vary'), varySel, countWrap)),
    el('div', { class: 'btnrow' }, go, status),
    variantResults());
  return wrap;
}

function variantResults() {
  const wrap = el('div', { id: 'variant-results' });
  if (!variantJob || !variantMap || !variantCtx) return wrap;
  const music = variantJob.manifest.assets.filter(a => a.type === 'music');
  if (music.length === 0) { wrap.append(el('p', { class: 'meta' }, 'No variants rendered.')); return wrap; }
  // Order results to match the generated value order (synthetic ids sort).
  music.sort((a, b) => a.subject.localeCompare(b.subject));
  const p = profile();
  const baseId = variantCtx.baseId;
  const desc = p.descriptions[baseId];
  const path = variantCtx.path;
  if (!desc) { wrap.append(el('p', { class: 'meta' }, 'Original character was removed.')); return wrap; }

  wrap.append(el('h3', {}, 'Variants for ' + baseId + ' · ' + variantCtx.mood +
    ' · varying ' + (path || 'seed')));
  const table = el('table', {});
  table.append(el('tr', {}, el('th', {}, 'value'), el('th', {}, 'preview'), el('th', {}, '')));
  for (const a of music) {
    const info = variantMap[a.subject];
    if (!info) continue;
    const use = el('button', { onclick: async () => {
      const cur = p.params[baseId];
      if (!cur) { window.alert('Character no longer has params'); return; }
      const obj = clone(cur);
      if (path) setPath(obj, path, info.value); else obj.seed = info.value;
      try { await setParams(desc, obj); render(); }
      catch (e) { window.alert(String(e.message || e)); }
    } }, 'Use this');
    table.append(el('tr', {},
      el('td', {}, el('strong', {}, info.label)),
      el('td', {}, player(variantJob, a)),
      el('td', {}, use)));
  }
  wrap.append(el('div', { class: 'entity' }, table));
  return wrap;
}

function fileUrl(job, p) { return '/file?job=' + encodeURIComponent(job.job) + '&path=' + encodeURIComponent(p); }
function player(job, asset) {
  if (!asset) return el('span', { class: 'meta' }, '—');
  const a = el('audio', { controls: '', loop: '', preload: 'none', src: fileUrl(job, asset.wav) });
  return el('div', {}, a, el('div', { class: 'meta' },
    asset.seconds.toFixed(1) + 's · rms ' + asset.rmsDb.toFixed(1) + 'dB' +
    (asset.key ? ' · ' + asset.key + ' · ' + asset.tempoBpm + 'bpm' : '')));
}

function resultsSection() {
  const wrap = el('div', { id: 'results' });
  wrap.append(el('h2', {}, 'Audition'));
  if (!lastJob) { wrap.append(el('p', { class: 'meta' }, 'Generate to browse, play and download results here.')); return wrap; }
  const assets = lastJob.manifest.assets;
  const music = assets.filter(a => a.type === 'music');
  const ambience = assets.filter(a => a.type === 'ambience');

  wrap.append(el('a', { class: 'dlbtn', href: '/api/download?job=' + lastJob.job }, 'Download all (zip)'));

  const characters = uniq(music.map(a => a.subject));
  const usedBackends = uniq(music.map(a => a.backend));
  const moods = uniq(music.map(a => a.mood));
  for (const ch of characters) {
    const table = el('table', {});
    const head = el('tr', {}, el('th', {}, 'mood'));
    for (const b of usedBackends) head.append(el('th', {}, b));
    head.append(el('th', {}, 'midi'));
    table.append(head);
    for (const m of moods) {
      const row = el('tr', {}, el('td', {}, m));
      for (const b of usedBackends) {
        const asset = music.find(a => a.subject === ch && a.mood === m && a.backend === b);
        row.append(el('td', {}, player(lastJob, asset)));
      }
      const withMid = music.find(a => a.subject === ch && a.mood === m && a.mid);
      row.append(el('td', {}, withMid ? el('a', { href: fileUrl(lastJob, withMid.mid), download: ch + '-' + m + '.mid' }, '.mid') : '—'));
      table.append(row);
    }
    wrap.append(el('div', { class: 'entity' }, el('h3', {}, ch), table));
  }
  if (ambience.length) {
    wrap.append(el('h2', {}, 'Ambience'));
    for (const a of ambience) wrap.append(el('div', { class: 'entity' }, el('h3', {}, a.location), player(lastJob, a)));
  }
  return wrap;
}

async function init() {
  try {
    caps = await fetch('/api/capabilities').then(r => r.json());
    await ensureStore();
    render();
  } catch (e) {
    document.getElementById('root').textContent = 'failed to load: ' + (e.message || e);
  }
}
init();
</script>
</body>
</html>`;
