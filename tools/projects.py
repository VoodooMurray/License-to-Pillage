#!/usr/bin/env python3
"""Level-editor projects: games next to License to Pillage, made from tools/templates/new_game.

A project is a folder with the same layout as game/ (game.js, rooms/<id>.js + rooms/<id>/bg.jpg, items/, actors/...).
License to Pillage itself is the project `game/` (key None); every other project lives in `games/<key>/` and runs
with `index.html?game=<key>` (editor: `?edit&game=<key>`). Used by tools/serve.py (the editor's API) and from the
command line; nothing here ever deletes or overwrites without a backup in .trash/editor_backups/.

  tools/projects.py list
  tools/projects.py new <key> "<title>"                     games/<key>/ with a first room `start`
  tools/projects.py room <key> <room id> "<name>" [--image FILE] [--width W]
  tools/projects.py item <key> <item id> "<name>" [--icon FILE] [--look "..."]
"""
import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time

from PIL import Image, ImageDraw, ImageFont

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(TOOLS)
TEMPLATE = os.path.join(TOOLS, 'templates', 'new_game')
KEY = re.compile(r'^[a-z][a-z0-9_]{1,30}$')
ID = re.compile(r'^[a-z][a-z0-9_]{0,40}$')
S = 4                      # art is 4x the logical 640x480 screen
H = 480


class ProjectError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


def project_dir(root, key):
    """None / '' -> game/ (License to Pillage); else games/<key>/ (must exist)."""
    if not key:
        return os.path.join(root, 'game')
    if not KEY.match(key):
        raise ProjectError('bad project id', 404)
    d = os.path.join(root, 'games', key)
    if not os.path.isfile(os.path.join(d, 'game.js')):
        raise ProjectError('no such project', 404)
    return d


def node(script, *args, stdin=None):
    r = subprocess.run(['node', os.path.join(TOOLS, 'js', script), *args], input=stdin, capture_output=True, text=True,
                       timeout=60)
    try:
        out = json.loads(r.stdout)
    except ValueError:
        raise ProjectError((r.stderr.strip() or f'{script} failed')[-400:], 500)
    if r.returncode not in (0, 1) or (isinstance(out, dict) and out.get('error')):
        raise ProjectError(out.get('error') if isinstance(out, dict) else 'failed', 422)
    return out


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = os.path.join(os.path.dirname(path), '.' + os.path.basename(path) + '.tmp')
    with open(tmp, 'wb') as f:
        f.write(data if isinstance(data, bytes) else data.encode('utf-8'))
    os.replace(tmp, path)


def backup(root, path):
    """A copy of a file about to be replaced, under .trash/editor_backups/<time>/<path relative to root>."""
    if os.path.exists(path):
        dst = os.path.join(root, '.trash', 'editor_backups', time.strftime('%Y%m%d_%H%M%S'), os.path.relpath(path, root))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(path, dst)
        return dst
    return None


def to_trash(root, path):
    """Moves a file (never deleted) to .trash/editor_backups/<time>/<path relative to root>."""
    dst = os.path.join(root, '.trash', 'editor_backups', time.strftime('%Y%m%d_%H%M%S'), os.path.relpath(path, root))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    os.replace(path, dst)
    return dst


def title_of(game_js):
    m = re.search(r"""\bname:\s*(['"])(.*?)\1""", game_js) or re.search(r"""\btitle:\s*(['"])(.*?)\1""", game_js)
    return m.group(2) if m else None


def list_projects(root):
    out = []
    g = os.path.join(root, 'game', 'game.js')
    if os.path.isfile(g):
        out.append({'key': None, 'dir': 'game', 'title': title_of(open(g, encoding='utf-8').read()), 'reference': True})
    d = os.path.join(root, 'games')
    if os.path.isdir(d):
        for k in sorted(os.listdir(d)):
            f = os.path.join(d, k, 'game.js')
            if KEY.match(k) and os.path.isfile(f):
                out.append({'key': k, 'dir': f'games/{k}', 'title': title_of(open(f, encoding='utf-8').read())})
    return out


def fill(text, **kw):
    for k, v in kw.items():
        text = text.replace('{{' + k + '}}', str(v))
    return text


def js_str(s):
    return s.replace('\\', '\\\\').replace("'", "\\'").replace('\n', ' ')


