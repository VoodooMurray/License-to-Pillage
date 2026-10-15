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



# ---------------------------------------------------------------- painted pieces (tools/theme/art, mod/artgen/ui.py)
ART = os.path.join(HERE, 'art')


def art(name):
    for ext in ('.png', '.jpg'):
        p = os.path.join(ART, name + ext)
        if os.path.exists(p):
            return Image.open(p).convert('RGBA')
    return None


def fit(im, w, h):
    """The picture cropped to its visible pixels and scaled to fit w x h logical px (at the art scale)."""
    im = im.crop(im.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox())
    k = min(w * S / im.width, h * S / im.height)
    return im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)


def place(w, h, piece, cx, cy):
    """A transparent w x h logical canvas (art scale) with piece centred on (cx, cy)."""
    im = Image.new('RGBA', (w * S, h * S), (0, 0, 0, 0))
    im.alpha_composite(piece, (round(cx * S - piece.width / 2), round(cy * S - piece.height / 2)))
    return im


def tint(im, rgb, amount=0.55):
    """The picture shifted towards a colour (the hot variants), alpha kept."""
    a = np.asarray(im).astype(np.float32)
    lum = a[..., :3].mean(2, keepdims=True) / 255.0
    a[..., :3] = a[..., :3] * (1 - amount) + np.array(rgb, np.float32) * (0.35 + 0.9 * lum) * amount
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def lit_icon(icon):
    """A hovered verb: brighter, with a warm glow round it."""
    a = np.asarray(icon).astype(np.float32)
    a[..., :3] = np.clip(a[..., :3] * 1.25 + 20, 0, 255)
    bright = Image.fromarray(a.astype(np.uint8))
    pad = 10 * S
    out = Image.new('RGBA', (icon.width + 2 * pad, icon.height + 2 * pad), (0, 0, 0, 0))
    glow = Image.new('RGBA', out.size, (255, 244, 190, 0))
    m = Image.new('L', out.size, 0)
    m.paste(icon.getchannel('A'), (pad, pad))
    glow.putalpha(m.filter(ImageFilter.GaussianBlur(4 * S)).point(lambda v: min(255, v * 2)))
    out.alpha_composite(glow)
    out.alpha_composite(bright, (pad, pad))
    return out


def painted_coin(lit=None):
    base = art('coin')
    w, h = 116, 118
    im = place(w, h, fit(base, 110, 110), 58, 59)
    for verb, c, size in (('hand', (25, 54), 32), ('eye', (58, 34), 34), ('mouth', (91, 56), 32)):
        icon = fit(art('icon_' + verb), size, size)
        if lit == verb:
            icon = lit_icon(icon)
        im.alpha_composite(icon, (round(c[0] * S - icon.width / 2), round(c[1] * S - icon.height / 2)))
    return im


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
    if art('coin_full'):        # one painted coin with hand / eye / parrot, lit versions from mod/artgen/ui.py lit
        name = {'hand': 'coin_lit_hand', 'look': 'coin_lit_eye', 'mouth': 'coin_lit_parrot'}.get(lit, 'coin_full')
        return place(116, 118, fit(art(name) or art('coin_full'), 112, 112), 58, 59)
    if all(art(n) for n in ('coin', 'icon_hand', 'icon_eye', 'icon_mouth')):
        return painted_coin({'look': 'eye'}.get(lit, lit))
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
# Drawn at their own size like a cartoon cel (bold shape, thick wobbly ink outline, flat bright paint, one highlight
# stroke), the way CMI's own read at a glance; the shapes are ours (a compass star, a fat arrow).
def wobbly(pts, amt, seed, step=2.0):
    """A closed polygon (logical px) redrawn by hand: edges subdivided, each point nudged a little."""
    import random
    rng = random.Random(seed)
    out = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        for k in range(n):
            t = k / n
            out.append((x0 + (x1 - x0) * t + rng.uniform(-amt, amt), y0 + (y1 - y0) * t + rng.uniform(-amt, amt)))
    return out


def cel(w, h, pts, fill, seed, ink=3.2, shade=None, shine=None):
    """A cartoon cel: drop shadow, ink outline (the shape grown by ink px), paint, a darker lower half, a highlight."""
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    out = wobbly(pts, 0.35, seed)
    cx = sum(x for x, _ in pts) / len(pts); cy = sum(y for _, y in pts) / len(pts)
    def grown(q, k):
        return [(x + (x - cx) / max(1e-6, math.hypot(x - cx, y - cy)) * k, y + (y - cy) / max(1e-6, math.hypot(x - cx, y - cy)) * k) for x, y in q]
    d.polygon([P(x + 1.6, y + 1.8) for x, y in grown(out, ink)], fill=(0, 0, 0, 90))           # shadow
    d.polygon([P(*q) for q in grown(out, ink)], fill=INK)                                         # ink
    d.polygon([P(*q) for q in out], fill=fill)                                                    # paint
    if shade:                                # lit from the upper left: a darker rim along the lower right
        d.polygon([P(*q) for q in out], fill=shade)
        d.polygon([P(x - 0.9, y - 1.0) for x, y in grown(out, -1.0)], fill=fill)
    if shine:
        d.line([P(*q) for q in shine], fill=(255, 255, 255, 200), width=int(SS * S * 1.1), joint='curve')
    return finish(im)


