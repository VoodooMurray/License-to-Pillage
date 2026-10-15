// The level editor (EDITOR_PLAN.md), loaded by main.js with ?edit: edits the running room's
// definition in place, so the web engine previews every change at once, and saves the changes back
// into game/rooms/<id>.js through tools/serve.py (only the changed values are rewritten; the ScummVM
// version picks them up with tools/scumm/build.py). Tab switches between editing and playing.

import { W, H } from '../engine.js';
import { clamp } from '../util.js';
import { bumpSteps } from '../steps.js';
import { setPath, clone } from './paths.js';
import { RoomDoc, KEY } from './model.js';
import { api, setProject, getProject, editorMode, local } from './api.js';
import { arrivals, movedValue, writable, befores } from './arrivals.js';
import { ProjectTools } from './project.js';
import { Scripts } from './scripts.js';
import { AI } from './ai.js';
import { Build } from './build.js';
import { PuzzleChart } from './puzzle.js';
import { HitMap } from './hitmap.js';
import { lint } from './lint.js';
import { ScaleRuler } from './scale.js';
import { Tools } from './tools.js';
import { Panel } from './panel.js';
import { drawOverlay } from './overlay.js';
import { NUMPAD } from './geom.js';

const TOP = 46, BOTTOM = 28, SIDE = 380;

// an element that takes typing (text boxes, number fields, menus, checkboxes, contenteditable)
export const isField = el => !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

export function installEditor(engine) {
  setProject(engine.project);
  const ed = new Editor(engine);
  engine.editor = ed;
  window.__editor = ed;
  return ed;
}

class Editor {
  constructor(e) {
    this.e = e;
    this.active = true;
    this.tool = 'select';
    this.sel = null;
    this.vsel = null;             // selected vertex / scale point
    this.hover = null;
    this.show = { hotspots: true, walk: true, labels: true, hitmap: false, walkTo: true, arrivals: true };
    this.probe = false;
    this.sound = false;
    this.camX = e.camX;
    this.docs = new Map();
    this.doc = null;
    this.notices = [];
    this.problems = [];
    this.mouse = null;
    this.snapHit = null;
    this.pathTest = null;
    this.editView = { zoom: 1, panX: 0, panY: 0 };
    this.hitmap = new HitMap(this);
    this.ruler = new ScaleRuler(this);
    this.project = new ProjectTools(this);
    this.scripts = new Scripts(this);
    this.ai = new AI(this);
    this.build = new Build(this);
    this.puzzles = new PuzzleChart(this);
    this.areaPick = null;          // {resolve, a: [x, y], b: [x, y]} while an area is being dragged out
    this.gameOpening = null;       // where the game starts ({room, x, y, dir}: the g.goto in game.js's start)
    this.arrivalCache = null;
    api.opening().then(r => { this.gameOpening = r.data?.opening || null; this.arrivalCache = null; if (this.panel) this.hitmapChanged(); this.panel?.refresh(['arrivals']); });
    this.buildDom();
    editorMode().then(m => this.browserMode(m === 'browser'));
    this.project.load().then(() => { this.renderGames(); if (getProject()) { this.project.loadLibrary(); this.project.loadStyle(); this.project.loadTheme(); } });
    this.tools = new Tools(this, this.layer);
    this.panel = new Panel(this, this.side);
    e.onKey = ev => this.key(ev);
    window.addEventListener('keyup', ev => { if (ev.key === ' ') { this.tools.space = false; } });
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('focus', () => { if (!this.pollHold) this.doc?.poll(); });
    window.addEventListener('beforeunload', ev => {
      if ([...this.docs.values()].some(d => d.dirty().length)) { ev.preventDefault(); ev.returnValue = ''; }
    });
    this.pollHold = 0;
    setInterval(() => { if (document.visibilityState === 'visible' && !this.pollHold) this.doc?.poll(); }, 2000);
    this.layout();
    this.setMode('edit');
  }

  get room() { return this.e.room; }

