#!/usr/bin/env python3
"""License to Pillage: installer and launcher (a fan-made chapter for The Curse of Monkey Island).

Needs your own copy of The Curse of Monkey Island (Steam, GOG or CD). Nothing of the original game comes with
this download: the installer reads your game files (read-only) and builds everything that needs them here, in
this folder.

  python3 setup.py install [--cmi FOLDER] [--scummvm BINARY] [--no-scummvm] [--yes]
  python3 setup.py web            play in your browser
  python3 setup.py scummvm        play inside CMI in ScummVM
  python3 setup.py editor         the level editor (browser)
  python3 setup.py rebuild        rebuild the ScummVM version (after editing the game)
  python3 setup.py voice-pack [ZIP] [--remove]   the optional Guybrush voice pack (a separate download)
  python3 setup.py status         what is installed where
  python3 setup.py uninstall      move everything the installer made into .trash/ (your saves stay)

The double-click launchers next to this file run the same commands.
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.join(ROOT, 'tools')
VENV = os.path.join(ROOT, '.venv')
MIN_PY = (3, 8)
PIP_DEPS = ['numpy', 'pillow']
TITLE = 'License to Pillage'


# ------------------------------------------------------------------ output
def say(msg=''):
    print(msg, flush=True)


def step(msg):
    say(f'\n== {msg}')


def fail(msg):
    say(f'\nERROR: {msg}')
    pause_if_double_clicked()
    sys.exit(1)


def pause_if_double_clicked():
    # a launcher started from Finder/Explorer closes its window at once: keep errors readable
    if os.environ.get('LTP_LAUNCHER') and sys.stdin and sys.stdin.isatty():
        try:
            input('\nPress Enter to close this window.')
        except EOFError:
            pass


# ------------------------------------------------------------------ python dependencies (numpy, Pillow)
def venv_python():
    return os.path.join(VENV, 'Scripts', 'python.exe') if os.name == 'nt' else os.path.join(VENV, 'bin', 'python3')


def have_deps(modules=('numpy', 'PIL')):
    import importlib
    try:
        for m in modules:
            importlib.import_module(m)
        return True
    except ImportError:
        return False


def ensure_deps(argv, extra=()):
    """numpy + Pillow (+ extra (module, pip name) pairs, e.g. onnxruntime for the HD pack): from this Python if it has
    them, else from a private .venv here (created once; nothing is ever installed into your own Python)."""
    mods = ['numpy', 'PIL'] + [m for m, _ in extra]
    if have_deps(mods):
        return
    in_venv = os.path.realpath(sys.executable) == os.path.realpath(venv_python())
    if in_venv:     # the .venv lacks an extra: add it
        if subprocess.call([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '-q'] + [p for _, p in extra]) == 0:
            return
        fail('pip could not install ' + ', '.join(p for _, p in extra) + ' (no internet?). Try again.')
    if not in_venv:
        if not os.path.isfile(venv_python()):
            step('Setting up Python packages (numpy, Pillow) in .venv (one time, needs the internet)')
            try:
                subprocess.check_call([sys.executable, '-m', 'venv', VENV])
            except (subprocess.CalledProcessError, OSError):
                fail('Could not create a Python virtual environment. On Debian/Ubuntu: sudo apt install python3-venv. '
                     'Or install numpy and Pillow for this Python yourself: python3 -m pip install numpy pillow')
        check = subprocess.run([venv_python(), '-c', 'import ' + ', '.join(mods)], capture_output=True)
        if check.returncode != 0:
            r = subprocess.call([venv_python(), '-m', 'pip', 'install', '--disable-pip-version-check', '-q'] + PIP_DEPS
                                + [p for _, p in extra])
            if r != 0:
                fail('pip could not install the Python packages (no internet?). Try again, or install them yourself.')
        # continue in the venv's Python
        if os.name == 'nt':
            sys.exit(subprocess.call([venv_python(), os.path.abspath(__file__)] + argv))
        os.execv(venv_python(), [venv_python(), os.path.abspath(__file__)] + argv)
    fail('numpy/Pillow are missing from .venv: delete the .venv folder and run the installer again')


def tools_path():
    for p in (TOOLS, os.path.join(TOOLS, 'byog'), os.path.join(TOOLS, 'scumm')):
        if p not in sys.path:
            sys.path.insert(0, p)


# ------------------------------------------------------------------ helpers
def cfg_load():
    tools_path()
    import modcfg
    return modcfg.load()


def cfg_save(cfg):
    tools_path()
    import modcfg
    modcfg.save(cfg)


def ask(prompt, default=None, yes=False):
    if yes or not (sys.stdin and sys.stdin.isatty()):
        return default
    try:
        r = input(prompt).strip()
    except EOFError:
        return default
    return r or default


def free_port(start=8765):
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    fail('no free port for the local game server')


def wait_port(port, timeout=20):
    t = time.time()
    while time.time() - t < timeout:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('127.0.0.1', port)) == 0:
                return True
        time.sleep(0.2)
    return False


LANGS = ['en', 'de', 'fr', 'es', 'it']


def remember_lang(cfg, lang):
    """--lang: the ScummVM version's text language from now on (install.json; tools/modcfg.py passes it on)."""
    if lang:
        cfg['lang'] = lang
        cfg_save(cfg)


