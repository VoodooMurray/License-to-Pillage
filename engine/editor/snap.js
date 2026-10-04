// Snapping for the editor's drags: magnets (vertices, edges, room borders, sprite edges) within a few
// screen pixels, then the grid step (1 logical px for geometry, 0.25 for sprites). Alt: grid only.

import { toSeg } from './geom.js';

const MAGNET_CSS_PX = 6;

// Candidate magnets of the current room, without the thing being dragged (exclude(kind, id) -> bool).
export function magnets(ed, exclude = () => false) {
  const room = ed.room, points = [], segs = [], xs = [], ys = [];
  const poly = (pts, kind, id) => {
    if (exclude(kind, id)) return;
    pts.forEach((p, i) => { points.push(p); segs.push([p, pts[(i + 1) % pts.length]]); });
  };
  for (const o of room.objects.values()) {
    if (o.hot) poly(o.hot, 'object', o.id);
    else if (o.box) { const [x, y, w, h] = o.box; poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], 'object', o.id); }
    const sp = room.objSprite(ed.e, o);
    if (sp && !exclude('sprite', o.id)) { xs.push([sp.x, sp.y, sp.y + sp.h], [sp.x + sp.w, sp.y, sp.y + sp.h]); ys.push([sp.y, sp.x, sp.x + sp.w], [sp.y + sp.h, sp.x, sp.x + sp.w]); }
  }
  const walk = room.def.walk || {};
  (walk.polys || []).forEach((p, i) => poly(p, 'polys', i));
  (walk.holes || []).forEach((p, i) => poly(p, 'holes', i));
  xs.push([0, 0, room.height], [room.width, 0, room.height]);
  ys.push([0, 0, room.width], [room.height, 0, room.width]);
  return { points, segs, xs, ys };
}

// -> {p: [x, y], hit: null | {x, y, kind}}
export function snap(ed, p, { step = 1, mags = null, magnet = true } = {}) {
  const round = v => Math.round(v / step) * step;
  if (!magnet || !mags) return { p: [round(p[0]), round(p[1])], hit: null };
  const T = MAGNET_CSS_PX * ed.e.dpr / ed.e.k;
  let best = null;
  for (const q of mags.points) {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d <= T && (!best || d < best.d)) best = { d, q };
  }
  if (best) return { p: [best.q[0], best.q[1]], hit: { x: best.q[0], y: best.q[1], kind: 'vertex' } };
  for (const [a, b] of mags.segs) {
    const r = toSeg(p, a, b);
    if (r.d <= T && (!best || r.d < best.d)) best = r;
  }
  if (best) return { p: [round(best.q[0]), round(best.q[1])], hit: { x: best.q[0], y: best.q[1], kind: 'edge' } };
  let x = round(p[0]), y = round(p[1]), hit = null;
  let bx = T, by = T;
  for (const [lx, y0, y1] of mags.xs) {
    const d = Math.abs(lx - p[0]);
    if (d <= bx && p[1] >= y0 - T && p[1] <= y1 + T) { bx = d; x = lx; hit = { x: lx, y: p[1], kind: 'line' }; }
  }
  for (const [ly, x0, x1] of mags.ys) {
    const d = Math.abs(ly - p[1]);
    if (d <= by && p[0] >= x0 - T && p[0] <= x1 + T) { by = d; y = ly; hit = { x: hit ? x : p[0], y: ly, kind: 'line' }; }
  }
  return { p: [x, y], hit };
}