  // ------------------------------------------------------------ DOM
  buildDom() {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('./editor.css', import.meta.url).href;
    document.head.append(css);
    const root = document.createElement('div');
    root.id = 'ed';
    const rooms = this.e.game.rooms.map(r => `<option value="${r.id}">${r.id}</option>`).join('');
    // game.title is the title-screen script; the name is the page title's first part
    const title = typeof this.e.game.title === 'string' ? this.e.game.title : document.title.split(/\s+[—-]\s+/)[0];
    root.innerHTML = `
      <header id="ed-top">
        <div class="ed-brand">${title}<b>Level Editor</b></div>
        <label class="ed-roomsel">Game <select id="ed-game"><option>${title}</option></select></label>
        <label class="ed-roomsel">Room <select id="ed-room">${rooms}<option value="+" ${getProject() ? '' : 'disabled title="License to Pillage is the reference project"'}>+ New room…</option></select></label>
        <div class="ed-seg" id="ed-mode"><button data-mode="edit" title="Tab">Edit</button><button data-mode="play" title="Tab">Play</button></div>
        <div class="ed-seg" id="ed-tools">
          <button data-tool="select" title="Hotspots (V)">Hotspots</button><button data-tool="walk" title="Walk area (W)">Walk area</button><button data-tool="scale" title="Scale (S)">Scale</button>
        </div>
        <div class="ed-seg ed-toggles">
          <button data-toggle="hitmap" title="Effective hit map, as the engine resolves clicks (H)">Hit map</button><button data-toggle="labels" title="Labels (L)">Labels</button><button data-toggle="arrivals" title="Arrival points: where Guybrush comes in (A)">Arrivals</button><button data-toggle="probe" title="Guybrush follows the mouse (G)">Probe</button><button data-toggle="sound" title="Game sound while editing (Play mode always has sound)">Sound</button>
        </div>
        <div class="ed-spacer"></div>
        <button id="ed-puzzles" title="Puzzle chart: what can be done in which order, and what can't (P)">Puzzles</button>
        <button id="ed-build" title="Build the ScummVM version (tools/scumm/build.py) — then play it there or export a standalone web folder">Build</button>
        <button id="ed-playgame" title="Play the whole game from its start, in a new tab">▶ Play game</button>
        <button id="ed-comfy" title="ComfyUI (generating pictures): address, connection">⚙</button>
        <button id="ed-save" class="ed-primary" title="Save (⌘S)">Save</button>
      </header>
      <div id="ed-layer"></div>
      <aside id="ed-side"></aside>
      <footer id="ed-status"><span id="ed-pos"></span><span id="ed-hov"></span><span class="ed-spacer"></span><span id="ed-msg"></span></footer>`;
    document.body.append(root);
    this.layer = root.querySelector('#ed-layer');
    this.side = root.querySelector('#ed-side');
    this.roomSelect = root.querySelector('#ed-room');
    this.saveButton = root.querySelector('#ed-save');
    root.querySelector('#ed-top').addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.mode) this.setMode(b.dataset.mode);
      else if (b.dataset.tool) this.setTool(b.dataset.tool);
      else if (b.dataset.toggle) this.toggle(b.dataset.toggle);
      else if (b.id === 'ed-save') this.save();
      else if (b.id === 'ed-playgame') window.open(getProject() ? `?game=${getProject()}` : '?', '_blank');
      else if (b.id === 'ed-comfy') this.ai.settings();
      else if (b.id === 'ed-build') this.build.open();
      else if (b.id === 'ed-puzzles') this.puzzles.open();
      b.blur();
    });
    this.roomSelect.addEventListener('change', () => {
      const v = this.roomSelect.value;
      this.roomSelect.blur();
      if (v === '+') { this.roomSelect.value = this.e.room?.id; this.project.newRoom(); return; }
      this.switchRoom(v);
    });
    this.gameSelect = root.querySelector('#ed-game');
    this.gameSelect.addEventListener('change', () => {
      const v = this.gameSelect.value;
      this.gameSelect.blur();
      this.gameSelect.value = getProject() || '';
      if (v === '+') this.project.newGame();
      else if (v === '>export') this.exportGame();
      else if (v === '<import') this.importGame();
      else if (v === '!forget') this.forgetBrowser();
      else if (v !== (getProject() || '')) this.project.go(v || null);
    });
  }

  renderGames() {
    const cur = getProject() || '';
    this.gameSelect.innerHTML = this.project.projects.map(p => `<option value="${p.key || ''}">${(p.title || p.dir).replace(/</g, '&lt;')}${p.reference ? ' (reference)' : ''}</option>`).join('')
      + '<option value="+">+ New game…</option>'
      + (this.browser ? '<option value=">export">⇩ Export this game (zip)…</option><option value="<import">⇧ Import a game (zip)…</option>'
        + '<option value="!forget">Forget what this browser kept…</option>' : '');
    this.gameSelect.value = cur;
  }

  // ------------------------------------------------------------ no tools/serve.py (a static host): the browser backend
  browserMode(on) {
    this.browser = on;
    if (!on) return;
    const off = (id, why) => { const b = document.getElementById(id); if (b) { b.disabled = true; b.title = why; } };
    off('ed-build', 'The ScummVM build needs the desktop editor (python3 setup.py editor)');
    off('ed-comfy', '✨ AI pictures need the desktop editor (python3 setup.py editor) and a ComfyUI server');
    document.getElementById('ed').classList.add('ed-browser');
    this.renderGames();
    if (!sessionStorage.getItem('ltp-editor-browser-note')) {
      sessionStorage.setItem('ltp-editor-browser-note', '1');
      this.notice('Browser editor: everything you make is saved in this browser. Game → Export keeps a copy as a zip '
        + '(Import brings it back, here or in another browser). Building for ScummVM and ✨ AI pictures need the desktop editor.', 'info');
    }
  }

  async exportGame() {
    try {
      const n = await (await local()).exportGame(getProject());
      this.notice(`Exported ${n} files${getProject() ? '' : ' (the changes made in this browser)'}.`, 'info');
    } catch (err) { this.notice(`Export: ${err.message}`, 'error'); }
  }

  importGame() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.zip,application/zip';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        this.notice('Importing…', 'info');
        const key = await (await local()).importGame(f, this.project.projects.map(p => p.key).filter(Boolean));
        this.project.go(key);
      } catch (err) { this.notice(`Import: ${err.message}`, 'error'); }
    };
    inp.click();
  }

  async forgetBrowser() {
    if (!confirm('Forget every game and change this browser kept? (Export what you want to keep first.)')) return;
    await (await local()).forgetAll();
    this.project.go(null);
  }

  layout() {
    const w = window.innerWidth, h = window.innerHeight;
    const v = this.e.viewport || { ...this.editView };
    this.e.viewport = { ...v, x: 0, y: TOP, w: Math.max(200, w - SIDE), h: Math.max(150, h - TOP - BOTTOM) };
    Object.assign(this.layer.style, { left: '0px', top: TOP + 'px', width: this.e.viewport.w + 'px', height: this.e.viewport.h + 'px' });
    this.e.resize();
  }

  updateToolbar() {
    const top = document.getElementById('ed-top');
    for (const b of top.querySelectorAll('[data-mode]')) b.classList.toggle('on', (b.dataset.mode === 'edit') === this.active);
    for (const b of top.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === this.tool);
    const on = { hitmap: this.show.hitmap, labels: this.show.labels, arrivals: this.show.arrivals, probe: this.probe, sound: this.sound };
    for (const b of top.querySelectorAll('[data-toggle]')) b.classList.toggle('on', !!on[b.dataset.toggle]);
    top.querySelector('#ed-tools').classList.toggle('ed-off', !this.active);
    const n = [...this.docs.values()].reduce((s, d) => s + d.dirty().length, 0);
    this.saveButton.textContent = n ? `Save · ${n}` : 'Saved';
    this.saveButton.disabled = !n;
    document.getElementById('ed').classList.toggle('ed-playing', !this.active);
  }

  // ------------------------------------------------------------ per frame (engine.render)
  draw(c) {
    this.tick();
    if (this.active) drawOverlay(this, c);
    const ap = this.areaPick;
    if (ap?.a && ap.b) {
      const [x, y, w, h] = this.areaRect();
      c.save();
      c.translate(-this.e.camX, 0);
      c.setLineDash([6, 4]);
      c.lineWidth = 2;
      c.strokeStyle = '#ffd353';
      c.fillStyle = 'rgba(255, 211, 83, 0.12)';
      c.fillRect(x, y, w, h);
      c.strokeRect(x, y, w, h);
      c.restore();
    }
  }

  // one rectangle dragged in the room (room logical px), for generating / repainting; null if cancelled
  pickArea(msg) {
    this.areaPick?.resolve(null);
    this.setMode('edit');
    this.status(msg);
    this.layer.style.cursor = 'crosshair';
    return new Promise(resolve => { this.areaPick = { resolve, a: null, b: null }; });
  }

  areaRect() {
    const { a, b } = this.areaPick;
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])].map(Math.round);
  }

  endArea(ok) {
    const ap = this.areaPick;
    if (!ap) return;
    this.areaPick = null;
    this.layer.style.cursor = '';
    const r = ok && ap.a && ap.b ? this.areaRect.call({ areaPick: ap }) : null;
    ap.resolve(r && r[2] >= 8 && r[3] >= 8 ? r : null);
  }

  tick() {
    const e = this.e;
    if (e.room && e.room.id !== this.doc?.id && this.opening !== e.room.id) this.openDoc(e.room.id);
    if (this.active) {
      // scripts keep running in edit mode (enter cutscenes etc.): fast-forward them
      if (e.cutsceneDepth) e.skipping = true;
      if (e.lineSkip) e.skipLine();
      this.hitmap.update();
    }
    const m = e.audio.master;
    if (m) m.gain.value = this.sound || !this.active ? 1 : 0;      // silent while editing, unless Sound is on
  }

  // ------------------------------------------------------------ documents
  // a room's document (loaded once; other rooms' too: arrival points edit the exits that lead here)
  ensureDoc(id) {
    if (this.docs.has(id)) return this.docLoads?.get(id) || Promise.resolve(this.docs.get(id));
    const doc = new RoomDoc(this, id);
    this.docs.set(id, doc);
    const p = doc.load().then(() => {
      this.docLoads.delete(id);
      if (doc.offline) this.notice(`Read-only: ${doc.error}`, 'error');
      const rec = doc.recovered();
      if (rec) {
        const stale = rec.sha && doc.sha && rec.sha !== doc.sha;
        this.notice(`Unsaved edits to ${doc.file} from ${new Date(rec.t).toLocaleString()} were kept (${rec.edits.length})${stale
          ? '. The file has changed since: restoring may overwrite newer values.' : '.'}`, 'warn', [
          { label: stale ? 'Restore anyway' : 'Restore them', run: () => doc.restore(rec) },
          { label: 'Discard', run: () => localStorage.removeItem(KEY(id)) },
        ], rec.edits.map(([p]) => p).join('\n'));
      }
      return doc;
    });
    (this.docLoads ||= new Map()).set(id, p);
    return p;
  }

  async openDoc(id) {
    this.opening = id;
    const doc = await this.ensureDoc(id);
    if (this.e.room?.id !== id) { this.opening = null; return; }
    this.doc = doc;
    this.opening = null;
    this.sel = this.pendingSel || null; this.vsel = null; this.pathTest = null;
    this.pendingSel = null;
    this.arrivalCache = null;
    this.camX = this.e.camX;
    this.roomSelect.value = id;
    history.replaceState(null, '', this.project.url(getProject(), id));
    this.hitmap.invalidate(0);
    this.panel.refresh();
    this.updateToolbar();
    if (this.sel) this.reveal();
    // the rooms with a way in here: their files, so dragging an arrival point can move the exit there
    for (const r of new Set(this.arrivalList().flatMap(a => a.targets.map(t => t.room)).filter(Boolean))) {
      if (!this.docs.has(r)) this.ensureDoc(r).then(() => this.schedule(['inspector']));
    }
  }

  // ------------------------------------------------------------ arrival points (arrivals.js)
  arrivalList() {
    if (!this.room) return [];
    if (this.arrivalCache?.room !== this.room) this.arrivalCache = { room: this.room, list: arrivals(this, this.room) };
    return this.arrivalCache.list;
  }

  arrival(key) { return this.arrivalList().find(a => a.key === key) || null; }

  // moves an arrival point (all its places: the exit in the room it comes from, this room's entry...), undoable
  async moveArrival(ar, x, y, dir, key) {
    x = Math.round(x); y = Math.round(y); dir = dir || ar.dir || 'S';
    if (ar.kind === 'opening') return this.setOpening(x, y, dir);
    const w = writable(this, ar);
    if (w.loading) { await this.ensureDoc(w.loading); return this.moveArrival(this.arrival(ar.key) || ar, x, y, dir, key); }
    if (!w.ok) { this.notice(`Can't move this arrival: ${w.why}`, 'warn'); return false; }
    const ops = befores(this, ar).map(b => ({ doc: b.doc, path: b.path, after: movedValue(b.t, b.before, x, y, dir) }));
    return this.doc.change('move arrival', ops, key);
  }

  // the game's opening point: written to game.js at once (it is code: only the g.goto call changes)
  async setOpening(x, y, dir) {
    const r = await api.setOpening({ x, y, dir });
    if (r.status !== 200) { this.notice(`Game start: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return false; }
    this.gameOpening = { room: r.data.room, x: r.data.x, y: r.data.y, dir: r.data.dir };
    this.arrivalCache = null;
    this.status(`The game now starts at ${r.data.x}, ${r.data.y} (${r.data.dir}) in ${r.data.room} (game.js).`);
    this.schedule(['inspector', 'arrivals']);
    return true;
  }

  // go to another room and select something there once it is open
  async goSelect(room, sel) {
    if (room === this.room?.id) { this.setTool('select'); this.select(sel); this.reveal(); return; }
    this.pendingSel = sel;
    this.setTool('select');
    await this.switchRoom(room);
  }

  async switchRoom(id) {
    if (!id || id === this.e.room?.id) return;
    this.restoreProbe();
    const r = this.e.rooms.get(id);
    const ent = r.def.entries?.default || r.def.start || [320, 400, 'S'];
    // the editor's room menu shows the room as defined: no exit/enter scripts run (walking there in Play mode runs them)
    await this.e.goRoom(id, { x: ent[0], y: ent[1], dir: ent[2], fade: false, scripts: !this.active });
  }

  // true when edits may be written: the shown room and the open document agree (room switches load async)
  get docReady() { return !!this.doc && !this.opening && this.e.room?.id === this.doc.id; }

  // pauses the on-disk change polling while the server rewrites files (saves, structural edits, library ops)
  async holdPoll(fn) {
    this.pollHold++;
    try { return await fn(); } finally { this.pollHold--; }
  }

  // the source path of a field of the selection
  path(key) {
    const s = this.sel;
    if (s?.kind === 'object') return `objects[id=${s.id}].${key}`;
    if (s?.kind === 'npc') return `npcs.${s.id}.${key}`;
    return key;
  }

  check(path, quiet) {
    const r = this.doc?.editable(path) || { ok: false, why: 'not loaded' };
    if (!r.ok && !quiet) this.notice(`Can't edit ${path}: ${r.why}`, 'warn');
    return r.ok;
  }

  // an undoable edit of the current room: ops [{path, after}] (after undefined: delete)
  edit(label, ops, key) {
    if (!this.docReady) { if (this.doc) this.status('The room is still loading…'); return false; }
    if (!ops.every(op => op.doc ? true : this.check(op.path))) return false;
    return this.doc.change(label, ops, key);
  }

  // a value during a drag (committed as one command at its end)
  live(path, value, doc = this.doc) {
    if (doc === this.doc && !this.docReady) return;
    setPath(doc.def, path, value === undefined ? undefined : clone(value));
    this.arrivalCache = null;
    if (doc !== this.doc) { this.schedule(['inspector']); return; }
    if (path.startsWith('walk')) this.room.rebuild();
    this.hitmap.invalidate();
    this.schedule(['inspector']);
  }

  changed(doc, path) {
    if (!path || path.startsWith('walk')) doc.room.rebuild();
    this.arrivalCache = null;
    bumpSteps();                 // edited steps / dialogue trees: compiled handlers are stale
    this.e.dlgCache = null;
    // a character's placement (undo/redo, typed values): the actor in the running room follows
    if (path?.startsWith('actors.')) {
      const id = path.split('.')[1], pl = doc.def.actors?.[id], a = this.e.actors.get(id);
      if (a && pl && a.room === doc.id) { a.x = pl.x; a.y = pl.y; }
    }
    // another room's file (an arrival point's exit there): this room's arrivals and the save state
    if (doc !== this.doc) { this.schedule(['doc', 'inspector', 'arrivals']); return; }
    this.hitmap.invalidate();
    this.tools?.updatePath();
    this.schedule(['doc', 'inspector', 'list', 'arrivals']);
  }

  hitmapChanged() {
    this.problems = lint(this);
    this.panel.refresh(['problems']);
  }

  schedule(parts) {
    this.pendingParts = [...new Set([...(this.pendingParts || []), ...parts])];
    if (this.panelTimer) return;
    this.panelTimer = setTimeout(() => {
      this.panelTimer = null;
      const p = this.pendingParts;
      this.pendingParts = [];
      this.panel.refresh(p);
      this.updateToolbar();
    }, 60);
  }

  save() { return this.holdPoll(() => this.saveAll()); }

  async saveAll() {
    const dirty = [...this.docs.values()].filter(d => d.dirty().length);
    if (!dirty.length) { this.status('Nothing to save.'); return { nothing: true }; }
    const results = [];
    for (const d of dirty) {
      const r = await d.save();
      results.push(r);
      if (r.conflicts) this.conflict(d, r.conflicts);
      else if (!r.ok) this.notice(`Save failed (${d.file}): ${r.error}`, 'error');
      else {
        this.panel.lastDiff = r.diff;
        this.status(`Saved ${d.file} (${r.n} change${r.n > 1 ? 's' : ''}). Rebuild the ScummVM version with tools/scumm/build.py.`);
        if (r.postcheck && !r.postcheck.ok) this.notice(`Saved, but the ScummVM loader (jsgame.py) now fails: ${r.postcheck.error}`, 'error');
      }
    }
    this.panel.refresh();
    this.updateToolbar();
    return results;
  }

  conflict(doc, conflicts) {
    this.notice(`${doc.file} was changed on disk where you edited it, so nothing was saved.`, 'error', [
      { label: 'Keep mine', run: async () => { const r = await doc.save({ force: true }); if (r.ok) this.status(`Saved ${doc.file} over the disk version.`); else this.notice(`Save failed: ${r.error}`, 'error'); this.panel.refresh(); this.updateToolbar(); } },
      { label: 'Take theirs', run: async () => { for (const c of conflicts) doc.pending.delete(c.path); await doc.load(); await doc.hotSwap(); doc.prune(); doc.resetHistory(); doc.persist(); this.panel.refresh(); this.updateToolbar(); } },
    ], conflicts.map(c => `${c.path}\n  on disk now: ${JSON.stringify(c.disk)}\n  you started from: ${JSON.stringify(c.expect)}`).join('\n'));
  }

  undo() { const c = this.doc?.history.undo(); this.vsel = null; this.status(c ? `Undo: ${c.label}` : 'Nothing to undo.'); }
  redo() { const c = this.doc?.history.redo(); this.vsel = null; this.status(c ? `Redo: ${c.label}` : 'Nothing to redo.'); }

  // ------------------------------------------------------------ selection, modes, view
  select(sel) {
    this.sel = sel;
    this.vsel = null;
    this.panel.refresh(['inspector', 'list', 'arrivals']);
  }

  // scroll the camera to the selection
  reveal() {
    const s = this.sel, room = this.room;
    if (!s || !room || room.width <= W) return;
    let x = null;
    if (s.kind === 'object') { const o = room.objects.get(s.id); if (o) x = room.centerOf(o)[0]; }
    else if (s.kind === 'npc') x = this.e.actors.get(s.id)?.x;
    if (x != null && (x < this.camX + 40 || x > this.camX + W - 40)) this.camX = clamp(x - W / 2, 0, room.width - W);
  }

  cycleSel(dir) {
    const room = this.room;
    if (!room) return;
    const list = [...this.e.actorsIn(room.id).filter(a => a !== this.e.player).map(a => ({ kind: 'npc', id: a.id })),
      ...[...room.objects.keys()].map(id => ({ kind: 'object', id }))];
    if (!list.length) return;
    const i = this.sel ? list.findIndex(x => x.kind === this.sel.kind && x.id === this.sel.id) : -1;
    this.setTool('select');
    this.select(list[(i + dir + list.length) % list.length]);
    this.reveal();
  }

  setMode(m) {
    const active = m === 'edit';
    const v = this.e.viewport;
    if (active && !this.active) Object.assign(v, this.editView);
    if (!active && this.active) { this.editView = { zoom: v.zoom || 1, panX: v.panX || 0, panY: v.panY || 0 }; Object.assign(v, { zoom: 1, panX: 0, panY: 0 }); }
    this.active = active;
    this.layer.style.pointerEvents = active ? 'auto' : 'none';
    if (active) { this.camX = this.e.camX; this.e.coin = null; this.e.held = null; this.e.invOpen = false; this.e.mouse.down = false; }
    else { this.restoreProbe(); this.tools.cancel(); }
    this.e.resize();
    this.updateToolbar();
    this.panel.refresh(['inspector']);
  }

  setTool(t) {
    if (t === this.tool) return;
    this.tool = t;
    if (t !== 'scale' && !this.probe) this.restoreProbe();
    if (this.sel && ((t === 'walk') !== (this.sel.kind === 'walk') || (t === 'scale') !== (this.sel.kind === 'scale'))) this.sel = null;
    this.vsel = null;
    if (t === 'scale') this.sel = { kind: 'scale' };
    this.updateToolbar();
    this.panel.refresh(['inspector', 'list', 'arrivals']);
  }

  toggle(name) {
    if (name === 'probe') { this.probe = !this.probe; if (!this.probe && this.tool !== 'scale') this.restoreProbe(); }
    else if (name === 'sound') this.sound = !this.sound;
    else this.show[name] = !this.show[name];
    if (name === 'hitmap' && this.show.hitmap) this.hitmap.update(true);
    if (name === 'arrivals' && !this.show.arrivals && this.sel?.kind === 'arrival') this.select(null);
    this.updateToolbar();
  }

  get probeOn() { return this.active && (this.probe || this.tool === 'scale'); }

  // Guybrush stands where the mouse is (the probe): scale, tint and occlusion as in the game
  pointer(p) {
    this.mouse = p ? { ...p, inRoom: p.sx >= 0 && p.sx < W && p.sy >= 0 && p.sy < H } : null;
    if (this.probeOn && this.mouse?.inRoom && !this.tools.drag && !this.ruler.contains(p.cx, p.cy)) {
      const pl = this.e.player;
      if (!this.probeHome) { this.probeHome = [pl.x, pl.y]; pl.stopWalking?.(); }
      pl.path = [];
      pl.x = p.rx; pl.y = p.ry;
    }
    this.updateStatus();
  }

  restoreProbe() {
    if (!this.probeHome) return;
    const pl = this.e.player;
    [pl.x, pl.y] = this.probeHome;
    pl.path = [];
    this.probeHome = null;
  }

  panBy(dx, dy) {
    const e = this.e, v = e.viewport, z = v.zoom || 1;
    const lx = -dx * e.dpr / e.k, ly = -dy * e.dpr / e.k;
    const mx = (W / 2) * (1 - 1 / z), my = (H / 2) * (1 - 1 / z);
    const nx = clamp((v.panX || 0) + lx, -mx, mx);
    const rest = lx - (nx - (v.panX || 0));
    v.panX = nx;
    if (rest && this.room) this.camX = clamp(this.camX + rest, 0, Math.max(0, this.room.width - W));
    v.panY = clamp((v.panY || 0) + ly, -my, my);
    e.resize();
  }

  zoomAt(f, cx, cy) {
    const e = this.e, v = e.viewport;
    const [sx, sy] = e.toLogical(cx, cy);
    v.zoom = clamp((v.zoom || 1) * f, 1, 8);
    e.resize();
    const [sx2, sy2] = e.toLogical(cx, cy);
    const z = v.zoom, mx = (W / 2) * (1 - 1 / z), my = (H / 2) * (1 - 1 / z);
    v.panX = clamp((v.panX || 0) + sx - sx2, -mx, mx);
    v.panY = clamp((v.panY || 0) + sy - sy2, -my, my);
    e.resize();
  }

  resetZoom() { Object.assign(this.e.viewport, { zoom: 1, panX: 0, panY: 0 }); this.e.resize(); }

  blurInputs() { if (document.activeElement?.closest?.('#ed-side, #ed-top')) document.activeElement.blur(); }

  // ------------------------------------------------------------ messages
  notice(msg, level = 'info', actions = null, detail = null) {
    const n = { msg, level, actions, detail };
    this.notices.push(n);
    if (this.notices.length > 6) this.notices.shift();
    this.panel.render_notices();
    if (!actions && level === 'info') setTimeout(() => { const i = this.notices.indexOf(n); if (i >= 0) { this.notices.splice(i, 1); this.panel.render_notices(); } }, 6000);
  }

  status(msg) {
    const el = document.getElementById('ed-msg');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => el.classList.remove('on'), 5000);
  }

  updateStatus() {
    const m = this.mouse, room = this.room;
    const pos = document.getElementById('ed-pos'), hov = document.getElementById('ed-hov');
    if (!m || !room || !m.inRoom) { pos.textContent = ''; hov.textContent = ''; return; }
    const walkable = !room.walk || room.walk.inside([m.rx, m.ry]);
    pos.innerHTML = `x <b>${Math.round(m.rx)}</b> y <b>${Math.round(m.ry)}</b> · scale <b>${room.scaleAt(m.ry).toFixed(2)}</b> · ${walkable ? 'walkable' : '<span class="ed-dim">not walkable</span>'}`;
    const t = this.e.hotspotAt(m.sx, m.sy);
    hov.textContent = t ? `→ ${this.e.nameOf(t)} (${t.kind === 'actor' ? 'npc' : 'object'} ${t.id})` : '';
  }

  // ------------------------------------------------------------ keys (engine.onKey)
  key(ev) {
    const k = ev.key, mod = ev.metaKey || ev.ctrlKey;
    // typing in any field of the editor (text boxes, number fields, menus, dialogs): no editor or game shortcuts,
    // the field gets every key (space, arrows, Tab, Enter...); ⌘S still saves, Esc leaves the field
    const inField = isField(ev.target);
    if (mod && k.toLowerCase() === 's') { ev.preventDefault(); this.save(); return true; }
    if (inField) { if (k === 'Escape') ev.target.blur(); return true; }
    if (this.puzzles.box) return true;            // the puzzle chart is open: its own keys (Esc)
    if (k === 'Tab') { ev.preventDefault(); this.setMode(this.active ? 'play' : 'edit'); return true; }
    if (!this.active) return false;                // playing: the game gets the keys
    if (this.areaPick && k === 'Escape') { this.endArea(false); this.status('Cancelled.'); return true; }
    if (mod && k.toLowerCase() === 'z') { ev.preventDefault(); if (ev.shiftKey) this.redo(); else this.undo(); return true; }
    if (mod && k.toLowerCase() === 'y') { ev.preventDefault(); this.redo(); return true; }
    if (mod) return true;
    const step = ev.shiftKey ? 10 : 1;
    switch (k) {
      case ' ': ev.preventDefault(); this.tools.space = true; break;
      case 'v': case 'V': this.setTool('select'); break;
      case 'w': case 'W': this.setTool('walk'); break;
      case 's': case 'S': this.setTool('scale'); break;
      case 'h': case 'H': this.toggle('hitmap'); break;
      case 'l': case 'L': this.toggle('labels'); break;
      case 'a': case 'A': this.toggle('arrivals'); break;
      case 'p': case 'P': this.puzzles.open(); break;
      case 'g': case 'G': this.toggle('probe'); break;
      case 'b': case 'B': this.tools.toggleShape(); break;
      case 'f': case 'F': this.tools.fitSprite(); break;
      case 'Escape': if (this.tools.drag) this.tools.cancel(); else if (this.vsel != null) { this.vsel = null; this.panel.refresh(['inspector']); } else this.select(null); break;
      case 'Backspace': case 'Delete': ev.preventDefault(); this.tools.deleteSelected(); break;
      case 'ArrowLeft': ev.preventDefault(); this.tools.nudge(-step, 0); break;
      case 'ArrowRight': ev.preventDefault(); this.tools.nudge(step, 0); break;
      case 'ArrowUp': ev.preventDefault(); this.tools.nudge(0, -step); break;
      case 'ArrowDown': ev.preventDefault(); this.tools.nudge(0, step); break;
      case '[': this.cycleSel(-1); break;
      case ']': this.cycleSel(1); break;
      case '0': this.resetZoom(); break;
      case '+': case '=': { const v = this.e.viewport; this.zoomAt(1.25, v.w / 2, v.y + v.h / 2); break; }
      case '-': { const v = this.e.viewport; this.zoomAt(0.8, v.w / 2, v.y + v.h / 2); break; }
      default:
        if (/^[1-9]$/.test(k)) this.tools.setFace(NUMPAD[k] || null);
    }
    return true;
  }
}