def run_build(cfg, extra=()):
    tools_path()
    import modcfg
    busy = modcfg.scummvm_conflict(ROOT)
    if busy:
        fail('ScummVM is playing this game right now: quit it first (the build replaces the files it reads).')
    others = modcfg.scummvm_processes()
    if others:
        say('  note: a ScummVM is running. If it is playing License to Pillage (added from its own launcher), quit it first.')
    # License to Pillage -> scumm/game; a project (--game KEY) -> scumm/projects/KEY/ (build.py decides)
    where = [] if '--game' in extra else ['--out', os.path.join(ROOT, 'scumm', 'game'), '--work', os.path.join(ROOT, 'scumm', 'build')]
    cmd = [sys.executable, '-u', os.path.join(TOOLS, 'scumm', 'build.py')] + modcfg.build_args() + where + ['--force', *extra]
    say('  ' + ' '.join(os.path.relpath(c, ROOT) if os.path.isabs(c) and c.startswith(ROOT) else c for c in cmd[1:]))
    r = subprocess.call(cmd, cwd=ROOT)
    if r != 0:
        fail('the ScummVM build failed (see above). The browser version still works: python3 setup.py web')


# ------------------------------------------------------------------ install
def images_in(paths):
    """CD images among the given paths (files, or folders holding them)."""
    import iso9660
    out = []
    for p in paths:
        if iso9660.is_image(p):
            out.append(p)
        elif os.path.isdir(p):
            out += sorted(os.path.join(p, n) for n in os.listdir(p) if iso9660.is_image(os.path.join(p, n)))
    return out


def from_images(images, log=say):
    """CMI's CD images -> one game folder (.byog/cd), read straight from the images."""
    import iso9660
    dst = os.path.join(ROOT, '.byog', 'cd')
    say(f'  reading {len(images)} CD image(s) (about 1 GB is copied out once)')
    try:
        iso9660.extract_game(images, dst, log=lambda m: say(m))
    except (OSError, iso9660.IsoError) as e:
        fail(f'could not read the CD image: {e}')
    return dst


def find_cmi(a):
    tools_path()
    import gamedir
    given = [os.path.abspath(os.path.expanduser(p.strip().strip('"').strip("'"))) for p in (a.cmi or [])]
    if given:
        folders = [p for p in given if os.path.isdir(p) and gamedir.looks_like(p)]
        if folders:
            return folders[0]
        images = images_in(given)
        if images:
            return from_images(images)
        return given[0]
    found = [f for f in gamedir.candidates() if gamedir.check(f)['ok']]
    if found:
        for f in found:
            say(f'  found: {f}')
        return found[0]
    # CD images put into this folder (or next to it)
    images = images_in([ROOT, os.path.dirname(ROOT)])
    if images:
        say('  found CD images: ' + ', '.join(os.path.basename(i) for i in images))
        return from_images(images)
    say('  No installation of The Curse of Monkey Island found automatically.')
    say('  It is the folder with COMI.LA0, COMI.LA1, COMI.LA2 and a RESOURCE folder, or the CD images (.iso/.bin) of both CDs')
    say('  (Steam on a Mac: ~/Library/Application Support/Steam/steamapps/common/The Curse of Monkey Island/ScummVM/monkey3).')
    p = ask('  Folder of your CMI game files (or a CD image): ', yes=a.yes)
    if not p:
        fail('no game found: run again with --cmi "<folder>" or --cmi CD1.iso --cmi CD2.iso')
    p = os.path.abspath(os.path.expanduser(p.strip().strip('"').strip("'")))
    images = images_in([p])
    return from_images(images) if images and not gamedir.looks_like(p) else p


