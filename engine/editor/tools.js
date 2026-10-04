// Pointer interaction of the editor's tools (keys are in editor.js):
//   Hotspots (V): click picks what the game would pick (click again on the same spot: the next
//     overlapping one); drag box handles, polygon vertices, the whole shape or the walk-to diamond;
//     double-click a polygon edge adds a vertex.
//   Walk area (W): drag vertices, drag a hole to move it, double-click an edge adds a vertex,
//     right-click twice tests a path.
//   Scale (S): drag the ruler's points (double-click adds one); Guybrush follows the mouse.
//   Arrival points (A shows them): drag the feet of a faint Guybrush; the exit in the room he comes from moves along.
// Space-drag, middle-drag or the wheel pans; ctrl/cmd-wheel (pinch) zooms. Shift locks the axis of a
// drag, Alt turns the magnets off.

import { clone } from './paths.js';
import { magnets, snap } from './snap.js';
import { boxPoly, bboxOf, inBox, nearestEdge, pointInPoly, polyArea, insidePoint } from './geom.js';
import { ghost, writable, befores, movedValue } from './arrivals.js';

const HANDLE_CSS = 7, DRAG_CSS = 3;
const BOX_HANDLES = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

function resizeBox([bx, by, bw, bh], h, x, y) {
  let x0 = bx, y0 = by, x1 = bx + bw, y1 = by + bh;
  if (h.includes('w')) x0 = x;
  if (h.includes('e')) x1 = x;
  if (h.includes('n')) y0 = y;
  if (h.includes('s')) y1 = y;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(1, Math.abs(x1 - x0)), Math.max(1, Math.abs(y1 - y0))];
}

const round2 = v => Math.round(v * 100) / 100;

export class Tools {
  constructor(ed, layer) {
    this.ed = ed;
    this.layer = layer;
    this.drag = null;
    this.space = false;
    this.lastDown = null;
    layer.addEventListener('pointerdown', ev => this.down(ev));
    layer.addEventListener('pointermove', ev => this.move(ev));
    layer.addEventListener('pointerup', ev => this.up(ev));
    layer.addEventListener('pointercancel', () => this.cancel());
    layer.addEventListener('pointerleave', () => { if (!this.drag) this.ed.pointer(null); });
    layer.addEventListener('dblclick', ev => this.dbl(ev));
    layer.addEventListener('wheel', ev => this.wheel(ev), { passive: false });
    layer.addEventListener('contextmenu', ev => ev.preventDefault());
  }

  get e() { return this.ed.e; }
  get room() { return this.e.room; }
  get doc() { return this.ed.doc; }
  T() { return HANDLE_CSS * this.e.dpr / this.e.k; }

  pos(ev) {
    const [sx, sy] = this.e.toLogical(ev.clientX, ev.clientY);
    return { sx, sy, rx: sx + this.e.camX, ry: sy, cx: ev.clientX, cy: ev.clientY };
  }

  npcBox(a, hot) { return [a.x + hot[0], a.y + hot[1], hot[2], hot[3]]; }

  npcWalkTo(a, n) {
    if (n?.walkTo) return n.walkTo;
    const p = this.e.player;
    return [Math.round(a.x + (p.x < a.x ? -60 : 60) * this.room.scaleAt(a.y)), Math.round(a.y)];
  }

  // ------------------------------------------------------------ handles and picking
  handles() {
    const ed = this.ed, room = this.room, sel = ed.sel, out = [];
    if (!room || !ed.active) return out;
    if (ed.tool === 'walk') {
      const w = room.def.walk || {};
      for (const poly of ['polys', 'holes']) {
        (w[poly] || []).forEach((pts, index) => pts.forEach(([x, y], vi) => out.push({
          kind: 'wvert', poly, index, vi, x, y,
          selected: sel?.kind === 'walk' && sel.poly === poly && sel.index === index && ed.vsel === vi,
        })));
      }
      return out;
    }
    if (ed.tool !== 'select' || !sel) return out;
    if (sel.kind === 'object') {
      const o = room.objects.get(sel.id);
      if (!o) return out;
      if (o.hot) o.hot.forEach(([x, y], vi) => out.push({ kind: 'vertex', vi, x, y, selected: ed.vsel === vi }));
      else if (o.box) for (const [h, [fx, fy]] of Object.entries(BOX_HANDLES)) out.push({ kind: 'box', h, x: o.box[0] + fx * o.box[2], y: o.box[1] + fy * o.box[3] });
      if (o.box || o.hot) { const p = o.walkTo || room.walkToOf(o); out.push({ kind: 'walkTo', x: p[0], y: p[1] }); }
    } else if (sel.kind === 'npc') {
      const a = this.e.actors.get(sel.id), n = room.def.npcs?.[sel.id];
      if (!a || a.room !== room.id) return out;
      if (n?.hot) {
        const b = this.npcBox(a, n.hot);
        for (const [h, [fx, fy]] of Object.entries(BOX_HANDLES)) out.push({ kind: 'nbox', h, x: b[0] + fx * b[2], y: b[1] + fy * b[3] });
      }
      const wt = this.npcWalkTo(a, n);
      out.push({ kind: 'walkTo', x: wt[0], y: wt[1] });
    }
    return out;
  }

