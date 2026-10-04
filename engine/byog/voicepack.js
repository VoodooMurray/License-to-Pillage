// Guybrush's voice pack (License-to-Pillage-Guybrush-Voice-*.zip, a separate download) in the browser: dropped on the
// page, its voice files are kept in this browser's Cache Storage (served by ../../sw.js under game/voice/...) and its
// lines join game/voice.json. The zip is read in place: the mp3s are stored uncompressed, so each one is a byte range of
// the zip; only pack.json is inflated. The pack's decoded audio for ScummVM (scumm/audio_cache) is skipped.
import { zipEntries, zipRead } from './zip.js';

export const CACHE = 'ltp-voice-1';
export const MANIFEST = 'byog/voice.json';
const ROOT = new URL('../../', import.meta.url);
const VOICE_FILE = /^game\/voice\/[a-z0-9_]+\/[\w.-]+\.mp3$/i;

const url = p => new URL(p, ROOT).href;

// files a voice pack can bring: its zip, or an unpacked pack folder (pack.json + game/voice/...)
export const packFile = path => /\.zip$/i.test(path) || /(^|\/)pack\.json$/.test(path) || /(^|\/)game\/voice\/[^/]+\/[^/]+\.mp3$/i.test(path);

// A voice pack among dropped files ([{path, file}]): {meta (pack.json), files: {game path: () => Blob}}, or null
export async function readPack(files) {
  for (const f of files) {
    if (!/\.zip$/i.test(f.path)) continue;
    let entries;
    try { entries = await zipEntries(f.file); } catch (err) { continue; }
    const rel = n => n.replace(/^[^/]*Guybrush-Voice[^/]*\//, '');      // the zip's top folder
    const pj = entries.find(e => rel(e.name) === 'pack.json');
    if (!pj) continue;
    const meta = JSON.parse(await (await zipRead(f.file, pj)).text());
    const out = {};
    for (const e of entries) if (VOICE_FILE.test(rel(e.name))) out[rel(e.name)] = () => zipRead(f.file, e);
    return { meta, files: out };
  }
  const pj = files.find(f => /(^|\/)pack\.json$/.test(f.path));
  if (!pj) return null;
  const base = pj.path.slice(0, pj.path.length - 'pack.json'.length);
  const out = {};
  for (const f of files) {
    const r = f.path.startsWith(base) ? f.path.slice(base.length) : '';
    if (VOICE_FILE.test(r)) out[r] = async () => f.file;
  }
  return { meta: JSON.parse(await pj.file.text()), files: out };
}

// keeps a pack read by readPack (replacing an earlier one); resolves with the number of voiced lines
export async function keepPack(pack) {
  const entries = pack.meta?.entries || {};
  const want = [...new Set(Object.values(entries).map(v => 'game/' + v))].filter(p => pack.files[p]);
  if (!want.length) throw new Error('This voice pack has no voice files.');
  const cache = await caches.open(CACHE);
  await cache.delete(url(MANIFEST));        // nothing is served from a half-written pack
  const files = {};
  let bytes = 0;
  for (let i = 0; i < want.length; i += 16) {
    await Promise.all(want.slice(i, i + 16).map(async p => {
      const blob = await pack.files[p]();
      bytes += blob.size;
      await cache.put(url(p), new Response(blob, { headers: { 'Content-Type': 'audio/mpeg', 'X-LTP-Kept': 'voice' } }));
      files[p] = p;
    }));
  }
  const kept = Object.fromEntries(Object.entries(entries).filter(([, v]) => files['game/' + v]));
  const keepUrls = new Set(Object.keys(files).map(url));
  for (const req of await cache.keys()) if (!keepUrls.has(req.url)) await cache.delete(req);
  await cache.put(url(MANIFEST), new Response(JSON.stringify({ format: 1, name: pack.meta.name, version: pack.meta.version,
    speaker: pack.meta.speaker, entries: kept, files, bytes }), { headers: { 'Content-Type': 'application/json' } }));
  return Object.keys(kept).length;
}

export async function packInfo() {
  try {
    const r = await (await caches.open(CACHE)).match(url(MANIFEST));
    return r ? await r.json() : null;
  } catch (err) { return null; }
}