def cmd_install(a, argv):
    ensure_deps(argv)
    tools_path()
    import gamedir
    import modcfg
    say(f'{TITLE}: installing into {ROOT}')
    if sys.version_info < MIN_PY:
        fail(f'Python {MIN_PY[0]}.{MIN_PY[1]} or newer is needed (this is {sys.version.split()[0]})')

    step('1/5 Your copy of The Curse of Monkey Island')
    cmi = find_cmi(a)
    chk = gamedir.check(cmi)
    if not chk['ok']:
        fail(f'{cmi} is not a complete CMI folder: missing {", ".join(chk["missing"])}.\n'
             '  From CDs: give both discs, e.g. --cmi CD1.iso --cmi CD2.iso (or copy both CDs into one folder).')
    say(f'  using {cmi}')
    say(f'  version: {chk["version"] or "unknown (not the English Steam/GOG/CD data): trying anyway"}')
    for n in chk['notes']:
        say(f'  note: {n}')
    view = os.path.join(ROOT, '.byog', 'game')
    gamedir.make_view(cmi, view)

    cfg = modcfg.load()
    cfg.update({'version': 1, 'cmi': cmi, 'cmi_md5': chk['md5'], 'cmi_version': chk['version'],
                'installed': time.strftime('%Y-%m-%d %H:%M:%S')})
    if a.lang:
        cfg['lang'] = a.lang
    cfg_save(cfg)

    make_pieces(view, cfg, '2/5', '3/5')
    hp = find_hd_pack()
    if hp and not cfg.get('hd'):
        say(f'  optional HD pack found: {os.path.basename(hp)} (sharper Guybrush and interface in the browser): '
            'python3 setup.py hd')

    pack = find_pack()
    if pack:
        say(f'  optional voice pack found: {os.path.basename(pack)}')
        cfg['voice_pack'] = voice_pack_install(pack, log=lambda m: say(m)).get('voice_pack')   # kept by the saves below

    step('4/5 ScummVM version (the chapter inside CMI)')
    if a.no_scummvm:
        say('  skipped (--no-scummvm). Later: python3 setup.py rebuild')
        cfg['ltp_built'] = False
    else:
        run_build(cfg)
        cfg['ltp_built'] = True
    cfg_save(cfg)

    step('5/5 Finding ScummVM')
    cands = modcfg.scummvm_candidates()
    if a.scummvm:
        binary = os.path.abspath(os.path.expanduser(a.scummvm))
        cands.insert(0, (binary, modcfg.scummvm_version(binary)))
    for p, v in cands:
        say(f'  {v or "?":>10}  {p}')
    if cands:
        cfg['scummvm'], cfg['scummvm_version'] = cands[0]
        cfg['scummvm_all'] = [list(c) for c in cands]
        say(f'  using ScummVM {cands[0][1] or "?"}: {cands[0][0]}')
    else:
        cfg['scummvm'] = None
        say('  No ScummVM found. Get it free from https://www.scummvm.org (any version from 2.0 on), then run:')
        say('    python3 setup.py install --scummvm "<path to scummvm>"     or add the folder scumm/game in ScummVM')
    cfg_save(cfg)
    write_ini(cfg)

    say('\nDone. Play:')
    say('  in your browser:   python3 setup.py web       (or double-click "Play in Browser")')
    say('  inside CMI:        python3 setup.py scummvm   (or double-click "Play in ScummVM")')
    say('  level editor:      python3 setup.py editor    (or double-click "Level Editor")')
    say('Everything in cmi/, .byog/ and scumm/game/ was made from your own game.')
    pause_if_double_clicked()
    if cfg.get('hd'):
        exit_after_hd()


