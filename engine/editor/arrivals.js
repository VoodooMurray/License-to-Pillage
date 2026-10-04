// Arrival points: where Guybrush appears when he comes into a room. Each one lives where its way in is defined:
//   an exit in any room          objects[id].exit = {room, x, y, dir}  (what the web engine and the ScummVM build use)
//   the room's entries.<from>    the default arrival of new exits from that room; ?room=<id>&entry=<from>
//   entries.default / start      where ?room=<id> and the editor put him
//   a "Go to room" step          { goto: room, x, y, dir } in a script or a conversation of any room
//   the game's opening           the g.goto(room, x, y, dir) in game.js's start (tools/projects.py opening)
//   hand-written code            any other g.goto(room, x, y, dir) in a room's or the game's functions (shown, read-only)
// An exit and the entry of the room it comes from are one arrival: they move together.

import { getPath, clone } from './paths.js';
import { Actor } from '../actor.js';

const VERBS = ['look', 'hand', 'mouth', 'push', 'talk'];
const keyPath = k => /^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : `[${JSON.stringify(k)}]`;
const VERB_NAMES = { look: 'look at', hand: 'use', mouth: 'talk to / eat', push: 'push', talk: 'talk' };

// the data scripts of a room definition: [path, value, label]
function scriptRoots(def) {
  const out = [];
  const handlers = (pre, d, name) => {
    if (!d || typeof d !== 'object') return;
    for (const v of VERBS) if (Array.isArray(d[v]?.do)) out.push([`${pre}.${v}`, d[v], `${name}: ${VERB_NAMES[v]}`]);
    if (d.use && typeof d.use === 'object') {
      for (const [k, u] of Object.entries(d.use)) if (Array.isArray(u?.do)) out.push([`${pre}.use${keyPath(k)}`, u, `${name}: use ${k}`]);
    }
  };
  for (const o of def.objects || []) if (o?.id) handlers(`objects[id=${o.id}]`, o, typeof o.name === 'string' ? o.name : o.id);
  for (const [id, n] of Object.entries(def.npcs || {})) handlers(`npcs.${id}`, n, n?.name || id);
  for (const [id, t] of Object.entries(def.dialogues || {})) if (t && typeof t === 'object') out.push([`dialogues.${id}`, t, `conversation ${id}`]);
  return out;
}

// where in a handler / dialogue tree the "go to <room>" steps are: [['do', 0, 'then', 1], ...]
function gotoSteps(v, room) {
  const out = [];
  const walk = (steps, at) => (Array.isArray(steps) ? steps : []).forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    if (s.goto === room) out.push([...at, i]);
    walk(s.then, [...at, i, 'then']);
    walk(s.else, [...at, i, 'else']);
  });
  walk(v.do, ['do']);
  walk(v.hello, ['hello']);
  walk(v.again, ['again']);
  (v.options || []).forEach((o, i) => walk(o?.do, ['options', i, 'do']));
  return out;
}

const at = (v, loc) => loc.reduce((x, k) => x?.[k], v);

