// Playing without the installer: the player drops their own copy of The Curse of Monkey Island on the page (both CD
// images, the game folder, or its files), the installer's Python reads it in a worker (worker.js, Pyodide), and the
// pieces the game uses (interface, fonts, Guybrush, the chapter's extras) are kept in this browser's Cache Storage,
// served under their usual paths by ../../sw.js. Nothing leaves the computer.
import { packFile, readPack, keepPack, CACHE as VOICE_CACHE, MANIFEST as VOICE_MANIFEST } from './voicepack.js';
import { zipEntries, zipRead, makeZip } from './zip.js';
import { keepHd, hdFiles, hdSupport, hdInfo } from './hdpack.js';

const CACHE = 'ltp-byog-1';
const ROOT = new URL('../../', import.meta.url);
const MANIFEST = 'byog/manifest.json';
// the chapter's own files its extras read (Guybrush's poses, the feather tickle, which CMI clips it reuses)
const INPUTS = ['game/actors/guybrush_extras/extras.json', 'game/actors/guybrush_extras/pose_overlay.png',
  'game/items/feather.png', 'game/voice.json'];
const PORTRAIT = 'game/art/portrait_reveal.jpg';      // shipped: else the extras paint it from the player's Guybrush
const PORTRAIT_INPUTS = ['game/art/portrait_frame.jpg', 'game/art/portrait_frame.json'];
const TYPES = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', json: 'application/json', wav: 'audio/wav', txt: 'text/plain' };
const IMAGE_EXT = /\.(iso|bin|img|mdf|toast|cdr)$/i;

const url = p => new URL(p, ROOT).href;

// the files a drop may contain that the extraction reads, or Guybrush's voice pack (the rest is not even opened)
export function wanted(path) {
  const name = path.split('/').pop().toUpperCase();
  return name.startsWith('COMI.LA') || /\.(BUN|NUT|TAB)$/.test(name) || IMAGE_EXT.test(name) || packFile(path);
}

// ------------------------------------------------------------------ the service worker
export async function serviceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
  try {
    await navigator.serviceWorker.register(url('sw.js'));
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      // the first visit (the worker claims the page when it activates), or a reload that bypassed it (Shift+reload):
      // ask the running worker to claim this page
      await new Promise(res => {
        navigator.serviceWorker.addEventListener('controllerchange', res, { once: true });
        reg.active?.postMessage('claim');
        setTimeout(res, 3000);
      });
    }
    return !!navigator.serviceWorker.controller;
  } catch (err) {
    console.warn('service worker:', err);
    return false;
  }
}

// tells the service worker that the kept set changed; resolves once it has read the new one
function changed() {
  const sw = navigator.serviceWorker?.controller;
  if (!sw) return Promise.resolve();
  return new Promise(res => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => res();
    sw.postMessage('byog-changed', [ch.port2]);
    setTimeout(res, 2000);
  });
}

async function manifest() {
  try {
    const r = await (await caches.open(CACHE)).match(url(MANIFEST));
    return r ? await r.json() : null;
  } catch (err) { return null; }
}

// the chapter's inputs as {path: ArrayBuffer} (null without License to Pillage's game/ here)
async function chapterInputs() {
  const out = {};
  for (const p of INPUTS) {
    const r = await fetch(url(p), { cache: 'no-cache' }).catch(() => null);
    if (r && r.ok) out[p] = await r.arrayBuffer();
  }
  if (!Object.keys(out).length) return null;
  const portrait = await fetch(url(PORTRAIT), { method: 'HEAD', cache: 'no-cache' }).catch(() => null);
  if (portrait && portrait.ok) out[PORTRAIT] = new ArrayBuffer(0);       // only that it is there
  else {
    for (const p of PORTRAIT_INPUTS) {
      const r = await fetch(url(p), { cache: 'no-cache' }).catch(() => null);
      if (r && r.ok) out[p] = await r.arrayBuffer();
    }
  }
  return out;
}