def write_ini(cfg, force=False):
    tools_path()
    import modcfg
    ini = os.path.join(ROOT, 'scumm', 'play', 'scummvm.ini')
    saves = os.path.join(ROOT, 'scumm', 'saves')
    os.makedirs(os.path.dirname(ini), exist_ok=True)
    os.makedirs(saves, exist_ok=True)
    if os.path.isfile(ini) and not force:
        return ini      # ScummVM keeps its own settings in there (window size, volumes...)
    with open(ini, 'w', encoding='utf-8') as f:
        f.write(modcfg.ini_text(modcfg.TARGET, f'The Curse of Monkey Island: {TITLE}',
                                os.path.join(ROOT, 'scumm', 'game'), saves))
    return ini


# ------------------------------------------------------------------ play / edit
def cmd_web(a, argv, edit=False):
    if edit:
        ensure_deps(argv)           # the editor's tools need numpy + Pillow; playing needs only Python itself
    if not os.path.isdir(os.path.join(ROOT, 'cmi', 'fonts')):
        say('Your own Curse of Monkey Island is not installed in this folder: the page will ask for it (drop the CD\n'
            'images or the game folder on it; your browser reads it and keeps what it needs). Or install it here with\n'
            '"python3 setup.py install" (that also makes the ScummVM version).')
    port = free_port(a.port)
    url = f'http://127.0.0.1:{port}/' + ('?edit' if edit else '')
    py = venv_python() if os.path.isfile(venv_python()) else sys.executable
    p = subprocess.Popen([py, os.path.join(TOOLS, 'serve.py'), '--port', str(port)], cwd=ROOT)
    if not wait_port(port):
        p.terminate()
        fail('the local game server did not start')
    say(f'{TITLE}{" level editor" if edit else ""} at {url}')
    if not a.no_browser:
        webbrowser.open(url)
    say('Keep this window open while you play. Ctrl+C (or closing it) stops the game server.')
    if edit and not shutil.which('node'):
        say('Note: saving in the level editor needs Node.js (https://nodejs.org). Playing and looking around work without it.')
    try:
        p.wait()
    except KeyboardInterrupt:
        p.terminate()


def cmd_scummvm(a, argv):
    tools_path()
    import modcfg
    cfg = modcfg.load()
    if not cfg:
        fail('not installed yet: python3 setup.py install')
    binary = a.scummvm or cfg.get('scummvm')
    if not binary or not os.path.isfile(binary):
        fail('no ScummVM found. Install it from https://www.scummvm.org, then: python3 setup.py install --scummvm "<path>"\n'
             f'  (or add the folder {os.path.join(ROOT, "scumm", "game")} as a game in your own ScummVM)')
    if not os.path.isfile(os.path.join(ROOT, 'scumm', 'game', 'COMI.LA3')):
        ensure_deps(argv)
        step('Building the ScummVM version first')
        run_build(cfg)
        cfg['ltp_built'] = True
        cfg_save(cfg)
    ini = write_ini(cfg)
    say(f'Starting {TITLE} in ScummVM {cfg.get("scummvm_version") or ""} ...')
    sys.exit(subprocess.call([binary, f'--config={ini}', modcfg.TARGET]))


def exit_after_hd():
    """After work with the HD model: leave without Python's teardown (onnxruntime's CoreML backend can abort while
    shutting down on macOS: a scary message after everything is done)."""
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


def make_pieces(view, cfg, n1='1/2', n2='2/2'):
    """cmi/ and the chapter's extras from the player's game; with the HD pack (setup.py hd) through its model."""
    import extract
    import ltp_extras
    import upscale
    model = hd_model_path() if cfg.get('hd') else None
    if model and os.path.isfile(model) and have_deps(['onnxruntime']):
        import hdmodel
        upscale.MODEL = hdmodel.OnnxModel(model)
        say('  HD: Real-ESRGAN on this computer (a few minutes with a graphics card, longer without)')
    elif cfg.get('hd'):
        say('  note: the HD pack is set but its model or onnxruntime is missing: python3 setup.py hd')
    step(f'{n1} Interface, fonts and Guybrush from your game (stays on this computer)')
    extract.Extractor(view, os.path.join(ROOT, 'cmi'), log=lambda m: say('  ' + m)).run(
        ['ui', 'fonts', 'glint', 'lo', 'guybrush'])
    step(f'{n2} License to Pillage: Guybrush\'s extra poses and CMI sound clips')
    ltp_extras.install(view, ROOT, log=lambda m: say('  ' + m))
    upscale.MODEL = None


