#!/usr/bin/env python3
"""Builds "License to Pillage" as a real chapter of The Curse of Monkey Island (SCUMM v8), from the
web game in game/ (single source of truth: rooms, objects, dialogue, puzzles, art).

  python3 tools/scumm/build.py            # -> scumm/game/COMI.LA0 + COMI.LA3 (+ links), scumm/hdtheme/2-levels/
  python3 tools/scumm/build.py --game KEY # a level-editor project games/KEY -> scumm/projects/KEY/ (configure_project)
  "License to Pillage (CMI).command"      # plays it in the user's HD ScummVM build

Room numbers 95 harbor, 96 office, 97 records, 98 items/icons, 99-101 full-screen cards; objects
from 1401; costumes from 446; new global scripts from 459; global script 119 (new game) and 130
(Part I) are replaced so a new game starts straight in the new chapter. See scumm/NOTES.md.
"""
import hashlib
import json
import math
import re
import os
import struct
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scummres as sr          # noqa: E402
import scummwrite as sw        # noqa: E402
import v8asm                   # noqa: E402
import akos                    # noqa: E402
import audio                   # noqa: E402
from jsgame import Game, Func  # noqa: E402
import jsgame                  # noqa: E402
import compiler as compiler_mod  # noqa: E402
from compiler import (Compiler, Script, Scope, CompileError, js_quote, var_value, V,  # noqa: E402
                      FAR, VAR_ROOM, VAR_EGO, ANY_ITEM_VERB, DIRS, TICKS_PER_SEC)

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
GAME = os.path.join(ROOT, 'game')
OUT = os.path.join(ROOT, 'scumm', 'game')
THEME = os.path.join(ROOT, 'scumm', 'hdtheme', '2-levels')
LOG = os.path.join(ROOT, 'scumm', 'build')
S = 4

ROOMS = {'harbor': 95, 'office': 96, 'records': 97}
# Extended Edition rooms (edition: 'extended'): added to ROOMS when their art exists, numbered right after the
# cards (the index's room directory must stay contiguous: CMI 1-94, ours 95-98, cards 99+, then these)
EXT_ROOMS = ['alley', 'tavern', 'beach']
ITEMS_ROOM = 98
IMAGE_TITLES = {'art/title.jpg': 'LICENSE TO PILLAGE', 'art/chapter.jpg': 'Part I', 'art/the_end.jpg': 'THE END'}
IMAGES = {}   # path -> (room, name, placeholder title); filled from the g.showImage() calls in the JS
ACTORS = {'guybrush': 1, 'player': 1, 'agatha': 2, 'mort': 3, 'painter': 4, 'filbert': 5, 'squid': 6, 'murray': 11}   # 7-9: CMI's scripts use them
VOICE_ACTOR = 10
COSTUME_BASE = 446
# iMUSE states our rooms set (soundKludge 4096): CMI's own tracks, or ours (game/music/<name>.mp3) under
# those states' file names in MUSDISK3.BUN (see audio.py; --cmi-music keeps CMI's tracks)
MUSIC = {'harbor': 1260, 'office': 1285, 'records': 1460, 'title': 1099, 'ending': 1515}
MUSIC_SLOTS = (1260, 1285, 1460, 1515, 1099)     # the states a level-editor project's music goes into, in order
MUSIC_FILES = {1099: '1099-M~1.IMX', 1260: '1260-T~1.IMX', 1285: '1285-B~1.IMX', 1460: '1460-C~1.IMX',
               1515: '1515-C~1.IMX'}
OPTS = {'cmi_music': False, 'lang': 'en'}
TALK_COLORS = {'murray': 14, 'agatha': 227, 'mort': 228, 'painter': 229, 'filbert': 230, 'squid': 231, 'harbormaster': 232,
               '_narrator': 233}
ART_LO, ART_HI = 24, 226     # palette range for room art + NPC costumes
NPC_COSTUMES = ('agatha', 'mort', 'painter', 'filbert', 'squid')   # our NPC costumes (game/actors/<who>), in number order
FIRST_ROOM = 'harbor'        # the room whose LFLF holds the shared extras (voice costume, item scripts' context)
PROJECT = None               # --game KEY: a level-editor project instead of License to Pillage
ITEM_VERB_BASE = 230
FLAG_VAR_BASE = 1500
NEW_SCRIPT_BASE = 459
ARROWS = {'W': 106, 'E': 107, 'N': 108, 'S': 109, 'NW': 110, 'NE': 111, 'SE': 112, 'SW': 113}
CLASS_EXIT = 1 << 27        # class 28 (156)
CLASS_UNTOUCHABLE = 1 << 31  # class 32 (160)
CLASS_PERSON = 1 << 22       # class 23 (151): "push" / "give X to" labels
CLASS_ICON = 1 << 28         # class 29 (157): inventory icon (CMI's input scripts 32-35 use items only with it)
ANIM_STATES = 15             # SCUMM draws an object only while (state & 0xF) != 0: room anims use 15 frames per object
ANIM_SCRIPT = 2001           # room anims' local script (2000 = the room's enter handler)


def say_asm(text, actor=1):
    return f'push {actor}\n    talkActor {js_quote(text)}\n    wait.forMessage\n'


# ------------------------------------------------------------------ geometry
def point_in_poly(p, poly):
    x, y = p
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


class Walk:
    def __init__(self, d):
        self.polys = (d or {}).get('polys', [])
        self.holes = (d or {}).get('holes', [])

    def inside(self, p):
        if not self.polys:
            return True
        return any(point_in_poly(p, q) for q in self.polys) and not any(point_in_poly(p, h) for h in self.holes)

    def closest(self, p):
        if self.inside(p):
            return [p[0], p[1]]
        best, bd = None, 1e18
        for poly in self.polys + self.holes:
            for i in range(len(poly)):
                a, b = poly[i], poly[(i + 1) % len(poly)]
                dx, dy = b[0] - a[0], b[1] - a[1]
                l2 = dx * dx + dy * dy or 1
                t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
                q = (a[0] + t * dx, a[1] + t * dy)
                d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2
                if d < bd:
                    bd, best = d, q
        for r in (1.5, 3, 6, 10):
            for k in range(16):
                a = k / 16 * 2 * math.pi
                q = (best[0] + math.cos(a) * r, best[1] + math.sin(a) * r)
                if self.inside(q):
                    return [q[0], q[1]]
        return [best[0], best[1]]

    def boxes(self, splits=()):
        """Trapezoid decomposition of the walk area into SCUMM boxes (horizontal slabs)."""
        rings = self.polys + self.holes
        ys = sorted({int(round(y)) for r in rings for _, y in r} | {int(s) for s in splits})
        edges = []
        for r in rings:
            for i in range(len(r)):
                edges.append((tuple(r[i]), tuple(r[(i + 1) % len(r)])))

        def x_at(e, y):
            (x1, y1), (x2, y2) = e
            if y2 == y1:
                return x1
            return x1 + (y - y1) * (x2 - x1) / (y2 - y1)
        out = []
        for ya, yb in zip(ys, ys[1:]):
            if yb - ya < 1:
                continue
            ym = (ya + yb) / 2
            xs = []
            for e in edges:
                (x1, y1), (x2, y2) = e
                if (y1 <= ym < y2) or (y2 <= ym < y1):
                    xs.append((x_at(e, ym), e))
            xs.sort(key=lambda t: t[0])
            for (xa, ea), (xb, eb) in zip(xs, xs[1:]):
                if xb - xa < 1:
                    continue
                if self.inside(((xa + xb) / 2, ym)):
                    out.append({'ul': (int(round(x_at(ea, ya))), ya), 'ur': (int(round(x_at(eb, ya))), ya),
                                'lr': (int(round(x_at(eb, yb))), yb), 'll': (int(round(x_at(ea, yb))), yb)})
        return out


def rect_of(o):
    if o.get('box'):
        x, y, w, h = o['box']
        return x, y, w, h
    if o.get('hot'):
        xs = [p[0] for p in o['hot']]
        ys = [p[1] for p in o['hot']]
        return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)
    return None


# ------------------------------------------------------------------ ids
class Ids:
    """Numbers for everything the compiler references (objects, actors, vars, states, anims...)."""

    def __init__(self, game, costumes):
        self.gm = game
        self.game = game.game
        self.costumes = costumes     # id -> dict (actor.json + 'num', 'anim_nums')
        self.next_obj = None
        self.objs = {}               # (room, id) -> num
        self.img_objs = {}           # (room, id) -> num
        self.items = {}              # item -> num
        self.icons = {}              # item -> num
        self.npc_hot = {}            # (room, npc) -> num
        self.entries = {}            # (room, x, y, dir) -> num
        self.flags = {}
        self.vars_next = FLAG_VAR_BASE
        self.scripts = {}            # name -> number
        self.script_next = NEW_SCRIPT_BASE
        self.obj_defs = {}           # num -> def dict for build
        self.order = []

    # objects
    def alloc(self, key_room, key_id, kind, **d):
        n = self.next_obj
        self.next_obj += 1
        self.obj_defs[n] = dict(room=key_room, id=key_id, kind=kind, **d)
        self.order.append(n)
        return n

    def obj(self, room, oid):
        if (room, oid) in self.objs:
            return self.objs[(room, oid)]
        if (room, oid) in self.npc_hot:
            return self.npc_hot[(room, oid)]
        raise CompileError(f'no object {oid} in {room}')

    def item_obj(self, item):
        if item not in self.items:
            raise CompileError('no item ' + str(item))
        return self.items[item]

    def item_verb(self, item):
        return ITEM_VERB_BASE + list(self.game['items']).index(item)

    def room_num(self, room):
        if room in ROOMS:
            return ROOMS[room]
        raise CompileError('no room ' + str(room))

    def room_def(self, room):
        return self.gm.rooms[room]

    def obj_def(self, room, oid):
        for o in self.room_def(room).get('objects', []):
            if o['id'] == oid:
                return o
        raise CompileError(f'no object def {oid} in {room}')

    # vars
    def var(self, key):
        if key not in self.flags:
            self.flags[key] = self.vars_next
            self.vars_next += 1
        return self.flags[key]

    def flag_var(self, k):
        return self.var('flag:' + str(k))

    def hidden_var(self, room, oid):
        return self.var(f'hidden:{room}:{oid}')

    def base_var(self, who):
        return self.var('base:' + who)

    def visible_var(self, who):
        return self.var('visible:' + who)

    def from_var(self):
        return self.var('from_room')

    # states
    def state_list(self, room, oid):
        o = self.obj_def(room, oid)
        states = o.get('states') or {}
        nulls = [k for k, v in states.items() if not v]
        imgs = [k for k, v in states.items() if v]
        m = {}
        for i, k in enumerate(imgs):
            m[k] = i + 1
        for k in nulls:
            m[k] = 0
        return m, imgs

    def state_num(self, room, oid, st):
        m, _ = self.state_list(room, oid)
        if st not in m:
            raise CompileError(f'no state {st} for {room}.{oid}')
        return m[st]

    def default_state(self, room, oid):
        o = self.obj_def(room, oid)
        if not o.get('states'):
            return 0
        m, _ = self.state_list(room, oid)
        return m.get(o.get('state'), 0)

    def state_objs(self, room, oid):
        out = [self.obj(room, oid)]
        if (room, oid) in self.img_objs:
            out.append(self.img_objs[(room, oid)])
        return out

    def state_name(self, room, oid, st):
        o = self.obj_def(room, oid)
        nm = o.get('name')
        if isinstance(nm, Func):
            return eval_name(nm, room, oid, st)
        return None

    # actors
    def actor(self, who):
        if who in ACTORS:
            return ACTORS[who]
        if who == self.game.get('player'):
            return 1
        raise CompileError('no actor ' + str(who))

    def actor_place(self, room, who):
        return (self.room_def(room).get('actors') or {}).get(who)

    def npc_hotspot(self, room, who):
        return self.npc_hot.get((room, who))

    def anim_num(self, who, name):
        c = self.costumes.get(who)
        if not c:
            return None
        return c['anim_nums'].get(name) or c['anim_nums'].get(c.get('roles', {}).get(name, ''))

    def anim_holds(self, who, name):
        c = self.costumes.get(who)
        a = c and c['anims'].get(name)
        return bool(a) and a.get('loop') is False

    def anim_ticks(self, who, name):
        c = self.costumes.get(who)
        a = c and c['anims'].get(name)
        if not a:
            return 0
        frames = sum(f.get('hold', 1) for f in a['limbs'][0]['frames'])
        return round(frames * 60 / 12)

    def music_state(self, name):
        return MUSIC.get(name)

    def image_room(self, img):
        return IMAGES.get(img, (None,))[0]

    def game_rooms(self):
        return set(ROOMS)

    def talker(self, sc, who):
        """Actor number that says a line in the current room; off-stage speakers use the voice actor."""
        if who in ('player', self.game.get('player')):
            return 1
        room = sc.room
        place = self.actor_place(room, who) if room in ROOMS else None
        if who in self.costumes and place is not None:
            return ACTORS[who]
        # voice actor: color + position (room anchor or next to Guybrush)
        color = TALK_COLORS.get(who, 15)
        anchor = (self.room_def(room).get('voices') or {}).get(who) if room in ROOMS else None
        sc.e(f'push {VOICE_ACTOR}')
        sc.e('actorOps.setCurActor')
        sc.e(f'push {color}')
        sc.e('actorOps.talkColor')
        if anchor:
            sc.e('push 0')
            sc.e('push -40')
            sc.e('actorOps.textOffset')
            sc.e(f'push {VOICE_ACTOR}')
            sc.e(f'push {int(anchor[0])}')
            sc.e(f'push {int(anchor[1])}')
            sc.e(f'pushvar {VAR_ROOM}')
            sc.e('putActorAtXY')
        else:
            sc.e('push 20')
            sc.e('push -250')
            sc.e('actorOps.textOffset')
            sc.e(f'push {VOICE_ACTOR}')
            sc.e('push 1')
            sc.e('getObjectX')
            sc.e('push 1')
            sc.e('getObjectY')
            sc.e(f'pushvar {VAR_ROOM}')
            sc.e('putActorAtXY')
        return VOICE_ACTOR

    # global scripts
    def script(self, name):
        if name not in self.scripts:
            self.scripts[name] = self.script_next
            self.script_next += 1
        return self.scripts[name]