async function digest(inputs) {
  if (!inputs) return null;
  const enc = new TextEncoder();
  const parts = [];
  for (const k of Object.keys(inputs).sort()) parts.push(enc.encode(k + '\0'), new Uint8Array(inputs[k]));
  const h = await crypto.subtle.digest('SHA-256', await new Blob(parts).arrayBuffer());
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Does this game need the player's CMI, and is it here? {need, stale}: need = the hero's costume can't be loaded
// (neither the game's own nor CMI's Guybrush); stale = what this browser kept was made for another version of the
// chapter (new poses...): worth dropping the game once more.
export async function status(game, base) {
  const hero = game.actors?.[game.player];
  if (!hero) return { need: false };
  const paths = [];
  if (hero.costume) paths.push(/^(cmi|engine)\//.test(hero.costume) ? hero.costume : `${base}/${hero.costume}`);
  if (!paths.includes('cmi/actors/guybrush')) paths.push('cmi/actors/guybrush');
  let found = null;
  for (const p of paths) {
    const r = await fetch(url(p + '/actor.json'), { method: 'HEAD', cache: 'no-cache' }).catch(() => null);
    if (r && r.ok) { found = p; break; }
  }
  if (!found) return { need: true };
  const kept = await manifest();
  if (!kept || !kept.files?.[found + '/actor.json'] || !kept.inputs) return { need: false };
  // served from what this browser kept (no installed copy): made from this version of the chapter?
  const probe = await fetch(url('cmi/fonts/font1.json'), { method: 'HEAD', cache: 'no-store' }).catch(() => null);
  if (probe && probe.ok && probe.headers.get('X-LTP-Kept') !== '1') return { need: false };
  const now = await digest(await chapterInputs());
  return { need: now !== null && now !== kept.inputs, stale: true, kept: true };
}

// ------------------------------------------------------------------ the extraction
async function extract(files, inputs, progress) {
  let hd = null;
  if (await hdInfo()) {
    const sup = await hdSupport();
    if (sup.ok) hd = await hdFiles();
    else progress(`The HD pack is kept, but ${sup.why}: making the plain pieces.`, null);
  }
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') return progress(m.msg, m.pct);
      w.terminate();
      if (m.type === 'done') resolve(m);
      else reject(Object.assign(new Error(m.msg), { details: m.details }));
    };
    w.onerror = e => { w.terminate(); reject(Object.assign(new Error('The reader could not start in this browser.'), { details: e.message || '' })); };
    w.postMessage({ files, inputs: inputs || {}, hd, test: window.__byogTest }, Object.values(inputs || {}));
  });
}

async function keep(files, result, inputsHash) {
  const cache = await caches.open(CACHE);
  await cache.delete(url(MANIFEST));        // nothing is served from a half-written set
  const map = {};
  const queue = files.filter(f => f.data);
  const bytes = queue.reduce((n, f) => n + f.data.byteLength, 0);
  for (let i = 0; i < queue.length; i += 32) {
    await Promise.all(queue.slice(i, i + 32).map(f => {
      map[f.path] = f.path;
      const type = TYPES[f.path.split('.').pop().toLowerCase()] || 'application/octet-stream';
      return cache.put(url(f.path), new Response(f.data, { headers: { 'Content-Type': type, 'X-LTP-Kept': '1' } }));
    }));
  }
  for (const f of files) if (f.link && map[f.link]) map[f.path] = map[f.link];
  // entries of an earlier extraction that this one didn't make
  const want = new Set(Object.values(map).map(url));
  for (const req of await cache.keys()) if (!want.has(req.url)) await cache.delete(req);
  await cache.put(url(MANIFEST), new Response(JSON.stringify({
    format: 1, files: map, inputs: inputsHash, game: result, bytes,     // (no timestamp: every player's set is the same)
  }), { headers: { 'Content-Type': 'application/json' } }));
  await changed();
  try { await navigator.storage?.persist?.(); } catch (err) { /* the browser decides */ }
  return Object.keys(map).length;
}

