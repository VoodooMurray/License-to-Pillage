#!/usr/bin/env python3
"""A scene plan applied to a project (EDITOR_PLAN.md 10f B): the data half of "prompt a full scene".

A plan is plain JSON — a room (new, with a placeholder background, or an existing one), hotspots with
texts / data steps ({do: [...]}, engine/steps.js) / exits / items-used-on-them, new inventory items,
characters placed with a first conversation, the room's music. No art is generated here: new rooms get a
placeholder background and characters a drawn placeholder picture; the editor's ✨ buttons (or /api/ai)
replace them afterwards. The whole plan is validated first — ids, step kinds, references — and nothing is
written when it doesn't hold together. License to Pillage is refused like everywhere else.

Used by POST /api/scene/apply (tools/serve.py) and the MCP server (tools/mcp_editor.py).

Plan:
  { "room": {"id", "name", "width"?} | {"id": "<existing>"},
    "hotspots": [{ "id", "name", "box": [x, y, w, h], "walkTo"?, "face"?,
                   "look"? | {"do": [...]}, "use"? (the hand verb), "talk"?,
                   "items"?: {"<item id>": "text" | {"do": [...]}},
                   "exit"?: {"room", "x", "y", "dir"} }],
    "items": [{"id", "name", "look"?}],
    "characters": [{"id", "name", "color"?, "x", "y", "face"?, "height"?,
                    "conversation"?: {"hello": [steps], "again"?: [steps],
                                      "options": [{"text", "do": [steps], "once"?, "end"?, "if"?}]}}],
    "entries"?: {"<from room>": [x, y, dir]}, "music"?: "<game music name>", "ambience"?: null }
"""
import io
import json
import os
import re
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import projects  # noqa: E402
from projects import ProjectError, ID, project_dir, node, roomsrc_patch  # noqa: E402

STEP_KEYS = {'say', 'give', 'take', 'set', 'unset', 'state', 'show', 'hide', 'goto', 'walk', 'sfx', 'music',
             'stopMusic', 'wait', 'talk', 'card', 'hideCard', 'if', 'ifNot', 'ifHas', 'ifNotHas', 'once', 'end'}
EXTRA_KEYS = {'who', 'to', 'room', 'x', 'y', 'dir', 'face', 'then', 'else', 'id', 'seconds', 'keep'}
VERBS = {'look': 'look', 'use': 'hand', 'talk': 'mouth'}
DIRS = {'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'}


def _steps(v):
    """A handler in the plan: a string, or {do: [...]} -> the room-file value."""
    return v if isinstance(v, str) else {'do': v['do']} if isinstance(v, dict) and isinstance(v.get('do'), list) else None


def check_steps(steps, where, errors, depth=0):
    if depth > 6:
        errors.append(f'{where}: steps nest too deep')
        return
    for i, s in enumerate(steps or []):
        if not isinstance(s, dict):
            errors.append(f'{where} step {i + 1}: not an object')
            continue
        kinds = [k for k in s if k in STEP_KEYS]
        unknown = [k for k in s if k not in STEP_KEYS and k not in EXTRA_KEYS]
        if not kinds:
            errors.append(f'{where} step {i + 1}: no known step key ({", ".join(list(s)[:3])})')
        if unknown:
            errors.append(f'{where} step {i + 1}: unknown key {unknown[0]}')
        for br in ('then', 'else'):
            if s.get(br) is not None:
                check_steps(s[br], f'{where} step {i + 1} {br}', errors, depth + 1)


def check_handler(v, where, errors):
    if v is None or isinstance(v, str):
        return
    h = _steps(v)
    if h is None:
        errors.append(f'{where}: a text or {{do: [steps]}}')
    elif isinstance(h, dict):
        check_steps(h['do'], where, errors)