  handleAt(p) {
    const T = this.T();
    let best = null, bd = T;
    for (const h of this.handles()) {
      const d = Math.hypot(h.x - p.rx, h.y - p.ry);
      if (d <= bd) { bd = d; best = h; }
    }
    return best;
  }

  // hotspots under a point: what the game picks first, then smaller before larger
  candidates(rx, ry) {
    const room = this.room, e = this.e, out = [];
    for (const a of e.actorsIn(room.id)) {
      if (a === e.player) continue;
      const n = room.def.npcs?.[a.id];
      const b = n?.hot ? this.npcBox(a, n.hot) : (bb => [bb.x, bb.y, bb.w, bb.h])(a.bounds(room));
      if (inBox([rx, ry], b)) out.push({ kind: 'npc', id: a.id, area: b[2] * b[3] });
    }
    for (const o of room.objects.values()) {
      const hit = o.hot ? pointInPoly([rx, ry], o.hot) : o.box ? inBox([rx, ry], o.box) : false;
      if (hit) out.push({ kind: 'object', id: o.id, area: o.hot ? polyArea(o.hot) : o.box[2] * o.box[3] });
    }
    const t = e.hotspotAt(rx - e.camX, ry);
    const top = t && out.find(c => (c.kind === 'npc' ? 'actor' : 'object') === t.kind && c.id === t.id);
    return out.sort((a, b) => (b === top) - (a === top) || a.area - b.area);
  }

  // an arrival point under the mouse: its feet (feet = true), or anywhere on its faint Guybrush
  arrivalAt(p, feet) {
    const ed = this.ed;
    if (!ed.show.arrivals || ed.tool !== 'select') return null;
    const list = ed.arrivalList();
    if (feet) {
      const T = this.T() * 1.6;
      let best = null, bd = T;
      for (const a of list) { const d = Math.hypot(a.x - p.rx, a.y - p.ry); if (d <= bd) { bd = d; best = a; } }
      return best;
    }
    const sel = ed.sel?.kind === 'arrival' ? list.find(a => a.key === ed.sel.key) : null;
    for (const a of sel ? [sel, ...list.filter(x => x !== sel)] : list) {
      const g = ghost(ed, a.x, a.y, a.dir);
      if (g && inBox([p.rx, p.ry], g.box)) return a;
    }
    return null;
  }

  arrivalDown(p, ar) {
    const ed = this.ed;
    if (!(ed.sel?.kind === 'arrival' && ed.sel.key === ar.key)) ed.select({ kind: 'arrival', key: ar.key });
    const w = writable(ed, ar);
    if (w.loading) ed.ensureDoc(w.loading).then(() => ed.schedule(['inspector']));
    this.drag = { type: 'arrival', ar, start: p, started: false, editable: w.ok, why: w.why, orig: [ar.x, ar.y],
      before: w.ok && ar.kind !== 'opening' ? befores(ed, ar) : [], opening: ar.kind === 'opening' ? { ...ed.gameOpening } : null };
  }

  // near the selected polygon's outline (so a double-click there can add a vertex)
  onSelectedEdge(p) {
    const sel = this.ed.sel;
    const o = sel?.kind === 'object' && this.room.objects.get(sel.id);
    return !!(o?.hot && nearestEdge(o.hot, [p.rx, p.ry]).d <= this.T());
  }