// ------------------------------------------------------------------ the pieces as one file
// Everything this browser kept for the game (the pieces made from the player's CMI, + Guybrush's voice pack if added)
// as one zip: dropped later (another browser, another address, after clearing the site's data) it is restored at once,
// no CD images needed. The paths are the usual ones (unzipped into an installed folder they also fit).
const PIECES_TAG = 'ltp-pieces.json';
export const PIECES_NAME = 'License-to-Pillage-pieces.zip';

async function keptSets() {
  const sets = [];
  for (const [cache, key] of [[CACHE, MANIFEST], [VOICE_CACHE, VOICE_MANIFEST]]) {
    try {
      const r = await (await caches.open(cache)).match(url(key));
      if (r) sets.push({ cache, key, m: await r.json() });
    } catch (err) { /* nothing kept */ }
  }
  return sets;
}

// {bytes, voice} of what a pieces file would hold, or null when nothing is kept
export async function piecesInfo() {
  const sets = await keptSets();
  if (!sets.some(x => x.cache === CACHE)) return null;
  return { bytes: sets.reduce((n, x) => n + (x.m.bytes || 0), 0), voice: sets.some(x => x.cache === VOICE_CACHE) };
}

export async function savePieces() {
  const enc = new TextEncoder();
  const files = [];
  for (const { cache, key, m } of await keptSets()) {
    const c = await caches.open(cache);
    for (const p of new Set(Object.values(m.files))) {
      const r = await c.match(url(p));
      if (r) files.push({ path: p, data: new Uint8Array(await r.arrayBuffer()) });
    }
    files.push({ path: key, data: enc.encode(JSON.stringify(m)) });
  }
  if (!files.length) throw new Error('This browser has not kept any pieces yet.');
  files.push({ path: PIECES_TAG, data: enc.encode(JSON.stringify({ format: 1, game: 'License to Pillage' })) });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(makeZip(files));
  a.download = PIECES_NAME;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// a pieces file -> back into this browser's storage; {cmi, voice} counts, or null when the zip is not one
export async function restorePieces(file, progress = () => {}) {
  const entries = await zipEntries(file);
  const by = new Map(entries.map(e => [e.name, e]));
  if (!by.has(PIECES_TAG)) return null;
  const ours = p => typeof p === 'string' && /^(cmi|game)\//.test(p) && !p.split('/').includes('..');
  const out = { cmi: 0, voice: 0 };
  for (const [cache, key, kind] of [[CACHE, MANIFEST, 'cmi'], [VOICE_CACHE, VOICE_MANIFEST, 'voice']]) {
    if (!by.has(key)) continue;
    const m = JSON.parse(await (await zipRead(file, by.get(key))).text());
    m.files = Object.fromEntries(Object.entries(m.files || {}).filter(([k, v]) => ours(k) && ours(v) && by.has(v)));
    const c = await caches.open(cache);
    await c.delete(url(key));
    const stored = [...new Set(Object.values(m.files))];
    for (let i = 0; i < stored.length; i += 32) {
      progress(kind, i, stored.length);
      await Promise.all(stored.slice(i, i + 32).map(async p => {
        const type = TYPES[p.split('.').pop().toLowerCase()] || (p.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream');
        await c.put(url(p), new Response(await zipRead(file, by.get(p)), { headers: { 'Content-Type': type, 'X-LTP-Kept': kind === 'voice' ? 'voice' : '1' } }));
      }));
    }
    const want = new Set(stored.map(url));
    for (const req of await c.keys()) if (!want.has(req.url)) await c.delete(req);
    await c.put(url(key), new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/json' } }));
    out[kind] = stored.length;
  }
  await changed();
  return out;
}

// forget what this browser kept (the drop screen's "forget" link; F5 menu could offer it too)
export async function forget() {
  await caches.delete(CACHE);
  await changed();
}

// ------------------------------------------------------------------ the drop screen
async function fromEntry(entry, prefix, out) {
  if (entry.isFile) {
    const path = prefix + entry.name;
    if (wanted(path)) out.push({ path, file: await new Promise((res, rej) => entry.file(res, rej)) });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await fromEntry(e, prefix + entry.name + '/', out);
    }
  }
}

function fromList(list) {
  return [...list].map(f => ({ path: f.webkitRelativePath || f.name, file: f })).filter(f => wanted(f.path));
}

// the files of a drop event ([{path, file}]); the entries have to be taken during the event, the folders read after
function fromDrop(e) {
  const entries = [...(e.dataTransfer?.items || [])].filter(it => it.kind === 'file').map(it => it.webkitGetAsEntry?.() || it.getAsFile());
  return (async () => {
    const files = [];
    for (const en of entries) {
      if (!en) continue;
      if (en instanceof File) { if (wanted(en.name)) files.push({ path: en.name, file: en }); } else await fromEntry(en, '', files);
    }
    return files;
  })();
}

// Guybrush's voice pack among dropped files: kept, the service worker told; resolves with the number of lines, or null
async function addVoice(files) {
  const pack = await readPack(files.filter(f => packFile(f.path)));
  if (!pack) return null;
  const n = await keepPack(pack);
  await changed();
  return n;
}

const CSS = `
#byog { position: fixed; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at 50% 40%, #1c1408 0%, #000 75%); color: #f3dfa6; cursor: default;
  font: 16px/1.5 Georgia, serif; }
#byog .box { width: min(640px, 88vw); padding: 28px 34px; border: 2px dashed rgba(255, 211, 83, .35); border-radius: 14px;
  text-align: center; transition: border-color .15s, background .15s; }
#byog.over .box { border-color: #ffd353; background: rgba(255, 211, 83, .07); }
#byog h1 { margin: 0 0 4px; color: #ffd353; font-size: 30px; font-weight: normal; letter-spacing: .06em; }
#byog .sub { margin: 0 0 18px; color: #b9a46c; font-style: italic; }
#byog p { margin: 10px 0; }
#byog .drop { margin: 18px 0 8px; font-size: 19px; color: #ffe9a8; }
#byog button { margin: 6px; padding: 8px 16px; font: 15px Georgia, serif; color: #1a1206; background: #ffd353;
  border: 0; border-radius: 6px; cursor: pointer; }
#byog button:hover { background: #ffe08a; }
#byog button.quiet { background: none; color: #b9a46c; text-decoration: underline; padding: 4px 8px; }
#byog .small { font-size: 13px; color: #a8976a; }
#byog details { margin-top: 14px; text-align: left; font-size: 14px; color: #cbb98a; }
#byog summary { cursor: pointer; text-align: center; color: #e2c774; }
#byog li { margin: 6px 0; }
#byog .bar { height: 10px; margin: 18px 0 6px; border-radius: 5px; background: rgba(255, 211, 83, .15); overflow: hidden; }
#byog .bar div { height: 100%; width: 0; background: #ffd353; transition: width .3s; }
#byog .err { color: #ff9b7a; }
#byog pre { max-height: 140px; overflow: auto; text-align: left; font-size: 11px; color: #a8976a; white-space: pre-wrap; }
#byog [hidden] { display: none; }
`;

// The screen; resolves when the game data is there ('done') or the player goes on without it ('skipped').
export function dropScreen(game, { stale = false, chapter = true, hd = false } = {}) {
  const canKeep = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller && 'caches' in window;
  const title = typeof game.name === 'string' ? game.name : 'License to Pillage';
  const boot = document.getElementById('boot');
  if (boot) boot.hidden = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  const el = document.createElement('div');
  el.id = 'byog';
  el.innerHTML = `<div class="box">
    <h1></h1><div class="sub">a new chapter of The Curse of Monkey Island</div>
    <div class="ask">
      <p class="why"></p>
      <p class="drop">Drop your game here: both CD images (.iso or .bin), or the game's folder.</p>
      <div><button class="files">Choose CD images or game files…</button><button class="folder">Choose the game folder…</button></div>
      <p class="small">Nothing is uploaded: your browser reads the game on this computer and keeps the few pieces it
        needs (about 9 MB) for next time. Your game files are not changed.</p>
      <p class="small">Saved a pieces file on an earlier visit? Drop that instead: no CDs needed.
        Have Guybrush's voice pack or the HD pack? Drop their zips here too, now or later onto the game.</p>
      <details><summary>Where is my game?</summary><ul>
        <li><b>Steam:</b> in your library, right-click The Curse of Monkey Island → Manage → Browse local files, and drag
          that folder onto this page.</li>
        <li><b>GOG:</b> the folder you installed it to (on Windows usually C:\\GOG Games\\The Curse of Monkey Island).</li>
        <li><b>CDs:</b> images of both discs at once (.iso, or .bin from a raw copy), or everything from both discs copied
          into one folder.</li>
        <li><b>Installed it with the installer?</b> Then this page should not ask: start it with the launcher, or
          <code>python3 setup.py web</code>.</li>
      </ul></details>
    </div>
    <div class="work" hidden><div class="bar"><div></div></div><p class="status"></p></div>
    <p class="err" hidden></p><pre hidden></pre>
    <div class="foot"><button class="quiet skip"></button></div>
    <input type="file" id="byog-files" multiple hidden>
    <input type="file" id="byog-folder" webkitdirectory hidden>
  </div>`;
  document.head.append(style);
  document.body.append(el);
  const $ = s => el.querySelector(s);
  $('h1').textContent = title;
  $('.sub').hidden = !chapter;
  $('.why').textContent = hd
    ? 'The HD pack is kept. Drop your game once more (the CD images or the game folder) to make the HD pieces: a few minutes with your graphics card.'
    : stale
      ? 'This version of the chapter has something new for Guybrush, made from your game: drop it once more to add it.'
      : 'This game uses pieces of your own copy of The Curse of Monkey Island: Guybrush, the verb coin, the fonts.';
  if (hd) $('.skip').textContent = 'Not now';
  $('.skip').textContent = stale ? 'Continue with what you have' : 'Continue without it (Guybrush will be missing)';
  if (!canKeep) {
    $('.drop').textContent = 'This browser window cannot keep files for the game (a private window, or service workers ' +
      'are turned off), so reading your game here would not last. Use a normal window, or the installer (python3 setup.py install).';
    $('.files').hidden = $('.folder').hidden = true;
  }

  return new Promise(resolve => {
    let busy = false;
    const close = how => { el.remove(); style.remove(); if (boot) boot.hidden = false; resolve(how); };
    const fail = (msg, details) => {
      busy = false;
      $('.work').hidden = true;
      $('.ask').hidden = false;
      $('.err').hidden = false;
      $('.err').textContent = msg;
      $('pre').hidden = !details;
      $('pre').textContent = details || '';
    };
    const go = async all => {
      if (busy || !canKeep) return;
      // a pieces file saved earlier: restored as it is, the game is not read again
      for (const z of all.filter(f => /\.zip$/i.test(f.path))) {
        busy = true;
        $('.ask').hidden = $('.err').hidden = $('pre').hidden = true;
        $('.work').hidden = false;
        let r = null;
        try {
          r = await restorePieces(z.file, (kind, i, n) => {
            $('.status').textContent = kind === 'voice' ? "Guybrush's voice…" : 'Putting your pieces back…';
            $('.bar div').style.width = Math.round(100 * i / Math.max(n, 1)) + '%';
          });
        } catch (err) {
          return fail('That pieces file could not be read: ' + err.message);
        }
        busy = false;
        if (r && r.cmi) {
          $('.status').textContent = 'Done. Starting the game…';
          setTimeout(() => close('done'), 400);
          return;
        }
        $('.work').hidden = true;
        $('.ask').hidden = false;
        if (r) all = all.filter(f => f !== z);         // only a voice pack in it: the game still has to come
      }
      // the HD pack: kept; the game read now (or next) comes out sharper
      if (all.some(f => /\.zip$/i.test(f.path))) {
        let kept = null;
        try { kept = await keepHd(all); } catch (err) { return fail('The HD pack could not be read: ' + err.message); }
        if (kept) {
          all = all.filter(f => f !== kept.file);
          const sup = await hdSupport();
          $('.why').textContent = sup.ok ? 'The HD pack is kept.' + (all.some(f => !packFile(f.path)) ? '' : ' Now drop your game (the CD images or the game folder) to make the HD pieces.')
            : `The HD pack is kept, but ${sup.why}.`;
          if (!all.length) { $('.err').hidden = $('pre').hidden = true; return; }
        }
      }
      let files = all.filter(f => !packFile(f.path));
      if (files.length < all.length) {        // Guybrush's voice pack, with the game or on its own
        try {
          const n = await addVoice(all);
          if (n) $('.why').textContent = `Guybrush's voice is added (${n} lines).` + (files.length ? '' : ' Now drop your game.');
          else if (!files.length) return fail('That zip is not a License to Pillage voice pack.');
        } catch (err) {
          return fail('The voice pack could not be read: ' + err.message);
        }
        if (!files.length) { $('.err').hidden = $('pre').hidden = true; return; }
      }
      if (!files.length) return fail('None of these is a Curse of Monkey Island file. Drop the CD images or the game folder.');
      busy = true;
      $('.ask').hidden = $('.err').hidden = $('pre').hidden = true;
      $('.work').hidden = false;
      const bar = $('.bar div');
      const say = (msg, pct) => { $('.status').textContent = msg; if (pct != null) bar.style.width = pct + '%'; };
      try {
        say('Getting ready…', 1);
        const inputs = await chapterInputs();
        const hash = await digest(inputs);
        const res = await extract(files, inputs, say);
        say('Keeping the files in your browser…', 97);
        await keep(res.files, res.result, hash);
        say('Done. Starting the game…', 100);
        setTimeout(() => close('done'), 400);
      } catch (err) {
        fail(err.message, err.details);
      }
    };
    $('.files').onclick = () => $('#byog-files').click();
    $('.folder').onclick = () => $('#byog-folder').click();
    $('#byog-files').onchange = e => go(fromList(e.target.files));
    $('#byog-folder').onchange = e => go(fromList(e.target.files));
    $('.skip').onclick = () => { if (!busy) close('skipped'); };
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', e => { if (e.target === el) el.classList.remove('over'); });
    el.addEventListener('drop', async e => {
      e.preventDefault();
      el.classList.remove('over');
      let files;
      try { files = await fromDrop(e); } catch (err) { return fail('Could not read what was dropped.', String(err)); }
      go(files);
    });
  });
}

// ------------------------------------------------------------------ while playing: drop Guybrush's voice pack on the game
// (or a pieces file)
export function gameDrop(engine) {
  const say = text => { engine.toast = { text, until: engine.time + 4 }; };
  window.addEventListener('dragover', e => { if (!document.getElementById('byog')) e.preventDefault(); });
  window.addEventListener('drop', async e => {
    if (document.getElementById('byog')) return;
    e.preventDefault();
    try {
      const files = await fromDrop(e);
      if (!(await serviceWorker())) return say('This browser window cannot keep files (a private window?).');
      for (const z of files.filter(f => /\.zip$/i.test(f.path))) {
        const r = await restorePieces(z.file);
        if (r) { say('Your pieces are back.'); setTimeout(() => location.reload(), 1200); return; }
      }
      if (await keepHd(files)) {
        const sup = await hdSupport();
        if (!sup.ok) return say(`The HD pack is kept, but ${sup.why}.`);
        if ((await dropScreen(engine.game, { hd: true, chapter: true })) === 'done') location.reload();
        return;
      }
      const n = await addVoice(files);
      if (!n) return say("Drop Guybrush's voice pack (License-to-Pillage-Guybrush-Voice….zip) to add his voice.");
      say(`Guybrush's voice is added (${n} lines).`);
      setTimeout(() => location.reload(), 1500);
    } catch (err) {
      say('The voice pack could not be read: ' + err.message);
    }
  });
}

// ------------------------------------------------------------------ small notes over the game
function note(text, buttons, { top = false, id = 'byog-note' } = {}) {
  const el = document.createElement('div');
  el.id = id;
  el.style.cssText = `position:fixed;left:50%;${top ? 'top' : 'bottom'}:14px;transform:translateX(-50%);z-index:9;padding:8px 14px;` +
    'border-radius:8px;background:rgba(20,14,6,.92);border:1px solid rgba(255,211,83,.5);color:#f3dfa6;font:14px Georgia,serif;' +
    'cursor:default;max-width:min(760px,92vw);text-align:center';
  const span = document.createElement('span');
  span.textContent = text;
  el.append(span);
  for (const [label, fn, quiet] of buttons) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = quiet ? 'margin-left:6px;background:none;border:0;color:#b9a46c;font:14px Georgia,serif;cursor:pointer;text-decoration:underline'
      : 'margin-left:8px;font:14px Georgia,serif;background:#ffd353;border:0;border-radius:5px;padding:4px 10px;cursor:pointer';
    b.onclick = e => { e.stopPropagation(); fn(el); };
    el.append(b);
  }
  for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) el.addEventListener(t, e => e.stopPropagation());
  document.body.append(el);
  return el;
}