def validate(root, key, plan, game, room_ids, existing_objects):
    e = []
    room = plan.get('room') or {}
    rid = room.get('id')
    if not rid or not ID.match(rid):
        e.append('room.id: lower case letters, digits and _, starting with a letter')
        return e
    new_room = rid not in room_ids
    if new_room and not (640 <= int(room.get('width') or 640) <= 1920):
        e.append('room.width: 640-1920')
    items = {i.get('id'): i for i in plan.get('items') or []}
    chars = {c.get('id'): c for c in plan.get('characters') or []}
    have_items = set(game.get('items') or {}) | set(items)
    have_rooms = room_ids | {rid}
    seen = set(existing_objects)
    for i, it in enumerate(items.values()):
        if not it.get('id') or not ID.match(it['id']):
            e.append(f'item {i + 1}: bad id')
        elif it['id'] in (game.get('items') or {}):
            e.append(f"item {it['id']} exists already")
    for i, c in enumerate(chars.values()):
        if not c.get('id') or not ID.match(c['id']):
            e.append(f'character {i + 1}: bad id')
        elif c['id'] in (game.get('actors') or {}):
            e.append(f"character {c['id']} exists already")
        if c.get('conversation'):
            t = c['conversation']
            check_steps(t.get('hello'), f"{c.get('id')} hello", e)
            check_steps(t.get('again'), f"{c.get('id')} again", e)
            for j, o in enumerate(t.get('options') or []):
                if not str(o.get('text') or '').strip():
                    e.append(f"{c.get('id')} option {j + 1}: no text")
                check_steps(o.get('do'), f"{c.get('id')} option {j + 1}", e)
    for i, h in enumerate(plan.get('hotspots') or []):
        w = f"hotspot {h.get('id') or i + 1}"
        if not h.get('id') or not ID.match(h['id']):
            e.append(f'{w}: bad id')
        elif h['id'] in seen:
            e.append(f"{w}: an object with this id is in the room already")
        else:
            seen.add(h['id'])
        box = h.get('box')
        if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box) and box[2] > 0 and box[3] > 0):
            e.append(f'{w}: box must be [x, y, w, h]')
        for verb in VERBS:
            check_handler(h.get(verb), f'{w} {verb}', e)
        for it, hv in (h.get('items') or {}).items():
            if it not in have_items:
                e.append(f"{w}: items-used references unknown item '{it}'")
            check_handler(hv, f'{w} item {it}', e)
        ex = h.get('exit')
        if ex is not None and (not isinstance(ex, dict) or ex.get('room') not in have_rooms):
            e.append(f"{w}: exit.room must name a room of the game ({ex.get('room') if isinstance(ex, dict) else ex})")
        if h.get('face') is not None and h['face'] not in DIRS:
            e.append(f'{w}: face must be one of {sorted(DIRS)}')
    if plan.get('music') is not None and plan['music'] not in (game.get('music') or {}):
        e.append(f"music '{plan['music']}' is not in the game's music")
    return e


def placeholder_character(name, height):
    return projects.placeholder_person(name, height)


def default_conversation(who, name):
    return {'hello': [{'say': f'Hello. I am {name}.', 'who': who}],
            'options': [{'text': 'Who are you?', 'once': True, 'do': [{'say': 'Nobody important.', 'who': who}]},
                        {'text': 'Goodbye.', 'end': True, 'do': [{'say': 'Goodbye.', 'who': who}]}]}


