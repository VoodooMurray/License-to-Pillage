// The level editor's browser backend (worker.js), used when there is no tools/serve.py (a static host): the same
// /api calls, answered by the editor's Python code running in this browser. Games are kept in this browser; Export /
// Import move them as a zip (games/<key>/...: drop the folder into games/ of a full copy to use it there).
import { serviceWorker } from '../../byog/byog.js';
import { makeZip, zipEntries, zipRead } from '../../byog/zip.js';

let worker = null, seq = 0;
const waiting = new Map();
let swReady = null;

function start() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => { const w = waiting.get(e.data.id); if (w) { waiting.delete(e.data.id); w(e.data); } };
  worker.onerror = e => { for (const w of waiting.values()) w({ status: 500, data: { error: `the browser editor stopped: ${e.message || 'error'}` } }); waiting.clear(); };
  return worker;
}

function ask(msg, transfer = []) {
  start();
  const id = ++seq;
  return new Promise(res => { waiting.set(id, res); worker.postMessage({ ...msg, id }, transfer); });
}

// sw.js serves what was kept: it reads the index again after every change (and before the first one is played)
async function swReload() {
  const sw = navigator.serviceWorker?.controller;
  if (!sw) return;
  await new Promise(res => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => res();
    sw.postMessage('byog-changed', [ch.port2]);
    setTimeout(res, 2000);
  });
}

export function ensureServiceWorker() {
  return (swReady ??= serviceWorker().catch(() => false));
}

export async function call(method, path, body) {
  await ensureServiceWorker();
  const r = await ask({ op: 'call', method, path: '/api' + path, body: body ? JSON.stringify(body) : '' });
  if (r.changed?.length) await swReload();
  return { status: r.status, data: r.data };
}

const download = (blob, name) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
};

// a game as <key>.zip (folder <key>/ inside); License to Pillage (key null): only the files changed in this browser
export async function exportGame(key) {
  const r = await ask({ op: 'export', key });
  if (!r.files) throw new Error(r.data?.error || 'export failed');
  if (!r.files.length) throw new Error('nothing to export yet (no changes in this browser)');
  const top = key || 'license-to-pillage-changes';
  download(makeZip(r.files.map(f => ({ path: `${top}/${f.path}`, data: f.data }))), `${top}.zip`);
  return r.files.length;
}

// a zip made by exportGame (or any zip with a game.js at its top or in one folder) -> games/<key>/; resolves to the key
export async function importGame(file, taken = []) {
  const entries = (await zipEntries(file)).filter(e => !e.name.endsWith('/'));
  const gj = entries.map(e => e.name).filter(n => /(^|\/)game\.js$/.test(n)).sort((a, b) => a.length - b.length)[0];
  if (!gj) throw new Error('this zip has no game.js (export a game from the editor first)');
  const prefix = gj.slice(0, -'game.js'.length);
  let key = (prefix.replace(/\/$/, '').split('/').pop() || file.name.replace(/\.zip$/i, '')).toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 28) || 'imported';
  if (key.length < 2) key = 'game_' + key;
  for (let i = 2, k = key; taken.includes(key); i++) key = `${k}_${i}`;
  const files = [];
  for (const e of entries) {
    if (!e.name.startsWith(prefix) || e.name.split('/').some(s => s === '..')) continue;
    files.push({ path: e.name.slice(prefix.length), data: await (await zipRead(file, e)).arrayBuffer() });
  }
  const r = await ask({ op: 'import', key, files }, files.map(f => f.data));
  if (r.changed?.length) await swReload();
  if (r.status !== 200) throw new Error(r.data?.error || 'import failed');
  return key;
}

// everything the editor kept in this browser, gone (the release's own files stay)
export async function forgetAll() {
  await ask({ op: 'forget' });
  await swReload();
}