  // ------------------------------------------------------------ pointer
  down(ev) {
    const ed = this.ed;
    if (!ed.active || !this.room) return;
    this.layer.setPointerCapture(ev.pointerId);
    ed.blurInputs();
    const p = this.pos(ev);
    if (ev.button === 1 || this.space) { this.drag = { type: 'pan', last: [ev.clientX, ev.clientY] }; return; }
    if (ev.button === 2) { if (ed.tool === 'walk') this.pathClick(p); return; }
    if (ev.button !== 0) return;
    if (ed.areaPick) { ed.areaPick.a = [p.rx, p.ry]; ed.areaPick.b = [p.rx, p.ry]; this.drag = { type: 'area' }; return; }
    if (ed.ruler.contains(p.cx, p.cy)) { this.rulerDown(p); return; }
    if (ed.tool === 'walk') this.walkDown(p);
    else if (ed.tool === 'select') this.selectDown(p);
  }

  selectDown(p) {
    const ed = this.ed;
    const h = this.handleAt(p);
    if (h) {
      if (h.kind === 'vertex') ed.vsel = h.vi;
      this.startDrag(p, h);
      return;
    }
    const same = this.lastDown && Math.hypot(p.cx - this.lastDown[0], p.cy - this.lastDown[1]) < 4;
    this.lastDown = [p.cx, p.cy];
    if (this.onSelectedEdge(p)) { this.startDrag(p, { kind: 'body' }); return; }
    // arrival points: their feet first; the selected one's faint Guybrush too
    const ar = this.arrivalAt(p, true) || (ed.sel?.kind === 'arrival' && this.arrivalAt(p, false)?.key === ed.sel.key ? this.arrivalAt(p, false) : null);
    if (ar) { this.arrivalDown(p, ar); return; }
    const cands = this.candidates(p.rx, p.ry);
    if (!cands.length) {
      const g = this.arrivalAt(p, false);
      if (g) { this.arrivalDown(p, g); return; }
      ed.select(null);
      return;
    }
    const cur = ed.sel ? cands.findIndex(c => c.kind === ed.sel.kind && c.id === ed.sel.id) : -1;
    const pick = cur >= 0 ? cands[cur] : cands[0];
    if (cur < 0) ed.select({ kind: pick.kind, id: pick.id });
    ed.vsel = null;
    this.startDrag(p, { kind: 'body' });
    // a click (no drag) on the same spot again: the next hotspot under it
    this.drag.cycle = cur >= 0 && same && cands.length > 1 ? cands[(cur + 1) % cands.length] : null;
  }

  walkDown(p) {
    const ed = this.ed;
    const h = this.handleAt(p);
    if (h) {
      ed.select({ kind: 'walk', poly: h.poly, index: h.index });
      ed.vsel = h.vi;
      this.startDrag(p, h);
      return;
    }
    const w = this.room.def.walk || {};
    const hi = (w.holes || []).findIndex(hp => pointInPoly([p.rx, p.ry], hp));
    if (hi >= 0) { ed.select({ kind: 'walk', poly: 'holes', index: hi }); this.startDrag(p, { kind: 'hole', index: hi }); return; }
    const pi = (w.polys || []).findIndex(pp => pointInPoly([p.rx, p.ry], pp));
    ed.select(pi >= 0 ? { kind: 'walk', poly: 'polys', index: pi } : null);
  }

  rulerDown(p) {
    const ed = this.ed;
    const i = ed.ruler.pointAt(p.cx, p.cy);
    ed.select({ kind: 'scale' });
    if (i < 0) return;
    ed.vsel = i;
    if (!ed.check('scale')) return;
    const before = clone(this.doc.get('scale'));
    this.drag = { type: 'scale', i, start: p, started: true, before: new Map([['scale', before]]), orig: before };
  }