const GOTO = /\bg\.goto\(\s*(['"])(\w+)\1\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(['"])(\w+)\5)?/g;

// g.goto calls into `room` in the functions of a definition: [{x, y, dir, where}]
function codeGotos(v, room, where = [], seen = new Set(), out = []) {
  if (v == null || where.length > 8) return out;
  if (typeof v === 'function') {
    for (const m of String(v).matchAll(GOTO)) if (m[2] === room) out.push({ x: +m[3], y: +m[4], dir: m[6] || 'S', where: where.join('.') });
    return out;
  }
  if (typeof v !== 'object' || seen.has(v)) return out;
  seen.add(v);
  for (const [k, x] of Object.entries(v)) codeGotos(x, room, [...where, x && typeof x === 'object' && typeof x.id === 'string' ? x.id : k], seen, out);
  return out;
}

// every arrival point of a room: {key, kind, label, from, obj, x, y, dir, targets: [{room, path, type, loc?}]}
//   type exit: the value is the exit object; triple: [x, y, dir]; step: the script root, loc = the step in it
export function arrivals(ed, room) {
  const e = ed.e, id = room.id, out = [];
  const name = r => { const n = e.rooms.get(r)?.def.name; return typeof n === 'string' ? n : r; };
  for (const r of e.rooms.values()) {
    for (const o of r.objects.values()) {
      const ex = o.exit;
      if (!ex || typeof ex !== 'object' || ex.room !== id || ex.x == null) continue;
      const oname = typeof o.name === 'string' ? o.name : o.id;
      out.push({ key: `exit:${r.id}:${o.id}`, kind: 'exit', from: r.id, obj: o.id, x: ex.x, y: ex.y, dir: ex.dir || 'S',
        label: r.id === id ? `${oname} (this room)` : `from ${name(r.id)}`, sub: oname,
        targets: [{ room: r.id, path: `objects[id=${o.id}].exit`, type: 'exit' }] });
    }
    for (const [root, v, label] of scriptRoots(r.def)) {
      for (const loc of gotoSteps(v, id)) {
        const s = at(v, loc);
        out.push({ key: `step:${r.id}:${root}:${loc.join('.')}`, kind: 'script', from: r.id, x: +s.x || 320, y: +s.y || 420, dir: s.dir || 'S',
          label: `script in ${name(r.id)}`, sub: label, targets: [{ room: r.id, path: root, type: 'step', loc }] });
      }
    }
  }
  // hand-written code (License to Pillage's cutscenes...): shown where it puts him, edited in the source
  const code = (r, def, file, skip) => {
    const seen = new Set();
    for (const c of codeGotos(Object.fromEntries(Object.entries(def).filter(([k]) => !skip.includes(k))), id, [], seen)) {
      if (out.some(a => a.kind === 'code' && a.x === c.x && a.y === c.y && a.dir === c.dir)) continue;
      out.push({ key: `code:${r}:${c.where}:${c.x},${c.y}`, kind: 'code', from: r, x: c.x, y: c.y, dir: c.dir, label: `code in ${r === '*' ? 'game.js' : name(r)}`,
        sub: c.where, targets: [], readonly: `hand-written: g.goto in ${file}${c.where ? ` (${c.where})` : ''}` });
    }
  };
  for (const r of e.rooms.values()) code(r.id, r.def, `rooms/${r.id}.js`, ['walk', 'layers', 'scale', 'entries', 'start', 'size']);
  code('*', e.game, 'game.js', ['rooms', 'actors', 'items', 'music', 'sfx', 'voice', 'defaults', ...(ed.gameOpening ? ['start'] : [])]);
  // the room's own entries: the one for a room joins that room's exit here (the nearest, if there are several);
  // an entry no exit uses but code goes to (the same point) joins that
  const def = room.def, entries = def.entries && typeof def.entries === 'object' ? def.entries : {};
  for (const [k, v] of Object.entries(entries)) {
    if (k === 'default' || !Array.isArray(v)) continue;
    const exits = out.filter(a => a.kind === 'exit' && a.from === k);
    const near = exits.sort((a, b) => Math.hypot(a.x - v[0], a.y - v[1]) - Math.hypot(b.x - v[0], b.y - v[1]))[0];
    const t = { room: id, path: `entries${keyPath(k)}`, type: 'triple' };
    const same = !near && out.find(a => a.kind === 'code' && a.x === v[0] && a.y === v[1]);
    if (same) { same.targets.push(t); same.sub = `${same.sub ? same.sub + ', ' : ''}entries.${k}`; }
    else if (near) { near.targets.push(t); near.entry = v; }
    else out.push({ key: `entry:${k}`, kind: 'entry', from: k, x: v[0], y: v[1], dir: v[2] || 'S', label: `entry "${k}"`, sub: 'no exit uses it', targets: [t] });
  }
  // the start point (?room=, the editor): entries.default, else start; both move together
  const st = Array.isArray(entries.default) ? entries.default : Array.isArray(def.start) ? def.start : null;
  if (st) {
    const targets = [];
    if (Array.isArray(entries.default)) targets.push({ room: id, path: 'entries.default', type: 'triple' });
    if (Array.isArray(def.start)) targets.push({ room: id, path: 'start', type: 'triple' });
    out.push({ key: 'start', kind: 'start', x: st[0], y: st[1], dir: st[2] || 'S', label: 'start point', sub: '?room= and the editor', targets });
  }
  const op = ed.gameOpening;
  if (op && op.room === id) out.push({ key: 'opening', kind: 'opening', x: op.x, y: op.y, dir: op.dir || 'S', label: 'game start', sub: "game.js start", targets: [{ type: 'opening' }] });
  return out;
}

// the value of a target's path with the arrival moved to x, y, dir
export function movedValue(t, before, x, y, dir) {
  if (t.type === 'exit') return { ...before, x, y, dir };
  if (t.type === 'triple') return [x, y, dir, ...before.slice(3)];
  if (t.type === 'step') {
    const v = clone(before), s = at(v, t.loc);
    if (s) Object.assign(s, { x, y, dir });
    return v;
  }
  return before;
}

// can every target be written? -> {ok, why, docs: Map room -> doc}
export function writable(ed, ar) {
  if (ar.readonly) return { ok: false, why: ar.readonly };
  if (ar.kind === 'opening') {
    return ed.project.reference ? { ok: false, why: "License to Pillage's opening is scripted in game.js" } : { ok: true };
  }
  for (const t of ar.targets) {
    const doc = ed.docs.get(t.room);
    if (!doc?.base) return { ok: false, why: `${t.room} is loading`, loading: t.room };
    const r = doc.editable(t.path);
    if (!r.ok) return r;
  }
  return { ok: true };
}

// the target values now: [{doc, path, before}]
export function befores(ed, ar) {
  return ar.targets.filter(t => t.type !== 'opening').map(t => {
    const doc = ed.docs.get(t.room);
    return { doc, path: t.path, t, before: clone(getPath(doc.def, t.path)) };
  });
}

// Guybrush as he would stand at an arrival point (his costume, standing, facing dir, at the room's scale there):
// {parts, box: [x, y, w, h]}; a stand-in actor, so the real one is not disturbed
export function ghost(ed, x, y, dir) {
  const p = ed.e.player, room = ed.room;
  if (!room) return null;
  const s = room.scaleAt(y);
  if (!p?.costume) return { parts: [], box: [x - 30 * s, y - 200 * s, 60 * s, 200 * s] };
  let g = ed.ghostActor;
  if (!g || g.costume !== p.costume) { g = ed.ghostActor = new Actor('_ghost', p.def, p.costume); g.init(); }
  g.x = x; g.y = y;
  if (dir && dir !== g.dir) { g.setDir(dir); g.stand(); }
  const parts = g.parts(room);
  if (!parts.length) return { parts, box: [x - 30 * s, y - 200 * s, 60 * s, 200 * s] };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of parts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x + q.w); y1 = Math.max(y1, q.y + q.h); }
  return { parts, box: [x0, y0, x1 - x0, y1 - y0] };
}
