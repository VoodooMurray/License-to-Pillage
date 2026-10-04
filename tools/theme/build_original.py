#!/usr/bin/env python3
"""The built-in ORIGINAL interface theme (nothing of CMI): engine/theme/original/.

The web engine uses it wherever a game has no interface of its own and no CMI interface was extracted from the
player's game (cmi/), so the engine and the level editor always start. Same file names and logical sizes as the CMI
set (tools/byog/extract.py), so all of the engine's layout numbers still fit:

  ui/coin_idle|coin_fist|coin_skull|coin_parrot.png  116x118  a brass doubloon: hand / eye / mouth (hovered one lit)
  ui/cursor.png, cursor_hot.png                         80x56   a compass-star crosshair, hot spot (34, 25)
  ui/cursor_wait.png                                    80x56   an hourglass, hot spot (39, 24)
  ui/arrow_<N..NW>.png (+ _hot)                         80x56   exit arrows, hot spot (39, 24)
  ui/inv_next.png, inv_prev.png                         80x40   chest page arrows
  ui/dlg_up.png 32x40, dlg_down.png 32x32                       dialogue scroll arrows
  ui/chest.png                                          640x472 the inventory chest
  fonts/font1|font3|font4.(png|json)  speech / small / big, from OFL fonts (tools/theme/fonts)
  lo/...                                                 the same at 1x (each pixel 4x4) for the low-res views
  lo/palette.json                                        no fixed colours: every room's palette is all its own

Images are drawn here in code (Pillow), the verb icons are Noto Emoji glyphs (OFL). Rerun after changing it:
  python3 tools/theme/build_original.py
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'engine', 'theme', 'original')
FONTS = os.path.join(HERE, 'fonts')
S = 4                    # art scale
SS = 4                   # supersampling for smooth edges
INK = (24, 14, 6, 255)
GOLD = [(255, 236, 160), (231, 180, 72), (176, 116, 34), (110, 66, 18)]


def font_path(name):
    return os.path.join(FONTS, name)


def canvas(w, h):
    """A transparent canvas of w x h logical px, supersampled (S * SS per logical px)."""
    return Image.new('RGBA', (w * S * SS, h * S * SS), (0, 0, 0, 0))


def finish(im):
    return im.resize((im.width // SS, im.height // SS), Image.LANCZOS)


def P(x, y):
    return (x * S * SS, y * S * SS)


def radial(w, h, cx, cy, r, stops):
    """RGBA radial gradient (logical units) over the supersampled canvas size."""
    W, H = w * S * SS, h * S * SS
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.hypot(xx - cx * S * SS, yy - cy * S * SS) / (r * S * SS)
    out = np.zeros((H, W, 4), np.float32)
    pos = [p for p, _ in stops]
    for ch in range(3):
        out[..., ch] = np.interp(d, pos, [c[ch] for _, c in stops])
    out[..., 3] = 255
    return Image.fromarray(out.astype(np.uint8))


# ---------------------------------------------------------------- verb coin
def emoji(ch, size_px):
    f = ImageFont.truetype(font_path('NotoEmoji.ttf'), int(size_px))
    try:
        f.set_variation_by_axes([700])
    except Exception:  # noqa: BLE001 - static builds of the font
        pass
    bb = f.getbbox(ch)
    im = Image.new('L', (bb[2] - bb[0] + 8, bb[3] - bb[1] + 8), 0)
    ImageDraw.Draw(im).text((4 - bb[0], 4 - bb[1]), ch, font=f, fill=255)
    return im


def engrave(base, mask, center, lit):
    """An icon stamped into the coin: dark recess + light lower edge; lit = glowing (the hovered verb)."""
    pad = 16 * SS                  # room for the glow around the icon
    m2 = Image.new('L', (mask.width + 2 * pad, mask.height + 2 * pad), 0)
    m2.paste(mask, (pad, pad))
    mask = m2
    cx, cy = P(*center)
    x0, y0 = int(cx - mask.width / 2), int(cy - mask.height / 2)
    if lit:
        glow = Image.new('RGBA', mask.size, (255, 250, 210, 0))
        glow.putalpha(mask.filter(ImageFilter.GaussianBlur(10 * SS)).point(lambda v: min(255, v * 2)))
        base.alpha_composite(glow, (x0, y0))
    hi = Image.new('RGBA', mask.size, (255, 240, 190, 255))
    hi.putalpha(mask)
    base.alpha_composite(hi, (x0 + 2 * SS, y0 + 3 * SS))
    dark = Image.new('RGBA', mask.size, (150, 30, 10, 255) if lit else (86, 50, 14, 255))
    dark.putalpha(mask)
    base.alpha_composite(dark, (x0, y0))


def coin(lit=None):
    w, h = 116, 118
    disc = radial(w, h, 50, 48, 64, [(0, GOLD[0]), (0.45, GOLD[1]), (0.85, GOLD[2]), (1.0, GOLD[3])])
    mask = Image.new('L', disc.size, 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([P(3, 4), P(113, 114)], fill=255)
    im = canvas(w, h)
    im.paste(disc, (0, 0), mask)
    d = ImageDraw.Draw(im)
    d.ellipse([P(3, 4), P(113, 114)], outline=INK, width=3 * S * SS // 2)
    d.ellipse([P(10, 11), P(106, 107)], outline=(120, 74, 20, 255), width=S * SS)
    # icons in the engine's verb zones (image coordinates): hand left, eye top middle, mouth right
    size = 30 * S * SS
    for verb, ch, c in (('hand', '✋', (23, 52)), ('look', '\U0001F441', (58, 36)), ('mouth', '\U0001F444', (93, 56))):
        engrave(im, emoji(ch, size * (0.9 if verb == 'look' else 0.8)), c, lit == verb)
    return finish(im)


# ---------------------------------------------------------------- cursors, arrows
def star_cursor(color):
    im = canvas(80, 56)
    d = ImageDraw.Draw(im)
    cx, cy = 34, 25
    for ang in (0, 90, 180, 270):
        a = math.radians(ang)
        ux, uy = math.cos(a), math.sin(a)
        vx, vy = -uy, ux
        tip = (cx + ux * 15, cy + uy * 15)
        b1 = (cx + ux * 4 + vx * 3.5, cy + uy * 4 + vy * 3.5)
        b2 = (cx + ux * 4 - vx * 3.5, cy + uy * 4 - vy * 3.5)
        d.polygon([P(*tip), P(*b1), P(*b2)], fill=color, outline=INK, width=SS * 3)
    d.ellipse([P(cx - 2.2, cy - 2.2), P(cx + 2.2, cy + 2.2)], fill=INK)
    return finish(im)


def hourglass():
    im = canvas(80, 56)
    m = emoji('⌛', 34 * S * SS)
    cx, cy = P(39, 24)
    fill = Image.new('RGBA', m.size, (250, 226, 150, 255))
    fill.putalpha(m)
    edge = Image.new('RGBA', m.size, INK)
    edge.putalpha(m.filter(ImageFilter.MaxFilter(9)))
    im.alpha_composite(edge, (int(cx - m.width / 2), int(cy - m.height / 2)))
    im.alpha_composite(fill, (int(cx - m.width / 2), int(cy - m.height / 2)))
    return finish(im)


ARROW = [(0, -16), (11, -4), (4, -4), (4, 14), (-4, 14), (-4, -4), (-11, -4)]      # points up, centred


def arrow(deg, color=(255, 214, 92, 255)):
    im = canvas(80, 56)
    d = ImageDraw.Draw(im)
    a = math.radians(deg)
    pts = [(39 + x * math.cos(a) - y * math.sin(a), 24 + x * math.sin(a) + y * math.cos(a)) for x, y in ARROW]
    d.polygon([P(*p) for p in pts], fill=color, outline=INK, width=SS * 4)
    return finish(im)


def tri(w, h, pts, color=(255, 214, 92, 255)):
    im = canvas(w, h)
    ImageDraw.Draw(im).polygon([P(*p) for p in pts], fill=color, outline=INK, width=SS * 4)
    return finish(im)


# ---------------------------------------------------------------- chest
def chest():
    w, h = 640, 472
    W, H = w * S, h * S
    rng = np.random.default_rng(3)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    plank = (yy // (60 * S)).astype(np.int32)
    grain = np.sin(xx / (37 + plank * 3) + np.sin(yy / 23 + plank) * 2.4) * 0.5 + 0.5
    base = np.stack([96 + 40 * grain, 52 + 22 * grain, 24 + 10 * grain], -1)
    base += rng.normal(0, 5, (H, W, 1))
    seam = (yy % (60 * S)) < 3 * S
    base[seam] *= 0.45
    vign = np.clip(1.15 - np.hypot((xx - W / 2) / (W * 0.65), (yy - H / 2) / (H * 0.7)), 0.55, 1.0)
    base *= vign[..., None]
    im = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)).convert('RGBA')
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W - 1, H - 1], outline=(40, 22, 8, 255), width=10 * S)
    d.rectangle([14 * S, 14 * S, W - 14 * S, H - 14 * S], outline=(150, 100, 40, 255), width=3 * S)
    for cx, cy in ((0, 0), (W, 0), (0, H), (W, H)):        # brass corner brackets
        sx, sy = (1 if cx == 0 else -1), (1 if cy == 0 else -1)
        poly = [(cx, cy), (cx + sx * 70 * S, cy), (cx + sx * 70 * S, cy + sy * 16 * S), (cx + sx * 16 * S, cy + sy * 16 * S),
                (cx + sx * 16 * S, cy + sy * 70 * S), (cx, cy + sy * 70 * S)]
        d.polygon(poly, fill=(214, 160, 60, 255), outline=(60, 36, 10, 255), width=2 * S)
    return im


# ---------------------------------------------------------------- fonts
FONT_SPECS = {   # engine font number: (ttf, target average lowercase advance in logical px, cell height)
    1: ('AlegreyaSans-ExtraBold.ttf', 11.0, 30),
    3: ('AlegreyaSans-Bold.ttf', 7.4, 23),
    4: ('PirataOne-Regular.ttf', 11.0, 36),
}
CHARS = [c for c in range(32, 127)] + [c for c in range(160, 256)] + [0x2018, 0x2019, 0x201C, 0x201D, 0x2013, 0x2014, 0x2026]


def glyph_font(ttf_path, target_adv):
    """The font at the size whose average lowercase advance (+ the outline) is target_adv logical px."""
    size = 20.0
    for _ in range(30):
        f = ImageFont.truetype(ttf_path, max(4, round(size * S)))
        adv = sum(f.getlength(chr(c)) for c in range(97, 123)) / 26 / S + 2      # + the outline
        if abs(adv - target_adv) < 0.15:
            break
        size *= target_adv / adv
    return ImageFont.truetype(ttf_path, max(4, round(size * S))), size


def build_font(ttf_path, n, out_dir, lo=False, target_adv=None, cell=None):
    """An engine font atlas (fontN.png + fontN.json, see engine/font.js) from any TTF/OTF: white glyphs with a 1 px
    black outline in cells of the engine font's height, sized like the font it replaces. lo: the 1x pixel look."""
    target_adv = target_adv or FONT_SPECS[n][1]
    cell = cell or FONT_SPECS[n][2]
    f, size = glyph_font(ttf_path, target_adv)
    asc, desc = f.getmetrics()
    stroke = S                     # 1 logical px of outline
    top = (cell * S - (asc + desc)) // 2
    glyphs, placed = {}, []
    x = y = rowh = 0
    Wd = 2048
    for code in CHARS:
        ch = chr(code)
        try:
            adv = f.getlength(ch) / S + 2
        except Exception:  # noqa: BLE001 - a glyph the font lacks
            continue
        aw = max(1, int(math.ceil(adv))) * S
        g = Image.new('RGBA', (aw, cell * S), (0, 0, 0, 0))
        ImageDraw.Draw(g).text((stroke, top), ch, font=f, fill=(255, 255, 255, 255), stroke_width=stroke, stroke_fill=(0, 0, 0, 255))
        if lo:      # 1x pixels: shrink, harden, then each pixel 4x4
            small = g.resize((aw // S, cell), Image.BOX)
            a = np.asarray(small).copy()
            a[..., 3] = np.where(a[..., 3] >= 110, 255, 0)
            lum = a[..., :3].mean(2)
            a[..., :3] = np.where((lum > 128)[..., None], 255, 0)
            g = Image.fromarray(a).resize((aw, cell * S), Image.NEAREST)
        if x + aw > Wd:
            x, y, rowh = 0, y + rowh + 2, 0
        placed.append((code, g, x, y, int(math.ceil(adv))))
        x += aw + 2
        rowh = max(rowh, g.height)
    atlas = Image.new('RGBA', (Wd, y + rowh), (0, 0, 0, 0))
    for code, g, gx, gy, adv in placed:
        atlas.paste(g, (gx, gy))
        glyphs[str(code)] = [gx, gy, g.width, g.height, adv]
    os.makedirs(out_dir, exist_ok=True)
    atlas.save(os.path.join(out_dir, f'font{n}.png'), optimize=True)
    with open(os.path.join(out_dir, f'font{n}.json'), 'w') as fh:
        json.dump({'height': cell, 'scale': S, 'source': f'{os.path.basename(ttf_path)} at {size:.1f} px',
                   'glyphs': glyphs}, fh)
    return size


def font(n, lo=False):
    d = os.path.join(OUT, 'lo', 'fonts') if lo else os.path.join(OUT, 'fonts')
    return build_font(font_path(FONT_SPECS[n][0]), n, d, lo)


# ---------------------------------------------------------------- all
def save(im, name):
    for lo in (False, True):
        d = os.path.join(OUT, 'lo', 'ui') if lo else os.path.join(OUT, 'ui')
        os.makedirs(d, exist_ok=True)
        out = im
        if lo:      # the 1x look: box-shrink, then each pixel 4x4
            small = im.resize((im.width // S, im.height // S), Image.BOX)
            out = small.resize(im.size, Image.NEAREST)
        out.save(os.path.join(d, name), optimize=True)


def main():
    ui = {
        'coin_idle.png': coin(), 'coin_fist.png': coin('hand'), 'coin_skull.png': coin('look'), 'coin_parrot.png': coin('mouth'),
        'cursor.png': star_cursor((255, 255, 255, 255)), 'cursor_hot.png': star_cursor((255, 70, 40, 255)),
        'cursor_wait.png': hourglass(),
        'inv_next.png': tri(80, 40, [(14, 6), (68, 20), (14, 34)]), 'inv_prev.png': tri(80, 40, [(66, 6), (12, 20), (66, 34)]),
        'dlg_up.png': tri(32, 40, [(16, 6), (28, 32), (4, 32)]), 'dlg_down.png': tri(32, 32, [(4, 6), (28, 6), (16, 28)]),
        'chest.png': chest(),
    }
    for i, dname in enumerate(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']):
        ui[f'arrow_{dname}.png'] = arrow(i * 45)
        ui[f'arrow_{dname}_hot.png'] = arrow(i * 45, (255, 90, 50, 255))
    for name, im in ui.items():
        save(im, name)
    for lo in (False, True):
        d = os.path.join(OUT, 'lo', 'ui') if lo else os.path.join(OUT, 'ui')
        with open(os.path.join(d, 'ui.json'), 'w') as fh:
            json.dump({n: {'w': im.width / S, 'h': im.height / S} for n, im in ui.items()}, fh, indent=1)
    sizes = {n: round(font(n), 1) for n in FONT_SPECS}
    for n in FONT_SPECS:
        font(n, lo=True)
    with open(os.path.join(OUT, 'lo', 'palette.json'), 'w') as fh:
        json.dump({'source': 'original theme: no fixed colours', 'art': [0, 255], 'talk': {}, 'rgb': [0] * 768}, fh)
    with open(os.path.join(OUT, 'theme.json'), 'w') as fh:
        json.dump({'name': 'Original (built in)', 'note': 'Made by tools/theme/build_original.py; nothing of CMI.',
                   'fonts': {str(n): FONT_SPECS[n][0] for n in FONT_SPECS}}, fh, indent=1)
    print(f'original theme -> {OUT}: {len(ui)} images, fonts {sizes}')


if __name__ == '__main__':
    sys.exit(main())
