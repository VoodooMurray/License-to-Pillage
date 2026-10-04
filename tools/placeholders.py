#!/usr/bin/env python3
"""Placeholder art so the game runs before the final art exists: NPC costumes (labelled
silhouettes with stand/talk anims), item icons (parchment with the item name), room backgrounds
(copied from the latest art/rooms/<room>/ render). Never overwrites existing final files.

  tools/placeholders.py
"""
import json
import os
import re

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
GAME = os.path.join(ROOT, 'game')
S = 4

NPCS = {  # id: (logical w, h, color)
    'agatha': (70, 150, (170, 110, 200)),
    'mort': (70, 150, (220, 220, 200)),
    'painter': (60, 200, (230, 150, 60)),
    'filbert': (60, 110, (90, 200, 80)),
    'squid': (28, 18, (240, 140, 190)),
}


def font(px):
    for f in ['/System/Library/Fonts/Supplemental/Georgia.ttf', '/System/Library/Fonts/Helvetica.ttc']:
        if os.path.exists(f):
            return ImageFont.truetype(f, px)
    return ImageFont.load_default()


def npc(nid, w, h, color):
    d = os.path.join(GAME, 'actors', nid)
    if os.path.exists(os.path.join(d, 'actor.json')) and not json.load(open(os.path.join(d, 'actor.json'))).get('placeholder'):
        return
    os.makedirs(os.path.join(d, 'cels'), exist_ok=True)
    cels, frames = {}, []
    for i, mouth in enumerate([0, 1]):
        im = Image.new('RGBA', (w * S, h * S), (0, 0, 0, 0))
        dr = ImageDraw.Draw(im)
        dr.rounded_rectangle([4, 4, w * S - 4, h * S - 4], radius=w * S // 3, fill=color + (230,), outline=(20, 20, 20, 255), width=6)
        hx, hy, hr = w * S // 2, w * S // 2, w * S // 3
        dr.ellipse([hx - hr, hy - hr // 2, hx + hr, hy + hr * 3 // 2], fill=(250, 220, 190, 255), outline=(20, 20, 20, 255), width=5)
        if mouth:
            dr.ellipse([hx - hr // 3, hy + hr // 2, hx + hr // 3, hy + hr], fill=(80, 0, 0, 255))
        else:
            dr.line([hx - hr // 3, hy + hr * 3 // 4, hx + hr // 3, hy + hr * 3 // 4], fill=(40, 0, 0, 255), width=5)
        dr.text((10, h * S // 2), nid, fill=(0, 0, 0, 255), font=font(max(14, w * S // 6)))
        name = f'cels/{i:04d}.png'
        im.save(os.path.join(d, name))
        cels[str(i)] = {'file': name, 'w': w, 'h': h}
    one = lambda c: {'cels': [{'cel': c, 'x': -w / 2, 'y': -h}], 'hold': 1}
    anims = {
        'stand': {'fps': 4, 'loop': True, 'limbs': [{'limb': 0, 'frames': [one(0)]}]},
        'talk': {'fps': 6, 'loop': True, 'limbs': [{'limb': 0, 'frames': [one(0), one(1), one(0), one(1), one(1), one(0)]}]},
    }
    for extra in ['laugh', 'paint', 'stamp', 'screw', 'look', 'ink', 'blush', 'hide']:
        anims[extra] = {'fps': 6, 'loop': extra in ('laugh', 'paint', 'hide'), 'limbs': [{'limb': 0, 'frames': [one(0), one(1)] * 3}]}
    json.dump({'id': nid, 'scale': S, 'placeholder': True, 'cels': cels, 'anims': anims,
               'roles': {'stand': 'stand', 'talk': 'talk', 'walk': 'stand'}}, open(os.path.join(d, 'actor.json'), 'w'), indent=1)
    print('placeholder costume', nid)


def icons():
    from importlib import util
    import subprocess
    # item names from game.js (simple regex; good enough for placeholders)
    src = open(os.path.join(GAME, 'game.js')).read()
    items = re.findall(r"\n    (\w+): \{\n      name: '([^']+)', icon: '([^']+)'", src)
    for iid, name, icon in items:
        path = os.path.join(GAME, icon)
        if os.path.exists(path):
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        im = Image.new('RGBA', (80 * S, 56 * S), (0, 0, 0, 0))
        dr = ImageDraw.Draw(im)
        dr.rounded_rectangle([12, 12, 80 * S - 12, 56 * S - 12], radius=30, fill=(236, 214, 160, 255), outline=(60, 35, 10, 255), width=8)
        f = font(30)
        words, lines, line = name.split(), [], ''
        for w_ in words:
            t = (line + ' ' + w_).strip()
            if dr.textlength(t, font=f) > 80 * S - 50 and line:
                lines.append(line); line = w_
            else:
                line = t
        lines.append(line)
        y = 56 * S // 2 - len(lines) * 18
        for ln in lines:
            dr.text((80 * S // 2 - dr.textlength(ln, font=f) / 2, y), ln, fill=(60, 30, 0, 255), font=f)
            y += 36
        im.save(path)
        print('placeholder icon', icon)


def rooms():
    for room, src in [('harbor', 'cmi_s1.png'), ('office', 'cmi_s2.png'), ('records', 'cmi_s1.png')]:
        out = os.path.join(GAME, 'rooms', room, 'bg.jpg')
        if os.path.exists(out):
            continue
        os.makedirs(os.path.dirname(out), exist_ok=True)
        Image.open(os.path.join(ROOT, 'art', 'rooms', room, src)).convert('RGB').save(out, quality=92)
        print('placeholder bg', room)


if __name__ == '__main__':
    for k, v in NPCS.items():
        npc(k, *v)
    icons()
    rooms()
