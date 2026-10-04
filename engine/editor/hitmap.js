// The effective hit map: for every 2x2 logical pixels of the room, what the engine's own hit test
// (engine.hotspotAt) returns, in the colors of tools/hotspot_map.py. Also counts the pixels each
// hotspot wins (the reachability lint). Recomputed shortly after edits.

import { colorFor } from './geom.js';

const STEP = 2;

export class HitMap {
  constructor(ed) {
    this.ed = ed;
    this.canvas = document.createElement('canvas');
    this.counts = new Map();     // 'object:id' | 'actor:id' -> pixels (in STEP x STEP cells)
    this.due = 1;
    this.valid = false;
  }

  invalidate(ms = 300) { this.due = performance.now() + ms; }

  update(force) {
    if ((this.due && performance.now() >= this.due) || force) { this.due = 0; this.compute(); }
  }

  compute() {
    const e = this.ed.e, room = e.room;
    if (!room) return;
    const w = Math.ceil(room.width / STEP), h = Math.ceil(room.height / STEP);
    this.canvas.width = w; this.canvas.height = h;
    const cx = this.canvas.getContext('2d');
    const img = cx.createImageData(w, h);
    const counts = new Map(), cols = new Map();
    const cam = e.camX;
    e.camX = 0;
    try {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const t = e.hotspotAt(x * STEP + STEP / 2, y * STEP + STEP / 2);
          if (!t) continue;
          const k = t.kind + ':' + t.id;
          counts.set(k, (counts.get(k) || 0) + 1);
          let c = cols.get(k);
          if (!c) cols.set(k, c = colorFor(k));
          const i = (y * w + x) * 4;
          img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 150;
        }
      }
    } finally { e.camX = cam; }
    cx.putImageData(img, 0, 0);
    this.counts = counts;
    this.room = room;
    this.valid = true;
    this.ed.hitmapChanged();
  }

  // at room coordinates
  draw(c) {
    if (!this.valid || this.room !== this.ed.e.room) return;
    c.save();
    c.imageSmoothingEnabled = false;
    c.globalAlpha = 0.55;
    c.drawImage(this.canvas, 0, 0, this.canvas.width * STEP, this.canvas.height * STEP);
    c.restore();
  }
}
