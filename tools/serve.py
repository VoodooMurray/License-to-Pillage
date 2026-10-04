#!/usr/bin/env python3
"""Local web server for the game (static files, no caching) plus the level editor's API.

  tools/serve.py [--port 8765] [--root DIR]      (tools/serve.sh runs this)

Static: everything under --root (default: the repo), `Cache-Control: no-store`, quiet.
API (level editor, see EDITOR_PLAN.md), only for requests from this origin carrying `X-Editor: 1`:
  GET  /api/rooms                  room ids (game/rooms/*.js)
  GET  /api/room/<id>              model + source lines (tools/js/roomsrc.mjs dump) + sha, mtime
  GET  /api/room/<id>/sha          {sha, mtime} (cheap, for change polling)
  POST /api/room/<id>/patch        {sha, edits, force?} -> {sha, baseSha, diff, model, postcheck}
                                   409 conflicts, 422 not applicable / verification failed
  GET  /api/room/<id>/diff         git diff of the room file (read-only)
  Every /api/room... call takes ?game=<key> for a level-editor project in games/<key>/ (default: game/).
  GET  /api/projects               [{key, dir, title}] (key null = License to Pillage in game/)
  POST /api/projects               {key, title, player?: guybrush|own, hero?: name} -> games/<key>/ from the template
                                   (player own: a placeholder picture character instead of Guybrush, standalone-ready)
  POST /api/project/room?game=     {id, name, image?: data URL, width?} -> a new room (file, background, game.js)
  POST /api/project/item?game=     {id, name, icon?: data URL, look?} -> a new inventory item (game.js + icon)
  POST /api/project/upload?game=   {path, data: data URL} -> an image in the project (the old one backed up)
  POST /api/project/background?game= {room, image: data URL} -> the room's background, fitted to its size
  POST /api/project/actor-image?game= {id, image, height?} -> a new picture for a one-picture character
  POST /api/project/item-rename?game= {id, to} -> an item's id everywhere (game.js, icon file, data scripts)
  POST /api/project/actor-pose?game= {id, faces?, talk?, removeTalk?} -> a picture character's facing / talking picture
  (new rooms / items in License to Pillage itself only with reference: true; the editor never sends it)
  POST /api/project/sound?game=    {kind: music|sfx|ambience, name, data} -> <dir>/<name>.mp3 (converted) + game.js entry
  GET/POST /api/project/style?game= {style} / {prompt?, keep?, refs?} -> games/<key>/style.json: the project's art
                                   style pack, used by every ✨ generation instead of the CMI look (empty = CMI)
  GET/POST /api/project/theme?game= {theme} / the whole theme.json: the project's interface (verb coin, cursors,
                                   exit arrows, chest, colors, fonts), validated; empty = the CMI interface
  GET  /api/project/standalone?game= can it ship with no CMI at all: {standalone, cmiReferences, themeMissing,
                                   origins (generated/upload/template counts), unverified files}
  POST /api/project/font?game=     {name?, data: TTF/OTF data URL} -> fonts/<name>_{text,small,big} atlases at
                                   CMI's sizes + theme.json pointing at them (tools/make_font.py)
  POST /api/project/sound/remove?game= {kind, name} -> out of game.js, the file to .trash
  POST /api/game/patch?game=       {edits} -> game.js values (roomsrc patch; items, actors...)
  GET  /api/game/opening?game=     {opening: {room, x, y, dir} | null}
  POST /api/game/opening?game=     {x, y, dir} -> where the game starts (the g.goto in game.js's start)
  /api/ai/...                      ComfyUI: candidates for new objects / items / characters / backgrounds, repaint and
                                   inpaint (tools/ai_api.py, tools/ai_gen.py)
  GET  /api/library?game=          the project's library (tools/library.py): archived and saved things
  POST /api/library/archive?game=  {kind: object|item|character, id, room?, keep?} -> out of the game (into the library)
  POST /api/library/restore?game=  {id, room?, at?} -> back into a room / game.js
  POST /api/library/remove?game=   {id} -> the entry goes (its picture to .trash)
  POST /api/library/add?game=      {kind, name, image: data URL | path, def?} -> keep something for later
  GET  /api/project/files?game=    the project's images [{path, w, h, bytes}]
  GET  /api/project/costumes?game= costumes it can use [{source, id, from, path}]
  POST /api/project/actor?game=    {id, name, source | image (+ height), color} -> a character (game.js actors,
                                   costume copied in, or a one-picture costume)
  /api/voice/...                   the voice review page (tools/voice_review.html, also /?voices): see
                                   tools/voice_review_api.py
  GET  /api/history                what the journal holds: [{snap, file, t, bytes}], newest first
  POST /api/history/restore        {snap, file} -> that version back in place (the current one is journaled first)
  POST /api/build                  {game?, cmiMusic?} -> tools/scumm/build.py, streamed as JSON lines
                                   ({line} per output line, then {done, warnings}); one build at a time,
                                   409 while a ScummVM runs, real repo only
  POST /api/scumm/play             {game?} -> License to Pillage via scumm/play.sh --window, or a project via its
                                   own ini in scumm/projects/<key>/play (409 while a ScummVM runs)
  POST /api/export/web             {game?, withCmi?} -> tools/export_web.py: a standalone web folder in dist/,
                                   with its provenance report (what is CMI-derived)
  POST /api/scene/apply?game=      {plan} -> a whole scene as data (tools/scene.py: room, hotspots, items,
                                   characters + conversations), validated first; 422 with the reasons otherwise
Writes go only to <root>/game/rooms/<id>.js, the project folders games/<key>/ and (voice review) the voice JSON files + game/voice, atomically (temp
file + rename); nothing is deleted. Every room-file and game.js rewrite first copies the old bytes to
<root>/.history/<ms>/<file> (the journal; the oldest snapshots are pruned).
"""
import argparse
import base64
import difflib
import hashlib
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from urllib.parse import urlparse, parse_qs

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(TOOLS)
sys.path.insert(0, TOOLS)
try:
    import voice_review_api  # noqa: E402  (the developer's voice review page; not part of the mod)
