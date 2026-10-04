#!/usr/bin/env python3
"""The level editor's library: things a game keeps but doesn't use right now (archived objects, items and characters,
saved / generated pictures for objects, items, characters and backgrounds), in <project>/library/library.json with
their pictures in <project>/library/. Archiving takes a thing out of its room / game.js and keeps its definition
(code included, as source text); restoring puts it back (into any room). Nothing is ever deleted: removed entries'
files go to .trash/editor_backups/. Used by tools/serve.py (/api/library...).

Entry: {id, kind: object|item|character|background, name, image (project path), def, placement, room, from, created}
"""
import io
import json
import os
import re
import shutil
import time

from PIL import Image

import projects
from projects import ProjectError, project_dir, node, roomsrc_patch, write_atomic, backup, ID

KINDS = ('object', 'item', 'character', 'background')


def lib_dir(root, key):
    return os.path.join(project_dir(root, key), 'library')


def load(root, key):
    f = os.path.join(lib_dir(root, key), 'library.json')
    if not os.path.isfile(f):
        return {'entries': []}
    return json.load(open(f, encoding='utf-8'))


def save(root, key, lib):
    write_atomic(os.path.join(lib_dir(root, key), 'library.json'), json.dumps(lib, indent=1, ensure_ascii=False) + '\n')


def new_id(lib, base):
    base = re.sub(r'[^a-z0-9_]+', '_', (base or 'thing').lower()).strip('_')[:30] or 'thing'
    ids = {e['id'] for e in lib['entries']}
    i, nid = 1, base
    while nid in ids:
        i += 1
        nid = f'{base}_{i}'
    return nid


def dump(path):
    return node('roomsrc.mjs', 'dump', path)['value']


def first_image(obj_def):
    sts = obj_def.get('states') if isinstance(obj_def, dict) else None
    if isinstance(sts, dict):
        cur = obj_def.get('state')
        order = ([cur] if cur in sts else []) + list(sts)
        for k in order:
            st = sts.get(k)
            if isinstance(st, dict) and isinstance(st.get('img'), str):
                return st['img']
    return None


def costume_thumb(gd, costume):
    """The first cel of a costume's stand anim (project path), for a picture of a character."""
    if not isinstance(costume, str) or costume.startswith('cmi/'):
        return None
    f = os.path.join(gd, costume, 'actor.json')
    if not os.path.isfile(f):
        return None
    a = json.load(open(f))
    role = (a.get('roles') or {}).get('stand')
    if isinstance(role, dict):
        role = next(iter(role.values()), None)
    if isinstance(role, dict):
        role = role.get('anim')
    anim = (a.get('anims') or {}).get(role or 'stand') or next(iter((a.get('anims') or {}).values()), None)
    try:
        cel = anim['limbs'][0]['frames'][0]['cels'][0]['cel']
        return f"{costume}/{a['cels'][str(cel)]['file']}"
    except (KeyError, IndexError, TypeError):
        return None


def entries(root, key):
    return load(root, key)['entries']


def add(root, key, kind, name, image=None, defn=None, placement=None, room=None, src='saved'):
    """A library entry; image: bytes (a new picture, stored in library/) or a project path (kept where it is)."""
    if kind not in KINDS:
        raise ProjectError('unknown kind')
    gd = project_dir(root, key)
    lib = load(root, key)
    eid = new_id(lib, name)
    img = None
    if isinstance(image, (bytes, bytearray)):
        im = Image.open(io.BytesIO(image))
        ext = 'jpg' if kind == 'background' and im.mode != 'RGBA' else 'png'
        img = f'library/{kind}s/{eid}.{ext}'
        b = io.BytesIO()
        (im.convert('RGB').save(b, 'JPEG', quality=92) if ext == 'jpg' else im.convert('RGBA').save(b, 'PNG', optimize=True))
        write_atomic(os.path.join(gd, img), b.getvalue())
    elif isinstance(image, str):
        img = image
    e = {'id': eid, 'kind': kind, 'name': name or eid, 'image': img, 'def': defn, 'placement': placement, 'room': room,
         'from': src, 'created': time.strftime('%Y-%m-%d %H:%M')}
    lib['entries'].append(e)
    save(root, key, lib)
    return e