  // the paths a drag changes, their values before it, magnets without the dragged shape
  startDrag(p, h) {
    const ed = this.ed, sel = ed.sel;
    const d = { type: h.kind, h, start: p, started: false, before: new Map(), mags: null };
    const want = [];
    if (h.kind === 'wvert') want.push('walk.' + h.poly);
    else if (h.kind === 'hole') want.push('walk.holes');
    else if (sel?.kind === 'object') {
      const o = this.room.objects.get(sel.id);
      if (h.kind === 'walkTo') want.push(ed.path('walkTo'));
      else if (h.kind === 'box' || (h.kind === 'body' && o.box && !o.hot)) want.push(ed.path('box'));
      else if (h.kind === 'vertex' || (h.kind === 'body' && o.hot)) want.push(ed.path('hot'));
      // moving the whole hotspot takes its pictures and its walk-to point along
      if (h.kind === 'body' && want.length) {
        if (o.states && typeof o.states === 'object' && !o.states.$fn && Object.values(o.states).some(st => st && typeof st.img === 'string')) want.push(ed.path('states'));
        if (o.walkTo) want.push(ed.path('walkTo'));
      }
    } else if (sel?.kind === 'npc') {
      if (h.kind === 'walkTo') want.push(ed.path('walkTo'));
      else if (h.kind === 'nbox') want.push(ed.path('hot'));
      else if (h.kind === 'body' && this.room.def.actors?.[sel.id]) {
        // dragging a character moves where they stand (their hot rect is relative to the feet) and their walk-to
        want.push(`actors.${sel.id}`);
        if (this.room.def.npcs?.[sel.id]?.walkTo) want.push(ed.path('walkTo'));
      }
    }
    if (!want.length) { this.drag = { type: 'none', start: p, started: false, before: new Map(), cycle: null }; return; }
    d.editable = want.every(path => ed.check(path, true));
    for (const path of want) d.before.set(path, clone(this.doc.get(path)));
    d.orig = clone(this.doc.get(want[0]));
    d.path = want[0];
    this.drag = d;
  }

  move(ev) {
    const ed = this.ed;
    const p = this.pos(ev);
    ed.pointer(p);
    const d = this.drag;
    if (!d) { this.hover(p); return; }
    if (d.type === 'pan') { ed.panBy(ev.clientX - d.last[0], ev.clientY - d.last[1]); d.last = [ev.clientX, ev.clientY]; return; }
    if (d.type === 'area') { if (ed.areaPick) ed.areaPick.b = [p.rx, p.ry]; return; }
    if (!d.started) {
      if (Math.hypot(p.cx - d.start.cx, p.cy - d.start.cy) < DRAG_CSS) return;
      if (d.type === 'none') return;
      if (d.type === 'arrival' && !d.editable) { ed.notice(`Can't move this arrival: ${d.why}`, 'warn'); this.drag = null; return; }
      if (!d.editable) { ed.check(d.path); this.drag = null; return; }
      d.started = true;
      const sel = ed.sel;
      if (['box', 'vertex', 'nbox'].includes(d.type)) d.mags = magnets(ed, (k, id) => k === 'object' && sel?.kind === 'object' && id === sel.id);
      else if (d.type === 'wvert') d.mags = magnets(ed, (k, id) => k === d.h.poly && id === d.h.index);
    }
    if (d.type === 'scale') { this.scaleMove(d, p); return; }
    let q = [p.rx, p.ry];
    if (ev.shiftKey) {
      if (Math.abs(p.rx - d.start.rx) > Math.abs(p.ry - d.start.ry)) q[1] = d.start.ry; else q[0] = d.start.rx;
    }
    this.apply(d, q, !ev.altKey);
  }