except ImportError:
    voice_review_api = None
import modcfg  # noqa: E402
try:        # the level editor's API needs Pillow; playing needs only this file and the standard library
    import projects  # noqa: E402
    import library  # noqa: E402
    import ai_api  # noqa: E402
    import scene  # noqa: E402
    EDITOR_MISSING = None
except ImportError as _e:
    projects = library = ai_api = scene = None
    EDITOR_MISSING = _e.name or str(_e)
ROOMSRC = os.path.join(TOOLS, 'js', 'roomsrc.mjs')
ROOM_ID = re.compile(r'^[a-z0-9_]+$')
LOCK = threading.Lock()
BUILD_LOCK = threading.Lock()        # one ScummVM build / web export at a time
# the mod (install.json): the player's ScummVM, else $LTP_SCUMMVM (a developer's own build)
SCUMMVM = modcfg.scummvm() or os.path.expanduser(os.environ.get('LTP_SCUMMVM', 'scummvm'))
HD_PATH = os.path.expanduser(os.environ.get('LTP_HD_PATH', ''))    # an HD ScummVM build's HD pack (developer setups)


def scummvm_running():
    # the mod: only a ScummVM that plays this copy's games blocks a build; the developer's checkout: any
    if modcfg.is_mod():
        return modcfg.scummvm_conflict() or None
    return modcfg.scummvm_running() or None


def sha1(data):
    return hashlib.sha1(data).hexdigest()


HISTORY_KEEP = 400          # snapshots; the oldest beyond this are pruned


def journal(root, relfile, before_text):
    """The file's bytes before a rewrite -> <root>/.history/<ms>[-n]/<relfile> (deletes become restorable)."""
    hist = os.path.join(root, '.history')
    base = str(int(time.time() * 1000))
    snap, n = base, 0
    while os.path.exists(os.path.join(hist, snap)):
        n += 1
        snap = f'{base}-{n}'
    dst = os.path.join(hist, snap, relfile)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(before_text)
    try:
        snaps = sorted(os.listdir(hist))
        for s in snaps[:-HISTORY_KEEP]:
            shutil.rmtree(os.path.join(hist, s), ignore_errors=True)
    except OSError:
        pass
    return snap


