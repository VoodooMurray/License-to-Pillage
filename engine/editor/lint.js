// The Problems panel: geometry that is likely wrong, for the web engine or for the ScummVM build.
// Each problem: {level: 'error' | 'warn' | 'info', msg, sel} (sel = what to select when clicked).

import { pointInPoly } from '../util.js';
import { selfIntersects } from './geom.js';

// a problem's stable key, for "Ignore" (saved in the room file as lintIgnore): numbers stripped, so a
// nudged coordinate keeps an ignored problem ignored
export const problemKey = p => `${p.sel ? `${p.sel.kind}:${p.sel.id ?? p.sel.key ?? p.sel.index ?? ''}:` : ''}${p.msg.replace(/-?\d+(\.\d+)?/g, '#')}`;

export function lint(ed) {
  const e = ed.e, room = e.room, def = room?.def;
  if (!def) return [];
  const ignored = new Set(Array.isArray(def.lintIgnore) ? def.lintIgnore : []);
  const out = [];
  const add = (level, msg, sel) => {
    const p = { level, msg, sel };
    p.key = problemKey(p);
    p.ignored = ignored.has(p.key);
    out.push(p);
  };
  const walk = room.walk;
  const inWalk = p => !walk || walk.inside(p);
  const hits = ed.hitmap.valid && ed.hitmap.room === room ? ed.hitmap.counts : null;

  for (const o of room.objects.values()) {
    const sel = { kind: 'object', id: o.id };
    const st = room.objState(e, o.id);
    const shape = !!(o.box || o.hot);
    if (!shape && !o.noHotspot && !room.objSprite(e, o)) add('warn', `${o.id}: no box or hot polygon (no hotspot)`, sel);
    if (o.hot && selfIntersects(o.hot)) add('error', `${o.id}: hot polygon crosses itself`, sel);
    if (o.hot && o.hot.length < 3) add('error', `${o.id}: hot polygon has fewer than 3 points`, sel);
    if (o.box && (o.box[2] <= 0 || o.box[3] <= 0)) add('error', `${o.id}: box has no area`, sel);
    if (walk && (o.walkTo || shape) && !o.noHotspot) {
      const wt = o.walkTo || room.walkToOf(o);
      if (!inWalk(wt)) add('warn', `${o.id}: walkTo ${wt.map(Math.round)} is outside the walk area${o.walkTo ? '' : ' (default point)'}`, sel);
    }
    if (hits && shape && !st.hidden && !o.noHotspot && !(o.when && !o.when(e.api)) && !hits.get('object:' + o.id)) {
      add('warn', `${o.id}: covered by other hotspots, can't be clicked (web)`, sel);
    }
    if (o.exit) {
      const to = e.rooms.get(o.exit.room);
      if (!to) add('error', `${o.id}: exit to unknown room ${o.exit.room}`, sel);
      else if (to.walk && o.exit.x != null && !to.walk.inside([o.exit.x, o.exit.y])) add('warn', `${o.id}: arrival ${o.exit.x},${o.exit.y} is outside ${o.exit.room}'s walk area`, sel);
    }
    const dflt = o.state ?? null;
    if (st.state !== dflt && o.states) add('info', `${o.id}: runtime state '${st.state}' (definition: '${dflt}')`, sel);
  }

  const npcs = def.npcs || {};
  for (const a of e.actorsIn(room.id)) {
    if (a === e.player || a.def.noHotspot) continue;
    const n = npcs[a.id] || {};
    const sel = { kind: 'npc', id: a.id };
    if (!n.hot) add('warn', `${a.id}: no hot rect (web uses the sprite bounds, ScummVM [-30,-150,60,150])`, sel);
    if (walk && n.walkTo && !inWalk(n.walkTo)) add('warn', `${a.id}: walkTo ${n.walkTo} is outside the walk area`, sel);
    if (hits && !hits.get('actor:' + a.id)) add('warn', `${a.id}: can't be clicked (web)`, sel);
  }

  const wd = def.walk || {};
  (wd.polys || []).forEach((p, i) => {
    const sel = { kind: 'walk', poly: 'polys', index: i };
    if (selfIntersects(p)) add('error', `walk area ${i + 1} crosses itself`, sel);
    if (p.some(([, y]) => !Number.isInteger(y))) add('info', `walk area ${i + 1}: non-integer y (SCUMM walkboxes are cut at whole y)`, sel);
  });
  (wd.holes || []).forEach((h, i) => {
    const sel = { kind: 'walk', poly: 'holes', index: i };
    if (selfIntersects(h)) add('error', `hole ${i + 1} crosses itself`, sel);
    if (h.some(v => !(wd.polys || []).some(p => pointInPoly(v, p)))) add('info', `hole ${i + 1} reaches outside the walk area`, sel);
  });

  const sc = def.scale;
  if (sc) {
    const sel = { kind: 'scale' };
    if (sc.some((p, i) => i && p[0] <= sc[i - 1][0])) add('error', 'scale points are not sorted by y', sel);
    if (sc.length > 2) add('info', `scale has ${sc.length} points: the ScummVM build uses only the first and last`, sel);
    if (sc.some(p => p[1] > 1)) add('info', 'scale above 1.0: the ScummVM build caps it at 1.0', sel);
  }
  // the ways in (arrivals.js): Guybrush must arrive where he can stand; a room nothing leads to can't be reached
  const ways = ed.arrivalList();
  for (const a of ways) {
    // hand-written arrivals outside (a cutscene walking him in from off-screen) are often meant that way
    if (walk && !inWalk([a.x, a.y])) add(a.readonly || a.kind === 'entry' ? 'info' : 'warn', `${a.label}${a.sub ? ` (${a.sub})` : ''}: arrives at ${Math.round(a.x)},${Math.round(a.y)}, outside the walk area`, { kind: 'arrival', key: a.key });
  }
  if (e.rooms.size > 1 && !ways.some(a => ['exit', 'script', 'opening', 'code'].includes(a.kind))) {
    add('info', 'No way in: no exit or script leads to this room yet (and the game does not start here)', null);
  }
  if (typeof def.music === 'string' && !e.game.music?.[def.music]) add('warn', `room music '${def.music}' is not in the game's music`, null);
  // a project's ScummVM limits (the build is silent about them; License to Pillage is tuned by hand)
  if (ed.project && !ed.project.reference) {
    const actors = e.game.actors || {};
    const npcs = Object.keys(actors).filter(a => a !== e.game.player && !a.startsWith('_'));
    for (const a of npcs) {
      const c = String(actors[a].costume || '');
      if (c && c !== `actors/${a}`) add('warn', `${a}: costume '${c}' is not built for ScummVM (only the game's own actors/${a}), so they are invisible there`, null);
    }
    if (npcs.length > 6) add('info', `ScummVM gives only the first 6 characters their own text colour (${npcs.length} here)`, null);
    if (npcs.length > 58) add('error', `ScummVM fits at most 58 characters (${npcs.length} here)`, null);
    const music = Object.keys(e.game.music || {});
    if (music.length > 5) add('warn', `ScummVM plays only the first 5 music tracks (${music.slice(5).join(', ')} stay silent)`, null);
    const pc = String(actors[e.game.player]?.costume || '');
    if (pc && pc !== 'cmi/actors/guybrush') add('info', `the main character plays as Guybrush in ScummVM (own player costumes are web-only so far)`, null);
  }
  lintScripts(e, room, add);

  const order = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => (a.ignored ? 1 : 0) - (b.ignored ? 1 : 0) || order[a.level] - order[b.level]);
}

