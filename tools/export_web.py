#!/usr/bin/env python3
"""Exports a game as a standalone web folder: the engine + the game (as its game/ folder, so it starts without
?game=), nothing of the level editor. CMI's own data (interface, fonts, Guybrush: cmi/) is NOT included: whoever
plays it drops their own game on the page (the browser reads it and keeps the pieces: engine/byog/, sw.js), or makes
<export>/cmi with tools/byog/extract.py --game <CMI folder> --out <export>/cmi (--with-cmi copies yours, for personal
use). A standalone game (its own interface, fonts and hero) needs none of that and leaves the browser reader out.

  tools/export_web.py sandbox                 -> dist/sandbox/   (games/sandbox)
  tools/export_web.py --license               -> dist/license/   (License to Pillage, game/)
  tools/export_web.py sandbox --with-cmi --zip

Serve the folder over http (ES modules): python3 -m http.server -d dist/sandbox 8000 -> http://localhost:8000/
"""
import argparse
import json
import os
import re
import shutil
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(TOOLS)
sys.path.insert(0, TOOLS)
import projects  # noqa: E402

SKIP_DIRS = {'editor', '__pycache__', '.trash', 'node_modules', 'library'}   # library: the editor's shelf, not the game
SKIP_FILES = {'.DS_Store', 'lines.json'}


def copy_tree(src, dst, skip_dirs=SKIP_DIRS):
    n = 0
    for dp, dns, fns in os.walk(src):
        dns[:] = [d for d in dns if d not in skip_dirs and not d.startswith('.')]
        rel = os.path.relpath(dp, src)
        os.makedirs(os.path.join(dst, rel), exist_ok=True)
        for f in fns:
            if f in SKIP_FILES or f.startswith('.'):
                continue
            shutil.copy2(os.path.join(dp, f), os.path.join(dst, rel, f))
            n += 1
    return n


