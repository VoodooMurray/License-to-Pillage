#!/usr/bin/env python3
"""Bitmap-font atlases in the engine's format (like cmi/fonts/font1.json + .png) from any TTF/OTF file,
so a game needs none of CMI's fonts. Glyphs are white with a black outline (the engine tints the white
part per speaker/colour and the outline stays dark, exactly like CMI's own fonts).

  tools/make_font.py MyFont.ttf --out games/<key>/fonts/myfont --height 30
  tools/make_font.py MyFont.ttf --game <key>      all three slots at CMI's sizes (text 30, small 23,
                                                  big 36) into games/<key>/fonts/ + theme.json

The engine's atlas format: {height (logical px), scale (atlas px per logical px), glyphs: {charCode:
[x, y, w, h, advance]}} — h is always height*scale, advance in logical px; codes 32..255 (Latin-1).
"""
import argparse
import io
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
SLOTS = {'text': 30, 'small': 23, 'big': 36}       # CMI's font1 / font3 / font4 heights
ATLAS_W = 2048


def build_atlas(font_file, height, scale=4, outline=None):
    """-> (meta dict, PIL RGBA atlas). font_file: a path or bytes of a TTF/OTF."""
    H = height * scale
    outline = outline if outline is not None else max(2, scale)
    # the ink (ascent+descent, plus the outline) must fit the cell
    src = io.BytesIO(font_file) if isinstance(font_file, bytes) else font_file
    size = H
    for _ in range(24):
        if isinstance(src, io.BytesIO):
            src.seek(0)
        f = ImageFont.truetype(src, size)
        asc, desc = f.getmetrics()
        if asc + desc + 2 * outline <= H or size <= 4:
            break
        size = int(size * (H - 2 * outline) / max(1, asc + desc))
    baseline = outline + asc + (H - 2 * outline - asc - desc) // 2
    probe = ImageDraw.Draw(Image.new('L', (8, 8)))
    glyphs, cells = {}, []
    x = y = 0
    for code in range(32, 256):
        ch = chr(code)
        adv = probe.textlength(ch, font=f)
        if adv <= 0 and code != 32:
            continue
        w = int(adv) + 2 * outline + 2
        if x + w > ATLAS_W:
            x, y = 0, y + H + 2
        glyphs[str(code)] = [x, y, w, H, max(1, round(adv / scale))]
        cells.append((ch, x, y))
        x += w + 2
    atlas = Image.new('RGBA', (ATLAS_W, y + H + 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(atlas)
    for ch, cx, cy in cells:
        d.text((cx + outline + 1, cy + baseline), ch, font=f, fill=(255, 255, 255, 255), anchor='ls',
               stroke_width=outline, stroke_fill=(0, 0, 0, 255))
    return {'height': height, 'scale': scale, 'glyphs': glyphs}, atlas


def write_atlas(font_file, height, out_base, scale=4, outline=None):
    meta, atlas = build_atlas(font_file, height, scale, outline)
    os.makedirs(os.path.dirname(out_base) or '.', exist_ok=True)
    with open(out_base + '.json', 'w') as fp:
        json.dump(meta, fp)
    atlas.save(out_base + '.png', 'PNG')
    return meta


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('font', help='a .ttf / .otf / .ttc file')
    ap.add_argument('--out', help='output base path (writes <out>.json + <out>.png)')
    ap.add_argument('--height', type=int, default=30, help='logical cell height (CMI text: 30)')
    ap.add_argument('--scale', type=int, default=4)
    ap.add_argument('--outline', type=int, help='outline thickness in atlas px (default: scale)')
    ap.add_argument('--game', help='write all three slots into games/<key>/fonts/ and point theme.json at them')
    a = ap.parse_args()
    if a.game:
        sys.path.insert(0, TOOLS)
        import projects
        gd = projects.project_dir(ROOT, a.game)
        base = os.path.splitext(os.path.basename(a.font))[0].lower().replace(' ', '_')
        theme = projects.load_theme(gd)
        for slot, h in SLOTS.items():
            rel = f'fonts/{base}_{slot}'
            write_atlas(a.font, h, os.path.join(gd, rel), a.scale, a.outline)
            theme.setdefault('fonts', {})[slot] = rel
            print(f'{rel}.json + .png (height {h})')
        projects.save_theme(ROOT, a.game, theme)
        print(f'games/{a.game}/theme.json points at them')
        return
    out = a.out or os.path.splitext(a.font)[0].lower()
    write_atlas(a.font, a.height, out, a.scale, a.outline)
    print(f'{out}.json + {out}.png (height {a.height})')


if __name__ == '__main__':
    main()
