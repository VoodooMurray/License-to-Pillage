#!/usr/bin/env python3
"""Builds the toolkit's cmi/ folder from the player's own copy of The Curse of Monkey Island (nothing of CMI is
shipped with the mod; this runs on the player's machine and reads the game files read-only).

  cmi/ui/*.png, coin_glint.*   verb coin, cursors, exit arrows, chest, page/dialogue arrows (4x for the HD view)
  cmi/fonts/fontN.png/.json    CMI's five fonts as 4x atlases
  cmi/lo/{ui,fonts,palette.json}  the same at the original resolution (each pixel 4x4: the Alt+0 "original" view)
  cmi/actors/guybrush/         Guybrush (costume 2): actor.json + 4x cels, for the web engine and the editor

The 4x HD images are made with upscale.scale4x (pixel-art aware) or Lanczos for the painted chest; a private HD
pack can replace them (--hd DIR with the same layout as the developer's: costumes/cNNNN/..., rooms/r003/...).

  python3 tools/byog/extract.py --game <CMI folder> [--out cmi] [steps: ui fonts glint lo guybrush]
  python3 tools/byog/extract.py --game <CMI folder> --check-lo <existing cmi/lo>   # compare with another extraction
"""
import argparse
import json
import os
import shutil
import sys
import time

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, TOOLS)
import decoders as dec          # noqa: E402
import upscale                  # noqa: E402
import gamedir                  # noqa: E402

ROOT = os.path.dirname(TOOLS)
COIN_CELS = {'coin_idle.png': 63, 'coin_hand.png': 64, 'coin_fist.png': 65, 'coin_skull.png': 66, 'coin_parrot.png': 67}
UI_OBJECTS = {'chest.png': (114, 1), 'inv_next.png': (115, 1), 'inv_prev.png': (116, 1), 'dlg_up.png': (188, 1),
              'dlg_down.png': (189, 1), 'cursor.png': (105, 1), 'cursor_hot.png': (105, 2), 'cursor_wait.png': (257, 1)}
for _d, _n in {'W': 106, 'E': 107, 'N': 108, 'S': 109, 'NW': 110, 'NE': 111, 'SE': 112, 'SW': 113}.items():
    UI_OBJECTS[f'arrow_{_d}.png'] = (_n, 1)
    UI_OBJECTS[f'arrow_{_d}_hot.png'] = (_n, 2)
PAINTED = {'chest.png'}          # painted art: Lanczos instead of the pixel-art scaler in the HD view
FONTS = range(5)
SOURCE_NOTE = "extracted from the player's own CMI files by tools/byog (not distributed)"


def webp_ok():
    """Pillow can write WebP (not every build can, e.g. some WebAssembly ones): else cels are PNG."""
    try:
        from PIL import features
        return bool(features.check('webp'))
    except Exception:  # noqa: BLE001
        return False


CEL_EXT = 'webp' if webp_ok() else 'png'