def reader_files():
    """The Python files the browser's reader loads (engine/byog/worker.js's own list)."""
    js = open(os.path.join(REPO, 'engine', 'byog', 'worker.js'), encoding='utf-8').read()
    m = re.search(r"const PY = \[([^\]]*)\]", js)
    return re.findall(r"'([^']+)'", m.group(1)) if m else []


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('key', nargs='?', help='project key (games/<key>)')
    ap.add_argument('--license', action='store_true', help='export License to Pillage (game/)')
    ap.add_argument('--out', help='output folder (default dist/<key>)')
    ap.add_argument('--with-cmi', action='store_true', help='include your cmi/ folder')
    ap.add_argument('--zip', action='store_true')
    ap.add_argument('--share', action='store_true', help='export for sharing: refuse anything CMI-derived or '
                    'CMI-dependent (the game must be fully standalone: own interface theme, fonts, player)')
    a = ap.parse_args()
    if not a.key and not a.license:
        ap.error('a project key or --license')
    key = None if a.license else a.key
    src = projects.project_dir(REPO, key)
    report = None
    if key:
        try:
            report = projects.standalone_report(REPO, key)
        except Exception as e:  # noqa: BLE001 - the report must not break a plain export
            if a.share:
                sys.exit(f'standalone report failed: {e}')
            report = None
    if a.share:
        if a.with_cmi:
            sys.exit('--share with --with-cmi: never — cmi/ is CMI data (nothing was written)')
        if not key or report is None:
            sys.exit('--share: License to Pillage is CMI-derived by nature (Guybrush, interface); share projects')
        if not report['standalone']:
            why = report['cmiReferences'] + [f"interface still CMI: {', '.join(report['themeMissing'][:6])}"
                                             + (' …' if len(report['themeMissing']) > 6 else '') if report['themeMissing'] else '']
            sys.exit('not standalone yet, nothing was written:\n  ' + '\n  '.join(x for x in why if x)
                     + '\n(the Game section: ✨ Make a set…, Load font…, an own main character)')
    name = key or 'license'
    out = os.path.abspath(a.out or os.path.join(REPO, 'dist', name))
    if os.path.exists(out):
        # never delete, and never move a folder that isn't our own earlier export (--out ~/Desktop must not vanish)
        looks_like_export = not os.listdir(out) or (os.path.isfile(os.path.join(out, 'index.html'))
                                                    and os.path.isdir(os.path.join(out, 'engine'))
                                                    and os.path.isdir(os.path.join(out, 'game')))
        if not looks_like_export:
            sys.exit(f'{out} exists and is not an earlier export: pick another --out (nothing was touched)')
        trash = os.path.join(REPO, '.trash', 'dist')
        os.makedirs(trash, exist_ok=True)
        os.rename(out, os.path.join(trash, f'{name}_{int(os.path.getmtime(out))}'))
    os.makedirs(out)
    standalone = bool(report and report['standalone'])
    # the browser's own reading of the player's game (drop screen, Pyodide, sw.js) only where CMI's pieces are needed
    files = copy_tree(os.path.join(REPO, 'engine'), os.path.join(out, 'engine'),
                      SKIP_DIRS | ({'pyodide'} if standalone else set()))
    if not standalone and os.path.isfile(os.path.join(REPO, 'sw.js')):
        for rel in ['sw.js'] + reader_files():
            if os.path.isfile(os.path.join(REPO, rel)):
                os.makedirs(os.path.dirname(os.path.join(out, rel)), exist_ok=True)
                shutil.copy2(os.path.join(REPO, rel), os.path.join(out, rel))
                files += 1
    files += copy_tree(src, os.path.join(out, 'game'))
    title = projects.title_of(open(os.path.join(src, 'game.js'), encoding='utf-8').read()) or name
    html = open(os.path.join(REPO, 'index.html'), encoding='utf-8').read()
    html = re.sub(r'<title>.*?</title>', f'<title>{title}</title>', html, count=1)
    with open(os.path.join(out, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(html)
    files += 1
    if a.with_cmi:
        files += copy_tree(os.path.join(REPO, 'cmi'), os.path.join(out, 'cmi'))
    # provenance: CMI-derived files INSIDE this export (references to the player's own cmi/ are fine by design)
    cmi_derived = []
    if a.with_cmi:
        cmi_derived.append('cmi/ (your CMI interface, fonts, Guybrush)')
    gb = os.path.join(out, 'game', 'actors', 'guybrush')
    if os.path.isdir(gb):
        cmi_derived.append("game/actors/guybrush/ (Guybrush's animations come from your CMI)")
    with open(os.path.join(out, 'README.txt'), 'w') as f:
        needs = ('' if standalone else """
Needs your own copy of The Curse of Monkey Island for the interface, fonts and Guybrush: the page asks for it (drop
both CD images or the game folder on it; your browser reads it there and keeps the pieces it needs).
""") + ('(This export already contains a cmi/ folder.)\n' if a.with_cmi else '')
        f.write(f"""{title}
A point-and-click adventure made with the cmi-levels engine.
{'Fully standalone: its interface, fonts and characters are its own.' if standalone else needs.strip()}
Play: serve this folder over http, e.g.  python3 -m http.server 8000  then open http://localhost:8000/
""")
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fns in os.walk(out) for f in fns)
    print(json.dumps({'out': out, 'files': files, 'mb': round(size / 2**20, 1), 'cmi': a.with_cmi,
                      'cmiDerived': cmi_derived, 'shareable': not cmi_derived,
                      'standalone': report and report['standalone'],
                      'cmiReferences': (report or {}).get('cmiReferences'),
                      'themeMissing': (report or {}).get('themeMissing'),
                      'origins': (report or {}).get('origins'), 'unverified': len((report or {}).get('unverified') or [])}))
    if a.zip:
        z = shutil.make_archive(out, 'zip', out)
        print('zip:', z)


if __name__ == '__main__':
    main()
