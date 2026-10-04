#!/usr/bin/env python3
"""The installer's extraction for the browser version: engine/byog/worker.js runs this in Pyodide (Python in
WebAssembly) on the files the player drops on the page. Nothing is uploaded anywhere: the files are read in place
(mounted read-only), the results are kept by the browser (engine/byog/byog.js).

  find(root)            what was dropped: a game folder (Steam/GOG/copied CDs), loose game files, or CD images
                        (.iso and raw .bin/.img dumps, read in place: every game file a byte range of its image)
  run(plan, out, ...)   the same pieces as `setup.py install` makes for the web version: cmi/ (interface, fonts,
                        original-resolution set, Guybrush) and the game's own extras (game/actors/guybrush, CMI's
                        two voice clips)

The browser needs fewer of the game's files than the ScummVM version (no music bundles, no movies).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
for _p in (HERE, TOOLS, os.path.join(TOOLS, 'scumm')):
    if _p not in sys.path:
        sys.path.insert(0, _p)
import gamedir   # noqa: E402
import iso9660   # noqa: E402

NEEDED = ['COMI.LA0', 'COMI.LA1', 'COMI.LA2', 'RESOURCE/VOXDISK1.BUN', 'RESOURCE/VOXDISK2.BUN'] + \
         [f'RESOURCE/FONT{i}.NUT' for i in range(5)]
STEPS = [('ui', 'The interface…', 26), ('fonts', 'The fonts…', 34), ('glint', 'The verb coin…', 38),
         ('lo', 'The original-resolution set…', 40), ('guybrush', 'Guybrush…', 42)]


class PlayerError(Exception):
    """A message for the player (shown as is)."""


def wanted(rel):
    """A dropped file the extraction may read (everything else is not even looked at)."""
    name = rel.replace('\\', '/').split('/')[-1].upper()
    return name.startswith('COMI.LA') or name.endswith(('.BUN', '.NUT', '.TAB')) or iso9660.is_image_name(name)


def find(root):
    images, folders, loose = [], [], {}
    for dp, dns, fns in os.walk(root):
        dns.sort()
        if gamedir.looks_like(dp):
            folders.append(dp)
        for f in sorted(fns):
            p = os.path.join(dp, f)
            up = f.upper()
            if iso9660.is_image(p):
                images.append(p)
            elif up.startswith('COMI.LA'):
                loose.setdefault(up, p)
            elif up.endswith(('.NUT', '.BUN', '.TAB')):
                loose.setdefault('RESOURCE/' + up, p)
    # a complete folder wins; else everything found anywhere, merged (both CDs copied into two folders, ...)
    for f in folders:
        if not missing(f):
            return {'kind': 'folder', 'folder': f}
    if images:
        tables, problems = {}, []
        for img in images:
            try:
                iso = iso9660.Iso(img)
            except iso9660.IsoError as e:
                problems.append(str(e))
                continue
            files = iso9660.game_files(iso)
            if files:
                tables[img] = {'raw': [iso.raw, iso.data_off] if iso.raw else None,
                               'files': {n: [ext, size] for n, (ext, size) in files.items()}}
        if tables:
            return {'kind': 'images', 'tables': tables, 'sector': iso9660.SECTOR}
        raise PlayerError('These CD images have no Curse of Monkey Island game files' +
                          (f' ({"; ".join(problems)})' if problems else '') + '.')
    if loose:
        return {'kind': 'loose', 'files': loose}
    raise PlayerError('No Curse of Monkey Island files found. Drop the game folder, both CD images (.iso, .bin), '
                      'or COMI.LA0, COMI.LA1, COMI.LA2 with the files of the RESOURCE folder.')


def missing(folder):
    return [rel for rel in NEEDED if not gamedir.ci_path(folder, rel)]


def make_view(plan, view, cd='/cd'):
    """A folder with the names the readers use (links to the dropped files, or to the CD images' files that
    worker.js mounted at `cd`)."""
    if plan['kind'] == 'folder':
        gamedir.make_view(plan['folder'], view)
    elif plan['kind'] == 'images':
        gamedir.make_view(cd, view)
    else:
        os.makedirs(os.path.join(view, 'RESOURCE'), exist_ok=True)
        for name, p in plan['files'].items():
            os.symlink(p, os.path.join(view, *name.split('/')))
    gone = missing(view)
    if gone:
        cds = plan['kind'] == 'images' or any(n.startswith('COMI.LA') for n in gone)
        raise PlayerError('Missing ' + ', '.join(g.split('/')[-1] for g in gone) +
                          ('. The game is on two CDs: drop both at once.' if cds else '.'))
    return view


def run(plan, out, game_dir='game', report=print, view='/view', cd='/cd'):
    """cmi/ into out/cmi; for License to Pillage (game_dir 'game') also its extras into out/game. Inputs the extras
    read (extras.json, feather.png, voice.json, ...) have to be in out/game already."""
    import extract
    import ltp_extras
    ltp_extras.SYMLINKS = True
    make_view(plan, view, cd)
    chk = gamedir.check(view)
    report('Your game: ' + (chk['version'] or 'an unknown version (trying anyway)'), 20)
    ex = extract.Extractor(view, os.path.join(out, 'cmi'), log=lambda m: None)
    for step, msg, pct in STEPS:
        report(msg, pct)
        if step == 'guybrush':
            ex.progress = lambda i, n: report(f'Guybrush… {i}/{n}', 42 + int(38 * i / max(n, 1))) if i % 40 == 0 else None
        ex.run([step])
    if game_dir == 'game':
        report('Guybrush\'s poses and the feather tickle…', 82)
        clips = ltp_extras.install(view, out, log=lambda m: report(m, None))
    report('Done', 95)
    res = {'version': chk['version'], 'md5': chk['md5']}
    if game_dir == 'game' and clips:
        res['clips'] = clips          # for worker.js: CMI's clips, decoded by tools/bun_extract.py in its own Python
        res['voxdisks'] = [os.path.realpath(os.path.join(view, 'RESOURCE', d)) for d in ('VOXDISK1.BUN', 'VOXDISK2.BUN')]
    return res
