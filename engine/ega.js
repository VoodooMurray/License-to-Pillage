// EGA mode (EDITOR_PLAN.md 10f E): the low-res frame reduced to 400x300 in the classic 16-colour EGA
// palette — the MI1/MI2 look. Adaptive ordered dithering: a pixel that already sits near a palette colour
// stays flat (clean skies and walls), only in-between colours weave (Bayer 8x8); saturation is committed
// around the pixel's luma and contrast lifted a little, so warm scenes dither into brown/red/yellow
// instead of grey mush. Text, labels, menus and the cursor are drawn after the filter (engine.render), so
// they stay readable. Rides on the Alt+0 low-res path as its third state: HD → original → EGA.

export const EGA_PALETTE = [
  [0x00, 0x00, 0x00], [0x00, 0x00, 0xaa], [0x00, 0xaa, 0x00], [0x00, 0xaa, 0xaa],
  [0xaa, 0x00, 0x00], [0xaa, 0x00, 0xaa], [0xaa, 0x55, 0x00], [0xaa, 0xaa, 0xaa],
  [0x55, 0x55, 0x55], [0x55, 0x55, 0xff], [0x55, 0xff, 0x55], [0x55, 0xff, 0xff],
  [0xff, 0x55, 0x55], [0xff, 0x55, 0xff], [0xff, 0xff, 0x55], [0xff, 0xff, 0xff],
];

const SAT = 1.35;              // saturation commit: EGA has no muted colours
const CONTRAST = 1.22;         // contrast lift: MI1/2 EGA art is bold, darks go black
const GAMMA = 1.12;            // darkens the mids a little more (black structure like MI2's EGA)
const SPREAD = 64;             // dither bias at full strength (EGA steps are 85 apart)
const FLAT = 30 * 30 * 3;      // closer than ~30/channel to a palette colour: no dither, solid patches
const GAMMA_LUT = Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * (v / 255) ** GAMMA));

// Bayer 8x8, biases around 0
const B8 = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
const BAYER = B8.map(v => Math.round((v / 64 - 0.492) * SPREAD));

export class Ega {
  constructor(w = 320, h = 240) {
    this.w = w;
    this.h = h;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.lut = new Int8Array(32768).fill(-1);      // 15-bit colour -> palette index
    this.lutD = new Int32Array(32768);             // ... and its squared distance (for the flat test)
  }

  nearest(k) {
    const R = ((k >> 10) & 31) * 8 + 4, G = ((k >> 5) & 31) * 8 + 4, B = (k & 31) * 8 + 4;
    let best = 0, bd = Infinity;
    for (let i = 0; i < 16; i++) {
      const p = EGA_PALETTE[i];
      const dr = p[0] - R, dg = p[1] - G, db = p[2] - B;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    this.lut[k] = best;
    this.lutD[k] = bd;
    return best;
  }

  // src: the 640x480 low-res frame -> this.canvas (16 colours, adaptive ordered dither)
  apply(src) {
    const { w, h, ctx, lut, lutD } = this;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    for (let y = 0; y < h; y++) {
      const row = (y & 7) * 8;
      for (let x = 0, o = y * w * 4; x < w; x++, o += 4) {
        // saturate around the pixel's luma, then gamma + contrast (bold hues, black structure)
        const R0 = GAMMA_LUT[d[o]], G0 = GAMMA_LUT[d[o + 1]], B0 = GAMMA_LUT[d[o + 2]];
        const lum = 0.299 * R0 + 0.587 * G0 + 0.114 * B0;
        let r = (lum + (R0 - lum) * SAT - 128) * CONTRAST + 128;
        let g = (lum + (G0 - lum) * SAT - 128) * CONTRAST + 128;
        let b = (lum + (B0 - lum) * SAT - 128) * CONTRAST + 128;
        r = r < 0 ? 0 : r > 255 ? 255 : r;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        b = b < 0 ? 0 : b > 255 ? 255 : b;
        let k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let p = lut[k];
        if (p < 0) p = this.nearest(k);
        if (lutD[k] > FLAT) {
          // between palette colours: weave the two neighbours (ordered dither)
          const t = BAYER[row + (x & 7)];
          r = r + t < 0 ? 0 : r + t > 255 ? 255 : r + t;
          g = g + t < 0 ? 0 : g + t > 255 ? 255 : g + t;
          b = b + t < 0 ? 0 : b + t > 255 ? 255 : b + t;
          k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
          p = lut[k];
          if (p < 0) p = this.nearest(k);
        }
        const c = EGA_PALETTE[p];
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2];
      }
    }
    ctx.putImageData(img, 0, 0);
    return this.canvas;
  }
}

// VGA mode: 320x240 in the room's own 256-colour palette (the one the low-res path computes per room,
// MI2-style median cut) — chunky pixels, smooth colours, no dithering. The MI1-VGA / MI2 look.
export class Vga {
  constructor(w = 320, h = 240) {
    this.w = w;
    this.h = h;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  // src: the 640x480 low-res frame; room: the LowRes room record {pal, cand, lut} (null: just downsample)
  apply(src, room) {
    const { w, h, ctx } = this;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    if (!room) return this.canvas;
    const img = ctx.getImageData(0, 0, w, h), d = img.data, pal = room.pal, lut = room.lut;
    for (let o = 0; o < d.length; o += 4) {
      const k = ((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3);
      let p = lut[k];
      if (p < 0) p = nearestRoom(room, k);
      d[o] = pal[p * 3]; d[o + 1] = pal[p * 3 + 1]; d[o + 2] = pal[p * 3 + 2];
    }
    ctx.putImageData(img, 0, 0);
    return this.canvas;
  }
}

// nearest colour in the room's candidate palette (fills the same lut the low-res path uses)
function nearestRoom(r, k) {
  const R = ((k >> 10) & 31) * 8 + 4, G = ((k >> 5) & 31) * 8 + 4, B = (k & 31) * 8 + 4, pal = r.pal;
  let best = 0, bd = Infinity;
  for (const i of r.cand) {
    const dr = pal[i * 3] - R, dg = pal[i * 3 + 1] - G, db = pal[i * 3 + 2] - B;
    const d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; best = i; }
  }
  r.lut[k] = best;
  return best;
}