def eval_name(fn, room, oid, st):
    """Static value of `name: g => g.state('x') === 'inky' ? 'a' : 'b'` for a given state."""
    body = fn.node['body']

    def ev(n):
        t = n['type']
        if t == 'Literal':
            return n['value']
        if t == 'ConditionalExpression':
            return ev(n['consequent']) if ev(n['test']) else ev(n['alternate'])
        if t == 'BinaryExpression':
            a, b = ev(n['left']), ev(n['right'])
            return a == b if n['operator'] in ('===', '==') else a != b
        if t == 'CallExpression':
            return st    # g.state(<this object>)
        raise CompileError('dynamic name ' + t)
    return ev(body)


# ------------------------------------------------------------------ art helpers
def load_rgba(path):
    return Image.open(path).convert('RGBA')


def icon_ring(im, r, color):
    """CMI's highlighted icon (state 2): the icon on a solid ring, its opaque area dilated by a disc of
    radius r (fits CMI's icons: r 2 at 1x, ~6 in the HD pack)."""
    a = np.asarray(im)[:, :, 3] >= 128
    h, w = a.shape
    d = np.zeros_like(a)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r:
                d[max(0, dy):h + min(0, dy), max(0, dx):w + min(0, dx)] |= \
                    a[max(0, -dy):h - max(0, dy), max(0, -dx):w - max(0, dx)]
    ring = Image.new('RGBA', im.size, color + (0,))
    ring.putalpha(Image.fromarray((d * 255).astype(np.uint8)))
    ring.alpha_composite(im)
    return ring


def cel_path(c, info):
    """A costume cel file as referenced by actor.json (stale placeholder PNGs may sit next to it)."""
    path = os.path.join(c['dir'], info['file'])
    if os.path.exists(path):
        return path
    return path.rsplit('.', 1)[0] + '.png'


def game_path(p):
    return os.path.join(GAME, p)


def ref_palette():
    idx = sr.Index()
    df, (lf, size) = sr.find_room(9, idx)
    for depth, tag, o, sz in sr.tree(df.data, lf + 8, lf + size, maxdepth=4):
        if tag == 'APAL':
            return bytes(df.data[o + 8:o + 8 + 768])
    raise RuntimeError('no palette')


