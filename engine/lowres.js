// Alt+0: the original low-res graphics in the browser, like Alt+0 in the HD ScummVM build (and ScummVM without
// the HD pack). The frame is drawn at 640x480 and scaled up without smoothing. The room is reduced to 256 colours
// the way the ScummVM build does it (tools/scumm/build.py make_palette / to_indices): CMI's global palette with the
// art range replaced by a median cut of the room's background + sprites at 1x; the background is Floyd-Steinberg
// dithered once per room, everything drawn over it (actors, objects, water) is mapped to the nearest colour every
// frame. The interface uses CMI's original 1x images and fonts (cmi/lo, tools/extract_cmi.py lo).

import { imageNow } from './assets.js';

const MAX_CELS = 48;           // sprite cels per actor sampled into the room palette

export class LowRes {
  constructor(meta) {
    this.ref = Uint8Array.from(meta.rgb);
    [this.lo, this.hi] = meta.art;
    this.talk = new Set(Object.values(meta.talk || {}));
    this.canvas = document.createElement('canvas');
    this.canvas.width = 640; this.canvas.height = 480;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.rooms = new Map();          // room id -> {key, pal, lut, cand, bg (canvas), data, w, h}
  }

  // the room's palette and dithered background (null until the background image is loaded)
  room(engine, room) {
    const src = room.def.layers?.[0]?.img && engine.path(room.def.layers[0].img);
    const img = src && imageNow(src);
    if (!img) return null;
    let r = this.rooms.get(room.id);
    if (r && r.key === src) return r;
    const t0 = performance.now();
    const w = room.width, h = room.height;
    const bg = document.createElement('canvas');
    bg.width = w; bg.height = h;
    const bx = bg.getContext('2d', { willReadFrequently: true });
    bx.imageSmoothingQuality = 'high';
    bx.drawImage(img, 0, 0, w, h);
    const data = bx.getImageData(0, 0, w, h);
    // histogram: the background + the room's sprites (object states, occluders, actors' loaded cels)
    const hist = new Float64Array(32768 * 4);
    addPixels(hist, data.data, false);
    for (const im of spriteImages(engine, room)) {
      const sw = Math.max(1, Math.round(im.naturalWidth / 4)), sh = Math.max(1, Math.round(im.naturalHeight / 4));
      const cv = document.createElement('canvas');
      cv.width = sw; cv.height = sh;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(im, 0, 0, sw, sh);
      addPixels(hist, cx.getImageData(0, 0, sw, sh).data, true);
    }
    const pal = Uint8Array.from(this.ref);
    const art = medianCut(hist, this.hi - this.lo + 1);
    art.forEach((c, i) => pal.set(c, (this.lo + i) * 3));
    // candidates for "nearest colour": the art range + CMI's own colours (not the text colour slots)
    const cand = [];
    for (let i = 0; i < 256; i++) if ((i >= this.lo && i < this.lo + art.length) || ((i < this.lo || i > this.hi) && !this.talk.has(i))) cand.push(i);
    r = { key: src, pal, cand, lut: new Int16Array(32768).fill(-1), w, h };
    dither(data.data, w, h, k => nearest(r, k), pal);
    bx.putImageData(data, 0, 0);
    r.bg = bg; r.data = data.data;
    this.rooms.set(room.id, r);
    console.log(`lowres: ${room.id} palette + dither ${Math.round(performance.now() - t0)} ms`);
    return r;
  }