// F5 menu: the pieces as one file, whenever this browser's storage supplies them
export function piecesMenu(engine) {
  (engine.menuExtras ||= []).push({
    label: t => t('Save your pieces as a file'),
    click: async e => {
      try { await savePieces(); if (e.menu) e.menu.msg = e.t(`Saved: ${PIECES_NAME}`); } catch (err) { if (e.menu) e.menu.msg = err.message; }
    },
  });
}

// On a later visit (the pieces came from this browser's storage): offer them as one file, until saved or declined
// (?pieces shows it again)
const OFFER = 'cmi-levels:byog-pieces-offer';
export async function saveOffer({ force = false } = {}) {
  if (!force && localStorage.getItem(OFFER)) return;
  const info = await piecesInfo();
  if (!info) return;
  const mb = Math.max(1, Math.round(info.bytes / 1e6));
  note(`Save what this browser made from your game as one file (${mb} MB${info.voice ? ", Guybrush's voice included" : ''}): ` +
    'next time, or in another browser, drop it instead of the CDs.', [
    ['Save file', async el => { try { await savePieces(); localStorage.setItem(OFFER, 'saved'); el.remove(); } catch (err) { el.querySelector('span').textContent = err.message; } }],
    ['Not now', el => el.remove(), true],
    ["Don't ask again", el => { localStorage.setItem(OFFER, 'no'); el.remove(); }, true],
  ], { top: true, id: 'byog-offer' });
}

