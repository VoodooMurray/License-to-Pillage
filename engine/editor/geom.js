// Geometry helpers for the level editor (room logical coordinates).

import { pointInPoly } from '../util.js';

export { pointInPoly };

export const boxPoly = ([x, y, w, h]) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

export function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1 - x0, y1 - y0];
}

export const inBox = ([px, py], [x, y, w, h]) => px >= x && py >= y && px < x + w && py < y + h;

// nearest point on segment ab: {d, q, t}
export function toSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  const q = [a[0] + t * dx, a[1] + t * dy];
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), q, t };
}

// nearest edge of a closed polygon: {i (edge from poly[i] to poly[i+1]), d, q}
export function nearestEdge(poly, p) {
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const r = toSeg(p, poly[i], poly[(i + 1) % poly.length]);
    if (!best || r.d < best.d) best = { i, d: r.d, q: r.q };
  }
  return best;
}

function cross(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }

export function segsCross(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// true when two non-adjacent edges of the closed polygon cross
export function selfIntersects(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

export function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

export const centroid = pts => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

// the eight directions, and the numpad digit for each (8 = N, 6 = E, 2 = S, 4 = W ...)
export const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const NUMPAD = { 8: 'N', 9: 'NE', 6: 'E', 3: 'SE', 2: 'S', 1: 'SW', 4: 'W', 7: 'NW' };
export const DIR_VEC = { N: [0, -1], NE: [0.71, -0.71], E: [1, 0], SE: [0.71, 0.71], S: [0, 1], SW: [-0.71, 0.71], W: [-1, 0], NW: [-0.71, -0.71] };

// FNV-1a hash -> hue: the same colors as tools/hotspot_map.py's reports
export function colorFor(key) {
  let v = 2166136261;
  for (const ch of new TextEncoder().encode(key)) v = Math.imul(v ^ ch, 16777619) >>> 0;
  const h = (v % 360) / 60, s = 0.85, val = 1;
  const i = Math.floor(h), f = h - i, p = val * (1 - s), q = val * (1 - s * f), t = val * (1 - s * (1 - f));
  const [r, g, b] = [[val, t, p], [q, val, p], [p, val, t], [p, q, val], [t, p, val], [val, p, q]][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export const rgba = ([r, g, b], a = 1) => `rgba(${r},${g},${b},${a})`;

// the nearest whole-pixel point that is inside a walk area (WalkArea.closest lands on the edge, which may test outside)
export function insidePoint(walk, p) {
  if (!walk || walk.inside(p)) return p.map(Math.round);
  const c = walk.closest(p);
  let best = c.map(Math.round), bd = Infinity;
  for (let r = 0; r <= 6 && bd === Infinity; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const q = [Math.round(c[0]) + dx, Math.round(c[1]) + dy], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd && walk.inside(q)) { bd = d; best = q; }
    }
  }
  return best;
}
