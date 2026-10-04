#!/usr/bin/env python3
"""Where this copy of the toolkit finds the player's own things: their CMI installation, ScummVM, the extracted
CMI interface. Written by `setup.py install` (install.json at the top of the folder); without it (a developer's
checkout) every tool keeps its old defaults.

  install.json  {"version": 1, "cmi": "<their CMI folder>", "view": ".byog/game", "scummvm": "<binary>",
                 "scummvm_version": "2.9.1", "scummvm_all": [...], "ltp_built": true, ...}
"""
import json
import os
import re
import subprocess
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
CFG = os.path.join(ROOT, 'install.json')
TARGET = 'license-to-pillage'          # the ScummVM target of License to Pillage in scumm/play/scummvm.ini


def load():
    try:
        with open(CFG, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(cfg):
    tmp = CFG + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=1)
    os.replace(tmp, CFG)


def is_mod():
    return bool(load())


def cmi_view():
    """The normalized view of the player's CMI folder (links), if installed."""
    v = os.path.join(ROOT, '.byog', 'game')
    return v if os.path.isfile(os.path.join(v, 'COMI.LA0')) else None


def scummvm():
    return load().get('scummvm')


def build_args():
    """Extra tools/scumm/build.py arguments for this copy (the player's CMI, no HD theme, shipped audio)."""
    if not is_mod():
        return []
    args = ['--no-hd-theme']
    view = cmi_view()
    if view:
        args += ['--cmi', view]
    cache = os.path.join(ROOT, 'scumm', 'audio_cache')
    if os.path.isdir(cache):
        args += ['--audio-cache', cache]
    lang = (load() or {}).get('lang')
    if lang and lang != 'en':
        args += ['--lang', lang]          # the text language of the ScummVM version (setup.py --lang)
    return args


def scummvm_version(binary):
    """'2.0.0' / '2026.3.0' or None."""
    try:
        out = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r'ScummVM\s+(\d+(?:\.\d+)+)', out)
    return m.group(1) if m else None


def version_key(v):
    return tuple(int(x) for x in re.findall(r'\d+', v or '0'))


def scummvm_candidates():
    """ScummVM binaries on this machine: [(path, version)] newest first. Includes the one Steam/GOG ship with CMI."""
    home = os.path.expanduser('~')
    paths = []
    if sys.platform == 'darwin':
        paths += ['/Applications/ScummVM.app/Contents/MacOS/scummvm',
                  os.path.join(home, 'Applications', 'ScummVM.app', 'Contents', 'MacOS', 'scummvm'),
                  '/opt/homebrew/bin/scummvm', '/usr/local/bin/scummvm']
    elif sys.platform.startswith('win'):
        for env in ('ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'):
            if os.environ.get(env):
                paths += [os.path.join(os.environ[env], 'ScummVM', 'scummvm.exe'),
                          os.path.join(os.environ[env], 'Programs', 'ScummVM', 'scummvm.exe')]
    else:
        paths += ['/usr/bin/scummvm', '/usr/local/bin/scummvm', '/usr/games/scummvm', '/snap/bin/scummvm']
    import shutil
    w = shutil.which('scummvm')
    if w:
        paths.append(w)
    # the copy that came with the game (Steam / GOG put ScummVM next to the data)
    cfg = load()
    cmi = cfg.get('cmi')
    if cmi:
        d = os.path.abspath(cmi)
        for _ in range(3):
            for n in ('scummvm', 'scummvm.exe', 'ScummVM/scummvm', 'ScummVM/scummvm.exe'):
                paths.append(os.path.join(d, n))
            d = os.path.dirname(d)
    out, seen = [], set()
    for p in paths:
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            rp = os.path.realpath(p)
            if rp in seen:
                continue
            seen.add(rp)
            out.append((p, scummvm_version(p)))
    out.sort(key=lambda pv: version_key(pv[1]), reverse=True)
    return out


def ini_text(target, title, game_dir, saves, hd=None):
    """A private ScummVM config for one target (never the player's own ScummVM settings). hd: the HD fork's
    keys {path, theme_path, cache} or None for a stock ScummVM."""
    lines = ['[scummvm]', 'updates_check=0', 'confirm_exit=false', 'subtitles=true', 'speech_mute=false',
             'music_volume=192', 'sfx_volume=192', 'speech_volume=192', f'savepath={saves}',
             f'lastselectedgame={target}', '',
             f'[{target}]', f'description={title}', 'gameid=comi', 'engineid=scumm', 'platform=windows',
             'language=en', f'path={game_dir}', f'savepath={saves}', 'subtitles=true', 'object_labels=true',
             'original_gui_object_labels=1', 'guioptions=sndNoMIDI noAspect lang_English plat_windows']
    if hd:
        lines += ['hd_enabled=true', 'hd_scale=4', 'hd_theme=2', f'hd_path={hd["path"]}',
                  f'hd_theme_path={hd["theme_path"]}', f'hd_cache_path={hd["cache"]}']
    return '\n'.join(lines) + '\n'


def scummvm_processes():
    """Command lines of running ScummVMs ([] if none or unknown)."""
    try:
        if sys.platform.startswith('win'):
            out = subprocess.run(['wmic', 'process', 'where', "name='scummvm.exe'", 'get', 'CommandLine'],
                                 capture_output=True, text=True).stdout
            return [l.strip() for l in out.splitlines()[1:] if l.strip()]
        out = subprocess.run(['pgrep', '-fl', 'scummvm'], capture_output=True, text=True).stdout
        return [l.strip() for l in out.splitlines() if l.strip()]
    except OSError:
        return []


def scummvm_conflict(root=ROOT):
    """A running ScummVM that plays THIS copy's game (its command line names our folder or target), else ''.
    One started from ScummVM's own launcher can't be told apart: scummvm_processes() lists those."""
    for line in scummvm_processes():
        if root in line or TARGET in line or os.path.join(root, 'scumm') in line:
            return line
    return ''


def scummvm_running():
    """A running ScummVM (its command line), else ''."""
    try:
        if sys.platform.startswith('win'):
            out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq scummvm.exe', '/NH'], capture_output=True,
                                 text=True).stdout
            return out.strip() if 'scummvm' in out.lower() else ''
        out = subprocess.run(['pgrep', '-fl', 'scummvm'], capture_output=True, text=True).stdout.strip()
        return out.splitlines()[0] if out else ''
    except OSError:
        return ''
