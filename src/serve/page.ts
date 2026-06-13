/** The audition page, served as a single self-contained HTML string. */
export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Score — audition</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 system-ui, sans-serif; background: #14161a; color: #d8dce2; margin: 0; padding: 2rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.1rem; margin-top: 2.2rem; border-bottom: 1px solid #2a2e35; padding-bottom: .3rem; }
  h3 { font-size: 1rem; color: #9fc1ff; }
  .entity { display: grid; grid-template-columns: 1fr 340px; gap: 1.2rem; margin-bottom: 1.6rem; background: #1a1d22; border: 1px solid #272b32; border-radius: 10px; padding: 1rem 1.2rem; }
  table { border-collapse: collapse; width: 100%; }
  td, th { padding: .35rem .6rem; text-align: left; vertical-align: middle; }
  th { color: #8b93a0; font-weight: 500; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; }
  tr + tr td { border-top: 1px solid #23272e; }
  audio { width: 230px; height: 30px; vertical-align: middle; }
  .meta { color: #79818d; font-size: .78rem; }
  textarea { width: 100%; height: 280px; background: #101216; color: #cde0b8; border: 1px solid #2a2e35; border-radius: 6px; font: 12px/1.45 ui-monospace, monospace; padding: .6rem; box-sizing: border-box; }
  button { background: #2e6bd6; color: white; border: 0; border-radius: 6px; padding: .45rem .9rem; cursor: pointer; font-size: .85rem; }
  button:disabled { opacity: .5; cursor: wait; }
  button.secondary { background: #343a44; }
  .status { font-size: .8rem; margin-left: .6rem; }
  .ok { color: #7fd17f; } .err { color: #ff8484; white-space: pre-wrap; }
  .badge { display: inline-block; background: #23272e; border-radius: 4px; padding: 0 .45rem; font-size: .75rem; color: #9aa3b0; margin-left: .5rem; }
</style>
</head>
<body>
<h1>Score — audition page</h1>
<p class="meta" id="backendInfo"></p>
<div id="root">loading…</div>
<script>
const state = { data: null };

async function load() {
  const res = await fetch('/api/state');
  state.data = await res.json();
  render();
}

function fileUrl(p) { return '/file?path=' + encodeURIComponent(p); }

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick') e.onclick = v; else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

function player(asset) {
  if (!asset) return el('span', { class: 'meta' }, '—');
  const a = el('audio', { controls: '', loop: '', preload: 'none', src: fileUrl(asset.wav) });
  const wrap = el('div', {}, a, el('div', { class: 'meta' },
    asset.seconds.toFixed(1) + 's · rms ' + asset.rmsDb.toFixed(1) + 'dB' +
    (asset.key ? ' · ' + asset.key + ' · ' + asset.tempoBpm + 'bpm' : '')));
  return wrap;
}

async function loadParams(kind, id) {
  const sub = kind === 'character' ? 'characters' : 'locations';
  const res = await fetch(fileUrl(sub + '/' + id + '.params.json'));
  return res.text();
}

function paramsPanel(kind, id, regenAll) {
  const ta = el('textarea', { spellcheck: 'false' });
  loadParams(kind, id).then(t => ta.value = t);
  const status = el('span', { class: 'status' });
  const save = el('button', {}, 'Save params + regenerate');
  save.onclick = async () => {
    save.disabled = true; status.textContent = 'validating…'; status.className = 'status';
    try {
      const content = JSON.parse(ta.value);
      let res = await fetch('/api/params', { method: 'POST', body: JSON.stringify({ id, kind, content }) });
      let j = await res.json();
      if (!res.ok) throw new Error(j.error);
      status.textContent = 'rendering…';
      await regenAll(status);
      status.textContent = 'done — refreshed'; status.className = 'status ok';
      await load();
    } catch (e) {
      status.textContent = String(e.message || e); status.className = 'status err';
    } finally { save.disabled = false; }
  };
  return el('div', {}, ta, el('div', { style: 'margin-top:.5rem' }, save, status));
}

function render() {
  const { manifest, backends, moods } = state.data;
  document.getElementById('backendInfo').textContent =
    'backends: ' + backends.map(b => b.name + (b.ok ? ' ✓' : ' ✗ (' + b.reason + ')')).join('   ');
  const root = document.getElementById('root');
  root.innerHTML = '';

  const music = manifest.assets.filter(a => a.type === 'music');
  const ambience = manifest.assets.filter(a => a.type === 'ambience');
  const characters = [...new Set(music.map(a => a.subject))];
  const usedBackends = [...new Set(music.map(a => a.backend))];

  root.append(el('h2', {}, 'Subjects — same theme, every mood, A/B across backends'));
  for (const ch of characters) {
    const table = el('table', {});
    table.append(el('tr', {}, el('th', {}, 'mood'),
      ...usedBackends.map(b => el('th', {}, b)), el('th', {}, 'midi')));
    for (const mood of moods) {
      const row = el('tr', {}, el('td', {}, mood));
      for (const b of usedBackends) {
        const asset = music.find(a => a.subject === ch && a.mood === mood && a.backend === b);
        row.append(el('td', {}, player(asset)));
      }
      const anyAsset = music.find(a => a.subject === ch && a.mood === mood);
      row.append(el('td', {}, anyAsset ? el('a', { href: fileUrl(anyAsset.mid), download: ch + '-' + mood + '.mid' }, '.mid') : '—'));
      table.append(row);
    }
    const regenAll = async (status) => {
      let i = 0;
      for (const mood of moods) for (const b of usedBackends) {
        status.textContent = 'rendering ' + (++i) + '/' + moods.length * usedBackends.length + ' (' + mood + '/' + b + ')…';
        const res = await fetch('/api/regenerate', { method: 'POST',
          body: JSON.stringify({ type: 'music', id: ch, mood, backend: b }) });
        if (!res.ok) throw new Error((await res.json()).error);
      }
    };
    root.append(el('div', { class: 'entity' },
      el('div', {}, el('h3', {}, ch), table),
      el('div', {}, el('div', { class: 'meta' }, 'parameters (edit & regenerate)'), paramsPanel('character', ch, regenAll))));
  }

  root.append(el('h2', {}, 'Locations — ambience'));
  for (const a of ambience) {
    const regenAll = async () => {
      const res = await fetch('/api/regenerate', { method: 'POST', body: JSON.stringify({ type: 'ambience', id: a.location }) });
      if (!res.ok) throw new Error((await res.json()).error);
    };
    root.append(el('div', { class: 'entity' },
      el('div', {}, el('h3', {}, a.location), player(a)),
      el('div', {}, el('div', { class: 'meta' }, 'parameters (edit & regenerate)'), paramsPanel('location', a.location, regenAll))));
  }
}

load();
</script>
</body>
</html>`;