  // maps the room part of the frame (already drawn into this.ctx) to the room's colours; pixels that show the
  // dithered background unchanged are kept
  quantize(r, camX) {
    const img = this.ctx.getImageData(0, 0, 640, 480), d = img.data, bg = r.data, pal = r.pal, lut = r.lut;
    const cx = Math.round(camX), wmax = Math.min(640, r.w - cx);
    for (let y = 0; y < 480; y++) {
      let o = y * 2560;
      let b = (y * r.w + cx) * 4;
      const inBg = y < r.h;
      for (let x = 0; x < 640; x++, o += 4, b += 4) {
        if (inBg && x < wmax && d[o] === bg[b] && d[o + 1] === bg[b + 1] && d[o + 2] === bg[b + 2]) continue;
        const k = ((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3);
        let p = lut[k];
        if (p < 0) p = nearest(r, k);
        d[o] = pal[p * 3]; d[o + 1] = pal[p * 3 + 1]; d[o + 2] = pal[p * 3 + 2];
      }
    }
    this.ctx.putImageData(img, 0, 0);
  }
}

function* spriteImages(engine, room) {
  for (const o of room.objects.values()) {
    for (const s of Object.values(o.states || {})) {
      const im = s?.img && imageNow(engine.path(s.img));
      if (im) yield im;
    }
  }
  for (const oc of room.def.occluders || []) {
    const im = imageNow(engine.path(oc.img));
    if (im) yield im;
  }
  for (const a of engine.actorsIn(room.id)) {
    // CMI's Guybrush is drawn in the palette's fixed CMI colours; any other main character needs room colours
    if (!a.costume || (a === engine.player && String(a.costume.path || '').includes('guybrush') && engine.lowresFixedPalette)) continue;
    let n = 0;
    for (const id of Object.keys(a.costume.cels)) {
      const im = a.costume.celImage(id);
      if (im && ++n <= MAX_CELS) yield im;
    }
  }
}

// hist: per 15-bit colour [count, r sum, g sum, b sum]
function addPixels(hist, d, alpha) {
  for (let i = 0; i < d.length; i += 4) {
    if (alpha && d[i + 3] < 128) continue;
    const k = (((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)) * 4;
    hist[k]++; hist[k + 1] += d[i]; hist[k + 2] += d[i + 1]; hist[k + 3] += d[i + 2];
  }
}

// Median cut (like PIL's MEDIANCUT, which the ScummVM build uses): split the most populated box along its longest
// channel at the pixel median, n boxes -> their mean colours
function medianCut(hist, n) {
  const all = [];
  let total = 0;
  for (let k = 0; k < 32768; k++) if (hist[k * 4]) { all.push(k); total += hist[k * 4]; }
  const ch = (k, c) => (k >> (10 - 5 * c)) & 31;
  const boxes = [{ c: all, n: total }];
  while (boxes.length < n) {
    let bi = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].c.length > 1 && (bi < 0 || boxes[i].n > boxes[bi].n)) bi = i;
    if (bi < 0) break;
    const b = boxes[bi];
    let best = 0, range = -1;
    for (let c = 0; c < 3; c++) {
      let lo = 31, hi = 0;
      for (const k of b.c) { const v = ch(k, c); if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi - lo > range) { range = hi - lo; best = c; }
    }
    b.c.sort((p, q) => ch(p, best) - ch(q, best));
    let acc = 0, cut = 1;
    for (let i = 0; i < b.c.length - 1; i++) {
      acc += hist[b.c[i] * 4];
      if (acc >= b.n / 2) { cut = i + 1; break; }
      cut = i + 1;
    }
    const left = b.c.slice(0, cut), right = b.c.slice(cut);
    const nl = left.reduce((s, k) => s + hist[k * 4], 0);
    boxes.splice(bi, 1, { c: left, n: nl }, { c: right, n: b.n - nl });
  }
  return boxes.map(b => {
    let s = 0, r = 0, g = 0, bl = 0;
    for (const k of b.c) { s += hist[k * 4]; r += hist[k * 4 + 1]; g += hist[k * 4 + 2]; bl += hist[k * 4 + 3]; }
    return [Math.round(r / s), Math.round(g / s), Math.round(bl / s)];
  });
}

function nearest(r, k) {
  const R = ((k >> 10) & 31) * 8 + 4, G = ((k >> 5) & 31) * 8 + 4, B = (k & 31) * 8 + 4, pal = r.pal;
  let best = 0, bd = Infinity;
  for (const i of r.cand) {
    const dr = pal[i * 3] - R, dg = pal[i * 3 + 1] - G, db = pal[i * 3 + 2] - B;
    const dd = dr * dr + dg * dg + db * db;
    if (dd < bd) { bd = dd; best = i; }
  }
  r.lut[k] = best;
  return best;
}

// Floyd-Steinberg in place (RGBA data, alpha untouched)
function dither(d, w, h, near, pal) {
  let cur = new Float32Array((w + 2) * 3), next = new Float32Array((w + 2) * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, e = (x + 1) * 3;
      const r = clamp8(d[o] + cur[e]), g = clamp8(d[o + 1] + cur[e + 1]), b = clamp8(d[o + 2] + cur[e + 2]);
      const p = near(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      const pr = pal[p * 3], pg = pal[p * 3 + 1], pb = pal[p * 3 + 2];
      d[o] = pr; d[o + 1] = pg; d[o + 2] = pb;
      const er = r - pr, eg = g - pg, eb = b - pb;
      cur[e + 3] += er * 7 / 16; cur[e + 4] += eg * 7 / 16; cur[e + 5] += eb * 7 / 16;
      next[e - 3] += er * 3 / 16; next[e - 2] += eg * 3 / 16; next[e - 1] += eb * 3 / 16;
      next[e] += er * 5 / 16; next[e + 1] += eg * 5 / 16; next[e + 2] += eb * 5 / 16;
      next[e + 3] += er / 16; next[e + 4] += eg / 16; next[e + 5] += eb / 16;
    }
    [cur, next] = [next, cur];
    next.fill(0);
  }
}

const clamp8 = v => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
