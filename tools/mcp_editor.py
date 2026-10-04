#!/usr/bin/env python3
"""MCP server for the level editor (EDITOR_PLAN.md 10f B): exposes tools/serve.py's API as MCP tools, so
Claude Code / Claude Desktop can make and change whole games conversationally — rooms, hotspots, steps,
items, characters, whole scenes (tools/scene.py), ComfyUI art, the ScummVM build and the web export.

Speaks MCP over stdio (one JSON-RPC message per line). The editor server must be running
(tools/serve.sh); EDITOR_URL overrides http://127.0.0.1:8765. Registered for this repo in .mcp.json.

  claude mcp add cmi-editor -- python3 tools/mcp_editor.py     (or just open Claude Code in the repo)
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get('EDITOR_URL', 'http://127.0.0.1:8765').rstrip('/')


def http(method, path, body=None, game=None, timeout=600):
    if game:
        path += ('&' if '?' in path else '?') + 'game=' + game
    headers = {'X-Editor': '1'}
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + '/api' + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    except OSError as e:
        return 0, {'error': f'no editor server at {BASE} (run tools/serve.sh): {e}'}
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, {'raw': raw.decode(errors='replace')[:2000]}


def build_stream(body):
    """POST /api/build streams JSON lines; collect them and return the summary + the last lines."""
    req = urllib.request.Request(BASE + '/api/build', data=json.dumps(body).encode(),
                                 headers={'X-Editor': '1', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=1200) as r:
            if r.status != 200:
                return r.status, json.loads(r.read() or b'{}')
            lines, done = [], None
            for raw in r:
                o = json.loads(raw)
                if 'line' in o:
                    lines.append(o['line'])
                else:
                    done = o
            return 200, {**(done or {'error': 'the build stream ended early'}), 'log_tail': lines[-15:]}
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')
    except OSError as e:
        return 0, {'error': f'no editor server at {BASE}: {e}'}


GAME = {'game': {'type': 'string', 'description': "project key under games/ (e.g. 'sandbox'); never License to Pillage"}}
EDITS = {'edits': {'type': 'array', 'description': ("source edits: [{op: set|del|insert|remove|move, path, value?, expect?}]. "
         "Paths like objects[id=door].box, npcs.agatha.hot, walk.polys[0], dialogues.keeper, entries.start, music. "
         "set inserts missing properties; insert appends to an array (path 'objects'); expect = the current value for "
         "conflict safety. Values holding code are locked.")}}

TOOLS = [
    ('list_projects', 'The games: License to Pillage (reference, read-mostly) and the projects in games/.',
     {}, lambda a: http('GET', '/projects')),
    ('new_game', 'A new game in games/<key>/ from the template (Guybrush + one start room).',
     {'key': {'type': 'string'}, 'title': {'type': 'string'}},
     lambda a: http('POST', '/projects', {'key': a.get('key'), 'title': a.get('title')})),
    ('list_rooms', "A game's room ids.", GAME, lambda a: http('GET', '/rooms', game=a.get('game'))),
    ('get_room', "A room's full definition (functions appear as {$fn}) + sha + source lines.",
     {**GAME, 'room': {'type': 'string'}}, lambda a: http('GET', f"/room/{a.get('room')}", game=a.get('game'))),
    ('patch_room', 'Edit a room file by paths (geometry, texts, data steps, dialogues, exits, music…). '
     'The patcher rewrites only the changed values; comments and formatting stay.',
     {**GAME, 'room': {'type': 'string'}, **EDITS, 'force': {'type': 'boolean'}},
     lambda a: http('POST', f"/room/{a.get('room')}/patch", {'edits': a.get('edits') or [], 'force': bool(a.get('force'))}, game=a.get('game'))),
    ('patch_game', "Edit game.js values (items' name/look/icon, actors, music tables…).",
     {**GAME, **EDITS}, lambda a: http('POST', '/game/patch', {'edits': a.get('edits') or []}, game=a.get('game'))),
    ('get_style', "The game's art style pack (style.json): the look every generate_art paints in (empty = the CMI look).",
     {'game': GAME['game']}, lambda a: http('GET', '/project/style', game=a.get('game'))),
    ('set_style', "The game's art style pack: prompt (the style phrase of every generation prompt, e.g. \"in the "
     "style of a 1960s sci-fi comic: flat colours, halftone shading\"), keep (the keep-sentence of edits), refs "
     "(up to 4 project-relative images; the first leads and replaces Guybrush as the character reference). "
     "All empty = back to the CMI look.",
     {**GAME, 'prompt': {'type': 'string'}, 'keep': {'type': 'string'},
      'refs': {'type': 'array', 'items': {'type': 'string'}}},
     lambda a: http('POST', '/project/style',
                    {k: a.get(k) for k in ('prompt', 'keep', 'refs') if a.get(k) is not None}, game=a.get('game'))),
    ('get_theme', "The game's interface theme (theme.json): verb coin, cursors, exit arrows, chest, colors, "
     "fonts; empty = the CMI interface.", {'game': GAME['game']},
     lambda a: http('GET', '/project/theme', game=a.get('game'))),
    ('set_theme', 'Replace the whole theme.json (validated; image slots are project-relative paths: coin.idle/'
     'hand/look/mouth 464x472, cursor/cursorHot/wait + arrows.N..NW 320x224, chest 2560x1888, invPrev/invNext '
     '320x160, dlgUp 128x160, dlgDown 128x128; colors: label/choice/choiceHover/highlight as #rrggbb). '
     'generate_art kind=theme makes a matching set in one job. Empty = back to CMI.',
     {**GAME, 'theme': {'type': 'object'}},
     lambda a: http('POST', '/project/theme', a.get('theme') or {}, game=a.get('game'))),
    ('standalone_report', 'Can the game ship with no CMI at all: cmi/ references (costumes), interface '
     'pieces/fonts still CMI, provenance counts (generated / upload / template / unverified files).',
     {'game': GAME['game']}, lambda a: http('GET', '/project/standalone', game=a.get('game'))),
    ('apply_scene', 'A whole scene as data, validated first (tools/scene.py): a room (new = placeholder '
     'background), hotspots with texts/steps/exits/items-used, items, characters placed with conversations. '
     'Art stays placeholder — replace it with generate_art afterwards.',
     {**GAME, 'plan': {'type': 'object', 'description': 'see tools/scene.py docstring for the shape'}},
     lambda a: http('POST', '/scene/apply', {'plan': a.get('plan') or {}}, game=a.get('game'))),
    ('new_room', 'One new room (placeholder background; use apply_scene for a filled scene).',
     {**GAME, 'id': {'type': 'string'}, 'name': {'type': 'string'}, 'width': {'type': 'number'}},
     lambda a: http('POST', '/project/room', {'id': a.get('id'), 'name': a.get('name'), 'width': a.get('width')}, game=a.get('game'))),
    ('new_item', 'One new inventory item (placeholder icon).',
     {**GAME, 'id': {'type': 'string'}, 'name': {'type': 'string'}, 'look': {'type': 'string'}},
     lambda a: http('POST', '/project/item', {'id': a.get('id'), 'name': a.get('name'), 'look': a.get('look')}, game=a.get('game'))),
    ('generate_art', 'ComfyUI art for the game: kind=background (a whole room picture), theme (a whole interface set: coin, cursors, arrows, chest -- use_art switches it on), card (a full-screen title/chapter/end card for game.cards: pass card=<id> and title=<lettering>; a {card} step shows it), object (into an area '
     'of the room: area=[x,y,w,h] logical px), item (inventory icon), character (a standing figure), or '
     'repaint/part of an existing picture (target={kind,id}). Returns a job id: poll art_job, then use_art.',
     {**GAME, 'kind': {'type': 'string', 'enum': ['background', 'object', 'item', 'character', 'theme', 'card', 'repaint', 'part']},
      'prompt': {'type': 'string'}, 'count': {'type': 'number'}, 'room': {'type': 'string'},
      'area': {'type': 'array'}, 'target': {'type': 'object'}, 'card': {'type': 'string'}, 'title': {'type': 'string'}},
     lambda a: http('POST', '/ai/generate', {k: a.get(k) for k in ('kind', 'prompt', 'count', 'room', 'area', 'target', 'card', 'title') if a.get(k) is not None}, game=a.get('game'))),
    ('art_job', 'A generation job: status, candidate pictures so far.',
     {'id': {'type': 'string'}}, lambda a: http('GET', f"/ai/job/{a.get('id')}")),
    ('use_art', "Put a job's candidate i into the game (the replaced picture is backed up).",
     {**GAME, 'id': {'type': 'string'}, 'i': {'type': 'number'}, 'room': {'type': 'string'}},
     lambda a: http('POST', f"/ai/job/{a.get('id')}/use", {k: a.get(k) for k in ('i', 'room') if a.get(k) is not None}, game=a.get('game'))),
    ('keep_art', "Keep a job's candidate i in the game's library for later.",
     {'id': {'type': 'string'}, 'i': {'type': 'number'}, 'game': GAME['game']},
     lambda a: http('POST', f"/ai/job/{a.get('id')}/keep", {'i': a.get('i')}, game=a.get('game'))),
    ('build_scummvm', 'Build the ScummVM version (License to Pillage without game, else scumm/projects/<game>). '
     'Refused while a ScummVM runs. Returns exit code, warnings and the last log lines.',
     {'game': GAME['game']}, lambda a: build_stream({'game': a.get('game')})),
    ('play_scummvm', 'Start the built game in the HD ScummVM (windowed).',
     {'game': GAME['game']}, lambda a: http('POST', '/scumm/play', {'game': a.get('game')})),
    ('export_web', 'A web folder in dist/ with its provenance/standalone report (cmi/ is never included).',
     {'game': GAME['game']}, lambda a: http('POST', '/export/web', {'game': a.get('game')})),
    ('history', "The write journal: every room/game.js rewrite's previous bytes.",
     {}, lambda a: http('GET', '/history')),
    ('restore_history', 'A journaled version back in place (the current one is journaled first).',
     {'snap': {'type': 'string'}, 'file': {'type': 'string'}},
     lambda a: http('POST', '/history/restore', {'snap': a.get('snap'), 'file': a.get('file')})),
]


def tool_defs():
    return [{'name': n, 'description': d,
             'inputSchema': {'type': 'object', 'properties': p, 'additionalProperties': True}}
            for n, d, p, _ in TOOLS]


def call_tool(name, args):
    for n, _, _, fn in TOOLS:
        if n == name:
            status, data = fn(args or {})
            text = json.dumps(data, indent=1)[:60000]
            return {'content': [{'type': 'text', 'text': text}], 'isError': status == 0 or status >= 400}
    return {'content': [{'type': 'text', 'text': f'unknown tool {name}'}], 'isError': True}


def main():
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        mid = msg.get('id')
        method = msg.get('method')
        if method == 'initialize':
            result = {'protocolVersion': msg.get('params', {}).get('protocolVersion', '2024-11-05'),
                      'capabilities': {'tools': {}},
                      'serverInfo': {'name': 'cmi-editor', 'version': '1.0'}}
        elif method == 'tools/list':
            result = {'tools': tool_defs()}
        elif method == 'tools/call':
            p = msg.get('params', {})
            try:
                result = call_tool(p.get('name'), p.get('arguments'))
            except Exception as e:  # noqa: BLE001 - report to the client
                result = {'content': [{'type': 'text', 'text': f'{type(e).__name__}: {e}'}], 'isError': True}
        elif method == 'ping':
            result = {}
        elif mid is None:
            continue              # a notification (initialized, cancelled...)
        else:
            out.write(json.dumps({'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': f'no method {method}'}}) + '\n')
            out.flush()
            continue
        if mid is not None:
            out.write(json.dumps({'jsonrpc': '2.0', 'id': mid, 'result': result}) + '\n')
            out.flush()


if __name__ == '__main__':
    main()