  apply(d, q, magnet) {
    const ed = this.ed, sel = ed.sel;
    const sn = pt => { const r = snap(ed, pt, { mags: d.mags, magnet: magnet && !!d.mags }); ed.snapHit = r.hit; return r.p; };
    const [dx, dy] = [Math.round(q[0] - d.start.rx), Math.round(q[1] - d.start.ry)];
    const shift = pts => pts.map(([x, y]) => [x + dx, y + dy]);
    switch (d.type) {
      case 'box': { const [x, y] = sn(q); ed.live(d.path, resizeBox(d.orig, d.h.h, x, y)); break; }
      case 'vertex': { const pts = clone(d.orig); pts[d.h.vi] = sn(q); ed.live(d.path, pts); break; }
      case 'walkTo': ed.live(d.path, [Math.round(q[0]), Math.round(q[1])]); break;
      case 'nbox': {
        const a = this.e.actors.get(sel.id);
        const [x, y] = sn(q);
        const b = resizeBox(this.npcBox(a, d.orig), d.h.h, x, y);
        ed.live(d.path, [Math.round(b[0] - a.x), Math.round(b[1] - a.y), Math.round(b[2]), Math.round(b[3])]);
        break;
      }
      case 'body':
        for (const [path, v] of d.before) {
          if (path.endsWith('.box')) ed.live(path, [v[0] + dx, v[1] + dy, v[2], v[3]]);
          else if (path.endsWith('.hot')) ed.live(path, shift(v));
          else if (path.endsWith('.walkTo')) ed.live(path, [v[0] + dx, v[1] + dy]);
          else if (path.endsWith('.states')) ed.live(path, Object.fromEntries(Object.entries(v).map(([k, st]) =>
            [k, st && typeof st.img === 'string' ? { ...st, x: round2(st.x + dx), y: round2(st.y + dy) } : st])));
          else if (path.startsWith('actors.')) {
            ed.live(path, { ...v, x: Math.round(v.x + dx), y: Math.round(v.y + dy) });
            const a = this.e.actors.get(sel.id);
            if (a) { a.x = Math.round(v.x + dx); a.y = Math.round(v.y + dy); }
          }
        }
        break;
      case 'wvert': { const arr = clone(d.orig); arr[d.h.index][d.h.vi] = sn(q); ed.live(d.path, arr); break; }
      case 'arrival': {
        // where he stands: inside the walk area (the magnet; Alt: anywhere)
        let pt = [d.orig[0] + dx, d.orig[1] + dy];
        const walk = this.room.walk;
        if (magnet && walk && !walk.inside(pt)) pt = insidePoint(walk, pt);
        const [x, y] = pt.map(Math.round);
        d.to = [x, y];
        if (d.opening) { ed.gameOpening = { ...d.opening, x, y }; ed.arrivalCache = null; ed.schedule(['inspector']); break; }
        for (const b of d.before) ed.live(b.path, movedValue(b.t, b.before, x, y, d.ar.dir), b.doc);
        break;
      }
      case 'hole': { const arr = clone(d.orig); arr[d.h.index] = shift(arr[d.h.index]); ed.live(d.path, arr); break; }
    }
  }

  scaleMove(d, p) {
    const r = this.ed.ruler, pts = clone(d.orig), i = d.i;
    const lo = i > 0 ? pts[i - 1][0] + 1 : 0, hi = i < pts.length - 1 ? pts[i + 1][0] - 1 : 480;
    pts[i] = [Math.max(lo, Math.min(hi, Math.round(r.cssToY(p.cy)))), round2(r.xToS(p.cx))];
    this.ed.live('scale', pts);
  }

  up(ev) {
    const d = this.drag, ed = this.ed;
    this.drag = null;
    ed.snapHit = null;
    if (!d || d.type === 'pan') return;
    if (d.type === 'area') { ed.endArea(true); return; }
    if (!d.started) {
      if (d.cycle) ed.select({ kind: d.cycle.kind, id: d.cycle.id });
      return;
    }
    if (d.type === 'arrival') {
      if (d.opening) { if (d.to) ed.setOpening(d.to[0], d.to[1], d.opening.dir).then(ok => { if (!ok) { ed.gameOpening = d.opening; ed.arrivalCache = null; } }); }
      else this.doc.commitAcross('move arrival', d.before);
      return;
    }
    const labels = { box: 'resize box', vertex: 'move point', walkTo: 'move walk-to point', nbox: 'resize NPC hotspot', body: ed.sel?.kind === 'npc' ? 'move character' : 'move hotspot', wvert: 'move walk point', hole: 'move hole', scale: 'move scale point' };
    this.doc.commitDrag(labels[d.type] || 'edit', d.before);
    if (d.type === 'wvert' || d.type === 'hole') this.updatePath();
  }

  cancel() {
    const d = this.drag;
    this.drag = null;
    this.ed.snapHit = null;
    if (d?.started && d.type === 'arrival') {
      if (d.opening) this.ed.gameOpening = d.opening;
      else for (const b of d.before) this.ed.live(b.path, b.before, b.doc);
      this.ed.arrivalCache = null;
      return;
    }
    if (d?.started) for (const [path, v] of d.before) {
      this.ed.live(path, v);
      if (path.startsWith('actors.')) { const a = this.e.actors.get(path.slice(7)); if (a) { a.x = v.x; a.y = v.y; } }
    }
  }