# ------------------------------------------------------------------ the optional HD pack (setup.py hd)
HD_GLOB = 'License-to-Pillage-HD'


def hd_model_path():
    return os.path.join(ROOT, '.byog', 'hd', 'anime6b.onnx')


def find_hd_pack(path=None):
    if path:
        return os.path.abspath(os.path.expanduser(path))
    for d in (ROOT, os.path.dirname(ROOT)):
        try:
            names = sorted(os.listdir(d), reverse=True)
        except OSError:
            continue
        for n in names:
            if n.startswith(HD_GLOB) and (n.endswith('.zip') or os.path.isfile(os.path.join(d, n, 'ltp-hd.json'))):
                return os.path.join(d, n)
    return None


def cmd_hd(a, argv):
    cfg = cfg_load()
    if not cfg:
        fail('not installed yet: python3 setup.py install')
    view = os.path.join(ROOT, '.byog', 'game')
    if a.remove:
        ensure_deps(argv)
        cfg.pop('hd', None)
        cfg_save(cfg)
        make_pieces(view, cfg)
        say('Done: the pieces are back to the plain upscale. In the browser, reload the page.')
        return
    ensure_deps(argv, extra=[('onnxruntime', 'onnxruntime')])
    pack = find_hd_pack(a.path)
    if not pack or not os.path.exists(pack):
        fail('no HD pack found: python3 setup.py hd "<License-to-Pillage-HD-....zip>"')
    import zipfile
    dst = hd_model_path()
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if pack.endswith('.zip'):
        z = zipfile.ZipFile(pack)
        name = next((n for n in z.namelist() if n.endswith('model/anime6b.onnx')), None)
        if not name or not any(n.endswith('ltp-hd.json') for n in z.namelist()):
            fail(f'{pack} is not a License to Pillage HD pack')
        with open(dst + '.tmp', 'wb') as f:
            f.write(z.read(name))
    else:
        if not os.path.isfile(os.path.join(pack, 'ltp-hd.json')):
            fail(f'{pack} is not a License to Pillage HD pack')
        shutil.copyfile(os.path.join(pack, 'model', 'anime6b.onnx'), dst + '.tmp')
    os.replace(dst + '.tmp', dst)
    cfg['hd'] = {'from': os.path.basename(pack)}
    cfg_save(cfg)
    step('HD pack: the pieces again, through its model')
    make_pieces(view, cfg)
    say('Done. In the browser, reload the page (the ScummVM version keeps CMI\'s own look).')
    pause_if_double_clicked()
    exit_after_hd()


def cmd_rebuild(a, argv):
    ensure_deps(argv)
    cfg = cfg_load()
    if not cfg:
        fail('not installed yet: python3 setup.py install')
    extra = ['--cmi-music'] if a.cmi_music else []
    if a.game:
        extra += ['--game', a.game]
    remember_lang(cfg, a.lang)
    run_build(cfg, extra)
    if not a.game:
        cfg['ltp_built'] = True
        cfg_save(cfg)
    say('Rebuilt.')


# ------------------------------------------------------------------ the optional voice packs
PACK_PREFIXES = ('License-to-Pillage-Voice-', 'License-to-Pillage-Guybrush-Voice')     # (the second: 0.1.0's name)


def find_pack(path=None):
    """A voice pack zip/folder: the one given, or one in this folder or next to it."""
    if path:
        return os.path.abspath(os.path.expanduser(path))
    for d in (ROOT, os.path.dirname(ROOT)):
        try:
            names = sorted(os.listdir(d), reverse=True)
        except OSError:
            continue
        for n in names:
            if '-Voice-Browser-' in n or '-Web-' in n:
                continue        # the browser's pack: dropped on the page, not installed here
            if n.startswith(PACK_PREFIXES) and (n.endswith('.zip') or os.path.isfile(os.path.join(d, n, 'pack.json'))):
                return os.path.join(d, n)
    return None