def saturate(im, k, light=1.0):
    """The picture with its colour strength scaled by k (alpha kept); k < 1 mutes towards grey, k > 1 pushes it."""
    a = np.asarray(im).astype(np.float32)
    lum = (a[..., 0] * 0.3 + a[..., 1] * 0.59 + a[..., 2] * 0.11)[..., None]
    out = a.copy()
    out[..., :3] = np.clip(lum + (a[..., :3] - lum) * k, 0, 255)
    out[..., :3] = np.clip(out[..., :3] * light, 0, 255)
    return Image.fromarray(out.astype(np.uint8))


def red_hot(im):
    """The light paint of a piece turned red (the ink stays): the hovered cursor, like CMI's."""
    a = np.asarray(im).astype(np.float32)
    lum = a[..., :3].mean(2, keepdims=True) / 255
    red = np.array([240, 58, 30], np.float32)
    a[..., :3] = np.where(lum > 0.35, red * (0.55 + 0.45 * lum), a[..., :3])
    return Image.fromarray(a.astype(np.uint8))


def inked(piece, hot, edge_px=1.3):
    """A painted piece as a cursor: pale gold at rest, vivid gold when hot, with a bold ink edge and a soft shadow."""
    m = round(S * 3)                                   # room for the edge and the shadow (no flat cuts at the tips)
    big = Image.new('RGBA', (piece.width + 2 * m, piece.height + 2 * m), (0, 0, 0, 0))
    big.alpha_composite(piece, (m, m))
    piece = big
    piece = saturate(piece, 1.5 if hot else 0.6, 1.0 if hot else 1.25)
    a = piece.getchannel('A').point(lambda v: 255 if v > 40 else 0)
    grow = a.filter(ImageFilter.MaxFilter(2 * max(1, round(S * edge_px)) + 1))
    edge = Image.new('RGBA', piece.size, INK)
    edge.putalpha(grow)
    shade = Image.new('RGBA', piece.size, (0, 0, 0, 110))
    shade.putalpha(grow.filter(ImageFilter.GaussianBlur(S * 0.8)))
    pad = Image.new('RGBA', piece.size, (0, 0, 0, 0))
    pad.alpha_composite(shade, (round(S * 0.8), round(S * 1.0)))
    pad.alpha_composite(edge); pad.alpha_composite(piece)
    return pad


def star_cursor(color):
    if art('cursor'):             # the painted sketched X (mod/artgen/ui.py pick cursor_x 8): cream at rest, red when hot
        piece = fit(art('cursor'), 20, 20)
        return place(80, 56, red_hot(piece) if color[1] < 200 else piece, 34, 25)
    cx, cy = 34, 25
    hot = color[1] < 200
    lit, dark = ((248, 86, 56, 255), (170, 26, 16, 255)) if hot else ((255, 255, 250, 255), (150, 164, 184, 255))
    im = canvas(80, 56)
    d = ImageDraw.Draw(im)
    pts = []                                   # (angle, radius, half-width angle)
    for k in range(8):
        pts.append((math.radians(k * 45 - 90), 16.5 if k % 2 == 0 else 10.5, 0.30 if k % 2 == 0 else 0.34))
    def poly(ang, r, w, grow=0.0, side=0):
        tip = (cx + math.cos(ang) * (r + grow), cy + math.sin(ang) * (r + grow))
        l = (cx + math.cos(ang - w) * (2.5 + grow * 0.3), cy + math.sin(ang - w) * (2.5 + grow * 0.3))
        rr = (cx + math.cos(ang + w) * (2.5 + grow * 0.3), cy + math.sin(ang + w) * (2.5 + grow * 0.3))
        base = [tip, rr, (cx, cy), l]
        return base if side == 0 else ([tip, rr, (cx, cy)] if side > 0 else [tip, (cx, cy), l])
    for ang, r, w in pts:                                       # shadow, then the ink (every point grown)
        d.polygon([P(x + 1.4, y + 1.6) for x, y in poly(ang, r, w, 1.6)], fill=(0, 0, 0, 90))
    for ang, r, w in pts:
        d.polygon([P(*q) for q in poly(ang, r, w, 1.7)], fill=INK)
    d.ellipse([P(cx - 5.2, cy - 5.2), P(cx + 5.2, cy + 5.2)], fill=INK)
    for ang, r, w in pts:                                       # paint: right half dark, left half lit
        d.polygon([P(*q) for q in poly(ang, r, w, 0, -1)], fill=lit)
        d.polygon([P(*q) for q in poly(ang, r, w, 0, 1)], fill=dark)
    d.ellipse([P(cx - 2.6, cy - 2.6), P(cx + 2.6, cy + 2.6)], fill=INK)
    d.ellipse([P(cx - 1.0, cy - 1.0), P(cx + 1.0, cy + 1.0)], fill=lit)
    return finish(im)