  hover(p) {
    const ed = this.ed;
    let cursor = 'crosshair', hover = null;
    if (this.space) cursor = 'grab';
    else if (ed.ruler.contains(p.cx, p.cy)) cursor = ed.ruler.pointAt(p.cx, p.cy) >= 0 ? 'grab' : 'default';
    else if (ed.tool === 'select' || ed.tool === 'walk') {
      const h = this.handleAt(p);
      if (h) cursor = h.h ? CURSORS[h.h] : 'grab';
      else if (ed.tool === 'select' && this.arrivalAt(p, true)) { const a = this.arrivalAt(p, true); hover = { kind: 'arrival', key: a.key }; cursor = 'grab'; }
      else if (ed.tool === 'select') {
        const c = this.candidates(p.rx, p.ry)[0];
        if (c) { hover = { kind: c.kind, id: c.id }; cursor = ed.sel && ed.sel.kind === c.kind && ed.sel.id === c.id ? 'move' : 'pointer'; }
      }
    }
    ed.hover = hover;
    this.layer.style.cursor = cursor;
  }

  dbl(ev) {
    const ed = this.ed;
    if (!ed.active || !this.room) return;
    const p = this.pos(ev), T = this.T();
    if (ed.ruler.contains(p.cx, p.cy)) { this.addScalePoint(p); return; }
    if (ed.tool === 'walk') {
      const w = this.room.def.walk || {};
      let best = null;
      for (const poly of ['polys', 'holes']) {
        (w[poly] || []).forEach((pts, index) => {
          const r = nearestEdge(pts, [p.rx, p.ry]);
          if (r.d <= T && (!best || r.d < best.d)) best = { ...r, poly, index };
        });
      }
      if (!best) return;
      const arr = clone(w[best.poly]);
      arr[best.index].splice(best.i + 1, 0, best.q.map(Math.round));
      if (ed.edit('add walk point', [{ path: 'walk.' + best.poly, after: arr }])) {
        ed.select({ kind: 'walk', poly: best.poly, index: best.index });
        ed.vsel = best.i + 1;
        this.updatePath();
      }
      return;
    }
    const sel = ed.sel, o = sel?.kind === 'object' && this.room.objects.get(sel.id);
    if (ed.tool === 'select' && o?.hot) {
      const r = nearestEdge(o.hot, [p.rx, p.ry]);
      if (r.d > T) return;
      const pts = clone(o.hot);
      pts.splice(r.i + 1, 0, r.q.map(Math.round));
      if (ed.edit('add point', [{ path: ed.path('hot'), after: pts }])) ed.vsel = r.i + 1;
    }
  }

  addScalePoint(p) {
    const ed = this.ed, pts = clone(this.doc.get('scale') || []);
    const y = Math.round(ed.ruler.cssToY(p.cy)), s = round2(ed.ruler.xToS(p.cx));
    if (pts.some(q => q[0] === y)) return;
    pts.push([y, s]);
    pts.sort((a, b) => a[0] - b[0]);
    if (ed.edit('add scale point', [{ path: 'scale', after: pts }])) { ed.select({ kind: 'scale' }); ed.vsel = pts.findIndex(q => q[0] === y); }
  }

  wheel(ev) {
    ev.preventDefault();
    if (!this.ed.active) return;
    if (ev.ctrlKey || ev.metaKey) this.ed.zoomAt(Math.exp(-ev.deltaY * 0.01), ev.clientX, ev.clientY);
    else this.ed.panBy(-ev.deltaX - (ev.shiftKey ? ev.deltaY : 0), ev.shiftKey ? 0 : -ev.deltaY);
  }

  // ------------------------------------------------------------ path test (walk tool, right clicks)
  pathClick(p) {
    const t = this.ed.pathTest;
    if (!t || t.b) this.ed.pathTest = { a: [p.rx, p.ry] };
    else { t.b = [p.rx, p.ry]; this.updatePath(); }
  }

  updatePath() {
    const t = this.ed.pathTest, walk = this.room?.walk;
    if (!t?.a || !t.b || !walk) return;
    t.from = walk.closest(t.a);
    t.path = walk.path(t.a, t.b);
  }