def remove_entry(root, key, eid, trash_files=True):
    gd = project_dir(root, key)
    lib = load(root, key)
    e = next((x for x in lib['entries'] if x['id'] == eid), None)
    if not e:
        raise ProjectError('no such library entry', 404)
    lib['entries'] = [x for x in lib['entries'] if x['id'] != eid]
    save(root, key, lib)
    img = e.get('image')
    if trash_files and isinstance(img, str) and img.startswith('library/') and os.path.isfile(os.path.join(gd, img)):
        t = os.path.join(root, '.trash', 'editor_backups', time.strftime('%Y%m%d_%H%M%S'))
        os.makedirs(t, exist_ok=True)
        os.replace(os.path.join(gd, img), os.path.join(t, os.path.basename(img)))      # moved, never deleted
    return e


# ------------------------------------------------------------------ archive / delete
def room_file(gd, rid):
    f = os.path.join(gd, 'rooms', f'{rid}.js')
    if not ID.match(rid or '') or not os.path.isfile(f):
        raise ProjectError('no such room', 404)
    return f


def archive(root, key, kind, tid, room=None, keep=True):
    """Takes an object (from `room`), an item or a character (from game.js and every room) out of the game; with
    keep, into the library (else it is just deleted; its pictures stay in the project)."""
    projects.guard(key, False)
    gd = project_dir(root, key)
    game_js = os.path.join(gd, 'game.js')
    if kind == 'object':
        f = room_file(gd, room)
        objs = dump(f).get('objects') or []
        o = next((x for x in objs if isinstance(x, dict) and x.get('id') == tid), None)
        if o is None:
            raise ProjectError('no such object', 404)
        roomsrc_patch(root, f, [{'op': 'remove', 'path': f'objects[id={tid}]'}])
        if keep:
            return add(root, key, 'object', o.get('name') if isinstance(o.get('name'), str) else tid, first_image(o), o, room=room, src='archive')
        return {'deleted': tid}
    if kind == 'item':
        items = dump(game_js).get('items') or {}
        if tid not in items:
            raise ProjectError('no such item', 404)
        it = items[tid]
        roomsrc_patch(root, game_js, [{'op': 'del', 'path': f'items.{tid}'}])
        if keep:
            return add(root, key, 'item', it.get('name') if isinstance(it.get('name'), str) else tid, it.get('icon'),
                       {**it, 'id': tid}, src='archive')
        return {'deleted': tid}
    if kind == 'character':
        actors = dump(game_js).get('actors') or {}
        if tid not in actors or tid == dump(game_js).get('player'):
            raise ProjectError('no such character', 404)
        placement = {}
        for fn in sorted(os.listdir(os.path.join(gd, 'rooms'))):
            if not fn.endswith('.js'):
                continue
            f = os.path.join(gd, 'rooms', fn)
            r = dump(f)
            got = {k: (r.get(k) or {}).get(tid) for k in ('actors', 'npcs', 'dialogues') if isinstance(r.get(k), dict) and tid in r[k]}
            if got:
                placement[fn[:-3]] = got
                roomsrc_patch(root, f, [{'op': 'del', 'path': f'{k}.{tid}'} for k in got])
        a = actors[tid]
        roomsrc_patch(root, game_js, [{'op': 'del', 'path': f'actors.{tid}'}])
        if keep:
            return add(root, key, 'character', a.get('name') or tid, costume_thumb(gd, a.get('costume')), {**a, 'id': tid},
                       placement=placement, src='archive')
        return {'deleted': tid, 'rooms': list(placement)}
    raise ProjectError('archive: object, item or character')


def unique(existing, base):
    i, nid = 1, base
    while nid in existing:
        i += 1
        nid = f'{base}{i}'
    return nid


