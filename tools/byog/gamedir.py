#!/usr/bin/env python3
"""Finds and checks a Curse of Monkey Island installation (read-only) and gives the toolkit one normalized
view of it: a folder with the upper-case names the tools expect (COMI.LA0-2, RESOURCE/...), made of links to
the player's own files (symlinks, else hard links, else nothing is copied unless asked).

  python3 tools/byog/gamedir.py find                 # list the installations found on this machine
  python3 tools/byog/gamedir.py check <folder>       # what is there, which version, what is missing

A usable folder has COMI.LA0, COMI.LA1, COMI.LA2 and RESOURCE/ with VOXDISK1.BUN, VOXDISK2.BUN, MUSDISK1.BUN,
MUSDISK2.BUN, FONT0-4.NUT (names in any case; a CD copy has to be merged from both CDs into one folder, as
ScummVM wants it too).
"""
import hashlib
import json
import os
import sys

REQUIRED = ['COMI.LA0', 'COMI.LA1', 'COMI.LA2', 'RESOURCE/VOXDISK1.BUN', 'RESOURCE/VOXDISK2.BUN',
            'RESOURCE/MUSDISK1.BUN', 'RESOURCE/MUSDISK2.BUN'] + [f'RESOURCE/FONT{i}.NUT' for i in range(5)]
OPTIONAL = ['RESOURCE/LANGUAGE.TAB']

# MD5 of COMI.LA0 for versions we have seen (the data is the same on Steam, GOG and the CD for a language).
# Others still work if their resources have the same structure; build.py checks what it needs.
KNOWN = {
    'fe60d6b5ff51b0553ac59963123b5777': 'English (Windows CD / Steam / GOG)',
}


def ci_path(root, rel):
    """rel ('RESOURCE/FONT0.NUT') inside root, matched case-insensitively per path part; None if absent."""
    cur = root
    for part in rel.split('/'):
        if not os.path.isdir(cur):
            return None
        hit = os.path.join(cur, part)
        if not os.path.exists(hit):
            want = part.lower()
            hit = next((os.path.join(cur, n) for n in os.listdir(cur) if n.lower() == want), None)
            if hit is None:
                return None
        cur = hit
    return cur


def md5(path, limit=None):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        left = limit
        while True:
            chunk = f.read(1 << 20 if left is None else min(1 << 20, left))
            if not chunk:
                break
            h.update(chunk)
            if left is not None:
                left -= len(chunk)
                if left <= 0:
                    break
    return h.hexdigest()


def check(folder):
    """{ok, folder, files: {REL: actual path}, missing: [...], version, md5, notes: [...]}"""
    folder = os.path.abspath(os.path.expanduser(folder))
    res = {'ok': False, 'folder': folder, 'files': {}, 'missing': [], 'version': None, 'md5': None, 'notes': []}
    if not os.path.isdir(folder):
        res['notes'].append('not a folder')
        return res
    for rel in REQUIRED + OPTIONAL:
        p = ci_path(folder, rel)
        if p and os.path.isfile(p):
            res['files'][rel] = p
        elif rel in REQUIRED:
            res['missing'].append(rel)
    la0 = res['files'].get('COMI.LA0')
    if la0:
        res['md5'] = md5(la0)
        res['version'] = KNOWN.get(res['md5'])
        with open(la0, 'rb') as f:
            head = f.read(4)
        if head not in (b'RNAM', b'MAXS'):
            res['notes'].append(f'COMI.LA0 does not look like a CMI index (starts with {head!r})')
            res['missing'].append('COMI.LA0 (valid)')
        if not res['version']:
            res['notes'].append('unknown COMI.LA0 version (not the English Steam/GOG/CD data): it may still work')
    for rel in ('COMI.LA1', 'COMI.LA2'):
        p = res['files'].get(rel)
        if p and os.path.getsize(p) < 1_000_000:
            res['notes'].append(f'{rel} is very small ({os.path.getsize(p)} bytes): a demo or a broken copy?')
    res['ok'] = not res['missing']
    return res


def looks_like(folder):
    return bool(ci_path(folder, 'COMI.LA0')) and bool(ci_path(folder, 'RESOURCE'))


