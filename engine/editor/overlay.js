// The editor's gizmos over the running room: hit map, walk area and holes, hotspot shapes in their
// hit-map colors, walk-to points with facing arrows, NPC hot rects, exits, labels, the path test,
// the scale probe and handles. Shapes are drawn in room coordinates; text and handles in device
// pixels so they stay the same size at any zoom.

import { colorFor, rgba, boxPoly, DIR_VEC } from './geom.js';
import { ghost } from './arrivals.js';

// arrival points by where they are defined: an exit, an entry of this room, the start point, a script, the game start,
// hand-written code
export const ARRIVAL_COLORS = { exit: '#7fd7ff', entry: '#c49bff', start: '#9cff9c', script: '#ffb36b', opening: '#ffe65a', code: '#b8b0a0' };

const FONT = '-apple-system, "Helvetica Neue", Helvetica, sans-serif';

export function drawOverlay(ed, c) {
  const e = ed.e, room = e.room;
  if (!room) return;
  const px = n => n * e.dpr / e.k;              // CSS px -> logical units
  const dev = (x, y) => [e.ox + (x - e.camX) * e.k, e.oy + y * e.k];
  const sel = ed.sel;
  c.save();
  c.translate(-e.camX, 0);
  c.lineJoin = 'round';

  if (ed.show.hitmap) ed.hitmap.draw(c);

  // walk area: polygons minus holes
  const walk = room.def.walk;
  if (walk && (ed.show.walk || ed.tool === 'walk')) {
    const trace = pts => { c.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) c.lineTo(p[0], p[1]); c.closePath(); };
    c.beginPath();
    for (const p of walk.polys || []) trace(p);
    for (const h of walk.holes || []) trace(h);
    c.fillStyle = ed.tool === 'walk' ? 'rgba(80,255,130,0.16)' : 'rgba(80,255,130,0.07)';
    c.fill('evenodd');
    c.lineWidth = px(ed.tool === 'walk' ? 1.6 : 1);
    (walk.polys || []).forEach((p, i) => {
      c.beginPath(); trace(p);
      const on = sel?.kind === 'walk' && sel.poly === 'polys' && sel.index === i;
      c.strokeStyle = on ? 'rgba(170,255,190,1)' : 'rgba(80,255,130,0.8)'; c.stroke();
    });
    (walk.holes || []).forEach((h, i) => {
      c.beginPath(); trace(h);
      const on = sel?.kind === 'walk' && sel.poly === 'holes' && sel.index === i;
      c.fillStyle = on ? 'rgba(255,80,40,0.28)' : 'rgba(255,80,40,0.14)'; c.fill();
      c.strokeStyle = on ? 'rgba(255,170,140,1)' : 'rgba(255,90,60,0.9)'; c.stroke();
    });
  }

  // hotspots
  const hot = ed.show.hotspots && ed.tool !== 'walk';
  if (hot) {
    for (const o of room.objects.values()) {
      const pts = o.hot || (o.box && boxPoly(o.box));
      if (!pts) continue;
      const on = sel?.kind === 'object' && sel.id === o.id, over = ed.hover?.kind === 'object' && ed.hover.id === o.id;
      const col = colorFor('object:' + o.id);
      const st = room.objState(e, o.id);
      const inactive = st.hidden || (o.when && !o.when(e.api));
      c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) c.lineTo(p[0], p[1]); c.closePath();
      if (on || over) { c.fillStyle = rgba(col, on ? 0.2 : 0.12); c.fill(); }
      c.setLineDash(inactive ? [px(4), px(3)] : []);
      c.lineWidth = px(on ? 2.4 : over ? 1.8 : 1.2);
      c.strokeStyle = rgba(col, on || over ? 1 : 0.8);
      c.stroke();
      c.setLineDash([]);
    }
    for (const a of e.actorsIn(room.id)) {
      if (a === e.player) continue;
      const n = room.def.npcs?.[a.id];
      const on = sel?.kind === 'npc' && sel.id === a.id, over = ed.hover?.kind === 'npc' && ed.hover.id === a.id;
      const col = colorFor('actor:' + a.id);
      c.lineWidth = px(on ? 2.4 : over ? 1.8 : 1.2);
      if (n?.hot) {
        const [x, y, w, h] = n.hot;
        if (on || over) { c.fillStyle = rgba(col, on ? 0.2 : 0.12); c.fillRect(a.x + x, a.y + y, w, h); }
        c.strokeStyle = rgba(col, 1); c.strokeRect(a.x + x, a.y + y, w, h);
      } else {
        const b = a.bounds(room);
        c.setLineDash([px(3), px(3)]); c.strokeStyle = rgba(col, 0.8); c.strokeRect(b.x, b.y, b.w, b.h); c.setLineDash([]);
      }
      c.fillStyle = rgba(col, 1);
      c.beginPath(); c.arc(a.x, a.y, px(3), 0, Math.PI * 2); c.fill();
    }
    // walk-to points: faint for all, strong for the selection
    for (const o of room.objects.values()) {
      if (!(o.box || o.hot) || o.noHotspot) continue;
      const on = sel?.kind === 'object' && sel.id === o.id;
      walkTo(o.walkTo || room.walkToOf(o), !!o.walkTo, o.face, room.centerOf(o), on);
    }
    for (const a of e.actorsIn(room.id)) {
      const n = room.def.npcs?.[a.id];
      if (a === e.player || !n?.walkTo) continue;
      walkTo(n.walkTo, true, n.face, [a.x, a.y - 40], sel?.kind === 'npc' && sel.id === a.id);
    }
  }

  // arrival points: a faint Guybrush as he arrives (his size there, his facing), feet and facing arrow
  const arrive = ed.show.arrivals && ed.tool === 'select' ? ed.arrivalList() : [];
  for (const a of arrive) {
    const on = sel?.kind === 'arrival' && sel.key === a.key, over = ed.hover?.kind === 'arrival' && ed.hover.key === a.key;
    const g = ghost(ed, a.x, a.y, a.dir);
    if (g?.parts.length) {
      c.globalAlpha = on ? 0.62 : over ? 0.48 : 0.3;
      for (const q of g.parts) e.drawPart(c, q);
      c.globalAlpha = 1;
    }
    const s = room.scaleAt(a.y), col = ARRIVAL_COLORS[a.kind] || '#fff';
    const bad = room.walk && !room.walk.inside([a.x, a.y]);
    if ((on || over) && g) { c.setLineDash([px(4), px(3)]); c.strokeStyle = col; c.lineWidth = px(1); c.strokeRect(...g.box); c.setLineDash([]); }
    c.strokeStyle = bad ? '#ff3b0f' : col;
    c.lineWidth = px(on ? 2.4 : 1.5);
    c.beginPath(); c.ellipse(a.x, a.y, Math.max(px(9), 24 * s), Math.max(px(3.5), 7 * s), 0, 0, Math.PI * 2); c.stroke();
    c.fillStyle = col;
    c.beginPath(); c.arc(a.x, a.y, px(on ? 3.5 : 2.5), 0, Math.PI * 2); c.fill();
    const v = DIR_VEC[a.dir];
    if (v) {
      const L = Math.max(px(16), 40 * s), tx = a.x + v[0] * L, ty = a.y + v[1] * L * 0.5;
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(tx, ty); c.stroke();
      const an = Math.atan2(ty - a.y, tx - a.x), H = px(6);
      c.beginPath(); c.moveTo(tx, ty);
      c.lineTo(tx - H * Math.cos(an - 0.5), ty - H * Math.sin(an - 0.5));
      c.lineTo(tx - H * Math.cos(an + 0.5), ty - H * Math.sin(an + 0.5));
      c.closePath(); c.fill();
    }
  }

  function walkTo(p, explicit, face, center, on) {
    if (!on && !ed.show.walkTo) return;
    c.strokeStyle = on ? 'rgba(255,230,90,0.9)' : 'rgba(255,230,90,0.35)';
    c.lineWidth = px(on ? 1.2 : 0.8);
    c.setLineDash([px(3), px(3)]);
    c.beginPath(); c.moveTo(center[0], center[1]); c.lineTo(p[0], p[1]); c.stroke();
    c.setLineDash([]);
    c.fillStyle = explicit ? (on ? '#ffe65a' : 'rgba(255,230,90,0.7)') : 'rgba(0,0,0,0)';
    c.strokeStyle = on ? '#ffe65a' : 'rgba(255,230,90,0.7)';
    c.lineWidth = px(1.2);
    c.beginPath(); c.arc(p[0], p[1], px(on ? 4 : 2.5), 0, Math.PI * 2); c.fill(); c.stroke();
    if (face && DIR_VEC[face]) {
      const [dx, dy] = DIR_VEC[face], L = px(on ? 18 : 11);
      const tx = p[0] + dx * L, ty = p[1] + dy * L;
      c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(tx, ty); c.stroke();
      const a = Math.atan2(dy, dx), H = px(5);
      c.beginPath(); c.moveTo(tx, ty);
      c.lineTo(tx - H * Math.cos(a - 0.5), ty - H * Math.sin(a - 0.5));
      c.lineTo(tx - H * Math.cos(a + 0.5), ty - H * Math.sin(a + 0.5));
      c.closePath(); c.fillStyle = c.strokeStyle; c.fill();
    }
  }

  // path test (walk tool, right clicks)
  const pt = ed.pathTest;
  if (pt?.a && ed.tool === 'walk') {
    c.strokeStyle = 'rgba(120,220,255,1)'; c.fillStyle = 'rgba(120,220,255,1)'; c.lineWidth = px(2);
    if (pt.path) {
      c.beginPath(); c.moveTo(pt.from[0], pt.from[1]);
      for (const p of pt.path) c.lineTo(p[0], p[1]);
      c.stroke();
      for (const p of pt.path) { c.beginPath(); c.arc(p[0], p[1], px(2.5), 0, Math.PI * 2); c.fill(); }
    }
    for (const p of [pt.a, pt.b].filter(Boolean)) { c.beginPath(); c.arc(p[0], p[1], px(4), 0, Math.PI * 2); c.stroke(); }
  }
  c.restore();

  // ---- device-pixel layer: labels, exits, handles, snap ring, probe readout
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  const d = e.dpr;
  const text = (s, x, y, color = '#fff', size = 11, align = 'center') => {
    c.font = `600 ${size * d}px ${FONT}`; c.textAlign = align; c.textBaseline = 'middle';
    c.lineWidth = 3 * d; c.strokeStyle = 'rgba(0,0,0,0.85)'; c.strokeText(s, x, y);
    c.fillStyle = color; c.fillText(s, x, y);
  };
  if (hot && ed.show.labels) {
    for (const o of room.objects.values()) {
      if (!(o.box || o.hot)) continue;
      const [x, y] = dev(...room.centerOf(o));
      const name = typeof o.name === 'function' ? o.id : (o.name || o.id);
      text(o.exit ? `${name} → ${o.exit.room}` : name, x, y, rgba(colorFor('object:' + o.id).map(v => Math.min(255, v + 60))));
    }
    for (const a of e.actorsIn(room.id)) {
      if (a === e.player) continue;
      const n = room.def.npcs?.[a.id];
      const [x, y] = dev(a.x, n?.hot ? a.y + n.hot[1] + n.hot[3] / 2 : a.y - 40);
      text(n?.name || a.def.name || a.id, x, y, rgba(colorFor('actor:' + a.id).map(v => Math.min(255, v + 60))));
    }
  }
  // labels under the feet; arrivals at (almost) the same spot stack theirs
  const placed = [];
  for (const a of arrive) {
    const on = ed.sel?.kind === 'arrival' && ed.sel.key === a.key, over = ed.hover?.kind === 'arrival' && ed.hover.key === a.key;
    if (!ed.show.labels && !on && !over) continue;
    const [x, y] = dev(a.x, a.y);
    const n = placed.filter(q => Math.abs(q[0] - x) < 70 * d && Math.abs(q[1] - y) < 8 * d).length;
    placed.push([x, y]);
    text(a.label, x, y + (14 + 13 * n) * d, ARRIVAL_COLORS[a.kind] || '#fff', on ? 12 : 10.5);
  }
  for (const h of ed.tools.handles()) {
    const [x, y] = dev(h.x, h.y);
    const on = h.selected, s = (h.kind === 'walkTo' ? 5 : 4) * d;
    c.fillStyle = on ? '#ff3b0f' : h.kind === 'walkTo' ? '#ffe65a' : '#ffd353';
    c.strokeStyle = '#140d06'; c.lineWidth = 1.5 * d;
    if (h.kind === 'walkTo') { c.beginPath(); c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y); c.closePath(); c.fill(); c.stroke(); }
    else { c.fillRect(x - s, y - s, 2 * s, 2 * s); c.strokeRect(x - s, y - s, 2 * s, 2 * s); }
  }
  if (ed.snapHit) {
    const [x, y] = dev(ed.snapHit.x, ed.snapHit.y);
    c.strokeStyle = '#78dcff'; c.lineWidth = 1.5 * d;
    c.beginPath(); c.arc(x, y, 8 * d, 0, Math.PI * 2); c.stroke();
  }
  if (ed.probeOn && ed.mouse?.inRoom) {
    const p = e.player, [x, y] = dev(p.x, p.y);
    const ok = !room.walk || room.walk.inside([p.x, p.y]);
    c.strokeStyle = ok ? '#78dcff' : '#ff3b0f'; c.lineWidth = 1.5 * d;
    c.beginPath(); c.ellipse(x, y, 16 * d, 5 * d, 0, 0, Math.PI * 2); c.stroke();
    const b = p.bounds(room);
    text(`scale ${p.scale(room).toFixed(2)} · ${Math.round(b.h)} px tall${ok ? '' : ' · outside walk area'}`, x, y + 16 * d, ok ? '#bfeeff' : '#ff9a7a', 11);
  }
  c.restore();
  ed.ruler.draw(c);
}