  // ------------------------------------------------------------ keyboard edits
  nudge(dx, dy) {
    const ed = this.ed, sel = ed.sel, room = this.room;
    if (!sel || !room) return;
    const key = 'nudge:' + JSON.stringify(sel) + ':' + ed.vsel;
    const mv = pts => pts.map(([x, y]) => [x + dx, y + dy]);
    if (sel.kind === 'arrival') { const a = ed.arrival(sel.key); if (a) ed.moveArrival(a, a.x + dx, a.y + dy, a.dir, key); return; }
    if (sel.kind === 'object') {
      const o = room.objects.get(sel.id);
      if (o?.hot) {
        let pts = clone(o.hot);
        if (ed.vsel != null && pts[ed.vsel]) pts[ed.vsel] = [pts[ed.vsel][0] + dx, pts[ed.vsel][1] + dy]; else pts = mv(pts);
        ed.edit('nudge', [{ path: ed.path('hot'), after: pts }], key);
      } else if (o?.box) ed.edit('nudge', [{ path: ed.path('box'), after: [o.box[0] + dx, o.box[1] + dy, o.box[2], o.box[3]] }], key);
    } else if (sel.kind === 'npc') {
      const hot = room.def.npcs?.[sel.id]?.hot;
      if (hot) ed.edit('nudge', [{ path: ed.path('hot'), after: [hot[0] + dx, hot[1] + dy, hot[2], hot[3]] }], key);
    } else if (sel.kind === 'walk') {
      const arr = clone(room.def.walk?.[sel.poly] || []);
      if (!arr[sel.index]) return;
      if (ed.vsel != null) { const v = arr[sel.index][ed.vsel]; arr[sel.index][ed.vsel] = [v[0] + dx, v[1] + dy]; }
      else if (sel.poly === 'holes') arr[sel.index] = mv(arr[sel.index]);
      else return;
      ed.edit('nudge', [{ path: 'walk.' + sel.poly, after: arr }], key);
      this.updatePath();
    } else if (sel.kind === 'scale' && ed.vsel != null) {
      const pts = clone(room.def.scale || []), i = ed.vsel;
      if (!pts[i]) return;
      const lo = i > 0 ? pts[i - 1][0] + 1 : 0, hi = i < pts.length - 1 ? pts[i + 1][0] - 1 : 480;
      pts[i] = [Math.max(lo, Math.min(hi, pts[i][0] + dy)), round2(Math.max(0.05, pts[i][1] + dx * 0.01))];
      ed.edit('nudge', [{ path: 'scale', after: pts }], key);
    }
  }

  deleteSelected() {
    const ed = this.ed, sel = ed.sel, room = this.room;
    if (!sel || !room) return;
    if (sel.kind === 'arrival') {
      // only an entry no exit uses can go (the others are the exits' arrival points: delete or change the exit)
      const a = ed.arrival(sel.key);
      if (a?.kind === 'entry' && ed.edit('delete entry', [{ path: a.targets[0].path, after: undefined }])) ed.select(null);
      else if (a) ed.notice('An arrival point goes with its exit: change or delete the exit in the room it comes from.', 'info');
      return;
    }
    if (sel.kind === 'object' && ed.vsel != null) {
      const o = room.objects.get(sel.id);
      if (!o?.hot || o.hot.length <= 3) return ed.notice('A polygon needs at least 3 points.', 'warn');
      const pts = clone(o.hot); pts.splice(ed.vsel, 1);
      if (ed.edit('delete point', [{ path: ed.path('hot'), after: pts }])) ed.vsel = null;
    } else if (sel.kind === 'walk') {
      const arr = clone(room.def.walk?.[sel.poly] || []);
      if (ed.vsel != null) {
        if (arr[sel.index].length <= 3) return ed.notice('A polygon needs at least 3 points.', 'warn');
        arr[sel.index].splice(ed.vsel, 1);
        if (ed.edit('delete walk point', [{ path: 'walk.' + sel.poly, after: arr }])) ed.vsel = null;
      } else if (sel.poly === 'holes') {
        arr.splice(sel.index, 1);
        if (ed.edit('delete hole', [{ path: 'walk.holes', after: arr }])) ed.select(null);
      }
      this.updatePath();
    } else if (sel.kind === 'scale' && ed.vsel != null) {
      const pts = clone(room.def.scale || []);
      if (pts.length <= 1) return;
      pts.splice(ed.vsel, 1);
      if (ed.edit('delete scale point', [{ path: 'scale', after: pts }])) ed.vsel = null;
    }
  }

