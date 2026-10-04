// Boot: load the game (game/game.js), init the engine, title screen, start.

import { Engine } from './engine.js';
import { installTestApi } from './testapi.js';
import * as byog from './byog/byog.js';

// ?game=<key>: a level-editor project in games/<key>/ (tools/projects.py); default: License to Pillage in game/
const project = new URLSearchParams(location.search).get('game');
const base = project && /^[a-z][a-z0-9_]{1,30}$/.test(project) ? `games/${project}` : 'game';
const game = (await import(`../${base}/game.js`)).default;

// the player's own CMI pieces (Guybrush, interface, fonts): an installed copy has them as files; without the installer,
// the player drops their game on the page once and this browser keeps them (engine/byog/, served by sw.js)
// (the level editor opens anyway: a note offers to add the game)
let byogMissing = null, byogKept = false, byogFresh = false;
if (!new URLSearchParams(location.search).has('nobyog')) {
  const check = () => byog.status(game, base).catch(err => { console.warn('byog:', err); return { need: false }; });
  let st = await check();       // an installed copy, or a game with its own hero: nothing to do, no service worker
  if (st.need && await byog.serviceWorker()) st = await check();     // what this browser kept, if anything
  if (st.need && new URLSearchParams(location.search).has('edit')) byogMissing = st;
  else if (st.need) byogKept = (await byog.dropScreen(game, { stale: st.stale, chapter: base === 'game' })) === 'done' || !!st.kept;
  else byogKept = !!st.kept;      // a later visit, the pieces from this browser's storage: offered as one file
  byogFresh = st.need;            // (just read now: the note waits for a later visit, the F5 entry is there at once)
}

const canvas = document.getElementById('c');
const engine = new Engine(canvas, game, base);
engine.project = base === 'game' ? null : project;
// ?edition=regular|extended answers the title's edition question (tests, links)
engine.edition = new URLSearchParams(location.search).get('edition');
window.__game = engine;
installTestApi(engine);

try {
  await engine.init();
} catch (err) {
  // never a silent "Loading…" forever: say what is missing
  const boot = document.getElementById('boot');
  if (boot) {
    boot.style.cssText += ';flex-direction:column;gap:12px;text-align:center;padding:0 10%';
    boot.textContent = '';
    for (const t of ['This game could not start.', String(err && err.message || err),
      'If it needs your own copy of The Curse of Monkey Island: reload the page and drop your game on it, or run the installer (python3 setup.py install).']) {
      const d = document.createElement('div'); d.textContent = t; boot.append(d);
    }
  }
  throw err;
}
document.getElementById('boot')?.remove();

const params = new URLSearchParams(location.search);
const g = engine.api;
engine.started = false;
// ?edit: the level editor (engine/editor/) on a room (default: the first), no title, no autosave
const edit = params.has('edit');
const startRoom = params.get('room') || (edit ? game.rooms[0].id : null);

async function begin() {
  engine.started = true;
  if (startRoom) {
    // dev shortcut: ?room=office&items=lime,menu&flags=a,b&x=300&y=400
    for (const it of (params.get('items') || '').split(',').filter(Boolean)) g.give(it);
    for (const f of (params.get('flags') || '').split(',').filter(Boolean)) g.set(f);
    if (engine.edition === 'extended') g.set('extended');
    const r = engine.rooms.get(startRoom);
    const ent = r?.def.entries?.[params.get('entry') || 'default'] || r?.def.start || [320, 400, 'S'];
    await engine.goRoom(startRoom, { x: +(params.get('x') || ent[0]), y: +(params.get('y') || ent[1]), dir: ent[2] });
  } else if (params.has('continue') && engine.load('auto')) {
    /* loaded */
  } else {
    await game.start(g);
  }
}

// from the title screen on: Guybrush's voice pack (or a pieces file) can be dropped on the game; a later visit whose
// pieces came from this browser's storage offers them as one file (not on developer links)
if (!edit && base === 'game') byog.gameDrop(engine);
if (!edit && byogKept) byog.piecesMenu(engine);          // F5: "Save your pieces as a file"
if (!edit && byogKept && (params.has('pieces') || (!byogFresh && !startRoom && !params.has('test')))) byog.saveOffer({ force: params.has('pieces') });

if (startRoom || params.has('skiptitle') || typeof game.title !== 'function') {
  begin();
} else {
  await game.title(g, begin);
}

if (edit) {
  const { installEditor } = await import('./editor/editor.js');
  installEditor(engine);
  if (byogMissing) byog.editorNote(game, { stale: byogMissing.stale, chapter: base === 'game' });
} else {
  // autosave when idle
  setInterval(() => { if (engine.interactive() && engine.room) engine.save('auto'); }, 15000);
}