def roomsrc(*args, stdin=None):
    r = subprocess.run(['node', ROOMSRC, *args], input=stdin, capture_output=True, text=True, timeout=60)
    if r.returncode not in (0, 1) or not r.stdout.strip():
        raise RuntimeError(r.stderr.strip() or f'roomsrc {args[0]} failed')
    return json.loads(r.stdout)


def postcheck(game_dir):
    """The SCUMM build's loader (tools/scumm/jsgame.py) must still read the game."""
    code = ('import sys; sys.path.insert(0, %r); import jsgame; g = jsgame.Game(%r); print(len(g.rooms))'
            % (os.path.join(TOOLS, 'scumm'), game_dir))
    r = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=60)
    if r.returncode == 0:
        return {'ok': True}
    return {'ok': False, 'error': (r.stderr.strip().splitlines() or ['?'])[-1]}


def editor_missing():
    return (f'The level editor needs Python packages this server was started without ({EDITOR_MISSING}). '
            'Start the editor with its launcher or: python3 setup.py editor')


class Handler(http.server.SimpleHTTPRequestHandler):
    root = REPO
    port = 8765
    # pinned: on Windows the registry's MIME types can be wrong (.js as text/plain stops the engine's modules)
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript',
                      '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json',
                      '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg',
                      '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.zip': 'application/zip', '.whl': 'application/zip'}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=self.root, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass

    # ------------------------------------------------------------ api plumbing
    def api_allowed(self):
        if self.headers.get('X-Editor') != '1':
            return False
        hosts = {f'localhost:{self.port}', f'127.0.0.1:{self.port}'}
        if self.headers.get('Host') not in hosts:
            return False
        origin = self.headers.get('Origin')
        return origin is None or origin in {'http://' + h for h in hosts}

    def send_json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def game_dir(self, query):
        """The project of a request (?game=<key>), or game/ (License to Pillage)."""
        key = (parse_qs(query).get('game') or [None])[0]
        return projects.project_dir(self.root, key), key

    def room_file(self, rid, game_dir):
        if not ROOM_ID.match(rid):
            return None
        p = os.path.join(game_dir, 'rooms', rid + '.js')
        return p if os.path.isfile(p) else None

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        if path in ('/', '/index.html') and 'voices' in url.query.split('&'):     # /?voices -> the voice review page
            self.send_response(302)
            self.send_header('Location', '/tools/voice_review.html')
            self.end_headers()
            return
        if not path.startswith('/api/'):
            return super().do_GET()
        if not self.api_allowed():
            return self.send_json(403, {'error': 'forbidden'})
        if EDITOR_MISSING:
            return self.send_json(503, {'error': editor_missing()})
        try:
            if path.startswith('/api/voice/'):
                if not voice_review_api:
                    return self.send_json(404, {'error': 'no voice review in this copy'})
                return self.send_json(*voice_review_api.get(self.root, path, url.query))
            if path.startswith('/api/ai/'):
                return self.send_json(*ai_api.get(self.root, path, url.query))
            self.api_get(path, url.query)
        except projects.ProjectError as e:
            self.send_json(e.code, {'error': str(e)})
        except Exception as e:  # noqa: BLE001 - report to the editor
            self.send_json(500, {'error': f'{type(e).__name__}: {e}'})

    def do_POST(self):
        url = urlparse(self.path)
        path = url.path
        if not path.startswith('/api/'):
            return self.send_json(404, {'error': 'not found'})
        if not self.api_allowed():
            return self.send_json(403, {'error': 'forbidden'})
        if EDITOR_MISSING:
            return self.send_json(503, {'error': editor_missing()})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(n) or b'{}')
            if path.startswith('/api/voice/'):
                if not voice_review_api:
                    return self.send_json(404, {'error': 'no voice review in this copy'})
                return self.send_json(*voice_review_api.post(self.root, path, body))
            if path.startswith('/api/ai/'):
                key = (parse_qs(url.query).get('game') or [None])[0]
                return self.send_json(*ai_api.post(self.root, path, key, body))
            self.api_post(path, body, url.query)
        except projects.ProjectError as e:
            self.send_json(e.code, {'error': str(e)})
        except Exception as e:  # noqa: BLE001
            self.send_json(500, {'error': f'{type(e).__name__}: {e}'})

    # ------------------------------------------------------------ endpoints
    def api_get(self, path, query=''):
        if path == '/api/projects':
            return self.send_json(200, {'projects': projects.list_projects(self.root)})
        if path == '/api/history':
            hist = os.path.join(self.root, '.history')
            out = []
            if os.path.isdir(hist):
                for s in sorted(os.listdir(hist), reverse=True)[:100]:
                    d = os.path.join(hist, s)
                    for dp, _, fns in os.walk(d):
                        for fn in fns:
                            p = os.path.join(dp, fn)
                            out.append({'snap': s, 'file': os.path.relpath(p, d),
                                        't': int(s.split('-')[0]) / 1000, 'bytes': os.path.getsize(p)})
            return self.send_json(200, {'entries': out})
        gd, key = self.game_dir(query)
        if path == '/api/project/files':
            return self.send_json(200, {'files': project_files(gd)})
        if path == '/api/library':
            return self.send_json(200, {'entries': library.entries(self.root, key)})
        if path == '/api/game/opening':
            o = projects.opening(self.root, key)
            if o:
                o.pop('span')
            return self.send_json(200, {'opening': o})
        if path == '/api/project/costumes':
            return self.send_json(200, {'costumes': projects.costumes(self.root, key)})
        if path == '/api/project/style':
            return self.send_json(200, {'style': projects.load_style(gd)})
        if path == '/api/project/theme':
            return self.send_json(200, {'theme': projects.load_theme(gd)})
        if path == '/api/project/standalone':
            return self.send_json(200, projects.standalone_report(self.root, key))
        if path == '/api/rooms':
            d = os.path.join(gd, 'rooms')
            ids = sorted(f[:-3] for f in os.listdir(d) if f.endswith('.js') and ROOM_ID.match(f[:-3]))
            return self.send_json(200, {'rooms': ids})
        m = re.match(r'^/api/room/([^/]+)(/sha|/diff)?$', path)
        f = m and self.room_file(m.group(1), gd)
        if not f:
            return self.send_json(404, {'error': 'no such room'})
        if m.group(2) == '/sha':
            data = open(f, 'rb').read()
            return self.send_json(200, {'sha': sha1(data), 'mtime': os.path.getmtime(f)})
        if m.group(2) == '/diff':
            r = subprocess.run(['git', 'diff', '--', os.path.relpath(f, self.root)], cwd=self.root, capture_output=True, text=True)
            return self.send_json(200, {'diff': r.stdout, 'error': r.stderr.strip() if r.returncode else None})
        d = roomsrc('dump', f)
        d['mtime'] = os.path.getmtime(f)
        d['file'] = os.path.relpath(f, self.root)
        return self.send_json(200, d)

    # ------------------------------------------------------------ ScummVM build / play, web export
    def real_repo(self):
        return os.path.realpath(self.root) == os.path.realpath(REPO)

    def api_build(self, body):
        """Streams build.py output as JSON lines: {line} each, then {done: code, warnings: [...]}."""
        key = body.get('game') or None
        if not self.real_repo():
            return self.send_json(400, {'error': 'builds run on the real repo only (serve.py without --root)'})
        if key and not os.path.isfile(os.path.join(self.root, 'games', key, 'game.js')):
            return self.send_json(404, {'error': f'no project games/{key}'})
        running = scummvm_running()
        if running:
            return self.send_json(409, {'error': f'A ScummVM is running ({running}): quit it first, the build would swap its files.'})
        if not BUILD_LOCK.acquire(blocking=False):
            return self.send_json(409, {'error': 'a build or export is already running'})
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.end_headers()
            cmd = [sys.executable, '-u', os.path.join(TOOLS, 'scumm', 'build.py')] + (['--game', key] if key else []) \
                + (['--cmi-music'] if body.get('cmiMusic') else []) + modcfg.build_args() + (['--force'] if modcfg.is_mod() else [])
            p = subprocess.Popen(cmd, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in p.stdout:
                self.wfile.write((json.dumps({'line': line.rstrip('\n')}) + '\n').encode())
                self.wfile.flush()
            code = p.wait()
            log = os.path.join(self.root, 'scumm', 'projects', key, 'build') if key else os.path.join(self.root, 'scumm', 'build')
            warnings = []
            try:
                warnings = json.load(open(os.path.join(log, 'build.json'))).get('warnings', [])
            except OSError:
                pass
            out = os.path.join('scumm', 'projects', key, 'game') if key else os.path.join('scumm', 'game')
            self.wfile.write((json.dumps({'done': code, 'warnings': warnings, 'out': out}) + '\n').encode())
            self.wfile.flush()
        finally:
            BUILD_LOCK.release()

    def api_scumm_play(self, body):
        key = body.get('game') or None
        if not self.real_repo():
            return self.send_json(400, {'error': 'ScummVM runs on the real repo only'})
        running = scummvm_running()
        if running:
            return self.send_json(409, {'error': f'A ScummVM is already running ({running}).'})
        if not key:
            if modcfg.is_mod():     # the player's ScummVM through the installer's launcher
                subprocess.Popen([sys.executable, os.path.join(self.root, 'setup.py'), 'scummvm'],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                subprocess.Popen(['bash', os.path.join(self.root, 'scumm', 'play.sh'), '--window'],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return self.send_json(200, {'ok': True, 'target': 'License to Pillage'})
        base = os.path.join(self.root, 'scumm', 'projects', key)
        if not os.path.isfile(os.path.join(base, 'game', 'COMI.LA3')):
            return self.send_json(409, {'error': 'not built yet: Build first'})
        if not os.path.isfile(SCUMMVM):
            return self.send_json(500, {'error': f'ScummVM not found: {SCUMMVM} (python3 setup.py install --scummvm <path>)'})
        ini = self.project_ini(key, base)
        subprocess.Popen([SCUMMVM, f'--config={ini}', f'comi-{key}'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return self.send_json(200, {'ok': True, 'target': key})

    def project_ini(self, key, base):
        """A project's private ScummVM config (like scumm/play.sh's, its own saves), created once."""
        ini = os.path.join(base, 'play', 'scummvm.ini')
        if os.path.isfile(ini):
            return ini
        title = projects.title_of(open(os.path.join(self.root, 'games', key, 'game.js'), encoding='utf-8').read()) or key
        os.makedirs(os.path.dirname(ini), exist_ok=True)
        os.makedirs(os.path.join(base, 'saves'), exist_ok=True)
        if modcfg.is_mod():         # a stock ScummVM: no HD keys
            with open(ini, 'w') as f:
                f.write(modcfg.ini_text(f'comi-{key}', title, os.path.join(base, 'game'), os.path.join(base, 'saves')))
            return ini
        os.makedirs(os.path.join(base, 'cache'), exist_ok=True)
        with open(ini, 'w') as f:
            f.write(f"""[scummvm]
gfx_mode=opengl
filtering=true
stretch_mode=fit
aspect_ratio=false
fullscreen=false
confirm_exit=true
updates_check=0
subtitles=true
lastselectedgame=comi-{key}
savepath={base}/saves

[comi-{key}]
description={title}
gameid=comi
engineid=scumm
platform=windows
language=en
path={base}/game
savepath={base}/saves
subtitles=true
talkspeed=227
original_gui_text_speed=8
original_gui_object_labels=1
object_labels=true
hd_enabled=true
hd_scale=4
hd_theme=2
hd_path={HD_PATH}
hd_theme_path={base}/hdtheme
hd_cache_path={base}/cache
guioptions=sndNoMIDI noAspect gameOption2 gameOption4 gameOption5 gameOption9 lang_English plat_windows
""")
        return ini

    def api_export_web(self, body):
        key = body.get('game') or None
        if not self.real_repo():
            return self.send_json(400, {'error': 'exports run on the real repo only'})
        if not BUILD_LOCK.acquire(blocking=False):
            return self.send_json(409, {'error': 'a build or export is already running'})
        try:
            cmd = [sys.executable, os.path.join(TOOLS, 'export_web.py')] + ([key] if key else ['--license']) \
                + (['--with-cmi'] if body.get('withCmi') else []) + (['--share'] if body.get('share') else [])
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if r.returncode != 0:
                return self.send_json(500, {'error': (r.stderr or r.stdout).strip()[-400:]})
            return self.send_json(200, json.loads(r.stdout.splitlines()[-1]))
        finally:
            BUILD_LOCK.release()

    def api_post(self, path, body, query=''):
        if path == '/api/build':
            return self.api_build(body)
        if path == '/api/scumm/play':
            return self.api_scumm_play(body)
        if path == '/api/export/web':
            return self.api_export_web(body)
        if path == '/api/projects':
            with LOCK:
                return self.send_json(200, projects.create_project(self.root, body.get('key'), body.get('title'),
                                                                   body.get('player') or 'guybrush', body.get('hero')))
        if path == '/api/history/restore':
            snap, rel = str(body.get('snap') or ''), str(body.get('file') or '')
            hist = os.path.realpath(os.path.join(self.root, '.history'))
            src = os.path.realpath(os.path.join(hist, snap, rel))
            if not src.startswith(hist + os.sep) or not os.path.isfile(src):
                return self.send_json(404, {'error': 'no such snapshot file'})
            dst = os.path.realpath(os.path.join(self.root, rel))
            allowed = tuple(os.path.realpath(os.path.join(self.root, d)) + os.sep for d in ('game', 'games'))
            if not dst.startswith(allowed) or not dst.endswith(('.js', '.json')):
                return self.send_json(400, {'error': 'only game .js/.json files are restored'})
            with LOCK:
                cur = open(dst, encoding='utf-8').read() if os.path.isfile(dst) else ''
                journal(self.root, rel, cur)
                tmp = dst + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as out:
                    out.write(open(src, encoding='utf-8').read())
                os.replace(tmp, dst)
            return self.send_json(200, {'restored': rel, 'from': snap})
        gd, key = self.game_dir(query)
        if path == '/api/project/room':
            with LOCK:
                r = projects.create_room(self.root, key, body.get('id'), body.get('name'), data_url(body.get('image')),
                                         body.get('width'), reference=bool(body.get('reference')))
            r['postcheck'] = postcheck(gd)
            return self.send_json(200, r)
        if path == '/api/project/item':
            with LOCK:
                r = projects.create_item(self.root, key, body.get('id'), body.get('name'), data_url(body.get('icon')),
                                         body.get('look'), reference=bool(body.get('reference')))
            return self.send_json(200, r)
        if path == '/api/project/actor':
            with LOCK:
                return self.send_json(200, projects.create_actor(self.root, key, body.get('id'), body.get('name'),
                                                                 body.get('source'), body.get('color'),
                                                                 reference=bool(body.get('reference')),
                                                                 image=data_url(body.get('image')), height=body.get('height')))
        if path == '/api/game/opening':
            # where the game starts: the g.goto(room, x, y, dir) in game.js's start
            with LOCK:
                r = projects.set_opening(self.root, key, body.get('x'), body.get('y'), body.get('dir') or 'S')
            return self.send_json(200, {**r, 'postcheck': postcheck(gd)})
        if path == '/api/scene/apply':
            # a whole scene as data (tools/scene.py): validated first, then room / items / characters /
            # hotspots / conversations in one go; art stays placeholder until ✨ replaces it
            with LOCK:
                r = scene.apply(self.root, key, body.get('plan') or {},
                                journal=lambda rel, txt: journal(self.root, rel, txt))
            return self.send_json(200, {**r, 'postcheck': postcheck(gd)})
        if path == '/api/game/patch':
            # value edits of game.js (an item's name / look text / icon...), written at once
            gf = os.path.join(gd, 'game.js')
            with LOCK:
                before_g = open(gf, encoding='utf-8').read()
                r = projects.roomsrc_patch(self.root, gf, body.get('edits') or [])
                if r['changed']:
                    journal(self.root, os.path.relpath(gf, self.root), before_g)
            return self.send_json(200, {'changed': r['changed'], 'postcheck': postcheck(gd) if r['changed'] else {'ok': True}})
        if path.startswith('/api/library/'):
            op = path.rsplit('/', 1)[1]
            with LOCK:
                if op == 'archive':
                    return self.send_json(200, library.archive(self.root, key, body.get('kind'), body.get('id'), body.get('room'),
                                                               keep=body.get('keep', True)))
                if op == 'restore':
                    return self.send_json(200, library.restore(self.root, key, body.get('id'), body.get('room'), body.get('at'),
                                                               body.get('keepEntry')))
                if op == 'remove':
                    return self.send_json(200, library.remove_entry(self.root, key, body.get('id')))
                if op == 'add':
                    img = data_url(body.get('image')) if body.get('image') else body.get('path')
                    return self.send_json(200, library.add(self.root, key, body.get('kind'), body.get('name'), img, body.get('def')))
            return self.send_json(404, {'error': 'unknown library operation'})
        if path == '/api/project/actor-image':
            with LOCK:
                return self.send_json(200, projects.replace_actor_image(self.root, key, body.get('id'), data_url(body.get('image')) or b'',
                                                                        body.get('height')))
        if path == '/api/project/item-rename':
            # {id, to} -> the item's id everywhere (game.js, its icon file, data scripts in every room)
            with LOCK:
                r = projects.rename_item(self.root, key, body.get('id'), body.get('to'))
            return self.send_json(200, {**r, 'postcheck': postcheck(gd)})
        if path == '/api/project/actor-pose':
            # a picture character: {id, faces?: E|W|S, talk?: data URL (mouth open), removeTalk?}
            with LOCK:
                return self.send_json(200, projects.actor_pose(self.root, key, body.get('id'), body.get('faces'),
                                                               data_url(body.get('talk')), bool(body.get('removeTalk'))))
        if path == '/api/project/background':
            with LOCK:
                return self.send_json(200, projects.replace_background(self.root, key, body.get('room'),
                                                                       data_url(body.get('image')) or b''))
        if path == '/api/project/sound':
            # {kind: music | sfx | ambience, name, data: data URL} -> <dir>/<name>.mp3 (+ its game.js entry)
            with LOCK:
                r = projects.add_sound(self.root, key, body.get('kind'), body.get('name'), data_url(body.get('data')) or b'')
            return self.send_json(200, {**r, 'postcheck': postcheck(gd)})
        if path == '/api/project/sound/remove':
            with LOCK:
                r = projects.remove_sound(self.root, key, body.get('kind'), body.get('name'))
            return self.send_json(200, {**r, 'postcheck': postcheck(gd)})
        if path == '/api/project/upload':
            with LOCK:
                return self.send_json(200, projects.save_upload(self.root, key, body.get('path') or '',
                                                                data_url(body.get('data')) or b''))
        if path == '/api/project/style':
            # {prompt?, keep?, refs?: [project images]} -> games/<key>/style.json (empty body removes it)
            with LOCK:
                f = os.path.join(gd, 'style.json')
                if os.path.isfile(f):
                    journal(self.root, os.path.relpath(f, self.root), open(f, encoding='utf-8').read())
                return self.send_json(200, projects.save_style(self.root, key, body))
        if path == '/api/project/theme':
            # the whole theme.json, validated (empty body removes it: back to the CMI interface)
            with LOCK:
                f = os.path.join(gd, 'theme.json')
                if os.path.isfile(f):
                    journal(self.root, os.path.relpath(f, self.root), open(f, encoding='utf-8').read())
                return self.send_json(200, projects.save_theme(self.root, key, body))
        if path == '/api/project/font':
            # {name?, data: a TTF/OTF as a data URL} -> three atlases at CMI's sizes (text 30 / small 23 /
            # big 36) in fonts/, theme.json pointing at them (tools/make_font.py)
            import make_font
            with LOCK:
                projects.guard(key, False)
                data = data_url(body.get('data')) or b''
                name = re.sub(r'[^a-z0-9_]+', '_', (body.get('name') or 'font').lower()).strip('_')[:24] or 'font'
                theme = projects.load_theme(gd)
                try:
                    for slot, h in make_font.SLOTS.items():
                        rel = f'fonts/{name}_{slot}'
                        for ext in ('.json', '.png'):
                            projects.backup(self.root, os.path.join(gd, rel + ext))
                        make_font.write_atlas(data, h, os.path.join(gd, rel))
                        projects.provenance_note(gd, rel + '.png', 'upload')
                        theme.setdefault('fonts', {})[slot] = rel
                except OSError as e:
                    return self.send_json(422, {'error': f'not a usable font file: {e}'})
                f = os.path.join(gd, 'theme.json')
                if os.path.isfile(f):
                    journal(self.root, os.path.relpath(f, self.root), open(f, encoding='utf-8').read())
                return self.send_json(200, projects.save_theme(self.root, key, theme))
        m = re.match(r'^/api/room/([^/]+)/patch$', path)
        f = m and self.room_file(m.group(1), gd)
        if not f:
            return self.send_json(404, {'error': 'no such room'})
        edits = body.get('edits') or []
        with LOCK:
            before = open(f, encoding='utf-8').read()
            base_sha = sha1(before.encode())
            r = roomsrc('patch', f, stdin=json.dumps({'edits': edits, 'force': bool(body.get('force'))}))
            if r['conflicts']:
                return self.send_json(409, {'conflicts': r['conflicts'], 'baseSha': base_sha})
            if r['errors'] or not r['verify']['ok']:
                return self.send_json(422, {'errors': r['errors'], 'verify': r['verify'], 'baseSha': base_sha})
            wrote = False
            if r['changed']:
                journal(self.root, os.path.relpath(f, self.root), before)
                tmp = os.path.join(os.path.dirname(f), '.' + os.path.basename(f) + '.tmp')
                with open(tmp, 'w', encoding='utf-8') as out:
                    out.write(r['text'])
                os.replace(tmp, f)
                wrote = True
            after = r['text'] if wrote else before
        diff = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                            'a/' + os.path.relpath(f, self.root), 'b/' + os.path.relpath(f, self.root)))
        model = roomsrc('dump', f)
        return self.send_json(200, {
            'sha': model['sha'], 'baseSha': base_sha, 'clientSha': body.get('sha'), 'wrote': wrote, 'diff': diff,
            'model': model['value'], 'loc': model['loc'], 'applied': r['applied'],
            'postcheck': postcheck(gd) if wrote else {'ok': True, 'skipped': True},
        })


def data_url(s):
    """'data:image/png;base64,...' (or plain base64) -> bytes; None for nothing."""
    if not s:
        return None
    if s.startswith('data:'):
        s = s.split(',', 1)[1]
    return base64.b64decode(s)


def project_files(gd):
    from PIL import Image
    out = []
    for dp, dns, fns in os.walk(gd):
        dns[:] = sorted(d for d in dns if not d.startswith('.'))
        for f in sorted(fns):
            if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')) and not f.startswith('.'):
                p = os.path.join(dp, f)
                try:
                    w, h = Image.open(p).size
                except OSError:
                    w = h = None
                out.append({'path': os.path.relpath(p, gd), 'w': w, 'h': h, 'bytes': os.path.getsize(p)})
    return out


def main():
    # launched from the .app, PATH is minimal: node (roomsrc.mjs, jsgame.py) lives in Homebrew
    if not shutil.which('node'):
        os.environ['PATH'] = os.pathsep.join(['/opt/homebrew/bin', '/usr/local/bin', os.environ.get('PATH', '')])
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--root', default=REPO, help='serve (and edit) this copy of the repo (tests)')
    a = ap.parse_args()
    Handler.root = os.path.abspath(a.root)
    Handler.port = a.port
    http.server.ThreadingHTTPServer(('127.0.0.1', a.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