def apply(root, key, plan, journal=None):
    """Validates, then writes the plan: new room / items / characters through projects.py, the room's
    hotspots, placements, conversations and music as one source patch. Returns what was made."""
    projects.guard(key, False)
    if not isinstance(plan, dict):
        raise ProjectError('plan: a JSON object')
    d = project_dir(root, key)
    game = node('roomsrc.mjs', 'dump', os.path.join(d, 'game.js'))['value']
    rooms_dir = os.path.join(d, 'rooms')
    room_ids = {f[:-3] for f in os.listdir(rooms_dir) if f.endswith('.js')}
    rid = (plan.get('room') or {}).get('id')
    existing = []
    if rid and rid in room_ids:
        model = node('roomsrc.mjs', 'dump', os.path.join(rooms_dir, rid + '.js'))['value']
        existing = [o.get('id') for o in model.get('objects') or []]
    errors = validate(root, key, plan, game, room_ids, existing)
    if errors:
        raise ProjectError('the plan does not hold together: ' + '; '.join(errors[:6]) + (' …' if len(errors) > 6 else ''), 422)

    applied, files = [], set()
    room = plan['room']
    if rid not in room_ids:
        projects.create_room(root, key, rid, room.get('name') or rid, None, int(room.get('width') or 640))
        applied.append(f'room {rid} (placeholder background)')
        files.add('game.js')
    for it in plan.get('items') or []:
        projects.create_item(root, key, it['id'], it.get('name') or it['id'], None, it.get('look'))
        applied.append(f"item {it['id']}")
        files.add('game.js')
    for c in plan.get('characters') or []:
        h = max(60, min(480, int(c.get('height') or 280)))
        projects.create_actor(root, key, c['id'], c.get('name') or c['id'], color=c.get('color') or '#9fe0ff',
                              image=placeholder_character(c.get('name') or c['id'], h), height=h, origin='template')
        applied.append(f"character {c['id']} (placeholder picture)")
        files.add('game.js')

    roomfile = os.path.join(rooms_dir, rid + '.js')
    if journal:
        journal(os.path.relpath(roomfile, root), open(roomfile, encoding='utf-8').read())
    edits = []
    for h in plan.get('hotspots') or []:
        v = {'id': h['id'], 'name': h.get('name') or h['id'], 'box': [round(x) for x in h['box']]}
        if h.get('walkTo'):
            v['walkTo'] = [round(x) for x in h['walkTo']]
        if h.get('face'):
            v['face'] = h['face']
        if h.get('exit'):
            ex = h['exit']
            v['exit'] = {'room': ex['room'], 'x': round(ex.get('x') or 320), 'y': round(ex.get('y') or 420), 'dir': ex.get('dir') or 'S'}
        for verb, field in VERBS.items():
            hv = _steps(h.get(verb))
            if hv is not None:
                v[field] = hv
        if h.get('items'):
            v['use'] = {it: _steps(hv) for it, hv in h['items'].items()}
        edits.append({'op': 'insert', 'path': 'objects', 'value': v})
        applied.append(f"hotspot {h['id']}")
    y_entry = None
    for c in plan.get('characters') or []:
        x, y = round(c.get('x') or 320), round(c.get('y') or 400)
        y_entry = y_entry or y
        who = c['id']
        tree = c.get('conversation') or default_conversation(who, c.get('name') or who)
        edits += [
            {'op': 'set', 'path': f'actors.{who}', 'value': {'x': x, 'y': y, 'dir': c.get('face') or 'W'}},
            {'op': 'set', 'path': f'npcs.{who}', 'value': {'name': c.get('name') or who, 'walkTo': [x - 70, y],
                                                           'face': 'E', 'mouth': {'do': [{'talk': who}]}}},
            {'op': 'set', 'path': f'dialogues.{who}', 'value': tree},
        ]
        applied.append(f'{who} placed at {x}, {y} with a conversation')
    for frm, p in (plan.get('entries') or {}).items():
        edits.append({'op': 'set', 'path': f'entries.{frm}', 'value': [round(p[0]), round(p[1]), p[2] if len(p) > 2 else 'S']})
    if plan.get('music') is not None:
        edits.append({'op': 'set', 'path': 'music', 'value': plan['music']})
    if edits:
        r = roomsrc_patch(root, roomfile, edits)
        if not r.get('changed') and len(edits):
            applied.append('(room file unchanged)')
        files.add(os.path.relpath(roomfile, root))
    return {'applied': applied, 'room': rid, 'files': sorted(files)}