// ------------------------------------------------------------------ the level editor without the player's game
// The editor opens anyway (CMI's pieces missing: the built-in interface, no Guybrush); a note offers to add the game.
export function editorNote(game, { stale = false, chapter = true } = {}) {
  const el = document.createElement('div');
  el.id = 'byog-note';
  el.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9;padding:8px 14px;border-radius:8px;' +
    'background:rgba(20,14,6,.92);border:1px solid rgba(255,211,83,.5);color:#f3dfa6;font:14px Georgia,serif;cursor:default';
  el.innerHTML = '<span></span> <button style="margin-left:8px;font:14px Georgia,serif;background:#ffd353;border:0;border-radius:5px;' +
    'padding:4px 10px;cursor:pointer">Add your game…</button> <button title="Hide" style="margin-left:4px;background:none;border:0;' +
    'color:#b9a46c;font-size:16px;cursor:pointer">×</button>';
  el.querySelector('span').textContent = stale ? 'Guybrush has new poses: they need your game once more.'
    : "Guybrush and CMI's interface aren't here yet (the editor works without them).";
  const [add, hide] = el.querySelectorAll('button');
  add.onclick = async () => {
    el.hidden = true;
    if (await serviceWorker() && (await dropScreen(game, { stale, chapter })) === 'done') location.reload();
    else el.hidden = false;
  };
  hide.onclick = () => el.remove();
  document.body.append(el);
  return el;
}