def hex_rgb(c):
    c = c.lstrip('#')
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def make_palette(bg_rgb, sprites, ref, talk):
    """Quantizes the room image + its sprites into ART_LO..ART_HI; returns (palette768, lut function)."""
    n = ART_HI - ART_LO + 1
    parts = [bg_rgb]
    for sp in sprites:
        a = np.asarray(sp)
        if a.shape[2] == 4:
            m = a[:, :, 3] > 128
            px = a[:, :, :3][m]
        else:
            px = a.reshape(-1, 3)
        if len(px):
            k = int(math.ceil(len(px) / 256))
            pad = np.zeros((k * 256 - len(px), 3), np.uint8)
            parts.append(Image.fromarray(np.concatenate([px, pad]).reshape(k, 256, 3)))
    W = max(p.width for p in parts)
    H = sum(p.height for p in parts)
    sheet = Image.new('RGB', (W, H))
    y = 0
    for p in parts:
        sheet.paste(p, (0, y))
        y += p.height
    q = sheet.quantize(colors=n, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    qp = q.getpalette()[:n * 3]
    pal = bytearray(ref)
    pal[ART_LO * 3:(ART_HI + 1) * 3] = bytes(qp) + bytes(n * 3 - len(qp))
    for who, idx in TALK_COLORS.items():
        pal[idx * 3:idx * 3 + 3] = bytes(talk.get(who, (255, 255, 255)))
    return bytes(pal)


def pal_image(pal):
    """A P-mode image holding only the art range; unused slots repeat entry 0 (mapped back to 0)."""
    p = Image.new('P', (1, 1))
    flat = list(pal[ART_LO * 3:(ART_HI + 1) * 3])
    n = len(flat) // 3
    full = flat + flat[:3] * (256 - n)
    p.putpalette(full)
    return p


def to_indices(img_rgb, pal, dither=True):
    q = img_rgb.convert('RGB').quantize(palette=pal_image(pal), dither=Image.Dither.FLOYDSTEINBERG if dither else Image.Dither.NONE)
    a = np.asarray(q, np.uint16)
    a[a > ART_HI - ART_LO] = 0
    return (a + ART_LO).astype(np.uint8)


def shrink_rgba(im, size):
    """RGBA downscale for the 1x (non-HD) art. Cut-outs keep a little of the matte they were cut from in their soft
    edges (light, for most of ours), which turns into a pale rim once alpha is thresholded at 1x: edge colours are
    first pulled toward their nearest solid neighbour (never lightened, so dark soft shadows stay dark), then the
    image is resized premultiplied (fully transparent pixels add no colour)."""
    a = np.asarray(im.convert('RGBA')).astype(np.float32)
    rgb, alpha = a[:, :, :3].copy(), a[:, :, 3]
    solid = alpha >= 250
    if solid.any() and not solid.all():
        fill, known = rgb * solid[:, :, None], solid.astype(np.float32)
        for _ in range(8):
            p = np.pad(fill, ((1, 1), (1, 1), (0, 0)))
            q = np.pad(known, 1)
            num = sum(p[1 + dy:p.shape[0] - 1 + dy, 1 + dx:p.shape[1] - 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
            den = sum(q[1 + dy:q.shape[0] - 1 + dy, 1 + dx:q.shape[1] - 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
            grow = (known == 0) & (den > 0)
            fill[grow] = num[grow] / den[grow][:, None]
            known[grow] = 1
        edge = (alpha > 0) & ~solid & (known > 0)
        rgb[edge] = np.minimum(rgb[edge], fill[edge])
    out = Image.fromarray(np.dstack([rgb, alpha]).clip(0, 255).astype(np.uint8))
    return out.convert('RGBa').resize(size, Image.LANCZOS).convert('RGBA')


def sprite_indices(rgba, pal, transparent=255):
    a = np.asarray(rgba)
    idx = to_indices(Image.fromarray(a[:, :, :3]), pal, dither=False)
    idx[a[:, :, 3] < 128] = transparent
    return idx


# ------------------------------------------------------------------ builder
class Builder:
    def __init__(self):
        self.gm = Game(GAME)
        self.game = self.gm.game
        self.find_images()
        self.ref = ref_palette()
        self.index = sr.Index()
        self.warnings = []
        self.load_costumes()
        # Extended Edition rooms are built when their art exists; objects with `edition` (e.g. the harbor's east
        # exit) are hidden at room entry unless that edition's flag is set (encd)
        nxt = ITEMS_ROOM + 1 + len(IMAGES)
        for rid in EXT_ROOMS:
            r = self.gm.rooms.get(rid)
            if r and os.path.exists(game_path(r['layers'][0]['img'])):
                ROOMS[rid] = nxt
                nxt += 1
            elif r:
                self.warnings.append(f'extended room {rid}: no art yet, not built')
        self.ids = Ids(self.gm, self.costumes)
        self.ids.pose = self.pose_costume
        self.ids.special = self.special_costume
        # sound effects (game.sfx) and room ambiences -> SOUN resources from CMI's 789 on
        self.sfx_files = {}
        n = self.index.maxs['numSounds']
        for name, f in (self.game.get('sfx') or {}).items():
            path = game_path(f if isinstance(f, str) else f.get('file'))
            if name != 'ui_chest' and os.path.exists(path):
                self.sfx_files[name] = (n, path, False)
                n += 1
        for rid in ROOMS:
            amb = self.gm.rooms[rid].get('ambience')
            if amb and os.path.exists(game_path(amb)):
                self.sfx_files['amb:' + rid] = (n, game_path(amb), True)
                n += 1
        self.ids.sfx = {k: v[0] for k, v in self.sfx_files.items()}
        self.ids.next_obj = self.index.maxs['numGlobalObjects']
        self.cc = Compiler(self.ids, self.gm)
        self.voices = audio.Voices(GAME)
        self.cc.voices = self.voices
        self.audio_report = {}
        self.new_scripts = {}    # number -> asm text
        self.theme_files = []

    def find_images(self):
        """Every g.showImage('<literal>') in the game gets a full-screen card room (99, 100, ...)."""
        paths = []

        def walk(n):
            if isinstance(n, dict):
                if n.get('type') == 'CallExpression':
                    c = n['callee']
                    if (c.get('type') == 'MemberExpression' and not c.get('computed') and
                            c['property'].get('name') == 'showImage' and n['arguments'] and
                            n['arguments'][0].get('type') == 'Literal'):
                        p = n['arguments'][0]['value']
                        if p not in paths:
                            paths.append(p)
                for v in n.values():
                    walk(v)
            elif isinstance(n, list):
                for v in n:
                    walk(v)
        for ast in self.gm.asts.values():
            walk(ast)
        # the game's cards table too: {card} data steps compile to g.showImage of these paths, and a
        # placeholder card carries the game's own title (the `title` card) or the card's name
        titles = {}
        for cid, v in (self.game.get('cards') or {}).items():
            p = v if isinstance(v, str) else v.get('img') if isinstance(v, dict) else None
            if isinstance(p, str):
                if p not in paths:
                    paths.append(p)
                titles[p] = ((self.game.get('title') or self.game.get('name') or cid) if cid == 'title'
                             else cid.replace('_', ' ')).upper()
        IMAGES.clear()
        for i, p in enumerate(paths):
            stem = os.path.splitext(os.path.basename(p))[0]
            IMAGES[p] = (ITEMS_ROOM + 1 + i, ('lp' + stem.replace('_', ''))[:8],
                         IMAGE_TITLES.get(p, titles.get(p, stem.replace('_', ' ').upper())))

    # -------------------------------------------------- costumes
    def load_costumes(self):
        self.costumes = {}
        n = COSTUME_BASE
        for who in NPC_COSTUMES:
            path = os.path.join(GAME, 'actors', who, 'actor.json')
            if not os.path.exists(path):
                continue
            d = json.load(open(path))
            d['num'] = n
            d['dir'] = os.path.dirname(path)
            # anim numbers: 1 init, 2 walk, 3 stand, 4 talk, 5 talk stop, then the rest
            names = ['stand', 'talk'] + sorted(k for k in d['anims'] if k not in ('stand', 'talk'))
            nums = {'init': 1, 'walk': 2, 'stand': 3, 'talk': 4, 'talk_stop': 5}
            nxt = 6
            for k in names:
                if k not in nums:
                    nums[k] = nxt
                    nxt += 1
            d['anim_nums'] = nums
            self.costumes[who] = d
            n += 1
        self.voice_costume = n
        # Murray (Extended Edition): CMI's own costume 12, extracted by tools/akos_extract.py, re-encoded like our
        # NPCs with the room's palette (CMI's costume points its colours at room palette slots that hold our art
        # here, and remapCostume can't fix that); stand + talk, mirrored at build time to face W like the web
        mp = os.path.join(GAME, 'actors', 'murray', 'actor.json')
        if os.path.exists(mp):
            m = json.load(open(mp))
            # the facing he sits in (tavern: W = CMI's E view mirrored, with the W anims' own cel offsets)
            face = next((rd['actors']['murray'].get('dir', 'E') for rd in self.gm.rooms.values()
                         if 'murray' in (rd.get('actors') or {})), 'E')
            ref = lambda r: m['roles'][r][face] if isinstance(m['roles'][r][face], dict) else {'anim': m['roles'][r][face]}
            role = lambda r: ref(r)['anim']
            anims = {'stand': m['anims'][role('stand')], 'talk': m['anims'][role('talk')]}
            used = {str(c['cel']) for a in anims.values() for f in a['limbs'][0]['frames'] for c in f['cels']}
            self.costumes['murray'] = {'num': n + 3, 'dir': os.path.dirname(mp), 'anims': anims, 'height': 40,
                                       'mirror': bool(ref('stand').get('flip')),
                                       'cels': {k: v for k, v in m['cels'].items() if k in used},
                                       'anim_nums': {'init': 1, 'walk': 2, 'stand': 3, 'talk': 4, 'talk_stop': 5}}
        # Guybrush's portrait pose (eye patch + Filbert, normal / sour): a small extra costume for
        # actor 1, swapped in like CMI does for special actions (web: actors/guybrush pose_* frames)
        self.pose_costume = None
        gpath = os.path.join(GAME, 'actors', 'guybrush', 'actor.json')
        if os.path.exists(gpath):
            g = json.load(open(gpath))
            poses = {k[:-2]: v for k, v in g['anims'].items() if k.startswith('pose') and k.endswith('_E')}
            if 'pose' in poses:
                used = {str(f['cels'][0]['cel']) for a in poses.values() for f in a['limbs'][0]['frames']}
                anims = {'stand': poses['pose'], 'talk': poses['pose'], **poses}
                nums = {'init': 1, 'walk': 2, 'stand': 3, 'talk': 4, 'talk_stop': 5}
                for k in sorted(poses):
                    nums.setdefault(k, max(nums.values()) + 1)
                nums['pose'] = 3
                self.pose_costume = {'num': n + 1, 'dir': os.path.dirname(gpath), 'anims': anims,
                                     'cels': {k: v for k, v in g['cels'].items() if k in used}, 'anim_nums': nums}
        # Guybrush's one-shot special gestures (fence_tickle: the feather lunge, tools/guybrush_fence.py):
        # one more extra costume for actor 1, swapped in for the gesture and back to costume 2 after it
        # (compiler.gesture). Lives in the LFLF of the room that uses it, built with that room's palette.
        self.special_costume = None
        if os.path.exists(gpath):
            sp = {k.rsplit('_', 1)[0]: v for k, v in g['anims'].items() if k.startswith('fence_')}
            if sp:
                used = {str(f['cels'][0]['cel']) for a in sp.values() for f in a['limbs'][0]['frames']}
                first = next(iter(sp.values()))
                still = {'loop': True, 'limbs': [{'limb': 0, 'op': 'set', 'frames': [dict(first['limbs'][0]['frames'][0], hold=1)]}]}
                nums = {'init': 1, 'walk': 2, 'stand': 3, 'talk': 4, 'talk_stop': 5}
                for k in sorted(sp):
                    nums[k] = max(nums.values()) + 1
                frames = {k: sum(int(f.get('hold', 1)) for f in a['limbs'][0]['frames']) for k, a in sp.items()}
                self.special_costume = {'num': n + 2, 'dir': os.path.dirname(gpath), 'anims': {'stand': still, **sp},
                                        'cels': {k: v for k, v in g['cels'].items() if k in used}, 'anim_nums': nums,
                                        'frames': frames, 'room': self.room_using(list(sp)) or 'office'}

    def room_using(self, names):
        """The room whose script source mentions one of these names as a string literal."""
        def has(n):
            if isinstance(n, dict):
                if n.get('type') == 'Literal' and n.get('value') in names:
                    return True
                return any(has(v) for v in n.values())
            if isinstance(n, list):
                return any(has(v) for v in n)
            return False
        for path, ast in self.gm.asts.items():
            rid = os.path.splitext(os.path.basename(path))[0]
            if os.path.basename(os.path.dirname(path)) == 'rooms' and rid in ROOMS and has(ast):
                return rid
        return None

    def room_of_costume(self, who):
        for rid, r in self.gm.rooms.items():
            if who in (r.get('actors') or {}):
                return rid
        return None

    def costume_scale(self, who, rid):
        place = self.gm.rooms[rid]['actors'][who]
        if place.get('scale') is not None:
            return float(place['scale'])
        sc = self.gm.rooms[rid].get('scale')
        if sc:
            (y1, s1), (y2, s2) = sc[0], sc[-1]
            y = place['y']
            return s1 + (s2 - s1) * (y - y1) / (y2 - y1)
        return 1.0

    def build_costume(self, who, pal, rid, c=None, scale=None):
        """AKOS block + HD cel files for an NPC, baked at its fixed on-screen scale (or at `scale`:
        1.0 for actor 1's pose costume, which the engine scales like Guybrush's own)."""
        c = c or self.costumes[who]
        s = scale if scale is not None else self.costume_scale(who, rid)
        cels_hd, cels_lo, offs = [], [], []
        celmap = {}
        for cid, info in sorted(c['cels'].items(), key=lambda kv: int(kv[0])):
            im = load_rgba(cel_path(c, info))
            if c.get('mirror'):
                im = im.transpose(Image.FLIP_LEFT_RIGHT)
            w = max(1, int(round(info['w'] * s)))
            h = max(1, int(round(info['h'] * s)))
            lo = shrink_rgba(im, (w, h))
            hd = im.resize((w * S, h * S), Image.LANCZOS)
            celmap[cid] = len(cels_lo)
            cels_lo.append(lo)
            cels_hd.append(hd)
        # palette codes: up to 31 room palette entries used by this costume
        allpx = np.concatenate([np.asarray(im)[np.asarray(im)[:, :, 3] >= 128][:, :3] for im in cels_lo if im.getbbox()] or
                               [np.zeros((1, 3), np.uint8)])
        k = int(math.ceil(len(allpx) / 256))
        sheet = Image.fromarray(np.concatenate([allpx, np.zeros((k * 256 - len(allpx), 3), np.uint8)]).reshape(k, 256, 3))
        idx = to_indices(sheet, pal, dither=False).reshape(-1)[:len(allpx)]
        vals, counts = np.unique(idx, return_counts=True)
        top = [int(v) for v in vals[np.argsort(-counts)][:31]]
        akpl = [0] + top
        sub = np.array([[pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]] for i in top], np.float32)
        codes = []
        for im in cels_lo:
            a = np.asarray(im).astype(np.float32)
            d = ((a[:, :, None, :3] - sub[None, None]) ** 2).sum(-1)
            code = d.argmin(-1).astype(np.uint8) + 1
            code[a[:, :, 3] < 128] = 0
            codes.append(code)
        rgbs = [(0, 0, 0)] + [tuple(pal[i * 3:i * 3 + 3]) for i in top]
        anims = {}
        for name, a in c['anims'].items():
            num = c['anim_nums'][name]
            frames = []
            for fr in a['limbs'][0]['frames']:
                cel = fr['cels'][0]
                ci = celmap[str(cel['cel'])]
                for _ in range(max(1, int(fr.get('hold', 1)))):     # (mirrored cels keep their box, as the web)
                    frames.append((ci, cel['x'] * s, cel['y'] * s))
            anims[num] = {'frames': frames, 'loop': a.get('loop', True) is not False}
        # talk stop (5) = first stand frame, init (1) = stand
        st = anims[c['anim_nums']['stand']]
        anims.setdefault(4, dict(st))
        anims[5] = {'frames': [st['frames'][0]], 'loop': False}
        anims[1] = dict(st)
        anims[2] = dict(st)
        blk = akos.build(anims, codes, akpl, rgbs)
        num = c['num']
        for i, hd in enumerate(cels_hd):
            self.theme(f'costumes/c{num:04d}/c{num:04d}_{i:04d}.png', hd)
        height = max(im.height for im in cels_lo)
        c['height'] = height
        return blk

    def build_voice_costume(self):
        codes = [np.zeros((1, 1), np.uint8)]
        anims = {n: {'frames': [(0, 0, 0)], 'loop': True} for n in (1, 2, 3, 4, 5)}
        return akos.build(anims, codes, [0, 15], [(0, 0, 0), (255, 255, 255)])

    def theme(self, rel, img, **save):
        if not OPTS.get('hd_theme', True):
            return              # --no-hd-theme: stock ScummVM never reads the HD theme
        path = os.path.join(THEME, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        img.save(path, **save)
        self.theme_files.append(rel)

    # -------------------------------------------------- ids for all objects
    def allocate(self):
        ids = self.ids
        for rid in ROOMS:
            r = self.gm.rooms[rid]
            objs = r.get('objects', [])
            # hotspots in click priority: NPCs, then high z, then small
            for who in (r.get('actors') or {}):
                ids.npc_hot[(rid, who)] = ids.alloc(rid, who, 'npc')
            ordered = sorted(enumerate(objs), key=lambda t: (-(t[1].get('hotZ', t[1].get('z', 0)) or 0),
                                                             (lambda rr: rr[2] * rr[3] if rr else 1e9)(rect_of(t[1]))))
            for _, o in ordered:
                ids.objs[(rid, o['id'])] = ids.alloc(rid, o['id'], 'hot')
            for o in objs:
                if any(v for v in (o.get('states') or {}).values()):
                    ids.img_objs[(rid, o['id'])] = ids.alloc(rid, o['id'], 'img')
        # entry points of exits (arrival objects in the target rooms)
        for rid in ROOMS:
            for o in self.gm.rooms[rid].get('objects', []):
                ex = o.get('exit')
                if ex:
                    key = (ex['room'], int(ex['x']), int(ex['y']), ex.get('dir', 'S'))
                    if key not in ids.entries:
                        ids.entries[key] = ids.alloc(ex['room'], f'entry{len(ids.entries)}', 'entry',
                                                     x=key[1], y=key[2], dir=key[3])
        for item in self.game['items']:
            ids.items[item] = ids.alloc('_items', item, 'item')
            ids.icons[item] = ids.alloc('_items', item, 'icon')
        # room anims (the harbor water): per merged rect one object per 15 frames. Allocated last: no other object
        # number moves, and they are the last objects of their room, which SCUMM draws first (under all others)
        for rid in ROOMS:
            for an in self.anim_defs(rid):
                for ri in range(len(an['scumm_rects'])):
                    for k in range(math.ceil(an['frames'] / ANIM_STATES)):
                        ids.alloc(rid, f'{an["id"]}{ri}_{k}', 'anim', anim=an['id'], rect=ri, set=k)

    def anim_defs(self, rid):
        """The room's `anims` entries with their anim.json (frames, fps, scale, atlas tiles, scumm_rects)."""
        out = []
        for d in self.gm.rooms[rid].get('anims') or []:
            if d.get('onlyIf'):        # tied to an object's state (a candle that can be taken): web only for now
                continue
            m = json.load(open(game_path(d['dir'] + 'anim.json')))
            m.update(id=d['id'], dir=d['dir'], fps=d.get('fps', m['fps']))
            out.append(m)
        return out

    def anim_frames(self, an, bg_hd):
        """Per merged rect: the HD frames (the 4x background with that frame's tiles blended in, so everything but
        the water stays the painted art) and the 1x coverage of the moving pixels."""
        sc, P = an['scale'], an.get('pad', 0)
        x0 = min(t['rect'][0] for t in an['atlas'])
        y0 = min(t['rect'][1] for t in an['atlas'])
        x1 = max(t['rect'][0] + t['rect'][2] for t in an['atlas'])
        y1 = max(t['rect'][1] + t['rect'][3] for t in an['atlas'])
        hd = {ri: [] for ri in range(len(an['scumm_rects']))}
        cover = {}
        for i in range(an['frames']):
            atlas = Image.open(game_path(an['dir'] + f'f{i:02d}.webp')).convert('RGBA')
            layer = Image.new('RGBA', ((x1 - x0) * S, (y1 - y0) * S), (0, 0, 0, 0))
            for t in an['atlas']:
                x, y, w, h = t['rect']
                tile = atlas.crop((t['ax'] - P, t['ay'] - P, t['ax'] + w * sc + P, t['ay'] + h * sc + P))
                f = S / sc
                tile = tile.resize((round(tile.width * f), round(tile.height * f)), Image.BICUBIC)
                g = round(P * f)
                layer.paste(tile.crop((g, g, g + w * S, g + h * S)), ((x - x0) * S, (y - y0) * S))
            for ri, (x, y, w, h) in enumerate(an['scumm_rects']):
                box = (x * S, y * S, (x + w) * S, (y + h) * S)
                img = bg_hd.crop(box).convert('RGBA')
                img.alpha_composite(layer.crop((box[0] - x0 * S, box[1] - y0 * S, box[2] - x0 * S, box[3] - y0 * S)))
                hd[ri].append(img.convert('RGB'))
                a = np.asarray(layer.crop((box[0] - x0 * S, box[1] - y0 * S, box[2] - x0 * S, box[3] - y0 * S))
                               .getchannel('A').resize((w, h), Image.BOX)) / 255
                cover[ri] = np.maximum(cover.get(ri, 0), a)
        return hd, cover

    # -------------------------------------------------- scripts
    CLOSE_CHEST = '    pushvar 312\n    push 3\n    eq\n    ifNot @chest\n    push 1\n    push 51\n    push 0\n    startScript\n@chest:\n'

    def verb_entries(self, rid, handlers, close_chest=False):
        """handlers: list of (verb, handler, args, name) -> [(verb, asm)] with room changes moved into
        global scripts (object scripts die when the room changes). close_chest: handlers with dialogue
        choices first close CMI's inventory chest (global 51) if it is open (item combinations)."""
        out = []
        for verb, h, args, name in handlers:
            try:
                sc = self.cc.handler_code(h, rid, name, args)
            except CompileError as e:
                # never let one handler break the build: fall back to a default line, report it
                self.warnings.append(f'{name}: {e} (handler replaced by a default line)')
                sc = self.cc.handler_code(self.game['defaults']['look'], rid, name, [])
            # object scripts die when the room changes, and ScummVM stops an item's scripts when the
            # item leaves the inventory (clearOwnerOf): such handlers run as global scripts
            own_item = name.split('.')[1] if name.startswith('item.') else None
            if sc.changes_room or (own_item and own_item in sc.takes):
                num = self.ids.script(name)
                g = self.cc.handler_code(h, rid, name, args, kind='global')
                self.new_scripts[num] = (self.CLOSE_CHEST if close_chest and g.has_dialog else '') + g.text()
                out.append((verb, f'push 0\n    push {num}\n    push 0\n    startScript\n    stopObjectCode\n'))
            else:
                txt = sc.text()
                if close_chest and sc.has_dialog:
                    txt = self.CLOSE_CHEST + txt
                out.append((verb, txt))
            # every compiled handler, for reading/debugging: scumm/build/handlers/<room.obj.verb>.asm
            hdir = os.path.join(LOG, 'handlers')
            os.makedirs(hdir, exist_ok=True)
            with open(os.path.join(hdir, f'{name}.asm'), 'w') as f:
                f.write(out[-1][1])
                if out[-1][1].startswith('push 0\n    push ') and 'startScript' in out[-1][1][:60]:
                    f.write('\n; ---- global script\n' + self.new_scripts[self.ids.script(name)])
        return out

    def label_asm(self, word, word2=None):
        if OPTS['lang'] != 'en':      # translated labels start with a capital ("Nimm Feder")
            word = compiler_mod.tr(word)
            word = word[:1].upper() + word[1:]
        s = f'push 0\n    arrayOps.assignString 630 {js_quote(word, translate=False)}\n'
        if word2 is not None:
            s += f'    push 0\n    arrayOps.assignString 631 {js_quote(word2)}\n'
        return s + '    stopObjectCode\n'

    def object_verbs(self, rid, o, is_npc=False, npc_id=None):
        d = self.game['defaults']
        name = f'{rid}.{npc_id or o["id"]}'
        verbs = o.get('verbs') or {}
        hs = []
        exit_code = None
        if o.get('exit') and not is_npc:
            exit_code = self.exit_asm(rid, o)
        hs.append((6, o.get('look', d['look']), [], name + '.look'))
        if o.get('hand') is not None or not o.get('exit'):
            hs.append((7, o.get('hand', d['push'] if is_npc else d['hand']), [], name + '.hand'))
        hs.append((8, o.get('mouth', d['talk'] if False else (d['talk'] if is_npc else d['mouth'])), [], name + '.mouth'))
        if is_npc and o.get('mouth') is None:
            hs[-1] = (8, d['talk'], [], name + '.mouth')
        use = o.get('use') or {}
        for item, h in use.items():
            if item == '*':
                hs.append((ANY_ITEM_VERB, h, [var_value(201, 'item'), o.get('id')], f'{name}.use.any'))
            elif item in self.game['items']:
                hs.append((self.ids.item_verb(item), h, [item, o.get('id')], f'{name}.use.{item}'))
        entries = self.verb_entries(rid, hs)
        if exit_code:
            entries.append((9, exit_code))
            if o.get('hand') is None:
                entries.append((7, exit_code))
            arrow = ARROWS.get(self.exit_arrow(rid, o), 108)
            entries.append((94, f'push {arrow}\n    writeVar 301\n    stopObjectCode\n'))
        entries.append((216, self.label_asm(verbs.get('hand', 'push' if is_npc else 'use'))))
        entries.append((217, self.label_asm(verbs.get('look', 'look at'))))
        entries.append((218, self.label_asm(verbs.get('mouth', 'talk to' if is_npc else 'eat'))))
        if is_npc:
            entries.append((219, self.label_asm('give', 'to')))
        return entries

    def exit_arrow(self, rid, o):
        ex = o['exit']
        r = rect_of(o) or (0, 0, 0, 0)
        w = self.gm.rooms[rid].get('size', [640, 480])[0]
        cx, cy = r[0] + r[2] / 2, r[1] + r[3] / 2
        if cy > 440:
            return 'S'
        if cx < 80:
            return 'W'
        if cx > w - 80:
            return 'E'
        return 'N'

    def exit_asm(self, rid, o):
        ex = o['exit']
        key = (ex['room'], int(ex['x']), int(ex['y']), ex.get('dir', 'S'))
        entry = self.ids.entries[key]
        sc = Script(self.cc, rid, f'{rid}.{o["id"]}.exit')
        if o.get('onExit') is not None:
            self.cc.compile_handler(sc, o['onExit'], [])
        sc.e(f'push {ROOMS[rid]}')
        sc.e(f'writeVar {self.ids.from_var()}')
        sc.e(f'push {entry}')
        sc.e(f'push {FAR}')
        sc.e(f'push {FAR}')
        sc.e('loadRoomWithEgo')
        sc.e('stopObjectCode')
        return sc.text()

    def item_verbs(self, item):
        it = self.game['items'][item]
        d = self.game['defaults']
        name = f'item.{item}'
        hs = [(6, it.get('look', d['lookItem']), [], name + '.look'),
              (7, it.get('hand', d['handItem']), [], name + '.hand'),
              (8, it.get('mouth', d['mouthItem']), [], name + '.mouth')]
        # combinations: entries for every item that combines with this one (either side defines it)
        for other, ot in self.game['items'].items():
            if other == item:
                continue
            h = (it.get('combine') or {}).get(other)
            if h is None:
                h = (ot.get('combine') or {}).get(item)
                args = [other, item]
            else:
                args = [item, other]
            if h is not None:
                hs.append((self.ids.item_verb(other), h, args, f'{name}.combine.{other}'))
        entries = self.verb_entries(FIRST_ROOM, hs, close_chest=True)
        iv = self.ids.item_verb(item)
        use = f"""pushvar 201
    ifNot @alone
    pushvar 201
    push {iv}
    getVerbEntrypoint
    ifNot @any
    push {iv}
    pushvar 201
    pushvar 200
    doSentence
    stopObjectCode
@any:
    pushvar 201
    push {ANY_ITEM_VERB}
    getVerbEntrypoint
    ifNot @dflt
    push {ANY_ITEM_VERB}
    pushvar 201
    pushvar 200
    doSentence
    stopObjectCode
@dflt:
    pushvar 201
    getOwner
    pushvar {VAR_EGO}
    eq
    ifNot @nc
{self.random_say(d['combine'])}    stopObjectCode
@nc:
    pushvar 201
    push 151
    push 1
    ifClassOfIs
    ifNot @nu
{self.random_say(d['give'])}    stopObjectCode
@nu:
{self.random_say(d['use'])}    stopObjectCode
@alone:
{self.random_say(d['handItem'])}    stopObjectCode
"""
        entries.append((5, use))
        entries.append((91, f'push {self.ids.icons[item]}\n    writeVar 266\n    stopObjectCode\n'))
        verbs = it.get('verbs') or {}
        entries.append((216, self.label_asm(verbs.get('hand', 'use'))))
        entries.append((217, self.label_asm(verbs.get('look', 'look at'))))
        entries.append((218, self.label_asm(verbs.get('mouth', 'eat'))))
        return entries

    def random_say(self, lines):
        self._rs = getattr(self, '_rs', 0) + 1
        sc = Script(self.cc, FIRST_ROOM, 'dflt')
        self.cc.say_random(sc, 'player', lines if isinstance(lines, list) else [lines])
        return '\n'.join(sc.lines).replace('@', f'@q{self._rs}_') + '\n'

    # -------------------------------------------------- rooms
    def build_room(self, rid):
        ids = self.ids
        r = self.gm.rooms[rid]
        num = ROOMS[rid]
        W, H = r.get('size', [640, 480])
        bg_path = game_path(r['layers'][0]['img'])
        bg_hd = Image.open(bg_path).convert('RGB')
        bg = bg_hd.resize((W, H), Image.LANCZOS)
        # sprites that must share the palette: object states, occluders, NPC cels
        sprites = []
        obj_imgs = {}
        for o in r.get('objects', []):
            for st, v in (o.get('states') or {}).items():
                if v:
                    im = load_rgba(game_path(v['img']))
                    obj_imgs[(o['id'], st)] = (im, v)
                    sprites.append(im.resize((max(1, im.width // S), max(1, im.height // S)), Image.LANCZOS))
        npcs = [w for w in (r.get('actors') or {}) if w in self.costumes]
        for who in npcs:
            c = self.costumes[who]
            for cid, info in c['cels'].items():
                im = load_rgba(cel_path(c, info))
                sprites.append(im.resize((max(1, im.width // S), max(1, im.height // S)), Image.LANCZOS))
        anims = {}
        for an in self.anim_defs(rid):
            hd, cover = self.anim_frames(an, bg_hd)
            anims[an['id']] = (an, hd, cover)
            for ri, frames in hd.items():
                for f in frames[::max(1, len(frames) // 4)]:
                    sprites.append(f.resize((f.width // S, f.height // S), Image.LANCZOS).convert('RGBA'))
        talk = {k: hex_rgb(v['color']) for k, v in self.game['actors'].items() if v.get('color')}
        pal = make_palette(bg, sprites, self.ref, talk)
        indices = to_indices(bg, pal)
        self.room_anims = (anims, indices, pal)
        # z-planes from occluders
        occ = [o for o in (r.get('occluders') or []) if o.get('scumm', True)]   # scumm: false = web-only layer
        masks = []
        splits = []
        hd_mask = None
        if occ:
            m = np.zeros((H, W), bool)
            hdm = Image.new('L', bg_hd.size, 0)
            for oc in occ:
                im = load_rgba(game_path(oc['img']))
                x, y = oc['x'], oc['y']
                a = im.split()[3]
                hdm.paste(a, (int(round(x * S)), int(round(y * S))), a)
                lo = a.resize((max(1, im.width // S), max(1, im.height // S)), Image.LANCZOS)
                la = np.asarray(lo) >= 128
                X, Y = int(round(x)), int(round(y))
                h2, w2 = la.shape
                m[Y:Y + h2, X:X + w2] |= la[:max(0, H - Y), :max(0, W - X)]
                splits.append(int(oc['z']))
            masks = [m]
            hd_mask = hdm
        # walkboxes
        walk = Walk(r.get('walk'))
        boxes = walk.boxes(splits)
        zmin = min(splits) if splits else None
        for b in boxes:
            b['slot'] = 1
            b['mask'] = 1 if (zmin is not None and b['lr'][1] <= zmin) else 0
        scale_slots = [self.scale_slot(r)]
        # objects
        objects = []
        for n in ids.order:
            od = ids.obj_defs[n]
            if od['room'] != rid:
                continue
            objects.append(self.object_record(rid, n, od, walk, obj_imgs, pal))
        # local script 2000: the room's enter handler
        lscrs = []
        if r.get('enter') is not None:
            sc = Script(self.cc, rid, f'{rid}.enter')
            fv = var_value(ids.from_var(), 'room')
            self.cc.compile_handler(sc, r['enter'], [fv])
            sc.e('stopObjectCode')
            lscrs.append((2000, sc.text()))
        has_enter = bool(lscrs)
        if anims:
            lscrs.append((ANIM_SCRIPT, self.anim_script(rid, [a for a, _, _ in anims.values()])))
        encd = self.encd(rid, has_enter=has_enter, has_anims=bool(anims))
        excd = 'stopObjectCode\n'
        amb = self.ids.sfx.get('amb:' + rid)
        if amb:
            excd = f'push {amb}\n    stopSound\n    stopObjectCode\n'
        # costumes live in the room's LFLF
        extra = []
        for who in npcs:
            extra.append(('AKOS', self.costumes[who]['num'], self.build_costume(who, pal, rid)))
        if rid == FIRST_ROOM:
            extra.append(('AKOS', self.voice_costume, self.build_voice_costume()))
            if self.pose_costume:
                pc = self.pose_costume
                extra.append(('AKOS', pc['num'], self.build_costume(None, pal, rid, c=pc, scale=1.0)))
        sp = self.special_costume
        if sp and rid == sp['room']:
            extra.append(('AKOS', sp['num'], self.build_costume(None, pal, rid, c=sp, scale=1.0)))
        lflf, rmsc_off, extra_offs = self.room_lflf(W, H, pal, indices, objects, boxes, scale_slots, encd, excd, lscrs,
                                                     masks, extra)
        # HD
        self.theme(f'rooms/r{num:03d}/r{num:03d}_bg.png', bg_hd)
        if hd_mask is not None:
            self.theme(f'rooms/r{num:03d}/r{num:03d}_z1.png', hd_mask)
        return lflf, rmsc_off, extra_offs, objects

    def scale_slot(self, r):
        sc = r.get('scale') or [[0, 1.0], [480, 1.0]]
        (y1, s1), (y2, s2) = sc[0], sc[-1]
        if s2 > 1.0:
            y2 = y1 + (1.0 - s1) / (s2 - s1) * (y2 - y1)
            s2 = 1.0
        return (int(round(s1 * 255)), int(round(y1)), int(round(s2 * 255)), int(round(y2)))

    def object_record(self, rid, n, od, walk, obj_imgs, pal):
        ids = self.ids
        r = self.gm.rooms[rid]
        kind = od['kind']
        name = f'lp-{rid}-{od["id"]}-{kind}'[:31]
        if kind == 'entry':
            x, y = od['x'], od['y']
            return {'id': n, 'name': name, 'obna': '', 'rect': (x, y, 0, 0), 'walk': (x, y),
                    'dir': DIRS.get(od['dir'], 180), 'verbs': [], 'cls': CLASS_UNTOUCHABLE, 'state': 0}
        if kind == 'npc':
            who = od['id']
            place = r['actors'][who]
            nd = dict((r.get('npcs') or {}).get(who) or {})
            hb = nd.get('hot') or [-30, -150, 60, 150]
            x, y = int(place['x'] + hb[0]), int(place['y'] + hb[1])
            wt = nd.get('walkTo') or walk.closest([place['x'] - 60, place['y']])
            face = DIRS.get(nd.get('face') or ('E' if wt[0] < place['x'] else 'W'), 90)
            actor = self.game['actors'].get(who, {})
            nd.setdefault('name', actor.get('name', who))
            return {'id': n, 'name': name, 'obna': nd['name'], 'rect': (x, y, int(hb[2]), int(hb[3])),
                    'walk': (int(wt[0]), int(wt[1])), 'dir': face,
                    'verbs': self.object_verbs(rid, nd, is_npc=True, npc_id=who), 'cls': CLASS_PERSON, 'state': 0}
        if kind == 'anim':
            anims, bg_idx, _ = self.room_anims
            an, hd, cover = anims[od['anim']]
            x, y, w, h = an['scumm_rects'][od['rect']]
            # 1x: the frame quantized where the water moves, the room's own pixels elsewhere
            keep = cover[od['rect']] < 0.05
            states = []
            frames = range(od['set'] * ANIM_STATES, min(an['frames'], (od['set'] + 1) * ANIM_STATES))
            for k, i in enumerate(frames, 1):
                img = hd[od['rect']][i]
                idx = to_indices(img.resize((w, h), Image.LANCZOS), pal)
                idx[keep] = bg_idx[y:y + h, x:x + w][keep]
                states.append(idx)
                self.theme(f'rooms/r{ROOMS[rid]:03d}/o{n:04d}_s{k}.jpg', img, quality=90)
            return {'id': n, 'name': name, 'obna': '', 'rect': (x, y, w, h), 'walk': (x, y), 'dir': 180,
                    'verbs': [], 'states': states, 'cls': CLASS_UNTOUCHABLE, 'state': 1 if od['set'] == 0 else 0}
        o = ids.obj_def(rid, od['id'])
        if kind == 'img':
            _, imgs = ids.state_list(rid, od['id'])
            # common 8-aligned rect of all state images
            rects = []
            for st in imgs:
                im, v = obj_imgs[(od['id'], st)]
                rects.append((v['x'], v['y'], v['x'] + im.width / S, v['y'] + im.height / S))
            x0 = int(math.floor(min(q[0] for q in rects) / 8) * 8)
            y0 = int(math.floor(min(q[1] for q in rects)))
            x1 = int(math.ceil(max(q[2] for q in rects) / 8) * 8)
            y1 = int(math.ceil(max(q[3] for q in rects)))
            w, h = x1 - x0, y1 - y0
            states = []
            for k, st in enumerate(imgs, 1):
                im, v = obj_imgs[(od['id'], st)]
                canvas = Image.new('RGBA', (w * S, h * S), (0, 0, 0, 0))
                canvas.alpha_composite(im, (int(round((v['x'] - x0) * S)), int(round((v['y'] - y0) * S))))
                lo = shrink_rgba(canvas, (w, h))
                states.append(sprite_indices(lo, pal))
                self.theme(f'rooms/r{ROOMS[rid]:03d}/o{n:04d}_s{k}.png', canvas)
            dstate = ids.default_state(rid, od['id'])
            return {'id': n, 'name': name, 'obna': '', 'rect': (x0, y0, w, h), 'walk': (x0, y0), 'dir': 180,
                    'verbs': [], 'states': states, 'cls': CLASS_UNTOUCHABLE, 'state': dstate}
        # hotspot object (noHotspot: a state-image carrier only, never clickable)
        no_hot = bool(o.get('noHotspot'))
        rr = (0, 0, 0, 0) if no_hot else rect_of(o) or (0, 0, 8, 8)
        x, y, w, h = [int(round(v)) for v in rr]
        if o.get('walkTo'):
            wt = o['walkTo']
        else:
            wt = walk.closest([x + w / 2, y + h + 4])
        nm = o.get('name')
        if isinstance(nm, Func):
            nm = eval_name(nm, rid, o['id'], o.get('state'))
        cls = (CLASS_EXIT if o.get('exit') else 0) | (CLASS_UNTOUCHABLE if no_hot else 0)
        return {'id': n, 'name': name, 'obna': nm or o['id'], 'rect': (x, y, w, h), 'walk': (int(wt[0]), int(wt[1])),
                'dir': DIRS.get(o.get('face') or 'S', 180), 'verbs': [] if no_hot else self.object_verbs(rid, o),
                'cls': cls, 'state': ids.default_state(rid, o['id'])}

    def anim_script(self, rid, anims):
        """Local script 2001 (started by ENCD, ended by the room change like any local script): cycles each anim's
        object sets forever, frame f = set f // 15 at state f % 15 + 1, the other sets off (state 0)."""
        lines = []
        for an in anims:
            objs = {}
            for n in self.ids.order:
                od = self.ids.obj_defs[n]
                if od['room'] == rid and od['kind'] == 'anim' and od['anim'] == an['id']:
                    objs.setdefault(od['set'], []).append(n)
            nsets = len(objs)
            ticks = max(1, round(TICKS_PER_SEC / an['fps']))
            lab = f'loop_{an["id"]}'
            lines.append(f'@{lab}:')
            for f in range(an['frames']):
                k, st = divmod(f, ANIM_STATES)
                off = [kk for kk in range(nsets) if kk != k] if f == 0 else ([k - 1] if st == 0 else [])
                for kk in off:
                    for o in objs[kk]:
                        lines += [f'push {o}', 'push 0', 'setState']
                for o in objs[k]:
                    lines += [f'push {o}', f'push {st + 1}', 'setState']
                lines += [f'push {ticks}', 'delay']
            lines.append(f'jump @{lab}')
            break     # one anim per room for now (the loop never ends)
        lines.append('stopObjectCode')
        return ''.join((l if l.startswith('@') else '    ' + l) + '\n' for l in lines)

    def encd(self, rid, has_enter, has_anims=False):
        """Room entry: music, NPC actors (costume, place, talk color...), then local script 2000."""
        ids = self.ids
        r = self.gm.rooms[rid]
        sc = Script(self.cc, rid, f'{rid}.encd', 'encd')
        # VAR_CURRENTDISK = 1: loading this room from COMI.LA3 set it to 3, and iMUSE opens the bundles
        # of the current disk first (our voices/music live in the disk-1 bundles, see audio.py)
        sc.e('push 1')
        sc.e('writeVar 42')
        m = r.get('music')
        if m and m in MUSIC:
            self.cc.music(sc, m)
        amb = self.ids.sfx.get('amb:' + rid)
        if amb:
            sc.e(f'push {amb}')
            sc.e('startSound')
        for who, place in (r.get('actors') or {}).items():
            if who not in self.costumes:
                continue
            c = self.costumes[who]
            a = ACTORS[who]
            hot = ids.npc_hot[(rid, who)]
            skip, done = sc.lab('np'), sc.lab('npd')
            if place.get('when') is not None:
                self.cc.jfalse_value(sc, self.cc.when_value(sc, place['when']), skip)
            for ln in (f'push {a}', 'actorOps.setCurActor', 'actorOps.default', f'push {c["num"]}', 'actorOps.setCostume',
                       'actorOps.ignoreBoxes', 'push 255', 'actorOps.scale', f'push {TALK_COLORS.get(who, 15)}',
                       'actorOps.talkColor', 'push 0', f'push {-(c.get("height", 150) + 70)}', 'actorOps.textOffset',
                       f'push {DIRS.get(place.get("dir", "S"), 180)}', 'actorOps.face'):
                sc.e(ln)
            if who == 'agatha':
                # behind the counter: always clipped by z-plane 1 (the counter)
                sc.e('push 1')
                sc.e('actorOps.alwaysZClip')
            sc.e(f'push {a}')
            sc.e(f'push {int(place["x"])}')
            sc.e(f'push {int(place["y"])}')
            sc.e(f'pushvar {VAR_ROOM}')
            sc.e('putActorAtXY')
            # base anim (setBase) persists in a variable (0 = stand)
            bv = ids.base_var(who)
            stand_l = sc.lab('bs')
            sc.e(f'pushvar {bv}')
            sc.e(f'ifNot @{stand_l}')
            sc.e(f'push {a}')
            sc.e('actorOps.setCurActor')
            sc.e(f'pushvar {bv}')
            sc.e('actorOps.standAnim')
            sc.place(stand_l)
            sc.e(f'push {a}')
            sc.e('push 1003')
            sc.e('animateActor')
            # clicks go to the NPC's hotspot object: CMI's input script (32) asks getActorFromXY first
            sc.e(f'push {a}')
            sc.e('push 160')
            sc.e('push 1')
            sc.e('setClass')
            sc.e(f'push {hot}')
            sc.e('push 32')
            sc.e('push 1')
            sc.e('setClass')
            sc.e(f'jump @{done}')
            sc.place(skip)
            sc.e(f'push {a}')
            sc.e('push 0')
            sc.e('push 0')
            sc.e('push 0')
            sc.e('putActorAtXY')
            sc.e(f'push {hot}')
            sc.e('push 160')
            sc.e('push 1')
            sc.e('setClass')
            sc.place(done)
        # edition-only objects (edition: 'extended'): hidden unless that edition's flag is set
        for o in r.get('objects') or []:
            if o.get('edition'):
                skip = sc.lab('ed')
                sc.e(f'pushvar {ids.flag_var(o["edition"])}')
                sc.e('not')
                sc.e(f'ifNot @{skip}')
                self.cc.hide(sc, rid, o['id'], True)
                sc.place(skip)
        if has_anims:
            sc.e('push 1')       # freeze resistant: keeps running through cutscenes (CMI's script 6 freezes the rest)
            sc.e(f'push {ANIM_SCRIPT}')
            sc.e('push 0')
            sc.e('startScript')
        if has_enter:
            sc.e('push 0')
            sc.e('push 2000')
            sc.e('push 0')
            sc.e('startScript')
        sc.e('stopObjectCode')
        return sc.text()

    def room_lflf(self, W, H, pal, indices, objects, boxes, scale_slots, encd, excd, lscrs, masks, extra):
        """Like scummwrite.room_lflf, with transparent object images (codec 149), object classes/states
        and extra resources (AKOS costumes, SCRP scripts) appended inside the LFLF."""
        sm, nz = sw.smap(indices, masks)
        room = sw.blk('ROOM',
                      # v8 rooms name their transparent colour in RMHD (CMI's own use 5); our object images use 255.
                      # The HD renderer takes transparency from the HD art, the original 1x renderer from here.
                      sw.rmhd(W, H, len(objects), nz, transparent=255),
                      sw.blk('CYCL', b'\0'),
                      sw.pals(pal),
                      sw.blk('IMAG', sw.wrap_offs([sm])),
                      *[self.obim(o) for o in objects],
                      sw.boxd(boxes), sw.boxm(boxes), sw.scal(scale_slots))
        rmsc = sw.blk('RMSC',
                      sw.blk('ENCD', v8asm.assemble(encd)),
                      sw.blk('EXCD', v8asm.assemble(excd)),
                      *[sw.blk('LSCR', struct.pack('<I', num) + v8asm.assemble(code)) for num, code in lscrs],
                      *[sw.obcd(o['id'], compiler_mod.tr(o.get('obna', '')), o['verbs']) if o['verbs'] else
                        sw.blk('OBCD', sw.blk('CDHD', struct.pack('<IHBB', 801, o['id'], 0, 0)),
                               sw.blk('OBNA', compiler_mod.tr(o.get('obna', '')).encode('latin1', 'replace') + b'\0'),
                               sw.blk('VERB', struct.pack('<I', 0))) for o in objects])
        body = room + rmsc
        offs = {}
        pos = 8 + len(body)
        extras = b''
        for kind, num, data in extra:
            offs[(kind, num)] = pos + len(extras)
            extras += data
        lflf = sw.blk('LFLF', body + extras)
        return lflf, 8 + len(room), offs

    def obim(self, o):
        states = o.get('states') or []
        x, y, w, h = o['rect']
        parts = [sw.imhd(o['name'], x, y, w, h, o['walk'], o.get('dir', 180), len(states))]
        if states:
            parts.append(sw.blk('IMAG', sw.wrap_offs([self.smap_transparent(s) for s in states])))
        return sw.blk('OBIM', *parts)

    def smap_transparent(self, idx):
        """Object image strips with codec 149 (raw, color 255 transparent) and no z-planes."""
        h, w = idx.shape
        ns = w // 8
        strips = [bytes([149]) + idx[:, s * 8:s * 8 + 8].astype(np.uint8).tobytes() for s in range(ns)]
        offs_size = 8 + 4 * ns
        table, pos = [], offs_size
        for s in strips:
            table.append(pos)
            pos += len(s)
        bstr = sw.blk('BSTR', sw.blk('WRAP', sw.blk('OFFS', struct.pack(f'<{ns}I', *table)), *strips))
        zpln = sw.blk('ZPLN', sw.wrap_offs([sw.blk('ZSTR', sw.blk('WRAP', sw.blk('OFFS', struct.pack(f'<{ns}I', *([0] * ns)))))]))
        return sw.blk('SMAP', bstr, zpln)

    # -------------------------------------------------- items room + cards
    def build_items_room(self):
        ids = self.ids
        objects = []
        for item in self.game['items']:
            it = self.game['items'][item]
            ino, icn = ids.items[item], ids.icons[item]
            objects.append({'id': ino, 'name': f'lp-item-{item}'[:31], 'obna': it['name'], 'rect': (0, 0, 8, 8),
                            'walk': (0, 0), 'dir': 180, 'verbs': self.item_verbs(item), 'cls': 0, 'state': 0})
            hd = load_rgba(game_path(it['icon'])).resize((320, 224), Image.LANCZOS)
            lo = hd.resize((80, 56), Image.LANCZOS)
            hi_hd = icon_ring(hd, 6, (255, 50, 0))
            s1 = self.icon_indices(lo)
            s2 = s1.copy()     # CMI's own 1x rings are fixed color 9 (255,59,15)
            s2[(s1 == 255) & (np.asarray(icon_ring(lo, 2, (255, 59, 15)))[:, :, 3] >= 128)] = 9
            self.theme(f'rooms/r{ITEMS_ROOM:03d}/o{icn:04d}_s1.png', hd)
            self.theme(f'rooms/r{ITEMS_ROOM:03d}/o{icn:04d}_s2.png', hi_hd)
            objects.append({'id': icn, 'name': f'lp-icon-{item}'[:31], 'obna': '', 'rect': (0, 0, 80, 56), 'walk': (0, 0),
                            'dir': 180, 'bomps': [s1, s2], 'cls': CLASS_ICON, 'state': 0,
                            'verbs': [(93, f'push {ino}\n    writeVar 300\n    stopObjectCode\n')]})
        return objects

    def icon_indices(self, rgba):
        """Inventory icons draw with CMI's fixed colors 0..23 in 8 bit (255 = transparent)."""
        pal = self.ref
        cols = np.array([[pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]] for i in range(24)], np.float32)
        a = np.asarray(rgba).astype(np.float32)
        d = ((a[:, :, None, :3] - cols[None, None]) ** 2).sum(-1)
        idx = d.argmin(-1).astype(np.uint8)
        idx[a[:, :, 3] < 128] = 255
        return idx

    def card_image(self, path, title):
        full = game_path(path)
        if os.path.exists(full):
            return Image.open(full).convert('RGB').resize((2560, 1920), Image.LANCZOS)
        # placeholder card until the art exists
        from PIL import ImageDraw, ImageFont
        im = Image.new('RGB', (2560, 1920), (20, 12, 6))
        d = ImageDraw.Draw(im)
        try:
            f = ImageFont.truetype('/System/Library/Fonts/Supplemental/Georgia.ttf', 160)
        except OSError:
            f = ImageFont.load_default()
        t = title or ''
        tw = d.textlength(t, font=f)
        d.text(((2560 - tw) / 2, 860), t, fill=(255, 211, 83), font=f)
        return im

    # -------------------------------------------------- boot scripts
    def script_119(self):
        """New game = CMI's own global script 119 minus the starting balloons, the logos and the opening
        movie (cut from its disassembly, so Guybrush's setup stays byte-exact), plus our voice actor."""
        lines = self.original_script(119)

        def find(seq, start=0):
            for i in range(start, len(lines) - len(seq) + 1):
                if all(lines[i + k].strip() == seq[k] for k in range(len(seq))):
                    return i
            raise RuntimeError(f'script 119: {seq} not found')
        a = find(['push 100', 'pickupObject'])
        b = find(['@76:'], a)
        lines[a:b + 1] = []
        c = find(['push 2', 'push 1', 'cutscene'])
        v = find(['startVideo "opening.san"'], c)
        e = find(['endCutscene'], v)
        lines[c:e + 1] = []
        voice = [f'    push {VOICE_ACTOR}', '    actorOps.setCurActor', '    actorOps.default', f'    push {self.voice_costume}',
                 '    actorOps.setCostume', '    actorOps.ignoreBoxes', '    push 255', '    actorOps.scale']
        f = find(['push 0', 'push 130', 'push 0', 'startScript'])
        lines[f:f] = voice
        return '\n'.join(lines) + '\n'

    def original_script(self, num):
        idx = self.index
        disks, offs = idx.dirs['DSCR']
        df, (lf, size) = sr.find_room(disks[num], idx)
        o = lf + offs[num]
        return v8asm.disasm_text(df.data[o + 8:o + sr.be32(df.data, o + 4)]).splitlines()

    def script_1(self):
        """CMI's boot script, ending in script 119 (new game) instead of the disk check + room 87 (the
        Regular / Mega-Monkey menu): launching the game starts the chapter directly."""
        lines = self.original_script(1)

        def find(seq, start=0):
            for i in range(start, len(lines) - len(seq) + 1):
                if all(lines[i + k].strip() == seq[k] for k in range(len(seq))):
                    return i
            raise RuntimeError(f'script 1: {seq} not found')
        a = find(['pushvar 42', 'push 1', 'neq'])
        b = find(['push 87', 'loadRoom'], a)
        lines[a:b + 2] = ['    push 0', '    push 119', '    push 0', '    startScript']
        return '\n'.join(lines) + '\n'

    def script_130(self):
        """Part I of the new chapter = the web game's start(): title and chapter cards, harbor opening."""
        sc = Script(self.cc, '_card', 'start', 'global')
        # bitvar490 = 1: CMI's room entry script (11) no longer runs its room -> music table (29), which
        # would silence our rooms (unknown rooms get STATE_NULL) right after their ENCD set the music
        sc.e('push 1')
        sc.e('writeVar 0x800001EA')
        sc.e('push 1')
        sc.e('writeVar 42')
        self.cc.compile_handler(sc, self.game['start'], [], block=False)
        sc.e('push 1')
        sc.e('actorFollowCamera')
        sc.e('stopObjectCode')
        return sc.text()

    # -------------------------------------------------- everything
    def build(self):
        os.makedirs(OUT, exist_ok=True)
        os.makedirs(LOG, exist_ok=True)
        self.allocate()
        lflfs = []
        new_rooms = []
        costume_dir = {}
        for rid, num in ROOMS.items():
            lflf, rmsc_off, extra_offs, objects = self.build_room(rid)
            lflfs.append((num, lflf, objects))
            new_rooms.append((num, 3, 'lp' + rid[:6], rmsc_off))
            for (kind, cnum), off in extra_offs.items():
                costume_dir[cnum] = (num, off)
        # items room (no image)
        iobjs = self.build_items_room()
        il, irmsc = self.items_lflf(iobjs)
        lflfs.append((ITEMS_ROOM, il, iobjs))
        new_rooms.append((ITEMS_ROOM, 3, 'lpitems', irmsc))
        # full-screen cards
        for path, (num, nm, title) in IMAGES.items():
            img = self.card_image(path, title)
            lo = img.resize((640, 480), Image.LANCZOS)
            pal = make_palette(lo, [], self.ref, {})
            idx = to_indices(lo, pal)
            lf, rm, _ = self.room_lflf(640, 480, pal, idx, [], [], [(255, 0, 255, 480)],
                                       'push 1\n    writeVar 42\n    stopObjectCode\n', 'stopObjectCode\n', [], [], [])
            lflfs.append((num, lf, []))
            new_rooms.append((num, 3, nm, rm))
            self.theme(f'rooms/r{num:03d}/r{num:03d}_bg.png', img)
        # global scripts: 119, 130 replaced; room-changing handlers as new globals
        scripts = {1: self.script_1(), 119: self.script_119(), 130: self.script_130()}
        scripts.update(self.new_scripts)
        # put all SCRP blocks into the items room's LFLF
        script_dir = {}
        items_idx = [i for i, (n, _, _) in enumerate(lflfs) if n == ITEMS_ROOM][0]
        num, lf, objs = lflfs[items_idx]
        body = lf[8:]
        for snum in sorted(scripts):
            code = v8asm.assemble(scripts[snum])
            script_dir[snum] = (ITEMS_ROOM, 8 + len(body))
            body += sw.blk('SCRP', code)
            open(os.path.join(LOG, f's{snum:04d}.asm'), 'w').write(scripts[snum])
        sound_dir = {}
        cache = os.path.join(LOG, 'audio_cache')
        for name, (snum, path, loop) in sorted(self.sfx_files.items(), key=lambda kv: kv[1][0]):
            af = 'loudnorm=I=-30:TP=-6:LRA=11' if loop else 'loudnorm=I=-19:TP=-2:LRA=11'
            pcm = audio.ffmpeg_pcm(path, 1, cache, af)
            sound_dir[snum] = (ITEMS_ROOM, 8 + len(body))
            body += sw.blk('SOUN', audio.imus(pcm, 1, name=name.replace(':', '_'), loop=loop))
        self.audio_report['sfx'] = len(sound_dir)
        lflfs[items_idx] = (num, sw.blk('LFLF', body), objs)
        # disk file + index
        la3 = sw.disk_file([(n, l) for n, l, _ in lflfs])
        open(os.path.join(OUT, 'COMI.LA3'), 'wb').write(la3)
        all_objs = []
        for n, _, objs in lflfs:
            for o in objs:
                all_objs.append((o['id'], o['name'], o.get('state', 0), n, o.get('cls', 0)))
        la0 = patch_index(self.index, new_rooms, all_objs, script_dir, costume_dir,
                          num_vars=max(self.ids.vars_next + 16, 1500), sound_dir=sound_dir)
        open(os.path.join(OUT, 'COMI.LA0'), 'wb').write(la0)
        self.link_game_files()
        self.build_audio()
        if OPTS.get('hd_theme', True):
            os.makedirs(THEME, exist_ok=True)
            with open(os.path.join(THEME, 'theme.json'), 'w') as f:
                f.write('{"name": "License to Pillage"}\n')
        self.write_report(la3, la0, lflfs)

    @staticmethod
    def link_game_files():
        link_game_files()

    def build_audio(self):
        build_audio(self)

    def items_lflf(self, objects):
        sm, nz = sw.smap(np.zeros((480, 0), np.uint8))
        room = sw.blk('ROOM', sw.rmhd(0, 480, len(objects), nz), sw.blk('CYCL', b'\0'), sw.pals(self.ref),
                      sw.blk('IMAG', sw.wrap_offs([sm])),
                      *[self.obim_items(o) for o in objects], sw.boxd([]), sw.boxm([]), sw.scal([]))
        rmsc = sw.blk('RMSC', sw.blk('ENCD', v8asm.assemble('stopObjectCode\n')),
                      sw.blk('EXCD', v8asm.assemble('stopObjectCode\n')),
                      *[sw.obcd(o['id'], compiler_mod.tr(o.get('obna', '')), o['verbs']) for o in objects])
        return sw.blk('LFLF', room + rmsc), 8 + len(room)

    def obim_items(self, o):
        if o.get('bomps'):
            return sw.obim(o['name'], *o['rect'], o['walk'], o.get('dir', 180), bomps=o['bomps'])
        return sw.obim(o['name'], *o['rect'], o['walk'], o.get('dir', 180))

    def write_report(self, la3, la0, lflfs):
        ids = self.ids
        rep = {'rooms': {str(n): len(l) for n, l, _ in lflfs}, 'la3': len(la3), 'la0': len(la0),
               'objects': {str(k): {kk: vv for kk, vv in v.items() if kk in ('room', 'id', 'kind')}
                           for k, v in ids.obj_defs.items()},
               'items': ids.items, 'icons': ids.icons, 'vars': ids.flags, 'scripts': ids.scripts,
               'costumes': {k: v['num'] for k, v in self.costumes.items()}, 'voice_costume': self.voice_costume,
               'theme_files': len(self.theme_files), 'audio': self.audio_report,
               'voice_tags': self.voices.used, 'lang': OPTS['lang'],
               'warnings': self.warnings + getattr(self.cc, 'warnings', [])}
        json.dump(rep, open(os.path.join(LOG, 'build.json'), 'w'), indent=1)
        print(f'LA3 {len(la3) / 1e6:.2f} MB, LA0 {len(la0)} bytes, {len(ids.obj_defs)} objects, '
              f'{len(ids.flags)} vars, {len(self.new_scripts) + 2} scripts, {len(self.theme_files)} HD files, '
              f'audio {self.audio_report}')
        for w in rep['warnings']:
            print('WARNING', w)


# ------------------------------------------------------------------ game folder + audio (portable)
def trash(path, tag):
    """Moves our own earlier output out of the way (never deletes): $LTP_TRASH or ROOT/.trash, <tag>_<pid>."""
    d = os.environ.get('LTP_TRASH') or os.path.join(ROOT, '.trash')
    os.makedirs(d, exist_ok=True)
    os.rename(path, os.path.join(d, f'{tag}_{os.getpid()}_{int(time.time() * 1000) % 100000000}'))


def link(src, dst):
    """dst -> src: a symlink, or a hard link where symlinks are not allowed (Windows without developer mode).
    An existing dst that is not already that link is moved to .trash first."""
    if os.path.islink(dst) and os.readlink(dst) == src:
        return
    if os.path.lexists(dst):
        if not os.path.islink(dst) and os.path.exists(src) and os.path.samefile(src, dst):
            return          # already a hard link to it
        trash(dst, 'scumm_game_' + os.path.basename(dst))
    try:
        os.symlink(src, dst)
    except (OSError, NotImplementedError):
        os.link(src, dst)


def link_game_files():
    """OUT = our LA0/LA3 + links to the original LA1/LA2 and resource files. RESOURCE is a directory of links;
    VOXDISK1/MUSDISK1.BUN become combined copies in build_audio. Our rooms are on disk 3 and iMUSE opens the current
    disk's bundle first (then falls back to disks 1 and 2): no disk-3 bundles may exist."""
    for name in ('COMI.LA1', 'COMI.LA2'):
        link(os.path.join(sr.GAME, name), os.path.join(OUT, name))
    res_src, res = os.path.join(sr.GAME, 'RESOURCE'), os.path.join(OUT, 'RESOURCE')
    if os.path.islink(res):
        trash(res, 'scumm_game_RESOURCE')
    os.makedirs(res, exist_ok=True)
    for f in sorted(os.listdir(res_src)):
        if f.upper() in ('VOXDISK1.BUN', 'MUSDISK1.BUN') and os.path.lexists(os.path.join(res, f)):
            continue            # our combined copies (build_audio) or already linked
        link(os.path.join(res_src, f), os.path.join(res, f))
    for f in ('VOXDISK3.BUN', 'MUSDISK3.BUN', 'VOXDISK3.BUN.stamp', 'MUSDISK3.BUN.stamp'):
        if os.path.lexists(os.path.join(res, f)):
            trash(os.path.join(res, f), 'scumm_game_' + f)


def build_audio(b):
    """Our voices and music inside combined copies of CMI's disk-1 bundles, see audio.py."""
    res = os.path.join(OUT, 'RESOURCE')
    orig = os.path.join(sr.GAME, 'RESOURCE')
    cache = os.path.join(LOG, 'audio_cache')

    def own(name):
        """Target path for a combined bundle (a link to the original is moved away first)."""
        path = os.path.join(res, name)
        if os.path.islink(path):
            trash(path, f'scumm_game_{name}_link')
        elif os.path.exists(path) and os.path.samefile(path, os.path.join(orig, name)):
            trash(path, f'scumm_game_{name}_hardlink')      # never write into the player's own file
        return path

    def original(name):
        path = os.path.join(res, name)
        if os.path.lexists(path) and not os.path.islink(path) and not os.path.samefile(path, os.path.join(orig, name)):
            trash(path, f'scumm_game_{name}')
        if not os.path.lexists(path):
            link(os.path.join(orig, name), path)
    if b.voices.used:
        n, size = b.voices.build(os.path.join(orig, 'VOXDISK1.BUN'), own('VOXDISK1.BUN'), cache)
        b.audio_report['voices'] = {'lines': n, 'bundle_mb': round(size / 1e6), 'map_entries': len(b.voices.map)}
    else:
        original('VOXDISK1.BUN')
    tracks = []
    if not OPTS['cmi_music']:
        for name, st in MUSIC.items():
            m = (b.game.get('music') or {}).get(name)
            f = m.get('file') if isinstance(m, dict) else m
            mp3 = game_path(f) if isinstance(f, str) else os.path.join(GAME, 'music', name + '.mp3')
            if st in MUSIC_FILES and os.path.exists(mp3):
                tracks.append((MUSIC_FILES[st], mp3, True))
    if tracks:
        n, size = audio.build_music(os.path.join(orig, 'MUSDISK1.BUN'), own('MUSDISK1.BUN'), tracks, cache)
        b.audio_report['music'] = {'tracks': n, 'bundle_mb': round(size / 1e6)}
    else:
        original('MUSDISK1.BUN')
        b.audio_report['music'] = 'CMI'


def scummvm_running():
    """A running ScummVM (its command line), else ''. The game files are read while playing: never rebuild under it."""
    import subprocess
    try:
        if sys.platform.startswith('win'):
            out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq scummvm.exe', '/NH'], capture_output=True, text=True).stdout
            return out.strip() if 'scummvm' in out.lower() else ''
        return subprocess.run(['pgrep', '-fl', 'scummvm'], capture_output=True, text=True).stdout.strip()
    except OSError:
        return ''


# ------------------------------------------------------------------ index
def patch_index(idx, new_rooms, new_objects, script_dir, costume_dir, num_vars, sound_dir=None):
    """COMI.LA0 with new rooms (DROO/DRSC/RNAM), objects (DOBJ), replaced/new global scripts (DSCR),
    new costumes (DCOS), new sounds (DSOU) and bigger MAXS tables."""
    sound_dir = sound_dir or {}
    d = idx.data
    maxs = dict(idx.maxs)
    nrooms, nobj = maxs['numRooms'], maxs['numGlobalObjects']
    room_ids = sorted(r for r, *_ in new_rooms)
    obj_ids = sorted(o[0] for o in new_objects)
    assert room_ids == list(range(nrooms, nrooms + len(room_ids))), (room_ids, nrooms)
    assert obj_ids == list(range(nobj, nobj + len(obj_ids))), (obj_ids[:5], nobj)
    maxs['numRooms'] = nrooms + len(room_ids)
    maxs['numGlobalObjects'] = nobj + len(obj_ids)
    maxs['numScripts'] = max(maxs['numScripts'], max(script_dir) + 1)
    maxs['numCostumes'] = max(maxs['numCostumes'], max(costume_dir) + 1 if costume_dir else 0)
    maxs['numSounds'] = max(maxs['numSounds'], max(sound_dir) + 1 if sound_dir else 0)
    maxs['numVariables'] = max(maxs['numVariables'], num_vars)
    out = []
    for tag, o, size in idx.blocks:
        body = d[o + 8:o + size]
        if tag == 'MAXS':
            body = body[:100] + struct.pack('<17I', *maxs.values())
        elif tag == 'RNAM':
            entries = body[:-1] if body.endswith(b'\0') else body
            add = b''
            for r, _, name, _ in sorted(new_rooms):
                nm = name.encode('latin1')[:8].ljust(9, b'\0')
                add += bytes([r]) + bytes(x ^ 0xFF for x in nm)
            body = entries + add + b'\0'
        elif tag in ('DROO', 'DRSC'):
            disks, offs = map(list, idx.dirs[tag])
            for r, disk, _, rmsc in sorted(new_rooms):
                if tag == 'DROO':
                    disks.append(disk)
                    offs.append(0)
                else:
                    disks.append(r)
                    offs.append(rmsc)
            n = len(disks)
            body = struct.pack('<I', n) + bytes(disks) + struct.pack(f'<{n}I', *offs)
        elif tag in ('DSCR', 'DCOS', 'DSOU'):
            table = {'DSCR': script_dir, 'DCOS': costume_dir, 'DSOU': sound_dir}[tag]
            disks, offs = map(list, idx.dirs[tag])
            need = max(list(table) + [len(disks) - 1]) + 1
            while len(disks) < need:
                disks.append(0)
                offs.append(0)
            for k, (room, off) in table.items():
                disks[k] = room
                offs[k] = off
            n = len(disks)
            body = struct.pack('<I', n) + bytes(disks) + struct.pack(f'<{n}I', *offs)
        elif tag == 'DOBJ':
            n = sr.le32(body, 0)
            add = b''
            for oid, name, state, room, cls in sorted(new_objects):
                nm = name.encode('latin1')[:39]
                add += nm + b'\0' * (40 - len(nm)) + struct.pack('<BBI', state, room, cls)
            body = struct.pack('<I', n + len(new_objects)) + body[4:] + add
        out.append(sw.blk(tag, body))
    return b''.join(out)


def game_strings():
    """tools/js/strings.mjs's list of the game's shown texts, cached by the game's sources like the parsed scripts
    (jsgame.py), so a copy made with the cache builds without Node."""
    h = hashlib.sha1(b'strings-1\0')
    for dp, dns, fns in sorted(os.walk(GAME)):
        dns.sort()
        for f in sorted(fns):
            if f.endswith('.js'):
                p = os.path.join(dp, f)
                h.update(os.path.relpath(p, GAME).encode() + b'\0' + open(p, 'rb').read())
    key = 'strings-' + h.hexdigest()[:24]
    hit = jsgame._cache_get(key)
    if hit is not None:
        return hit
    jsgame.need_node('the game texts')
    out = json.loads(subprocess.run(
        ['node', os.path.join(ROOT, 'tools/js/strings.mjs')] + ([os.path.relpath(GAME, ROOT)] if PROJECT else []),
        cwd=ROOT, capture_output=True, text=True, check=True).stdout)
    jsgame._cache_put(key, out)
    return out


def load_translation(code):
    """--lang CODE: every shown text (lines, names, labels, choices) from the translation tables; the voices
    stay English. Missing entries stay English (tools/lang.py status lists them)."""
    OPTS['lang'] = code
    t = {}
    for p in (os.path.join(ROOT, 'engine', 'lang', code + '.json'), os.path.join(GAME, 'lang', code + '.json')):
        if os.path.isfile(p):
            t.update(json.load(open(p, encoding='utf-8')))
    if not t:
        sys.exit(f'no translation for {code!r} ({GAME}/lang/{code}.json)')
    if code == 'fr':
        # French names carry their article ("le peintre"); CMI's label script prints verb + name with no way to
        # contract "Parler à le peintre", so the ScummVM build shows names without it, as LucasArts labels did
        names = {s['text'] for s in game_strings() if s['kind'] == 'name'}
        for k in names & set(t):
            t[k] = re.sub(r"^(le |la |les |l')", '', t[k])
    compiler_mod.TRANSLATION.update(t)


def configure_project(key):
    """--game KEY: build a level-editor project (games/KEY, tools/projects.py) into scumm/projects/KEY/ instead of
    License to Pillage: its rooms in game order (the first three 95-97, the rest after the cards, like the Extended
    Edition's), its characters as actors 2-6 then 11+ (7-10 belong to CMI's scripts and our voice actor), talk
    colours 227+, their costumes from games/KEY/actors/<id>, its music in License to Pillage's five iMUSE slots; no
    title cards. License to Pillage's
    settings are only replaced in this process."""
    global GAME, OUT, THEME, LOG, FIRST_ROOM, NPC_COSTUMES, PROJECT, ITEMS_ROOM
    PROJECT = key
    GAME = os.path.join(ROOT, 'games', key)
    if not os.path.isfile(os.path.join(GAME, 'game.js')):
        sys.exit(f'no project games/{key}')
    base = os.path.join(ROOT, 'scumm', 'projects', key)
    OUT, THEME, LOG = os.path.join(base, 'game'), os.path.join(base, 'hdtheme', '2-levels'), os.path.join(base, 'build')
    gm = Game(GAME)
    rooms = [r['id'] for r in gm.game['rooms']]
    ROOMS.clear()
    EXT_ROOMS[:] = rooms[3:]
    ROOMS.update({rid: 95 + i for i, rid in enumerate(rooms[:3])})
    ITEMS_ROOM = 95 + len(ROOMS)          # the room directory must stay contiguous: rooms, items, cards, the rest
    FIRST_ROOM = rooms[0]
    actors = gm.game.get('actors') or {}
    npcs = [a for a in actors if a != gm.game.get('player') and not a.startswith('_')]
    nums = [2, 3, 4, 5, 6] + list(range(11, 64))
    ACTORS.clear()
    ACTORS.update({'guybrush': 1, 'player': 1, gm.game.get('player', 'guybrush'): 1})
    ACTORS.update({a: nums[i] for i, a in enumerate(npcs)})
    TALK_COLORS.clear()
    TALK_COLORS.update({a: 227 + i for i, a in enumerate(npcs[:6])})
    TALK_COLORS['_narrator'] = 233
    NPC_COSTUMES = tuple(a for a in npcs if str(actors[a].get('costume') or '') == f'actors/{a}'
                         and os.path.exists(os.path.join(GAME, 'actors', a, 'actor.json')))
    # its music: the iMUSE states whose track files our music bundle replaces (License to Pillage's five), in
    # game.js order; a track past the fifth stays silent in ScummVM
    slots = MUSIC_SLOTS
    names = list((gm.game.get('music') or {}).keys())
    MUSIC.clear()
    MUSIC.update({n: slots[i] for i, n in enumerate(names[:len(slots)])})
    if len(names) > len(slots):
        print(f'warning: {len(names)} music tracks; ScummVM has room for {len(slots)} ({", ".join(names[len(slots):])} stay silent)', file=sys.stderr)
    IMAGE_TITLES.clear()


def main():
    import argparse
    import subprocess
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--cmi-music', action='store_true', help="CMI's own iMUSE tracks instead of game/music")
    ap.add_argument('--force', action='store_true', help='build even while a ScummVM is running')
    ap.add_argument('--game', help='a level-editor project (games/KEY) instead of License to Pillage')
    ap.add_argument('--cmi', help="the player's CMI data folder (COMI.LA0-2 + RESOURCE/, upper-case names; "
                                  "default: $COMI_GAME)")
    ap.add_argument('--out', help='output game folder (default scumm/game, projects scumm/projects/KEY/game)')
    ap.add_argument('--work', help='build log + caches folder (default scumm/build)')
    ap.add_argument('--no-hd-theme', action='store_true', help="skip the HD theme (only the HD ScummVM fork reads it)")
    ap.add_argument('--audio-cache', action='append', default=[],
                    help='extra read-only folders of decoded audio (shipped with the mod: no ffmpeg needed)')
    ap.add_argument('--lang', default='en', choices=['en', 'de', 'fr', 'es', 'it'],
                    help='text language (<game>/lang/<code>.json + engine/lang/<code>.json); voices stay English')
    a = ap.parse_args()
    OPTS['cmi_music'] = a.cmi_music
    OPTS['hd_theme'] = not a.no_hd_theme
    if a.cmi:
        sr.GAME = os.path.abspath(a.cmi)
    audio.EXTRA_CACHES[:] = [os.path.abspath(d) for d in a.audio_cache]
    if a.game:
        configure_project(a.game)
    global OUT, LOG
    if a.out:
        OUT = os.path.abspath(a.out)
    if a.work:
        LOG = os.path.abspath(a.work)
    for d in (OUT, LOG):
        os.makedirs(d, exist_ok=True)
    if a.lang != 'en':
        load_translation(a.lang)
    running = scummvm_running()
    if running and not a.force:
        # the game files are read while playing (rooms load from COMI.LA3): never swap them underneath
        sys.exit('A ScummVM is running (' + running.splitlines()[0] + '): quit it first (or --force).')
    b = Builder()
    b.build()


if __name__ == '__main__':
    main()