def save_png(a, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(np.ascontiguousarray(a)).save(path, optimize=False, compress_level=6)


def hd_of(a, painted=False):
    return upscale.hd4x(a, painted)     # Scale4x, or the optional HD pack's model (upscale.MODEL)


class Extractor:
    def __init__(self, game_folder, out, log=print):
        self.view = game_folder
        self.out = os.path.abspath(out)
        self.g = dec.Game(game_folder)
        self.log = log
        self.progress = None            # progress(i, n) while the costume cels are made (the browser's bar)
        self._pal = None
        self._coin = None

    @property
    def pal(self):
        if self._pal is None:
            self._pal = dec.room_palette(self.g, dec.ROOM_PAL)
        return self._pal

    @property
    def coin(self):
        if self._coin is None:
            self._coin = dec.Costume(self.g, 1)
        return self._coin

    # ------------------------------------------------------------ interface
    def ui_images(self):
        """{name: 1x RGBA} for every interface image the engine uses (+ coin_hand and the _hot arrows, as before)."""
        bomps = dec.room_bomps(self.g, dec.ROOM_UI)
        out = {}
        for name, (obj, st) in UI_OBJECTS.items():
            if (obj, st) not in bomps:
                raise RuntimeError(f'room 3 object {obj} state {st} not found: not the CMI interface we know')
            out[name] = dec.indexed_rgba(bomps[(obj, st)], self.pal)
        for name, cel in COIN_CELS.items():
            out[name] = self.coin.cel(cel)
        return out

    def ui(self):
        ims = self.ui_images()
        meta_hd, meta_lo = {}, {}
        for name, a in ims.items():
            save_png(hd_of(a, name in PAINTED), os.path.join(self.out, 'ui', name))
            save_png(upscale.nearest4x(a), os.path.join(self.out, 'lo', 'ui', name))
            meta_hd[name] = meta_lo[name] = {'w': a.shape[1], 'h': a.shape[0]}
        for d, meta in ((os.path.join(self.out, 'ui'), meta_hd), (os.path.join(self.out, 'lo', 'ui'), meta_lo)):
            with open(os.path.join(d, 'ui.json'), 'w') as f:
                json.dump(meta, f, indent=1)
        self.log(f'ui: {len(ims)} images')

    # ------------------------------------------------------------ fonts
    def font(self, n):
        glyphs, height = dec.nut_glyphs(self.g.resource(f'FONT{n}.NUT'))
        for lo in (False, True):
            W, x, y, rowh, placed = 2048, 0, 0, 0, []
            for code, (w, h, rgba) in enumerate(glyphs):
                big = upscale.nearest4x(rgba) if lo else upscale.hd_glyph(rgba)
                gh, gw = big.shape[:2]
                if x + gw > W:
                    x, y, rowh = 0, y + rowh + 2, 0
                placed.append((code, big, w, x, y))
                x += gw + 2
                rowh = max(rowh, gh)
            atlas = np.zeros((y + rowh, W, 4), np.uint8)
            meta = {'height': height, 'scale': 4, 'glyphs': {}}
            for code, big, adv, gx, gy in placed:
                gh, gw = big.shape[:2]
                atlas[gy:gy + gh, gx:gx + gw] = big
                meta['glyphs'][str(code)] = [gx, gy, gw, gh, adv]
            d = os.path.join(self.out, 'lo', 'fonts') if lo else os.path.join(self.out, 'fonts')
            save_png(atlas, os.path.join(d, f'font{n}.png'))
            with open(os.path.join(d, f'font{n}.json'), 'w') as f:
                json.dump(meta, f)
        self.log(f'font{n}: {len(glyphs)} glyphs, height {height}')

    # ------------------------------------------------------------ verb coin sparkles
    def glint(self):
        import akos_extract as ax
        ak = self.coin.ak
        anims, _ = ax.extract_anims(ak)
        limb = next(lb for lb in anims['a06_S']['limbs'] if lb['limb'] == 1)
        if limb['op'] != 'set' or limb['loop_to'] != 0:
            raise RuntimeError('unexpected verb coin animation')
        cels = sorted({c['cel'] for f in limb['frames'] for c in f['cels']})
        for lo in (False, True):
            ims = {}
            for c in cels:
                ci = ak.cel_info(c)
                if ci['w'] * ci['h'] <= 1:
                    continue
                a = self.coin.cel(c)
                ims[c] = upscale.nearest4x(a) if lo else upscale.hd4x(a)
            W, x, y, rowh, pos = 1024, 0, 0, 0, {}
            for c in sorted(ims, key=lambda c: -ims[c].shape[0]):
                h, w = ims[c].shape[:2]
                if x + w > W:
                    x, y, rowh = 0, y + rowh + 2, 0
                pos[c] = (x, y)
                x += w + 2
                rowh = max(rowh, h)
            atlas = np.zeros((y + rowh, W, 4), np.uint8)
            for c, (px, py) in pos.items():
                h, w = ims[c].shape[:2]
                atlas[py:py + h, px:px + w] = ims[c]
            frames = []
            for f in limb['frames']:
                c = f['cels'][0]
                e = {'hold': f['hold']}
                if c['cel'] in ims:
                    h, w = ims[c['cel']].shape[:2]
                    e.update(r=[*pos[c['cel']], w, h], x=c['x'], y=c['y'], w=w // 4, h=h // 4)
                frames.append(e)
            d = os.path.join(self.out, 'lo', 'ui') if lo else os.path.join(self.out, 'ui')
            save_png(atlas, os.path.join(d, 'coin_glint.png'))
            with open(os.path.join(d, 'coin_glint.json'), 'w') as f:
                json.dump({'source': 'CMI costume 1 (verb coin), anim 6 limb 1', 'fps': 12, 'img': 'coin_glint.png',
                           'frames': frames}, f, separators=(',', ':'))
        self.log(f'glint: {len(frames)} frames')

    # ------------------------------------------------------------ palette (low-res views)
    def palette(self):
        try:                    # the SCUMM build's numbers (it is not available in the browser version)
            sys.path.insert(0, os.path.join(TOOLS, 'scumm'))
            import build
            art, talk = [build.ART_LO, build.ART_HI], build.TALK_COLORS
        except Exception:  # noqa: BLE001
            art, talk = [24, 226], {'murray': 14, 'agatha': 227, 'mort': 228, 'painter': 229, 'filbert': 230,
                                    'squid': 231, 'harbormaster': 232, '_narrator': 233}
        os.makedirs(os.path.join(self.out, 'lo'), exist_ok=True)
        with open(os.path.join(self.out, 'lo', 'palette.json'), 'w') as f:
            json.dump({'source': 'CMI room 9 APAL', 'art': art, 'talk': talk,
                       'rgb': [int(v) for v in self.pal.reshape(-1)]}, f, separators=(',', ':'))
        self.log('palette: room 9')

    # ------------------------------------------------------------ Guybrush
    def costume(self, number, out_dir, actor_id, webp=None):
        """A CMI costume as an engine actor folder (actor.json + 4x cels), like tools/akos_extract.py makes it
        from a private HD pack, but from the game files."""
        import akos_extract as ax
        cos = dec.Costume(self.g, number)
        ak = cos.ak
        anims, used = ax.extract_anims(ak)
        dirs = ak.dirnames
        talk_loops = ax.TALK_LOOPS if number == 2 else ax.COSTUME_TALK_LOOPS.get(number, {4: 'talk'})
        ax.derive_talk(anims, dirs, talk_loops)
        os.makedirs(os.path.join(out_dir, 'cels'), exist_ok=True)
        webp = CEL_EXT == 'webp' if webp is None else webp
        ext = 'webp' if webp else 'png'
        lo_cache, cels = {}, {}
        for i, c in enumerate(sorted(used)):
            if self.progress:
                self.progress(i, len(used))
            a = cos.cel(c)
            lo_cache[c] = Image.fromarray(np.ascontiguousarray(a))
            big = Image.fromarray(upscale.hd4x(a))
            dst = os.path.join(out_dir, 'cels', f'{c:04d}.{ext}')
            if webp and upscale.MODEL is not None:      # the HD pack's painted-looking cels: lossy is far smaller
                big.save(dst, 'WEBP', quality=90, alpha_quality=100, method=4)
            elif webp:
                big.save(dst, 'WEBP', lossless=True, method=4)
            else:
                big.save(dst)
            cels[str(c)] = {'file': f'cels/{c:04d}.{ext}', 'w': a.shape[1], 'h': a.shape[0]}
        stand = {d: [c['cel'] for c in anims[f'a03_{d}']['limbs'][0]['frames'][0]['cels']]
                 for d in dirs if f'a03_{d}' in anims and anims[f'a03_{d}']['limbs'][0]['op'] == 'set'}
        same_pose = [[d, e] for i, d in enumerate(dirs) for e in dirs[i + 1:] if d in stand and stand.get(d) == stand.get(e)]
        if number == 2:
            roles, views = ax.build_roles(anims, dirs, lambda c: lo_cache[c], same_pose)
        else:
            table = ax.ROLE_TABLES.get(number, {'init': 1, 'walk': 2, 'stand': 3, 'talk': 4, 'talk_stop': 5})
            roles, views = ax.simple_roles(anims, dirs, table, talk_loops, not ak.never_mirror), {}
        actor = {
            'id': actor_id, 'scale': 4, 'fps': 12,
            'source': f'CMI costume {number} ({ak.cels} cels, {ak.chores} chores, {ak.ndirs} dirs), {SOURCE_NOTE}'
                      + ('; HD: Real-ESRGAN x4plus_anime_6B' if upscale.MODEL is not None else ''),
            'dirs': dirs, 'dir_angles': {d: i * (360 // len(dirs)) for i, d in enumerate(dirs)},
            'same_pose': same_pose, 'limbs': ax.LIMB_NAMES.get(number, {}), 'cels': cels, 'anims': anims,
            'roles': roles, 'native_views': views, 'never_mirror': ak.never_mirror,
            'walk': {'speed_x': 13 * 12, 'speed_y': 4 * 12, 'step_per_frame': [13, 4], 'fps': 12},
        }
        with open(os.path.join(out_dir, 'actor.json'), 'w') as f:
            json.dump(actor, f, separators=(',', ':'))
        self.log(f'costume {number} -> {out_dir}: {len(anims)} anims, {len(cels)} cels, {len(roles)} roles')
        return actor

    def guybrush(self):
        return self.costume(2, os.path.join(self.out, 'actors', 'guybrush'), 'guybrush')

    def run(self, steps):
        t = time.time()
        if 'ui' in steps:
            self.ui()
        if 'fonts' in steps:
            for n in FONTS:
                self.font(n)
        if 'glint' in steps:
            self.glint()
        if 'lo' in steps or 'palette' in steps:
            self.palette()
        if 'guybrush' in steps:
            self.guybrush()
        with open(os.path.join(self.out, 'README.txt'), 'w') as f:
            f.write("This folder was made on this computer from your own copy of The Curse of Monkey Island\n"
                    "(tools/byog/extract.py).\n")
        self.log(f'done in {time.time() - t:.1f} s -> {self.out}')


def compare_lo(new, old):
    """Pixel comparison of two cmi/lo folders (a check against an earlier, independently made extraction)."""
    bad = 0
    for sub in ('ui', 'fonts'):
        for n in sorted(os.listdir(os.path.join(old, sub))):
            p_old, p_new = os.path.join(old, sub, n), os.path.join(new, sub, n)
            if not n.endswith('.png'):
                continue
            if not os.path.exists(p_new):
                print('missing', sub, n)
                bad += 1
                continue
            a = np.asarray(Image.open(p_old).convert('RGBA'))
            b = np.asarray(Image.open(p_new).convert('RGBA'))
            if a.shape != b.shape or (a != b).any():
                print('DIFF', sub, n, a.shape, b.shape)
                bad += 1
    for n in ('palette.json',):
        if json.load(open(os.path.join(old, n)))['rgb'] != json.load(open(os.path.join(new, n)))['rgb']:
            print('DIFF', n)
            bad += 1
    for n in range(5):
        if json.load(open(os.path.join(old, 'fonts', f'font{n}.json'))) != json.load(open(os.path.join(new, 'fonts', f'font{n}.json'))):
            print('DIFF font json', n)
            bad += 1
    print('compare:', 'identical' if not bad else f'{bad} differences')
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('steps', nargs='*', choices=['ui', 'fonts', 'glint', 'lo', 'guybrush'], help='default: all')
    ap.add_argument('--game', required=True, help='CMI data folder (COMI.LA0..2 + RESOURCE/), any case')
    ap.add_argument('--out', default=os.path.join(ROOT, 'cmi'))
    ap.add_argument('--check-lo', help='compare the new cmi/lo with this folder')
    a = ap.parse_args()
    chk = gamedir.check(a.game)
    if not chk['ok']:
        sys.exit(f'not a complete CMI folder: missing {", ".join(chk["missing"])}')
    view = os.path.join(ROOT, '.byog', 'game')     # links with the upper-case names the readers use
    gamedir.make_view(a.game, view)
    Extractor(view, a.out).run(a.steps or ['ui', 'fonts', 'glint', 'lo', 'guybrush'])
    if a.check_lo:
        sys.exit(1 if compare_lo(os.path.join(a.out, 'lo'), a.check_lo) else 0)


if __name__ == '__main__':
    main()
