// Walkable area = union of polygons minus holes, in room logical coordinates.
// Pathfinding: visibility graph over (slightly inset) polygon vertices + A*.

import { pointInPoly, dist } from './util.js';

function segIntersect(p1, p2, p3, p4) {
  // proper intersection (not just touching at endpoints)
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
         ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

function closestOnSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

export class WalkArea {
  constructor(def = {}) {
    this.polys = def.polys || [];
    this.holes = def.holes || [];
    this.edges = [];
    for (const poly of [...this.polys, ...this.holes]) {
      for (let i = 0; i < poly.length; i++) this.edges.push([poly[i], poly[(i + 1) % poly.length]]);
    }
    this.nodes = this.buildNodes();
  }

  inside(p) {
    if (!this.polys.length) return true;
    return this.polys.some(poly => pointInPoly(p, poly)) && !this.holes.some(h => pointInPoly(p, h));
  }

  // Nearest walkable point (pulled 1.5 px inside the boundary).
  closest(p) {
    if (this.inside(p)) return [p[0], p[1]];
    let best = null, bd = Infinity;
    for (const [a, b] of this.edges) {
      const q = closestOnSeg(p, a, b);
      const d = dist(p, q);
      if (d < bd) { bd = d; best = q; }
    }
    if (!best) return [p[0], p[1]];
    // nudge inside
    for (const r of [1.5, 3, 6]) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const q = [best[0] + Math.cos(a) * r, best[1] + Math.sin(a) * r];
        if (this.inside(q)) return q;
      }
    }
    return best;
  }

  buildNodes() {
    const nodes = [];
    for (const poly of [...this.polys, ...this.holes]) {
      for (let i = 0; i < poly.length; i++) {
        const v = poly[i], a = poly[(i + poly.length - 1) % poly.length], b = poly[(i + 1) % poly.length];
        // bisector direction
        const ax = a[0] - v[0], ay = a[1] - v[1], bx = b[0] - v[0], by = b[1] - v[1];
        const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
        let dx = ax / la + bx / lb, dy = ay / la + by / lb;
        const l = Math.hypot(dx, dy);
        if (l < 1e-6) { dx = -ay / la; dy = ax / la; } else { dx /= l; dy /= l; }
        for (const s of [2.5, -2.5]) {
          const q = [v[0] + dx * s, v[1] + dy * s];
          if (this.inside(q)) { nodes.push(q); break; }
        }
      }
    }
    return nodes;
  }

  visible(a, b) {
    for (const [p, q] of this.edges) if (segIntersect(a, b, p, q)) return false;
    // sample points to catch segments that leave through a vertex
    const n = Math.max(2, Math.ceil(dist(a, b) / 8));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (!this.inside([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return false;
    }
    return true;
  }

  // Returns a list of waypoints (excluding the start) from a to the nearest walkable point to b.
  path(a, b) {
    const start = this.closest(a), goal = this.closest(b);
    if (this.visible(start, goal)) return [goal];
    const pts = [start, goal, ...this.nodes];
    const n = pts.length;
    const g = new Array(n).fill(Infinity), f = new Array(n).fill(Infinity), prev = new Array(n).fill(-1);
    const open = new Set([0]), closed = new Set();
    g[0] = 0; f[0] = dist(start, goal);
    const vis = new Map();
    const canSee = (i, j) => {
      const k = i < j ? i * n + j : j * n + i;
      if (!vis.has(k)) vis.set(k, this.visible(pts[i], pts[j]));
      return vis.get(k);
    };
    while (open.size) {
      let cur = -1, bf = Infinity;
      for (const i of open) if (f[i] < bf) { bf = f[i]; cur = i; }
      if (cur === 1) break;
      open.delete(cur); closed.add(cur);
      for (let j = 0; j < n; j++) {
        if (j === cur || closed.has(j) || !canSee(cur, j)) continue;
        const ng = g[cur] + dist(pts[cur], pts[j]);
        if (ng < g[j]) { g[j] = ng; f[j] = ng + dist(pts[j], goal); prev[j] = cur; open.add(j); }
      }
    }
    if (prev[1] === -1) return [goal]; // unreachable: walk straight (engine clips at the boundary)
    const out = [];
    for (let i = 1; i !== 0 && i !== -1; i = prev[i]) out.push(pts[i]);
    return out.reverse();
  }
}
