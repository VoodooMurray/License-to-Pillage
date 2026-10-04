// The scale ruler along the left edge of the view: room y downwards (matching the room), actor scale
// to the right. Web engine curve (all points, piecewise) solid; the ScummVM build's (first and last
// point only, capped at 1.0) dashed. Points are draggable; double-click adds one.

import { piecewise } from '../util.js';

const LEFT = 8, WIDTH = 124, PAD = 12, SMAX = 1.25;     // CSS px; scale range 0..SMAX

export function scummScale(points, y) {
  if (!points?.length) return 1;
  const a = points[0], b = points[points.length - 1];
  const t = b[0] === a[0] ? 0 : Math.max(0, Math.min(1, (y - a[0]) / (b[0] - a[0])));
  return Math.min(1, a[1] + (b[1] - a[1]) * t);
}

export class ScaleRuler {
  constructor(ed) { this.ed = ed; }

  get points() { return this.ed.room?.def.scale || null; }
  get visible() { return this.ed.active && this.ed.tool === 'scale'; }

  // CSS px geometry
  rect() { const v = this.ed.e.viewport; return { x: v.x + LEFT, y: v.y, w: WIDTH, h: v.h }; }
  sToX(s) { const r = this.rect(); return r.x + PAD + (s / SMAX) * (r.w - 2 * PAD); }
  xToS(x) { const r = this.rect(); return Math.max(0.05, Math.min(SMAX, ((x - r.x - PAD) / (r.w - 2 * PAD)) * SMAX)); }
  yToCss(y) { const e = this.ed.e; return (e.oy + y * e.k) / e.dpr; }
  cssToY(cy) { const e = this.ed.e; return (cy * e.dpr - e.oy) / e.k; }

  contains(cx, cy) { const r = this.rect(); return this.visible && cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h; }

  pointAt(cx, cy) {
    const pts = this.points || [];
    let best = -1, bd = 9;
    pts.forEach(([y, s], i) => { const d = Math.hypot(this.sToX(s) - cx, this.yToCss(y) - cy); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  // device-pixel drawing (called with the room transform in place)
  draw(c) {
    if (!this.visible) return;
    const e = this.ed.e, d = e.dpr, r = this.rect(), pts = this.points;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = 'rgba(14,10,6,0.78)';
    c.fillRect(r.x * d, r.y * d, r.w * d, r.h * d);
    c.strokeStyle = 'rgba(255,211,83,0.35)'; c.lineWidth = d;
    c.strokeRect(r.x * d + 0.5, r.y * d + 0.5, r.w * d - 1, r.h * d - 1);
    c.font = `${10 * d}px -apple-system, "Helvetica Neue", sans-serif`;
    c.textBaseline = 'top';
    // gridlines at 0.5 and 1.0
    for (const s of [0.5, 1]) {
      const x = this.sToX(s) * d;
      c.strokeStyle = s === 1 ? 'rgba(255,211,83,0.45)' : 'rgba(255,255,255,0.15)';
      c.beginPath(); c.moveTo(x, r.y * d); c.lineTo(x, (r.y + r.h) * d); c.stroke();
      c.fillStyle = 'rgba(255,211,83,0.8)'; c.fillText(s.toFixed(1), x + 2 * d, (r.y + 4) * d);
    }
    if (pts?.length) {
      const y0 = Math.max(0, this.cssToY(r.y)), y1 = Math.min(480, this.cssToY(r.y + r.h));
      const curve = (fn, color, dash) => {
        c.strokeStyle = color; c.lineWidth = 2 * d; c.setLineDash(dash.map(x => x * d));
        c.beginPath();
        for (let y = y0; y <= y1; y += 2) {
          const x = this.sToX(fn(y)) * d, yy = this.yToCss(y) * d;
          if (y === y0) c.moveTo(x, yy); else c.lineTo(x, yy);
        }
        c.stroke(); c.setLineDash([]);
      };
      curve(y => scummScale(pts, y), 'rgba(255,90,40,0.9)', [4, 3]);
      curve(y => piecewise(pts, y), 'rgba(255,211,83,1)', []);
      pts.forEach(([y, s], i) => {
        const x = this.sToX(s) * d, yy = this.yToCss(y) * d, sel = this.ed.sel?.kind === 'scale' && this.ed.vsel === i;
        c.fillStyle = sel ? '#ff3b0f' : '#ffd353'; c.strokeStyle = '#140d06'; c.lineWidth = 1.5 * d;
        c.beginPath(); c.arc(x, yy, 5 * d, 0, Math.PI * 2); c.fill(); c.stroke();
        c.fillStyle = '#f3e7cf';
        c.fillText(`${Math.round(y)} · ${s.toFixed(2)}`, Math.min(x + 7 * d, (r.x + r.w) * d - 52 * d), yy - 14 * d);
      });
    }
    // the mouse's y
    const m = this.ed.mouse;
    if (m && m.sy >= 0 && m.sy <= 480) {
      const yy = this.yToCss(m.sy) * d, s = this.ed.room ? this.ed.room.scaleAt(m.sy) : 1;
      c.strokeStyle = 'rgba(120,220,255,0.8)'; c.lineWidth = d;
      c.beginPath(); c.moveTo(r.x * d, yy); c.lineTo((r.x + r.w) * d, yy); c.stroke();
      c.fillStyle = 'rgba(120,220,255,1)';
      c.fillText(`y ${Math.round(m.sy)}  s ${s.toFixed(2)}`, (r.x + 4) * d, yy + 3 * d);
    }
    c.restore();
  }
}