# ------------------------------------------------------------------ images
def placeholder(w, h, name):
    """A plain stand-in background (4x): dusk sky, a wall band and a floor, the room's name in the middle."""
    W, Hh = w * S, h * S
    im = Image.new('RGB', (W, Hh))
    px = ImageDraw.Draw(im)
    horizon = int(Hh * 0.62)
    for y in range(Hh):
        if y < horizon:
            t = y / horizon
            c = (int(60 + 150 * t), int(70 + 90 * t), int(120 + 40 * t))
        else:
            t = (y - horizon) / (Hh - horizon)
            c = (int(150 - 60 * t), int(120 - 50 * t), int(80 - 30 * t))
        px.line([(0, y), (W, y)], fill=c)
    for x in range(0, W, 96 * S // 4):
        px.line([(x, horizon), (W / 2 + (x - W / 2) * 2.2, Hh)], fill=(110, 85, 55), width=3)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Georgia.ttf', 34 * S // 2)
        small = ImageFont.truetype('/System/Library/Fonts/Supplemental/Georgia.ttf', 14 * S // 2)
    except OSError:
        font, small = ImageFont.load_default(34 * S // 2), ImageFont.load_default(14 * S // 2)    # no Georgia: Pillow's own
    for text, f, y in ((name, font, Hh * 0.30), ('placeholder background: replace it in the level editor', small, Hh * 0.42)):
        tw = px.textlength(text, font=f)
        px.text(((W - tw) / 2 + 4, y + 4), text, font=f, fill=(20, 20, 30))
        px.text(((W - tw) / 2, y), text, font=f, fill=(255, 235, 170))
    return im


def fit_background(data, width=None):
    """An uploaded background -> (4x RGB image, logical width): 480 logical px high, width from the aspect (640 to
    1920, a multiple of 8), or the given width (cropped to it)."""
    im = Image.open(io.BytesIO(data)).convert('RGB')
    w = width or int(round(H * im.width / im.height / 8)) * 8
    w = max(640, min(1920, w))
    k = max(w * S / im.width, H * S / im.height)
    im = im.resize((max(w * S, round(im.width * k)), max(H * S, round(im.height * k))), Image.LANCZOS)
    x0, y0 = (im.width - w * S) // 2, (im.height - H * S) // 2
    return im.crop((x0, y0, x0 + w * S, y0 + H * S)), w


def fit_icon(data):
    """An item icon -> 320x224 RGBA (CMI's 80x56 inventory cell at 4x), centred, aspect kept."""
    im = Image.open(io.BytesIO(data)).convert('RGBA')
    im.thumbnail((320 - 16, 224 - 16), Image.LANCZOS)
    out = Image.new('RGBA', (320, 224), (0, 0, 0, 0))
    out.paste(im, ((320 - im.width) // 2, (224 - im.height) // 2), im)
    return out


def jpeg(im):
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=92)
    return b.getvalue()


def png(im):
    b = io.BytesIO()
    im.save(b, 'PNG', optimize=True)
    return b.getvalue()


# ------------------------------------------------------------------ operations
def guard(key, reference):
    if not key and not reference:
        raise ProjectError('License to Pillage (game/) is the reference project: make new rooms and items in a project '
                           'of your own (or pass reference: true)', 403)


def create_room(root, key, room_id, name, image=None, width=None, add_to_game=True, reference=False, origin=None):
    guard(key, reference)
    d = project_dir(root, key)
    if not ID.match(room_id or ''):
        raise ProjectError('room ids are lower case letters, digits and _, starting with a letter')
    f = os.path.join(d, 'rooms', room_id + '.js')
    if os.path.exists(f):
        raise ProjectError(f'room {room_id} exists', 409)
    if image:
        bg, w = fit_background(image, width)
    else:
        w = max(640, min(1920, int(width or 640) // 8 * 8))
        bg = placeholder(w, H, name or room_id)
    walk_y = 360
    text = fill(open(os.path.join(TEMPLATE, 'room.js'), encoding='utf-8').read(), ROOM=room_id,
                NAME=js_str(name or room_id), W=w, H=H, X=w // 2, Y=430, WALKY=walk_y, WALKX1=w - 20)
    game_js = os.path.join(d, 'game.js')
    new_game = None
    if add_to_game:
        r = node('gamesrc.mjs', 'add-room', game_js, room_id)
        new_game = r['text']
    write_atomic(os.path.join(d, 'rooms', room_id, 'bg.jpg'), jpeg(bg))
    provenance_note(d, os.path.join(d, 'rooms', room_id, 'bg.jpg'), origin or ('upload' if image else 'template'))
    write_atomic(f, text)
    if new_game is not None:
        write_atomic(game_js, new_game)
    return {'room': room_id, 'file': os.path.relpath(f, root), 'size': [w, H]}


def placeholder_person(name, height=280):
    """A visible stand-in figure (replace it with ✨ or Load image…): rounded body, a head, the name."""
    w = max(40, int(height * 0.42))
    im = Image.new('RGBA', (w * S, height * S), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    dr.rounded_rectangle([4, 4, w * S - 4, height * S - 4], radius=w * S // 3, fill=(120, 140, 170, 230),
                         outline=(20, 20, 20, 255), width=6)
    hx, hr = w * S // 2, w * S // 3
    dr.ellipse([hx - hr, hr // 2, hx + hr, hr * 5 // 2], fill=(250, 220, 190, 255), outline=(20, 20, 20, 255), width=5)
    dr.text((10, height * S // 2), (name or '?')[:14], fill=(10, 10, 10, 255))
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    return buf.getvalue()


def create_project(root, key, title, player='guybrush', hero=None):
    """player 'guybrush': the CMI-derived player (needs the player's own cmi/; plays in ScummVM as-is).
    player 'own': a placeholder picture character instead — nothing CMI-derived from the first minute."""
    if not KEY.match(key or ''):
        raise ProjectError('project ids are 2-31 lower case letters, digits and _, starting with a letter')
    d = os.path.join(root, 'games', key)
    if os.path.exists(d):
        raise ProjectError(f'games/{key} exists', 409)
    title = (title or key).strip()[:80]
    os.makedirs(os.path.join(d, 'rooms'))
    text = fill(open(os.path.join(TEMPLATE, 'game.js'), encoding='utf-8').read(), ID=key, TITLE=js_str(title))
    write_atomic(os.path.join(d, 'game.js'), text)
    write_atomic(os.path.join(d, 'voice.json'), '{}\n')
    write_atomic(os.path.join(d, 'theme.json'), '{}\n')          # all-CMI interface until pieces are replaced
    create_room(root, key, 'start', 'Start', add_to_game=False)
    out = {'key': key, 'dir': f'games/{key}', 'title': title}
    if player == 'own':
        name = (hero or 'Hero').strip()[:40] or 'Hero'
        hid = re.sub(r'[^a-z0-9_]+', '_', name.lower()).strip('_')[:30]
        if not ID.match(hid):
            hid = 'hero'
        create_actor(root, key, hid, name, image=placeholder_person(name), origin='template')
        roomsrc_patch(root, os.path.join(d, 'game.js'),
                      [{'op': 'set', 'path': 'player', 'value': hid}, {'op': 'del', 'path': 'actors.guybrush'}])
        out['player'] = hid
    return out


def roomsrc_patch(root, path, edits):
    r = node('roomsrc.mjs', 'patch', path, stdin=json.dumps({'edits': edits}))
    if r.get('conflicts'):
        raise ProjectError('conflict: ' + json.dumps(r['conflicts'])[:300], 409)
    if r.get('errors') or not r['verify']['ok']:
        raise ProjectError('not applied: ' + json.dumps(r.get('errors') or r['verify'])[:300], 422)
    if r['changed']:
        write_atomic(path, r['text'])
    return r


# the game's opening: the one g.goto(room, x, y, dir) in game.js's start (the template's cutscene). Code, not a
# literal: only that call's text is replaced, and only when there is exactly one
GOTO = re.compile(r"""g\.goto\(\s*(['"])(\w+)\1\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*(['"])(\w+)\5\s*)?\)""")


def opening(root, key):
    text = open(os.path.join(project_dir(root, key), 'game.js'), encoding='utf-8').read()
    m = re.search(r'\bstart\s*\(\s*g\s*\)\s*\{', text)
    calls = list(GOTO.finditer(text, m.end())) if m else []
    if len(calls) != 1:
        return None
    c = calls[0]
    num = lambda v: int(float(v)) if float(v).is_integer() else float(v)  # noqa: E731
    return {'room': c.group(2), 'x': num(c.group(3)), 'y': num(c.group(4)), 'dir': c.group(6) or 'S', 'span': c.span()}


def set_opening(root, key, x, y, direction, reference=False):
    guard(key, reference)
    o = opening(root, key)
    if not o:
        raise ProjectError("game.js's start doesn't have exactly one g.goto(room, x, y, dir): edit it in the source", 422)
    if direction not in ('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'):
        raise ProjectError('bad direction')
    path = os.path.join(project_dir(root, key), 'game.js')
    text = open(path, encoding='utf-8').read()
    a, b = o['span']
    call = f"g.goto('{o['room']}', {round(float(x))}, {round(float(y))}, '{direction}')"
    backup(root, path)
    write_atomic(path, text[:a] + call + text[b:])
    o = opening(root, key)
    o.pop('span')
    return o


def create_item(root, key, item_id, name, icon=None, look=None, reference=False, origin=None):
    guard(key, reference)
    d = project_dir(root, key)
    if not ID.match(item_id or ''):
        raise ProjectError('item ids are lower case letters, digits and _, starting with a letter')
    game_js = os.path.join(d, 'game.js')
    model = node('roomsrc.mjs', 'dump', game_js)['value']
    if item_id in (model.get('items') or {}):
        raise ProjectError(f'item {item_id} exists', 409)
    value = {'name': name or item_id, 'icon': f'items/{item_id}.png'}
    if look:
        value['look'] = look
    icon_path = os.path.join(d, 'items', item_id + '.png')
    if icon:
        backup(root, icon_path)
        write_atomic(icon_path, png(fit_icon(icon)))
        provenance_note(d, icon_path, origin or 'upload')
    elif not os.path.exists(icon_path):
        write_atomic(icon_path, png(icon_placeholder(name or item_id)))
        provenance_note(d, icon_path, 'template')
    roomsrc_patch(root, game_js, [{'op': 'set', 'path': f'items.{item_id}', 'value': value, 'expect': {'$missing': True}}])
    return {'item': item_id, 'icon': value['icon']}


def model_path(segs):
    """[key, index, ('id', x)...] -> a roomsrc path (objects[id=door].use.key, walk.polys[0], use["*"])."""
    out = ''
    for g in segs:
        if isinstance(g, tuple):
            out += f'[id={g[1]}]'
        elif isinstance(g, int):
            out += f'[{g}]'
        elif re.match(r'^[A-Za-z_$][\w$]*$', g):
            out += ('.' if out else '') + g
        else:
            out += '[' + json.dumps(g) + ']'
    return out


ITEM_STEP_KEYS = ('give', 'take', 'ifHas', 'ifNotHas')


def item_refs(value, old, new):
    """Edits that rename item `old` to `new` in a dumped file model: data steps (give / take / ifHas / ifNotHas),
    dialogue options (ifHas / ifNotHas), `use` and `combine` maps keyed by it; and the places in hand-written code
    that mention it (not changed)."""
    edits, code = [], []

    def renamed(v):
        """A copy with the item renamed (for a value that moves to a new key)."""
        if isinstance(v, list):
            return [renamed(x) for x in v]
        if not isinstance(v, dict) or '$fn' in v or '$opaque' in v:
            return v
        out = {k: (new if k in ITEM_STEP_KEYS and x == old else renamed(x)) for k, x in v.items()}
        for m in ('use', 'combine'):
            if isinstance(out.get(m), dict) and old in out[m] and '$fn' not in out[m]:
                out[m] = {(new if k == old else k): x for k, x in out[m].items()}
        return out

    def walk(v, segs):
        if isinstance(v, dict):
            if '$fn' in v or '$opaque' in v:
                if re.search(r"""['"]%s['"]""" % re.escape(old), str(v.get('$fn') or '')):
                    code.append(model_path(segs))
                return
            for k in ITEM_STEP_KEYS:
                if v.get(k) == old:
                    edits.append({'op': 'set', 'path': model_path(segs + [k]), 'value': new})
            moved = set()
            for m in ('use', 'combine'):
                mp = v.get(m)
                if isinstance(mp, dict) and '$fn' not in mp and old in mp:
                    edits.append({'op': 'del', 'path': model_path(segs + [m, old])})
                    edits.append({'op': 'set', 'path': model_path(segs + [m, new]), 'value': renamed(mp[old])})
                    moved.add(m)
            for k, x in v.items():
                if k in moved:
                    for kk, xx in x.items():
                        if kk != old:
                            walk(xx, segs + [k, kk])
                else:
                    walk(x, segs + [k])
        elif isinstance(v, list):
            ids = [x.get('id') for x in v if isinstance(x, dict)]
            for i, x in enumerate(v):
                # an element with a unique id is addressed by it (objects[id=door]), else by its index
                key = ('id', x['id']) if isinstance(x, dict) and isinstance(x.get('id'), str) and ids.count(x['id']) == 1 else i
                walk(x, segs + [key])
    walk(value, [])
    return edits, code


def rename_item(root, key, old, new, reference=False):
    """An item's id everywhere in the game: its game.js entry (and its icon file when it is items/<id>.png), data
    scripts in game.js and every room (steps, conversation options, `use` / `combine` maps). Hand-written code that
    mentions it is listed, not changed."""
    guard(key, reference)
    if not ID.match(new or ''):
        raise ProjectError('item ids are lower case letters, digits and _, starting with a letter')
    d = project_dir(root, key)
    gj = os.path.join(d, 'game.js')
    items = node('roomsrc.mjs', 'dump', gj)['value'].get('items') or {}
    if old not in items:
        raise ProjectError(f'no item {old}', 404)
    if new in items:
        raise ProjectError(f'an item {new} exists', 409)
    if new == old:
        return {'item': new, 'files': [], 'code': []}
    entry = dict(items[old])
    icon_old = entry.get('icon')
    if icon_old == f'items/{old}.png' and os.path.isfile(os.path.join(d, icon_old)) and not os.path.exists(os.path.join(d, 'items', f'{new}.png')):
        entry['icon'] = f'items/{new}.png'
    files, code = [], []
    # game.js: the entry under its new key, then references (other items' combine maps, game dialogues...)
    backup(root, gj)
    roomsrc_patch(root, gj, [{'op': 'del', 'path': f'items.{old}'}, {'op': 'set', 'path': f'items.{new}', 'value': entry}])
    edits, c = item_refs(node('roomsrc.mjs', 'dump', gj)['value'], old, new)
    if edits:
        roomsrc_patch(root, gj, edits)
    files.append('game.js')
    code += [f'game.js: {p}' for p in c]
    if entry.get('icon') != icon_old:
        os.replace(os.path.join(d, icon_old), os.path.join(d, entry['icon']))
    for f in sorted(os.listdir(os.path.join(d, 'rooms'))):
        if not f.endswith('.js'):
            continue
        path = os.path.join(d, 'rooms', f)
        edits, c = item_refs(node('roomsrc.mjs', 'dump', path)['value'], old, new)
        code += [f'rooms/{f}: {p}' for p in c]
        if edits:
            backup(root, path)
            roomsrc_patch(root, path, edits)
            files.append(f'rooms/{f}')
    return {'item': new, 'icon': entry.get('icon'), 'files': files, 'code': code}


def icon_placeholder(name):
    im = Image.new('RGBA', (320, 224), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    dr.rounded_rectangle((40, 30, 280, 194), 30, fill=(150, 110, 60, 255), outline=(40, 25, 10, 255), width=8)
    try:
        f = ImageFont.truetype('/System/Library/Fonts/Supplemental/Georgia.ttf', 44)
    except OSError:
        f = ImageFont.load_default(44)
    t = name[:10]
    tw = dr.textlength(t, font=f)
    dr.text(((320 - tw) / 2, 88), t, font=f, fill=(255, 235, 170, 255))
    return im


def replace_background(root, key, room_id, data, origin='upload'):
    """A new background for a room (first layer), fitted to the room's size; the old one is backed up."""
    d = project_dir(root, key)
    f = os.path.join(d, 'rooms', (room_id or '') + '.js')
    if not ID.match(room_id or '') or not os.path.isfile(f):
        raise ProjectError('no such room', 404)
    model = node('roomsrc.mjs', 'dump', f)['value']
    w, h = (model.get('size') or [640, 480])
    img = ((model.get('layers') or [{}])[0] or {}).get('img')
    if not isinstance(img, str):
        raise ProjectError("the room's first layer is not a plain image path", 422)
    path = os.path.normpath(os.path.join(d, img))
    if not path.startswith(d + os.sep):
        raise ProjectError('background outside the project', 403)
    bg, _ = fit_background(data, w)
    old = backup(root, path)
    write_atomic(path, jpeg(bg) if path.lower().endswith(('.jpg', '.jpeg')) else png(bg))
    provenance_note(d, path, origin)
    return {'path': os.path.relpath(path, d), 'size': [w, h], 'backup': old and os.path.relpath(old, root)}


def costumes(root, key):
    """Costumes a project can use: its own actors/, CMI's (cmi/actors, from the user's install) and, as samples,
    License to Pillage's characters (copied into the project when used)."""
    out = []
    d = project_dir(root, key)
    for base, label in ((os.path.join(d, 'actors'), 'project'), (os.path.join(root, 'cmi', 'actors'), 'cmi'),
                        (os.path.join(root, 'game', 'actors'), 'License to Pillage')):
        if not os.path.isdir(base):
            continue
        for a in sorted(os.listdir(base)):
            if os.path.isfile(os.path.join(base, a, 'actor.json')) and not (label != 'project' and a == 'guybrush'):
                out.append({'source': f'{label}:{a}', 'id': a, 'from': label, 'path': os.path.relpath(os.path.join(base, a), root)})
    return out


FACES = ('E', 'W', 'S')
TURNS = {'E': ('NE', 'E', 'SE', 'N', 'S'), 'W': ('NW', 'W', 'SW', 'N', 'S')}


def fit_picture(data, h4):
    """A character picture cropped to its visible part, scaled to h4 px (4x art) tall."""
    im = Image.open(io.BytesIO(data)).convert('RGBA')
    im = im.crop(im.split()[3].getbbox() or (0, 0, im.width, im.height))
    return im.resize((max(4, round(im.width * h4 / im.height)), h4), Image.LANCZOS)


def picture_actor(dst, faces='S', talk=False):
    """actor.json of a costume made from pictures (cels/0000.png standing, cels/0001.png talking if there is one):
    it faces `faces` (E, W or S: the picture as drawn) and is mirrored for the other side; talking switches between
    the two pictures, or (one picture) bobs."""
    cels, wh = {}, {}
    for i, f in enumerate(('0000.png', '0001.png')):
        p = os.path.join(dst, 'cels', f)
        if os.path.isfile(p) and (i == 0 or talk):
            w4, h4 = Image.open(p).size
            wh[i] = (w4 / S, h4 / S)
            cels[str(i)] = {'file': f'cels/{f}', 'w': wh[i][0], 'h': wh[i][1]}
    cel = lambda i, dy=0: {'cels': [{'cel': i, 'x': round(-wh[i][0] / 2, 2), 'y': round(-wh[i][1] + dy, 2)}]}
    if 1 in wh:
        # the mouth flaps: open, shut, open a bit longer...
        talk_frames = [dict(cel(1), hold=3), dict(cel(0), hold=2), dict(cel(1), hold=4), dict(cel(0), hold=3), dict(cel(1), hold=2), dict(cel(0), hold=2)]
    else:
        talk_frames = [dict(cel(0), hold=4), dict(cel(0, -2), hold=3), dict(cel(0), hold=5), dict(cel(0, -1), hold=3)]
    anims = {'stand': {'fps': 12, 'loop': True, 'limbs': [{'limb': 0, 'frames': [dict(cel(0), hold=60)]}]},
             'talk': {'fps': 12, 'loop': True, 'limbs': [{'limb': 0, 'frames': talk_frames}]}}
    if faces in TURNS:
        other = 'W' if faces == 'E' else 'E'
        role = lambda a: {**{d: a for d in TURNS[faces]}, **{d: {'anim': a, 'flip': True} for d in TURNS[other] if d not in ('N', 'S')}}
        roles = {'stand': role('stand'), 'talk': role('talk'), 'walk': role('stand')}
    else:
        roles = {'stand': 'stand', 'talk': 'talk', 'walk': 'stand'}
    actor = {'id': os.path.basename(dst), 'scale': S, 'fps': 12, 'source': 'a picture (level editor: Character from a picture)',
             'picture': {'faces': faces, 'talk': 1 in wh, 'height': wh[0][1]}, 'cels': cels, 'anims': anims, 'roles': roles}
    write_atomic(os.path.join(dst, 'actor.json'), json.dumps(actor, indent=1) + '\n')
    return actor


def is_picture_costume(a):
    return isinstance(a.get('picture'), dict) or str(a.get('source') or '').startswith('a picture')


def costume_from_image(dst, data, height=280, faces='S'):
    """A costume from one picture (actors/<id>/actor.json + cels/0000.png): standing on its bottom edge, `height`
    logical px tall at scale 1 (Guybrush is about 280); talking = a small bob until it gets a talking picture."""
    os.makedirs(os.path.join(dst, 'cels'), exist_ok=True)
    write_atomic(os.path.join(dst, 'cels', '0000.png'), png(fit_picture(data, int(height) * S)))
    return picture_actor(dst, faces, talk=False)


def actor_pose(root, key, actor_id, faces=None, talk=None, remove_talk=False, origin='upload'):
    """A picture character's facing (E / W / S as drawn; the other side mirrored) and talking picture (mouth open:
    talking switches between it and the standing one; scaled to the standing picture's height)."""
    guard(key, False)
    dst = os.path.join(project_dir(root, key), 'actors', actor_id or '')
    f = os.path.join(dst, 'actor.json')
    if not ID.match(actor_id or '') or not os.path.isfile(f):
        raise ProjectError('no such character costume in the project', 404)
    a = json.load(open(f))
    if not is_picture_costume(a):
        raise ProjectError('only characters made from a picture get poses here', 422)
    pic = a.get('picture') or {}
    faces = faces or pic.get('faces') or 'S'
    if faces not in FACES:
        raise ProjectError('faces: E, W or S')
    backup(root, f)
    has_talk = bool(pic.get('talk'))
    t = os.path.join(dst, 'cels', '0001.png')
    if talk:
        std = Image.open(os.path.join(dst, 'cels', '0000.png')).size
        im = Image.open(io.BytesIO(talk)).convert('RGBA')
        if os.path.isfile(t):
            backup(root, t)
        # the same size as the standing picture (a repaint of it, or drawn on the same canvas): as it is, so the two
        # line up exactly; else cropped and scaled to the standing height
        write_atomic(t, png(im if im.size == std else fit_picture(talk, std[1])))
        has_talk = True
    elif remove_talk and os.path.isfile(t):
        to_trash(root, t)
        has_talk = False
    a = picture_actor(dst, faces, talk=has_talk)
    if talk:
        provenance_note(project_dir(root, key), os.path.join(dst, 'cels', '0001.png'), origin)
    return {'actor': actor_id, **a['picture']}


def create_actor(root, key, actor_id, name, source=None, color='#ffffff', reference=False, image=None, height=280, origin=None):
    """A character for the project: game.js actors.<id> with a costume; a costume from elsewhere is copied into
    the project's actors/<id>/ (CMI's own stay in cmi/ and are referenced from there); with `image`, a one-picture
    costume is made from it."""
    guard(key, reference)
    d = project_dir(root, key)
    if not ID.match(actor_id or '') or actor_id in ('guybrush', 'g', '_narrator'):
        raise ProjectError('character ids are lower case letters, digits and _, starting with a letter')
    game_js = os.path.join(d, 'game.js')
    model = node('roomsrc.mjs', 'dump', game_js)['value']
    if actor_id in (model.get('actors') or {}):
        raise ProjectError(f'character {actor_id} exists', 409)
    src = None if image else next((c for c in costumes(root, key) if c['source'] == source), None)
    if not src and not image:
        raise ProjectError('no such costume', 404)
    if image:
        dst = os.path.join(d, 'actors', actor_id)
        if os.path.exists(dst):
            raise ProjectError(f'actors/{actor_id} exists', 409)
        costume_from_image(dst, image, max(60, min(480, int(height or 280))))
        provenance_note(d, dst, origin or 'upload')
        costume = 'actors/' + actor_id
    elif src['from'] == 'cmi':
        costume = 'cmi/actors/' + src['id']
    else:
        dst = os.path.join(d, 'actors', actor_id)
        if os.path.normpath(os.path.join(root, src['path'])) != os.path.normpath(dst):
            if os.path.exists(dst):
                raise ProjectError(f'actors/{actor_id} exists', 409)
            shutil.copytree(os.path.join(root, src['path']), dst)
            provenance_note(d, dst, 'generated')          # the sample costumes are this project's generated art
        costume = 'actors/' + actor_id
    if not re.match(r'^#[0-9a-fA-F]{6}$', color or ''):
        color = '#ffffff'
    value = {'name': name or actor_id, 'costume': costume, 'color': color, 'anim': 'stand'}
    roomsrc_patch(root, game_js, [{'op': 'set', 'path': f'actors.{actor_id}', 'value': value, 'expect': {'$missing': True}}])
    return {'actor': actor_id, 'costume': costume}


def replace_actor_image(root, key, actor_id, data, height=None, origin='upload'):
    """A new picture for a one-picture character (Character from a picture); the old costume is backed up."""
    guard(key, False)
    d = project_dir(root, key)
    dst = os.path.join(d, 'actors', actor_id or '')
    f = os.path.join(dst, 'actor.json')
    if not ID.match(actor_id or '') or not os.path.isfile(f):
        raise ProjectError('no such character costume in the project', 404)
    a = json.load(open(f))
    if not is_picture_costume(a) and len(a.get('cels') or {}) != 1:
        raise ProjectError('this character has an animated costume (several pictures): its pictures are not replaced from the editor', 422)
    h = height or (a['cels']['0'].get('h') if '0' in a['cels'] else 280)
    for c in a['cels'].values():
        backup(root, os.path.join(dst, c['file']))
    backup(root, f)
    # the talking picture belongs to the old drawing: it goes (to .trash); the facing stays
    talk = os.path.join(dst, 'cels', '0001.png')
    dropped = os.path.isfile(talk) and bool((a.get('picture') or {}).get('talk'))
    if dropped:
        to_trash(root, talk)
    costume_from_image(dst, data, max(60, min(480, int(h))), faces=(a.get('picture') or {}).get('faces') or 'S')
    provenance_note(d, dst, origin)
    return {'actor': actor_id, 'height': h, 'talk_dropped': dropped}


IMAGE_EXT = ('.png', '.jpg', '.jpeg', '.webp')


def save_upload(root, key, rel, data):
    """An image into the project (e.g. a new object state or a replacement background); the old file is backed up."""
    d = project_dir(root, key)
    rel = rel.lstrip('/')
    path = os.path.normpath(os.path.join(d, rel))
    if not path.startswith(d + os.sep) or not path.lower().endswith(IMAGE_EXT) or '/.' in rel or rel.startswith('.'):
        raise ProjectError('uploads go into the project folder, images only', 403)
    Image.open(io.BytesIO(data)).verify()          # must be an image
    old = backup(root, path)
    write_atomic(path, data)
    provenance_note(d, path, 'upload')
    return {'path': os.path.relpath(path, d), 'backup': old and os.path.relpath(old, root)}


# ------------------------------------------------------------------ provenance (games/<key>/provenance.json)
# Every asset the editor writes is tagged at creation: generated (✨), upload (the user's own file),
# template (placeholders). Files that appeared any other way stay unverified — the standalone report
# counts them. Origins: the legal posture of a project at a glance.
PROV_ORIGINS = ('generated', 'upload', 'template')


def provenance(gd):
    try:
        with open(os.path.join(gd, 'provenance.json')) as f:
            p = json.load(f)
        return p if isinstance(p, dict) else {}
    except (OSError, ValueError):
        return {}


def provenance_note(gd, path, origin):
    """Tag one written file (abs or project-relative). Never raises: bookkeeping must not break a write."""
    try:
        rel = os.path.relpath(path, gd) if os.path.isabs(path) else path
        if rel.startswith('..') or origin not in PROV_ORIGINS:
            return
        p = provenance(gd)
        p[rel.replace(os.sep, '/')] = {'origin': origin, 't': int(time.time())}
        write_atomic(os.path.join(gd, 'provenance.json'), json.dumps(p, indent=0, sort_keys=True) + '\n')
    except OSError:
        pass


ASSET_EXT = IMAGE_EXT + ('.mp3', '.ogg', '.wav', '.m4a', '.flac', '.ttf', '.otf')


def origin_of(prov, rel):
    """The tag of a file, or of the nearest tagged parent folder (costume copies tag actors/<id> once)."""
    e = prov.get(rel)
    while e is None and '/' in rel:
        rel = rel.rsplit('/', 1)[0]
        e = prov.get(rel)
    return (e or {}).get('origin')


def standalone_report(root, key):
    """Can this game ship with no CMI at all? cmi/ references in game.js (costumes), interface pieces and
    fonts still CMI, plus the provenance counts (what ✨ made, what the user gave, what is unverified)."""
    gd = project_dir(root, key)
    game = node('roomsrc.mjs', 'dump', os.path.join(gd, 'game.js'))['value']
    cmi_refs = []
    for aid, a in (game.get('actors') or {}).items():
        c = str((a or {}).get('costume') or '')
        if c.startswith('cmi/'):
            cmi_refs.append(f"{aid}: costume '{c}' (the player's own CMI)")
    theme = load_theme(gd)
    missing = [k for k in THEME_IMAGES if not theme.get(k)]
    missing += [f'{g}.{k}' for g, keys in (('coin', THEME_COIN), ('arrows', THEME_ARROWS)) for k in keys
                if not (theme.get(g) or {}).get(k)]
    missing += [f'fonts.{k}' for k in THEME_FONTS if not (theme.get('fonts') or {}).get(k)]
    prov = provenance(gd)
    counts = {o: 0 for o in PROV_ORIGINS}
    unverified = []
    for dp, dns, fns in os.walk(gd):
        dns[:] = [d for d in dns if not d.startswith('.') and d != 'library']
        for fn in fns:
            if not fn.lower().endswith(ASSET_EXT) or fn.startswith('.'):
                continue
            rel = os.path.relpath(os.path.join(dp, fn), gd).replace(os.sep, '/')
            o = origin_of(prov, rel)
            if o in counts:
                counts[o] += 1
            else:
                unverified.append(rel)
    return {'standalone': not cmi_refs and not missing,
            'cmiReferences': cmi_refs, 'themeMissing': missing,
            'origins': counts, 'unverified': sorted(unverified)}


# ------------------------------------------------------------------ UI theme (games/<key>/theme.json)
# The engine replaces single interface pieces with the project's own files (engine.js loadGfx):
# images (4x logical px): coin.idle/hand/look/mouth 464x472, cursor/cursorHot/wait + arrows.N..NW 320x224,
# chest 2560x1888, invPrev/invNext 320x160, dlgUp 128x160, dlgDown 128x128; colors '#rrggbb'; fonts: a base
# path (fonts/<name> -> .json + .png atlas, tools/make_font.py).
THEME_IMAGES = ('chest', 'cursor', 'cursorHot', 'wait', 'invNext', 'invPrev', 'dlgUp', 'dlgDown')
THEME_COIN = ('idle', 'hand', 'look', 'mouth')
THEME_ARROWS = ('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW')
THEME_COLORS = ('label', 'choice', 'choiceHover', 'highlight')
THEME_FONTS = ('text', 'small', 'big')


def load_theme(gd):
    try:
        with open(os.path.join(gd, 'theme.json')) as f:
            t = json.load(f)
        return t if isinstance(t, dict) else {}
    except (OSError, ValueError):
        return {}


def _theme_img(gd, where, v):
    if not isinstance(v, str) or v.startswith(('/', '.')) or '..' in v or not v.lower().endswith(IMAGE_EXT):
        raise ProjectError(f'theme.{where}: a project-relative image path', 422)
    if not os.path.isfile(os.path.join(gd, v)):
        raise ProjectError(f'theme.{where}: no such image ({v})', 422)
    return v


def save_theme(root, key, body, reference=False):
    """Replaces theme.json with the validated body (merge in the caller); {} removes it (back to CMI)."""
    guard(key, reference)
    gd = project_dir(root, key)
    out = {}
    for k in THEME_IMAGES:
        if body.get(k):
            out[k] = _theme_img(gd, k, body[k])
    for group, keys in (('coin', THEME_COIN), ('arrows', THEME_ARROWS)):
        g = body.get(group) or {}
        if not isinstance(g, dict):
            raise ProjectError(f'theme.{group}: an object', 422)
        got = {k: _theme_img(gd, f'{group}.{k}', g[k]) for k in keys if g.get(k)}
        if got:
            out[group] = got
    cols = body.get('colors') or {}
    got = {}
    for k in THEME_COLORS:
        v = cols.get(k)
        if v:
            if not isinstance(v, str) or not re.match(r'^#[0-9a-fA-F]{6}$', v):
                raise ProjectError(f'theme.colors.{k}: #rrggbb', 422)
            got[k] = v.lower()
    if got:
        out['colors'] = got
    fonts = body.get('fonts') or {}
    got = {}
    for k in THEME_FONTS:
        v = fonts.get(k)
        if v:
            if not isinstance(v, str) or v.startswith(('/', '.')) or '..' in v:
                raise ProjectError(f'theme.fonts.{k}: a project-relative path', 422)
            if not (os.path.isfile(os.path.join(gd, v + '.json')) and os.path.isfile(os.path.join(gd, v + '.png'))):
                raise ProjectError(f'theme.fonts.{k}: no {v}.json + {v}.png atlas (tools/make_font.py)', 422)
            got[k] = v
    if got:
        out['fonts'] = got
    # the file stays even when empty ({} = the CMI interface): the engine always fetches it (no 404 noise)
    write_atomic(os.path.join(gd, 'theme.json'), json.dumps(out, indent=1) + '\n')
    return {'theme': out}


# ------------------------------------------------------------------ style pack (games/<key>/style.json)
# {prompt: 'the art-style phrase of every generation prompt', keep?: 'the keep-sentence of edits',
#  refs?: [project images used as style references]} — ai_gen.style_text/keep_text fall back to the CMI look.
def load_style(gd):
    try:
        with open(os.path.join(gd, 'style.json')) as f:
            s = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(s, dict):
        return {}
    out = {k: s[k].strip() for k in ('prompt', 'keep') if isinstance(s.get(k), str) and s[k].strip()}
    refs = [r for r in (s.get('refs') or []) if isinstance(r, str) and not r.startswith(('/', '.'))
            and '..' not in r and r.lower().endswith(IMAGE_EXT) and os.path.isfile(os.path.join(gd, r))]
    if refs:
        out['refs'] = refs[:4]
    return out


def save_style(root, key, body, reference=False):
    guard(key, reference)
    gd = project_dir(root, key)
    out = {}
    for k, n in (('prompt', 600), ('keep', 400)):
        v = body.get(k)
        if v is not None and not isinstance(v, str):
            raise ProjectError(f'style.{k}: text', 422)
        if v and v.strip():
            out[k] = v.strip()[:n]
    refs = body.get('refs') or []
    if not isinstance(refs, list) or len(refs) > 4:
        raise ProjectError('style.refs: up to 4 images of the project', 422)
    for r in refs:
        if not isinstance(r, str) or r.startswith(('/', '.')) or '..' in r or not r.lower().endswith(IMAGE_EXT):
            raise ProjectError(f'style ref {r!r}: a project-relative image path', 422)
        if not os.path.isfile(os.path.join(gd, r)):
            raise ProjectError(f'style ref {r}: no such image in the project', 422)
    if refs:
        out['refs'] = refs
    path = os.path.join(gd, 'style.json')
    if out:
        write_atomic(path, json.dumps(out, indent=1) + '\n')
    elif os.path.exists(path):
        to_trash(root, path)
    return {'style': out}


# ------------------------------------------------------------------ sound: music, sound effects, room ambiences
SOUND_DIRS = {'music': 'music', 'sfx': 'sfx', 'ambience': 'sfx'}


def audio_kind(data):
    """mp3 / ogg / wav / m4a / flac by their first bytes, else None."""
    if data[:3] == b'ID3' or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return 'mp3'
    if data[:4] == b'OggS':
        return 'ogg'
    if data[:4] == b'RIFF' and data[8:12] == b'WAVE':
        return 'wav'
    if data[4:8] == b'ftyp':
        return 'm4a'
    if data[:4] == b'fLaC':
        return 'flac'
    return None


def add_sound(root, key, kind, name, data, reference=False):
    """A music track, sound effect or room ambience into the project as <dir>/<name>.mp3 (other formats are converted
    with ffmpeg: every browser plays mp3, and the ScummVM build reads it); music and sound effects get their game.js
    entry (music.<name> = {file}, sfx.<name> = 'sfx/<name>.mp3'); an ambience is set on the room by the editor."""
    guard(key, reference)
    if kind not in SOUND_DIRS:
        raise ProjectError('kind: music, sfx or ambience')
    if not ID.match(name or ''):
        raise ProjectError('sound names are lower case letters, digits and _, starting with a letter')
    fmt = audio_kind(data or b'')
    if not fmt:
        raise ProjectError('not a sound file (mp3, ogg, wav, m4a, flac)')
    d = project_dir(root, key)
    rel = f"{SOUND_DIRS[kind]}/{'amb_' if kind == 'ambience' else ''}{name}.mp3"
    path = os.path.join(d, rel)
    if fmt != 'mp3':
        os.makedirs(os.path.join(root, '.trash', 'tmp'), exist_ok=True)
        src = os.path.join(root, '.trash', 'tmp', f'upload_{int(time.time() * 1000)}.{fmt}')
        with open(src, 'wb') as f:
            f.write(data)
        out = src + '.mp3'
        r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-codec:a', 'libmp3lame', '-q:a', '2', out], capture_output=True, text=True)
        if r.returncode:
            raise ProjectError('could not convert it to mp3: ' + r.stderr[-200:], 422)
        data = open(out, 'rb').read()
    old = backup(root, path)
    write_atomic(path, data)
    provenance_note(d, path, 'upload')
    if kind == 'music':
        roomsrc_patch(root, os.path.join(d, 'game.js'), [{'op': 'set', 'path': f'music.{name}', 'value': {'file': rel}}])
    elif kind == 'sfx':
        roomsrc_patch(root, os.path.join(d, 'game.js'), [{'op': 'set', 'path': f'sfx.{name}', 'value': rel}])
    return {'kind': kind, 'name': name, 'file': rel, 'converted': fmt != 'mp3', 'backup': old and os.path.relpath(old, root)}


def remove_sound(root, key, kind, name, reference=False):
    """A music track or sound effect out of game.js; its file goes to .trash/editor_backups."""
    guard(key, reference)
    if kind not in ('music', 'sfx'):
        raise ProjectError('kind: music or sfx')
    d = project_dir(root, key)
    gj = os.path.join(d, 'game.js')
    model = node('roomsrc.mjs', 'dump', gj)
    entry = ((model.get('value') or {}).get(kind) or {}).get(name)
    if entry is None:
        raise ProjectError(f'no {kind} "{name}"', 404)
    rel = entry.get('file') if isinstance(entry, dict) else entry
    roomsrc_patch(root, gj, [{'op': 'del', 'path': f'{kind}.{name}'}])
    moved = None
    f = isinstance(rel, str) and os.path.normpath(os.path.join(d, rel))
    if f and f.startswith(d + os.sep) and os.path.isfile(f):
        moved = to_trash(root, f)
    return {'kind': kind, 'name': name, 'trash': moved and os.path.relpath(moved, root)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--root', default=REPO)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('list')
    p = sub.add_parser('new'); p.add_argument('key'); p.add_argument('title')
    p = sub.add_parser('room'); p.add_argument('key'); p.add_argument('room'); p.add_argument('name')
    p.add_argument('--image'); p.add_argument('--width', type=int)
    p = sub.add_parser('item'); p.add_argument('key'); p.add_argument('item'); p.add_argument('name')
    p.add_argument('--icon'); p.add_argument('--look')
    a = ap.parse_args()
    try:
        if a.cmd == 'list':
            r = list_projects(a.root)
        elif a.cmd == 'new':
            r = create_project(a.root, a.key, a.title)
        elif a.cmd == 'room':
            r = create_room(a.root, a.key, a.room, a.name, open(a.image, 'rb').read() if a.image else None, a.width)
        else:
            r = create_item(a.root, a.key, a.item, a.name, open(a.icon, 'rb').read() if a.icon else None, a.look)
    except ProjectError as e:
        print('error:', e, file=sys.stderr)
        sys.exit(1)
    print(json.dumps(r, indent=1))


if __name__ == '__main__':
    main()