def _pack_files(pack):
    """{relative path: bytes loader} of a pack zip or folder, only the kinds of files a pack may contain."""
    import zipfile

    def ok(rel):
        rel = rel.replace('\\', '/')
        return (rel == 'pack.json' or (rel.startswith('game/voice/') and rel.endswith('.mp3'))
                or (rel.startswith('scumm/audio_cache/') and rel.endswith('.pcmz'))) and '..' not in rel.split('/')
    out = {}
    if pack.endswith('.zip'):
        z = zipfile.ZipFile(pack)
        for info in z.infolist():
            parts = info.filename.split('/', 1)
            rel = parts[1] if len(parts) == 2 and parts[0].startswith(PACK_PREFIXES) else info.filename
            if not info.is_dir() and ok(rel):
                out[rel] = (lambda i=info: z.read(i))
    else:
        for dp, _, fns in os.walk(pack):
            for f in fns:
                rel = os.path.relpath(os.path.join(dp, f), pack).replace(os.sep, '/')
                if ok(rel):
                    out[rel] = (lambda p=os.path.join(dp, f): open(p, 'rb').read())
    return out


def voice_pack_install(path, log=say):
    pack = find_pack(path)
    if not pack or not os.path.exists(pack):
        fail('no voice pack found: python3 setup.py voice-pack "<License-to-Pillage-Voice-Complete-....zip>"')
    files = _pack_files(pack)
    if 'pack.json' not in files:
        fail(f'{pack} is not a License to Pillage voice pack (no pack.json)')
    meta = json.loads(files.pop('pack.json')().decode('utf-8'))
    entries = meta.get('entries') or {}
    if not any(r.startswith('scumm/audio_cache/') for r in files) and not shutil.which('ffmpeg'):
        fail(f'{os.path.basename(pack)} is the browser pack: drop it onto the game page in your browser. For this '
             'installation (the ScummVM version too) use License-to-Pillage-Voice-Complete-<version>.zip.')
    vj = os.path.join(ROOT, 'game', 'voice.json')
    base = os.path.join(ROOT, 'game', 'voice.base.json')
    if not os.path.isfile(base):                    # the download's own voice map, kept for --remove
        shutil.copyfile(vj, base)
    n = 0
    for rel, read in files.items():
        dst = os.path.join(ROOT, *rel.split('/'))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'wb') as f:
            f.write(read())
        n += 1
    vm = json.load(open(base, encoding='utf-8'))
    vm.update({k: v for k, v in entries.items() if os.path.isfile(os.path.join(ROOT, 'game', v))})
    with open(vj + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(vm, f, indent=0, ensure_ascii=False)
    os.replace(vj + '.tmp', vj)
    cfg = cfg_load()
    cfg['voice_pack'] = {'version': meta.get('version'), 'lines': len(entries), 'from': os.path.basename(pack)}
    cfg_save(cfg)
    log(f'  voice pack {meta.get("version")}: {len(entries)} lines of {meta.get("speaker", "?")} ({n} files)')
    return cfg


def voice_pack_remove(log=say):
    vj = os.path.join(ROOT, 'game', 'voice.json')
    base = os.path.join(ROOT, 'game', 'voice.base.json')
    cfg = cfg_load()
    if not os.path.isfile(base) and not cfg.get('voice_pack'):
        log('  no voice pack installed')
        return cfg
    stamp = time.strftime('%Y%m%d-%H%M%S')
    dst = os.path.join(ROOT, '.trash', f'voice-pack-{stamp}')
    os.makedirs(dst, exist_ok=True)
    pv = os.path.join(ROOT, 'game', 'voice', 'guybrush')
    if os.path.isdir(pv):
        os.rename(pv, os.path.join(dst, 'guybrush'))     # moved, never deleted
    if os.path.isfile(base):
        os.replace(base, vj)
    cfg.pop('voice_pack', None)
    cfg_save(cfg)
    log(f'  voice pack removed (its files are in {os.path.relpath(dst, ROOT)}; delete that folder to free the space)')
    return cfg


def cmd_voice_pack(a, argv):
    ensure_deps(argv)
    step('Guybrush voice pack')
    cfg = voice_pack_remove() if a.remove else voice_pack_install(a.path)
    if cfg.get('ltp_built'):
        step('Rebuilding the ScummVM version')
        run_build(cfg)
    say('Done. In the browser, reload the page.')
    pause_if_double_clicked()


def cmd_status(a, argv):
    cfg = cfg_load()
    say(json.dumps(cfg, indent=1) if cfg else 'not installed (python3 setup.py install)')
    for rel in ('cmi/fonts/font1.json', 'cmi/actors/guybrush/actor.json', 'game/actors/guybrush/actor.json',
                'scumm/game/COMI.LA3', 'scumm/play/scummvm.ini'):
        say(f'  {"ok     " if os.path.exists(os.path.join(ROOT, rel)) else "missing"}  {rel}')
    say(f'  node (editor saves): {shutil.which("node") or "not found"}')
    say(f'  ffmpeg (new audio in the editor): {shutil.which("ffmpeg") or "not found"}')


def cmd_uninstall(a, argv):
    stamp = time.strftime('%Y%m%d-%H%M%S')
    dst = os.path.join(ROOT, '.trash', f'uninstall-{stamp}')
    moved = []
    if os.path.isfile(os.path.join(ROOT, 'game', 'voice.base.json')):
        voice_pack_remove()
    for rel in ('cmi', '.byog', 'scumm/game', 'scumm/build', 'game/actors/guybrush', 'install.json',
                'scumm/play') + (('.venv', 'scumm/saves') if a.all else ()):
        p = os.path.join(ROOT, rel)
        if os.path.lexists(p):
            os.makedirs(os.path.dirname(os.path.join(dst, rel)), exist_ok=True)
            os.rename(p, os.path.join(dst, rel))
            moved.append(rel)
    say(f'Moved to {dst}: {", ".join(moved) or "nothing"}' + ('' if a.all else ' (saves and .venv kept: --all moves them too)'))
    say('Delete that folder to free the space. Your CMI installation was never changed.')


def main():
    argv = sys.argv[1:]
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__.split('\n', 2)[2])
    sub = ap.add_subparsers(dest='cmd')
    i = sub.add_parser('install', help='set up everything from your own CMI copy')
    i.add_argument('--cmi', action='append', help='your CMI game folder (COMI.LA0 ... and RESOURCE/), or CD images: '
                   '--cmi CD1.iso --cmi CD2.iso (or a folder with them)')
    i.add_argument('--scummvm', help='the ScummVM program to use')
    i.add_argument('--no-scummvm', action='store_true', help="don't build the ScummVM version now")
    i.add_argument('--yes', action='store_true', help='never ask')
    i.add_argument('--lang', choices=LANGS, help='text language of the ScummVM version (en de fr es it; voices stay English)')
    for name in ('web', 'editor'):
        w = sub.add_parser(name)
        w.add_argument('--port', type=int, default=8765)
        w.add_argument('--no-browser', action='store_true')
    s = sub.add_parser('scummvm')
    s.add_argument('--scummvm', help='this ScummVM program instead of the one found at install')
    r = sub.add_parser('rebuild')
    r.add_argument('--cmi-music', action='store_true', help="CMI's own music instead of the chapter's")
    r.add_argument('--game', help='a level-editor project (games/KEY) instead of License to Pillage')
    r.add_argument('--lang', choices=LANGS, help='text language (en de fr es it; voices stay English), remembered')
    h = sub.add_parser('hd', help='the optional HD pack: sharper Guybrush and interface in the browser (or --remove)')
    h.add_argument('path', nargs='?', help='the HD pack zip (default: one in or next to this folder)')
    h.add_argument('--remove', action='store_true')
    v = sub.add_parser('voice-pack', help="add (or --remove) the optional Guybrush voice pack")
    v.add_argument('path', nargs='?', help='the voice pack zip (default: one in or next to this folder)')
    v.add_argument('--remove', action='store_true')
    sub.add_parser('status')
    u = sub.add_parser('uninstall')
    u.add_argument('--all', action='store_true', help='also the saves and the Python packages (.venv)')
    a = ap.parse_args()
    if not a.cmd:
        ap.print_help()
        return
    {'install': cmd_install, 'web': cmd_web, 'scummvm': cmd_scummvm, 'rebuild': cmd_rebuild, 'status': cmd_status,
     'voice-pack': cmd_voice_pack,
     'uninstall': cmd_uninstall, 'hd': cmd_hd, 'editor': lambda a, argv: cmd_web(a, argv, edit=True)}[a.cmd](a, argv)


if __name__ == '__main__':
    main()