def restore(root, key, eid, room=None, at=None, keep_entry=None):
    """Puts a library entry (back) into the game: an object into `room` (at = [x, y]: its top-left there), an item
    into game.js, a character into game.js (+ its old placement in `room`, if it had one there or `at` is given),
    a background into `room` (replacing its picture) or into a new room (room = None: needs at = {'id', 'name'})."""
    projects.guard(key, False)
    gd = project_dir(root, key)
    game_js = os.path.join(gd, 'game.js')
    e = next((x for x in entries(root, key) if x['id'] == eid), None)
    if not e:
        raise ProjectError('no such library entry', 404)
    kind, d = e['kind'], e.get('def')
    out = {'kind': kind}
    if kind == 'object':
        f = room_file(gd, room)
        r = dump(f)
        ids = {o.get('id') for o in r.get('objects') or [] if isinstance(o, dict)}
        if not isinstance(d, dict):            # a saved picture: a new object showing it
            im = Image.open(os.path.join(gd, e['image']))
            w, h = round(im.width / projects.S, 2), round(im.height / projects.S, 2)
            x, y = (at or [320 - w / 2, 300 - h / 2])
            d = {'id': re.sub(r'[^a-z0-9_]', '_', e['name'].lower())[:30] or 'thing', 'name': e['name'],
                 'box': [round(x), round(y), round(w), round(h)], 'states': {'on': {'img': e['image'], 'x': round(x, 2), 'y': round(y, 2)}}, 'state': 'on'}
        else:
            d = json.loads(json.dumps(d))
            if at:
                dx, dy = shift_of(d, at)
                move_object(d, dx, dy)
        d['id'] = unique(ids, d.get('id') or 'thing')
        roomsrc_patch(root, f, [{'op': 'insert', 'path': 'objects', 'value': d}])
        out.update(room=room, id=d['id'])
    elif kind == 'item':
        items = dump(game_js).get('items') or {}
        d = dict(d) if isinstance(d, dict) else {'name': e['name'], 'icon': e['image']}
        iid = unique(set(items), d.pop('id', None) or re.sub(r'[^a-z0-9_]', '_', e['name'].lower())[:30] or 'item')
        roomsrc_patch(root, game_js, [{'op': 'set', 'path': f'items.{iid}', 'value': d}])
        out.update(id=iid)
    elif kind == 'character':
        actors = dump(game_js).get('actors') or {}
        if not isinstance(d, dict):
            raise ProjectError('a saved character picture: make a character from it with + Character', 422)
        d = dict(d)
        aid = unique(set(actors), d.pop('id', None) or 'character')
        roomsrc_patch(root, game_js, [{'op': 'set', 'path': f'actors.{aid}', 'value': d}])
        pl = (e.get('placement') or {}).get(room) if room else None
        if room and pl:
            f = room_file(gd, room)
            roomsrc_patch(root, f, [{'op': 'set', 'path': f'{k}.{aid}', 'value': v} for k, v in pl.items()])
        out.update(id=aid, placed=bool(room and pl))
    elif kind == 'background':
        data = open(os.path.join(gd, e['image']), 'rb').read()
        if room:
            out.update(projects.replace_background(root, key, room, data), room=room)
        else:
            nr = at or {}
            out.update(projects.create_room(root, key, nr.get('id'), nr.get('name') or e['name'], data))
    if keep_entry is None:
        keep_entry = e.get('from') != 'archive'      # archived things leave the library; saved pictures stay
    if not keep_entry:
        remove_entry(root, key, eid, trash_files=False)
    return out


def shift_of(d, at):
    if isinstance(d.get('box'), list):
        return at[0] - d['box'][0], at[1] - d['box'][1]
    if isinstance(d.get('hot'), list) and d['hot']:
        return at[0] - min(p[0] for p in d['hot']), at[1] - min(p[1] for p in d['hot'])
    return 0, 0


def move_object(d, dx, dy):
    if isinstance(d.get('box'), list):
        d['box'] = [d['box'][0] + dx, d['box'][1] + dy, d['box'][2], d['box'][3]]
    if isinstance(d.get('hot'), list):
        d['hot'] = [[p[0] + dx, p[1] + dy] for p in d['hot']]
    if isinstance(d.get('walkTo'), list):
        d['walkTo'] = [d['walkTo'][0] + dx, d['walkTo'][1] + dy]
    for st in (d.get('states') or {}).values() if isinstance(d.get('states'), dict) else []:
        if isinstance(st, dict) and 'x' in st:
            st['x'] = round(st['x'] + dx, 2)
            st['y'] = round(st['y'] + dy, 2)