def hourglass():
    if not art('hourglass'):
        return Image.new('RGBA', (80 * S, 56 * S))
    piece = fit(art('hourglass'), 30, 38)
    a = piece.getchannel('A').point(lambda v: 255 if v > 40 else 0)
    edge = Image.new('RGBA', piece.size, INK)
    edge.putalpha(a.filter(ImageFilter.MaxFilter(2 * round(S * 1.4) + 1)))        # a thick ink edge around it
    pad = Image.new('RGBA', piece.size, (0, 0, 0, 0))
    pad.alpha_composite(edge); pad.alpha_composite(piece)
    return place(80, 56, pad, 39, 24)


ARROW = [(0, -14), (10.5, -2), (4.5, -2), (4.5, 11), (-4.5, 11), (-4.5, -2), (-10.5, -2)]      # points up, centred


def arrow(deg, color=(255, 214, 92, 255)):
    hot = color[1] < 150
    a = math.radians(deg)
    rot = lambda x, y: (39 + x * math.cos(a) - y * math.sin(a), 24 + x * math.sin(a) + y * math.cos(a))
    fill = (240, 58, 30, 255) if hot else (255, 196, 48, 255)
    shade = (176, 28, 14, 255) if hot else (222, 128, 20, 255)
    return cel(80, 56, [rot(x, y) for x, y in ARROW], fill, 11 + deg, ink=3.0, shade=shade,
               shine=[rot(-2, 8), rot(-2, -1), rot(-4.5, -3)])


def tri(w, h, pts, color=(255, 214, 92, 255)):
    im = canvas(w, h)
    ImageDraw.Draw(im).polygon([P(*p) for p in pts], fill=color, outline=INK, width=SS * 4)
    return finish(im)


# ---------------------------------------------------------------- chest
def chest():
    w, h = 640, 472
    if art('chest'):
        return art('chest').convert('RGB').resize((w * S, h * S), Image.LANCZOS).convert('RGBA')
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
FONT_SPECS = {   # engine font number: (ttf, capital height incl. the outline in logical px (as CMI's), cell height)
    1: ('IMFellEnglish-Regular.ttf', 18.0, 30),
    3: ('IMFellEnglish-Regular.ttf', 13.5, 23),
    4: ('IMFellEnglish-Regular.ttf', 20.5, 36),
}
TRACK = -0.25     # logical px between letters beyond the font's own spacing (the outlines just touch, as in CMI)
CHARS = [c for c in range(32, 127)] + [c for c in range(160, 256)] + [0x2018, 0x2019, 0x201C, 0x201D, 0x2013, 0x2014, 0x2026]


def glyph_font(ttf_path, cap):
    """The font at the size whose capital H (+ the 1 px outline above and below) is cap logical px tall."""
    size = 20.0
    for _ in range(30):
        f = ImageFont.truetype(ttf_path, max(4, round(size * S)))
        bb = f.getbbox('H')
        h = (bb[3] - bb[1]) / S + 2
        if abs(h - cap) < 0.1:
            break
        size *= cap / h
    return ImageFont.truetype(ttf_path, max(4, round(size * S))), size


def build_font(ttf_path, n, out_dir, lo=False, cap=None, cell=None):
    """An engine font atlas (fontN.png + fontN.json, see engine/font.js) from any TTF/OTF: white glyphs with a 1 px
    black outline in cells of the engine font's height, letters as tall as the font it replaces. lo: the 1x pixel look."""
    cap = cap or FONT_SPECS[n][1]
    cell = cell or FONT_SPECS[n][2]
    f, size = glyph_font(ttf_path, cap)
    asc, desc = f.getmetrics()
    stroke = S                     # 1 logical px of outline
    top = (cell * S - (asc + desc)) // 2
    glyphs, placed = {}, []
    x = y = rowh = 0
    Wd = 2048
    for code in CHARS:
        ch = chr(code)
        try:
            adv = f.getlength(ch) / S + 1 + TRACK
        except Exception:  # noqa: BLE001 - a glyph the font lacks
            continue
        aw = max(1, int(math.ceil(adv + 1))) * S
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
        placed.append((code, g, x, y, round(adv) if lo else round(adv, 2)))
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