  addHole() {
    const ed = this.ed, room = this.room, walk = room.walk;
    const cx = Math.round(this.e.camX + 320);
    const c = walk ? walk.closest([cx, 400]).map(Math.round) : [cx, 400];
    const hole = [[c[0] - 20, c[1] - 8], [c[0] + 20, c[1] - 8], [c[0] + 20, c[1] + 8], [c[0] - 20, c[1] + 8]];
    const arr = clone(room.def.walk?.holes || []);
    arr.push(hole);
    if (ed.edit('add hole', [{ path: 'walk.holes', after: arr }])) { ed.select({ kind: 'walk', poly: 'holes', index: arr.length - 1 }); this.updatePath(); }
  }

  setFace(dir) {
    const sel = this.ed.sel;
    if (sel?.kind === 'arrival') { const a = this.ed.arrival(sel.key); if (a && dir) this.ed.moveArrival(a, a.x, a.y, dir); return; }
    if (sel?.kind === 'object' || sel?.kind === 'npc') this.ed.edit('face', [{ path: this.ed.path('face'), after: dir || undefined }]);
  }

  // box <-> polygon
  toggleShape() {
    const ed = this.ed, sel = ed.sel;
    const o = sel?.kind === 'object' && this.room.objects.get(sel.id);
    if (!o) return;
    if (o.hot) {
      const [x, y, w, h] = bboxOf(o.hot).map(Math.round);
      ed.edit('polygon to box', [{ path: ed.path('box'), after: [x, y, w, h] }, { path: ed.path('hot'), after: undefined }]);
    } else if (o.box) {
      ed.edit('box to polygon', [{ path: ed.path('hot'), after: boxPoly(o.box) }, { path: ed.path('box'), after: undefined }]);
    }
    ed.vsel = null;
  }

  addBox() {
    const ed = this.ed, sel = ed.sel;
    if (sel?.kind === 'object') {
      const x = Math.round(this.e.camX + 290);
      ed.edit('add box', [{ path: ed.path('box'), after: [x, 200, 60, 60] }]);
    } else if (sel?.kind === 'npc') {
      const a = this.e.actors.get(sel.id), b = a.bounds(this.room);
      ed.edit('add NPC hotspot', [{ path: ed.path('hot'), after: [Math.round(b.x - a.x), Math.round(b.y - a.y), Math.round(b.w), Math.round(b.h)] }]);
    }
  }

  // hotspot box = the visible (alpha) bounds of the object's current sprite
  fitSprite() {
    const ed = this.ed, sel = ed.sel;
    const o = sel?.kind === 'object' && this.room.objects.get(sel.id);
    const sp = o && this.room.objSprite(this.e, o);
    if (!sp?.img) return ed.notice('This object has no sprite in its current state.', 'warn');
    const b = alphaBox(sp.img);
    const fx = sp.w / sp.img.naturalWidth, fy = sp.h / sp.img.naturalHeight;
    const x0 = Math.floor(sp.x + b[0] * fx), y0 = Math.floor(sp.y + b[1] * fy);
    const x1 = Math.ceil(sp.x + (b[0] + b[2]) * fx), y1 = Math.ceil(sp.y + (b[1] + b[3]) * fy);
    ed.edit('fit box to sprite', [{ path: ed.path('box'), after: [x0, y0, x1 - x0, y1 - y0] }, { path: ed.path('hot'), after: undefined }]);
  }

  snapWalkToInside() {
    const ed = this.ed, room = this.room, sel = ed.sel;
    const cur = ed.doc.get(ed.path('walkTo'));
    if (!cur || !room.walk) return;
    ed.edit('walk-to inside', [{ path: ed.path('walkTo'), after: insidePoint(room.walk, cur) }]);
  }
}

const alphaCache = new Map();
function alphaBox(img) {
  if (alphaCache.has(img.src)) return alphaCache.get(img.src);
  const w = img.naturalWidth, h = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const x = cv.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const a = x.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let i = 0; i < w; i++) {
    if (a[(y * w + i) * 4 + 3] > 24) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const b = x1 < 0 ? [0, 0, w, h] : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  alphaCache.set(img.src, b);
  return b;
}
