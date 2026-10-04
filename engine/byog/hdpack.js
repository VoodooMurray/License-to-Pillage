// The optional HD pack (License-to-Pillage-HD-*.zip: the Real-ESRGAN model + onnxruntime-web's WebGPU build, nothing of
// the game) in the browser: dropped on the page it is kept in this browser's Cache Storage; the next reading of the
// player's game (worker.js) runs the model on the graphics card, so Guybrush, the coin and the fonts come out sharper.
// Needs WebGPU (a graphics card) and JavaScript Promise Integration (Python waits for the GPU): Chrome or Edge.
import { zipEntries, zipRead } from './zip.js';

const CACHE = 'ltp-hd-1';
const ROOT = new URL('../../', import.meta.url);
const TAG = 'ltp-hd.json';
const url = p => new URL('hd/' + p, ROOT).href;
const TYPES = { mjs: 'text/javascript', wasm: 'application/wasm', onnx: 'application/octet-stream', json: 'application/json' };

// an HD pack among dropped files: its zip entries by path, or null
async function packOf(file) {
  let entries;
  try { entries = await zipEntries(file); } catch (err) { return null; }
  const rel = n => n.replace(/^[^/]*-HD-[^/]*\//, '');
  const by = new Map(entries.map(e => [rel(e.name), e]));
  return by.has(TAG) ? by : null;
}

// keeps the first HD pack among the dropped zips; resolves with {meta, file} (the zip it was), or null when there is none
export async function keepHd(files, progress = () => {}) {
  for (const f of files.filter(x => /\.zip$/i.test(x.path))) {
    const by = await packOf(f.file);
    if (!by) continue;
    const meta = JSON.parse(await (await zipRead(f.file, by.get(TAG))).text());
    const need = [meta.model, meta.ort?.mjs, meta.ort?.loader, meta.ort?.wasm];
    if (need.some(p => !p || !by.has(p))) throw new Error('this HD pack is incomplete');
    const cache = await caches.open(CACHE);
    await cache.delete(url(TAG));
    for (const [i, p] of need.entries()) {
      progress(i, need.length);
      const type = TYPES[p.split('.').pop()] || 'application/octet-stream';
      await cache.put(url(p), new Response(await zipRead(f.file, by.get(p)), { headers: { 'Content-Type': type } }));
    }
    await cache.put(url(TAG), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    return { meta, file: f };
  }
  return null;
}

export async function hdInfo() {
  try {
    const r = await (await caches.open(CACHE)).match(url(TAG));
    return r ? await r.json() : null;
  } catch (err) { return null; }
}

// what the worker needs to run the model: {mjs, loader, wasm, model} as Blobs (or null without a kept pack)
export async function hdFiles() {
  const meta = await hdInfo();
  if (!meta) return null;
  const cache = await caches.open(CACHE);
  const get = async p => (await cache.match(url(p)))?.blob();
  const out = { mjs: await get(meta.ort.mjs), loader: await get(meta.ort.loader), wasm: await get(meta.ort.wasm), model: await get(meta.model) };
  return Object.values(out).every(Boolean) ? out : null;
}

// can this browser run it? {ok, why}
export async function hdSupport() {
  if (typeof WebAssembly.Suspending !== 'function') return { ok: false, why: 'this browser cannot wait for the graphics card from Python (use Chrome or Edge)' };
  if (!navigator.gpu) return { ok: false, why: 'this browser has no WebGPU (use Chrome or Edge)' };
  try {
    if (!(await navigator.gpu.requestAdapter())) return { ok: false, why: 'no graphics card is available to the browser' };
  } catch (err) { return { ok: false, why: 'no graphics card is available to the browser' }; }
  return { ok: true };
}

export async function forgetHd() {
  await caches.delete(CACHE);
}