// data scripts ({ do: [steps] }, dialogues; engine/steps.js): names that don't exist
const VERBS = ['look', 'hand', 'mouth', 'push', 'talk'];

function lintScripts(e, room, add) {
  const def = room.def, game = e.game;
  const items = game.items || {}, actors = game.actors || {};
  const dialogues = { ...(game.dialogues || {}), ...(def.dialogues || {}) };
  const check = (steps, where, sel) => {
    for (const s of steps || []) {
      if (!s || typeof s !== 'object') continue;
      for (const k of ['give', 'take', 'ifHas', 'ifNotHas']) if (s[k] && !items[s[k]]) add('error', `${where}: unknown item '${s[k]}'`, sel);
      if (s.who && !actors[s.who]) add('error', `${where}: unknown character '${s.who}'`, sel);
      if (s.goto && !e.rooms.has(s.goto)) add('error', `${where}: go to unknown room '${s.goto}'`, sel);
      if (s.talk && !dialogues[s.talk]) add('error', `${where}: no conversation '${s.talk}'`, sel);
      if (s.sfx && !game.sfx?.[s.sfx]) add('warn', `${where}: no sound '${s.sfx}'`, sel);
      if (s.music && !game.music?.[s.music]) add('warn', `${where}: no music '${s.music}'`, sel);
      if (s.card && !game.cards?.[s.card]) add('error', `${where}: no card '${s.card}' (Game → Cards)`, sel);
      for (const k of ['state', 'show', 'hide']) if (s[k] && !s.room && !room.objects.has(s[k])) add('warn', `${where}: no object '${s[k]}' in this room`, sel);
      if (s.say != null && !String(s.say).trim()) add('warn', `${where}: empty line`, sel);
      check(s.then, where, sel);
      check(s.else, where, sel);
    }
  };
  const handlers = (d, name, sel) => {
    for (const v of VERBS) if (d[v]?.do) check(d[v].do, `${name} ${v}`, sel);
    if (d.use && typeof d.use === 'object') {
      for (const [it, h] of Object.entries(d.use)) {
        if (it !== '*' && !items[it]) add('warn', `${name}: reacts to unknown item '${it}'`, sel);
        if (h?.do) check(h.do, `${name} use ${it}`, sel);
      }
    }
  };
  for (const o of room.objects.values()) handlers(o, o.id, { kind: 'object', id: o.id });
  for (const [id, n] of Object.entries(def.npcs || {})) handlers(n, id, { kind: 'npc', id });
  for (const [id, t] of Object.entries(def.dialogues || {})) {
    const npc = Object.entries(def.npcs || {}).find(([, n]) => n.mouth?.do?.some(s => s.talk === id));
    const sel = npc ? { kind: 'npc', id: npc[0] } : null;
    check(t.hello, `conversation ${id} (first time)`, sel);
    check(t.again, `conversation ${id} (later)`, sel);
    (t.options || []).forEach((o, i) => {
      if (!o.text?.trim()) add('warn', `conversation ${id}: option ${i + 1} has no text`, sel);
      check(o.do, `conversation ${id}, "${o.text || i + 1}"`, sel);
    });
    if (!(t.options || []).some(o => o.end && !o.if && !o.ifNot && !o.ifHas && !o.ifNotHas)) add('info', `conversation ${id}: no unconditional option ends it (a "Goodbye." is added)`, sel);
  }
}
