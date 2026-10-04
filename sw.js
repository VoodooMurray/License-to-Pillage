// Serves what this browser kept from the player's own files (engine/byog/: never uploaded) under the usual paths, so the
// engine loads it like an installed copy's files:
//   - the pieces made from their copy of The Curse of Monkey Island (cmi/..., game/actors/guybrush/...), only when the
//     server doesn't have them itself (an installed copy: setup.py install);
//   - Guybrush's voice pack (game/voice/...), whose lines are added to game/voice.json.
// Every other request goes to the server untouched.
const CACHE = 'ltp-byog-1';
const VOICE = 'ltp-voice-1';
const SCOPE = new URL(self.registration.scope).pathname;
let kept = null;        // Promise of {cmi, voice: {path: stored path}, entries: voice lines}; keptNow: the same once there
let keptNow = null;
let native = null;      // Promise: the server has the CMI pieces itself (probed once per start of this worker); nativeNow
let nativeNow = null;

function load() {
  const read = (cache, key) => caches.open(cache).then(c => c.match(SCOPE + key)).then(r => (r ? r.json() : null)).catch(() => null);
  return (kept = Promise.all([read(CACHE, 'byog/manifest.json'), read(VOICE, 'byog/voice.json')])
    .then(([m, v]) => (keptNow = { cmi: m?.files || {}, voice: v?.files || {}, entries: v?.entries || {} })));
}

function serverHasThem() {
  return (native ??= fetch(SCOPE + 'cmi/fonts/font1.json', { method: 'HEAD', cache: 'no-store' })
    .then(r => r.ok, () => false).then(ok => (nativeNow = ok)));
}

const voiced = k => Object.keys(k.entries).length > 0;
const answer = (req, res) => (req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res);

// game/voice.json from the server + the kept pack's lines (the server's own entries win)
async function voiceMap(req, k) {
  const r = await fetch(req);
  if (!r.ok || req.method === 'HEAD') return r;
  const map = await r.json();
  for (const [key, v] of Object.entries(k.entries)) if (!(key in map) && k.voice['game/' + v]) map[key] = v;
  return new Response(JSON.stringify(map), { headers: { 'Content-Type': 'application/json', 'X-LTP-Kept': 'voice' } });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(Promise.all([self.clients.claim(), load()])));
// the page made or forgot a set: read the manifests again, then answer (the page waits before loading the game)
self.addEventListener('message', e => {
  if (e.data === 'claim') return e.waitUntil(self.clients.claim());     // a page that was loaded past this worker
  if (e.data !== 'byog-changed') return;
  native = nativeNow = null;
  e.waitUntil(load().then(() => e.ports[0]?.postMessage('ok')));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' && req.method !== 'HEAD') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(SCOPE)) return;
  const rel = decodeURIComponent(url.pathname.slice(SCOPE.length));
  if (!/^(cmi\/|game\/)/.test(rel)) return;
  // not one of ours (the usual case): no detour
  if (keptNow && !keptNow.voice[rel] && !(rel === 'game/voice.json' && voiced(keptNow)) && (!keptNow.cmi[rel] || nativeNow)) return;
  e.respondWith((async () => {
    const k = await (kept || load());
    if (rel === 'game/voice.json' && voiced(k)) return voiceMap(req, k);
    if (k.voice[rel]) {
      const hit = await (await caches.open(VOICE)).match(SCOPE + k.voice[rel]);
      if (hit) return answer(req, hit);
    }
    if (k.cmi[rel] && !(await serverHasThem())) {
      const hit = await (await caches.open(CACHE)).match(SCOPE + k.cmi[rel]);
      if (hit) return answer(req, hit);
    }
    return fetch(req);
  })());
});