def steam_libraries():
    """Steam library folders (steamapps/ parents) on this machine, incl. extra libraries."""
    homes = []
    h = os.path.expanduser('~')
    if sys.platform == 'darwin':
        homes.append(os.path.join(h, 'Library', 'Application Support', 'Steam'))
    elif sys.platform.startswith('win'):
        for env in ('ProgramFiles(x86)', 'ProgramFiles'):
            if os.environ.get(env):
                homes.append(os.path.join(os.environ[env], 'Steam'))
    else:
        homes += [os.path.join(h, '.local', 'share', 'Steam'), os.path.join(h, '.steam', 'steam'),
                  os.path.join(h, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')]
    libs = []
    for home in homes:
        if os.path.isdir(os.path.join(home, 'steamapps')):
            libs.append(home)
        vdf = os.path.join(home, 'steamapps', 'libraryfolders.vdf')
        if os.path.isfile(vdf):
            try:
                for line in open(vdf, encoding='utf-8', errors='replace'):
                    line = line.strip()
                    if line.startswith('"path"'):
                        p = line.split('"')[3].replace('\\\\', '\\')
                        if os.path.isdir(os.path.join(p, 'steamapps')):
                            libs.append(p)
            except OSError:
                pass
    out = []
    for l in libs:
        if os.path.realpath(l) not in [os.path.realpath(x) for x in out]:
            out.append(l)
    return out


def _walk_for(folder, depth=4):
    """Folders below `folder` (max depth) that look like a CMI data folder."""
    found = []
    if not os.path.isdir(folder):
        return found
    if looks_like(folder):
        return [folder]
    if depth == 0:
        return found
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return found
    for n in names:
        p = os.path.join(folder, n)
        if os.path.isdir(p) and not n.startswith('.') and not os.path.islink(p):
            found += _walk_for(p, depth - 1)
    return found


def candidates():
    """Likely CMI data folders on this machine (Steam, GOG, common places)."""
    roots = []
    for lib in steam_libraries():
        roots.append(os.path.join(lib, 'steamapps', 'common', 'The Curse of Monkey Island'))
    h = os.path.expanduser('~')
    if sys.platform == 'darwin':
        roots += ['/Applications/The Curse of Monkey Island.app', os.path.join(h, 'Applications', 'The Curse of Monkey Island.app'),
                  os.path.join(h, 'GOG Games', 'The Curse of Monkey Island'), '/Applications/GOG Games/The Curse of Monkey Island']
    elif sys.platform.startswith('win'):
        for drive in ('C:\\', 'D:\\', 'E:\\'):
            roots += [os.path.join(drive, 'GOG Games', 'The Curse of Monkey Island'),
                      os.path.join(drive, 'Program Files (x86)', 'GOG Galaxy', 'Games', 'The Curse of Monkey Island'),
                      os.path.join(drive, 'Program Files', 'GOG Galaxy', 'Games', 'The Curse of Monkey Island'),
                      os.path.join(drive, 'Games', 'The Curse of Monkey Island')]
    else:
        roots += [os.path.join(h, 'GOG Games', 'The Curse of Monkey Island'),
                  os.path.join(h, 'Games', 'The Curse of Monkey Island')]
    found = []
    for r in roots:
        for f in _walk_for(r):
            if os.path.realpath(f) not in [os.path.realpath(x) for x in found]:
                found.append(f)
    return found


def aside(path):
    """Moves a file of ours out of the way into <toolkit>/.trash/ (nothing is ever deleted)."""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    d = os.path.join(root, '.trash', 'replaced')
    os.makedirs(d, exist_ok=True)
    os.replace(path, os.path.join(d, f'{os.path.basename(path)}_{os.getpid()}_{len(os.listdir(d))}'))


def make_view(folder, view):
    """view/ = links named like the tools expect (COMI.LA0 ... RESOURCE/<UPPER>) to the files in `folder`.
    Every file of RESOURCE/ is linked (the movies too: ScummVM plays them from the patched game folder).
    Returns the list of link names. Symlinks first, then hard links; never copies."""
    os.makedirs(os.path.join(view, 'RESOURCE'), exist_ok=True)
    made = []

    def link(src, dst):
        if os.path.lexists(dst):
            if os.path.realpath(dst) == os.path.realpath(src):
                return
            aside(dst)          # an old link of ours (the view folder only holds links): moved, never deleted
        try:
            os.symlink(src, dst)
        except (OSError, NotImplementedError):
            os.link(src, dst)
        made.append(dst)
    for rel in ('COMI.LA0', 'COMI.LA1', 'COMI.LA2'):
        p = ci_path(folder, rel)
        if p:
            link(p, os.path.join(view, rel))
    res = ci_path(folder, 'RESOURCE')
    if res:
        for n in sorted(os.listdir(res)):
            p = os.path.join(res, n)
            if os.path.isfile(p):
                link(p, os.path.join(view, 'RESOURCE', n.upper()))
    return made


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('find')
    c = sub.add_parser('check')
    c.add_argument('folder')
    a = ap.parse_args()
    if a.cmd == 'find':
        for f in candidates():
            r = check(f)
            print(json.dumps({'folder': f, 'ok': r['ok'], 'version': r['version'], 'missing': r['missing']}))
    else:
        print(json.dumps(check(a.folder), indent=1))


if __name__ == '__main__':
    main()
