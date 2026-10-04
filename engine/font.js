// CMI bitmap fonts (NUT glyphs upscaled 4x, see tools/extract_cmi.py). Glyphs are white with a
// black outline; text is colored by multiplying: white -> the text color, black stays black.

import { image, json } from './assets.js';
import { parseColor } from './util.js';

export class Font {
  static async load(base) {
    const [meta, img] = await Promise.all([json(base + '.json'), image(base + '.png')]);
    return new Font(meta, img);
  }

  constructor(meta, img) {
    this.meta = meta;
    this.img = img;
    this.height = meta.height;          // logical px (cell height)
    this.scale = meta.scale;            // atlas px per logical px
    this.lineHeight = Math.round(meta.height * 0.8);
    this.colored = new Map();
  }

  glyph(ch) {
    return this.meta.glyphs[ch.charCodeAt(0)] || this.meta.glyphs[63];
  }

  width(text) {
    let w = 0;
    for (const ch of text) w += this.glyph(ch)[4];
    return w;
  }

  // Word wrap to maxWidth (logical px). Honors explicit \n.
  wrap(text, maxWidth) {
    const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const t = line ? line + ' ' + word : word;
        if (line && this.width(t) > maxWidth) { out.push(line); line = word; } else line = t;
      }
      out.push(line);
    }
    return out;
  }

  atlas(color) {
    const key = parseColor(color).join(',');
    if (!this.colored.has(key)) {
      const c = document.createElement('canvas');
      c.width = this.img.width; c.height = this.img.height;
      const x = c.getContext('2d');
      x.drawImage(this.img, 0, 0);
      x.globalCompositeOperation = 'multiply';
      x.fillStyle = `rgb(${key})`;
      x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(this.img, 0, 0);
      this.colored.set(key, c);
    }
    return this.colored.get(key);
  }

  // Draws one line with its top-left at (x, y) in logical px (ctx is in logical units).
  draw(ctx, text, x, y, color = '#fff', alpha = 1) {
    const atlas = this.atlas(color);
    const s = this.scale;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * alpha;
    for (const ch of text) {
      const [gx, gy, gw, gh, adv] = this.glyph(ch);
      if (gw && gh) ctx.drawImage(atlas, gx, gy, gw, gh, x, y, gw / s, gh / s);
      x += adv;
    }
    ctx.globalAlpha = prev;
  }

  // Centered block of lines; returns the block's bounds.
  drawCentered(ctx, lines, cx, y, color, alpha = 1) {
    let yy = y;
    for (const line of lines) {
      const w = this.width(line);
      this.draw(ctx, line, Math.round(cx - w / 2), yy, color, alpha);
      yy += this.lineHeight;
    }
  }
}
