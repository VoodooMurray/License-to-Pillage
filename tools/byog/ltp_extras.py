#!/usr/bin/env python3
"""License to Pillage's own pieces that need the player's CMI (installer step 3, after extract.py):

  game/actors/guybrush/   Guybrush for the chapter = the player's costume 2 (cmi/actors/guybrush) + the chapter's
                          extra poses, made here from his own frames:
                            pose_E       his stand frame + Filbert on his shoulder + an eye patch (our overlay)
                            pose_sour_E  the same with his own gritted-teeth head (the lime scowl)
                          described by game/actors/guybrush_extras/extras.json (+ the overlay PNGs, our own art)
  cmi/voice/<TAG>.wav     CMI's own Guybrush clips the chapter reuses ("Youch!", "Pappapisshu!"): the web version
                          plays them from here; the ScummVM version plays them from the game's own bundles

  python3 tools/byog/ltp_extras.py --game <CMI view folder> [--root <toolkit folder>]
"""
import argparse
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, TOOLS)
import gamedir  # noqa: E402
S = 4
from extract import CEL_EXT  # noqa: E402
SAVE = {'format': 'WEBP', 'lossless': True, 'method': 4} if CEL_EXT == 'webp' else {'format': 'PNG'}


SYMLINKS = False        # the browser version (browser.py): symlinks, the page keeps one copy and serves both names


def link_or_copy(src, dst):
    if os.path.lexists(dst):
        if os.path.exists(dst) and os.path.samefile(src, dst):
            return
        gamedir.aside(dst)      # an earlier install's file: moved to .trash, never deleted
    if SYMLINKS:
        os.symlink(src, dst)
        return
    try:
        os.link(src, dst)
    except (OSError, AttributeError):
        shutil.copyfile(src, dst)


def cel_image(base_dir, actor, cel):
    return Image.open(os.path.join(base_dir, actor['cels'][str(cel)]['file'])).convert('RGBA')


def compose(base_dir, actor, parts, overlays, extras_dir):
    """parts: [(cel, x, y)] in draw order, overlays: [(png, x, y)] (logical px relative to the feet) ->
    (RGBA 4x image, x, y of its top-left)."""
    layers = [(cel_image(base_dir, actor, c), x, y) for c, x, y in parts]
    layers += [(Image.open(os.path.join(extras_dir, f)).convert('RGBA'), x, y) for f, x, y in overlays]
    x0 = min(x for _, x, _ in layers)
    y0 = min(y for _, _, y in layers)
    x1 = max(x + im.width / S for im, x, _ in layers)
    y1 = max(y + im.height / S for im, _, y in layers)
    # whole logical pixels: the cel's offset stays an integer like CMI's own cels
    x0, y0 = int(np.floor(x0)), int(np.floor(y0))
    W, H = int(np.ceil((x1 - x0) * S)), int(np.ceil((y1 - y0) * S))
    can = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    for im, x, y in layers:
        can.alpha_composite(im, (int(round((x - x0) * S)), int(round((y - y0) * S))))
    return can, x0, y0


def guybrush(root, log=print):
    base = os.path.join(root, 'cmi', 'actors', 'guybrush')
    extras_dir = os.path.join(root, 'game', 'actors', 'guybrush_extras')
    dst = os.path.join(root, 'game', 'actors', 'guybrush')
    actor = json.load(open(os.path.join(base, 'actor.json')))
    os.makedirs(os.path.join(dst, 'cels'), exist_ok=True)
    for c, info in actor['cels'].items():
        link_or_copy(os.path.join(base, info['file']), os.path.join(dst, info['file']))
    spec_path = os.path.join(extras_dir, 'extras.json')
    spec = json.load(open(spec_path)) if os.path.isfile(spec_path) else {'cels': [], 'anims': {}, 'roles': {}}
    made = []
    for c in spec.get('cels', []):
        need = [p[0] for p in c['parts']]
        if any(str(n) not in actor['cels'] for n in need):
            log(f"  skipped cel {c['cel']}: your Guybrush costume has no cel {need} (another game version?)")
            continue
        im, x, y = compose(base, actor, c['parts'], c.get('overlays', []), extras_dir)
        fn = f"cels/{c['name']}.{CEL_EXT}"
        im.save(os.path.join(dst, fn), **SAVE)
        actor['cels'][str(c['cel'])] = {'file': fn, 'w': im.width / S, 'h': im.height / S}
        for anim in spec['anims'].values():
            for limb in anim['limbs']:
                for fr in limb.get('frames', []):
                    for cc in fr['cels']:
                        if cc['cel'] == c['cel']:
                            cc['x'], cc['y'] = x, y
        made.append(c['name'])
    for name, anim in spec.get('anims', {}).items():
        cels = [cc['cel'] for l in anim['limbs'] for fr in l.get('frames', []) for cc in fr['cels']]
        if all(str(n) in actor['cels'] for n in cels):
            actor['anims'][name] = anim
    for role, table in spec.get('roles', {}).items():
        if all(v in actor['anims'] for v in table.values()):
            actor['roles'][role] = table
    actor['source'] += '; + License to Pillage poses (tools/byog/ltp_extras.py)'
    with open(os.path.join(dst, 'actor.json'), 'w') as f:
        json.dump(actor, f, separators=(',', ':'))
    log(f'guybrush -> game/actors/guybrush: {len(actor["cels"])} cels, extra poses: {", ".join(made) or "none"}')


# ---------------------------------------------------------------- the license portrait (painted by the painter)
def kuwahara(img, r):
    """Kuwahara filter (flat, painterly regions with kept edges) on an RGB image."""
    a = np.asarray(img).astype(np.float32)
    H, W, _ = a.shape
    pad = np.pad(a, ((r, r), (r, r), (0, 0)), mode='edge')
    S1 = np.cumsum(np.cumsum(np.pad(pad, ((1, 0), (1, 0), (0, 0))), 0), 1)
    S2 = np.cumsum(np.cumsum(np.pad(pad ** 2, ((1, 0), (1, 0), (0, 0))), 0), 1)
    ys, xs = np.mgrid[0:H, 0:W]
    n = (r + 1) ** 2
    best = bv = None
    for dy, dx in ((0, 0), (0, r), (r, 0), (r, r)):
        y0, x0 = ys + dy, xs + dx
        y1, x1 = y0 + r + 1, x0 + r + 1
        s1 = S1[y1, x1] - S1[y0, x1] - S1[y1, x0] + S1[y0, x0]
        s2 = S2[y1, x1] - S2[y0, x1] - S2[y1, x0] + S2[y0, x0]
        m = s1 / n
        v = (s2 / n - m * m).sum(-1)
        if best is None:
            best, bv = m, v
        else:
            sel = v < bv
            best[sel] = m[sel]
            bv[sel] = v[sel]
    return Image.fromarray(np.clip(best, 0, 255).astype(np.uint8))


def painting(figure, w, h, bg=(52, 38, 28)):
    """The posing Guybrush (RGBA, 4x art) as an oil painting of w x h px: head and shoulders, painterly."""
    from PIL import ImageEnhance, ImageFilter
    fw, fh = figure.size
    crop = figure.crop((0, 0, fw, int(fh * 0.40)))
    small = crop.resize((max(1, crop.width // 4), max(1, crop.height // 4)), Image.BOX)        # the 1x look
    k = h * 0.96 / small.height
    big = small.resize((max(1, round(small.width * k)), max(1, round(small.height * k))), Image.BICUBIC)
    rng = np.random.default_rng(7)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    glow = np.clip(1.25 - np.hypot((xx - w * 0.55) / (w * 0.8), (yy - h * 0.35) / (h * 0.9)), 0.45, 1.0)
    base = (np.array(bg, np.float32)[None, None, :] * glow[..., None] * 1.25).clip(0, 255)
    canvas = Image.fromarray(base.astype(np.uint8))
    canvas.paste(big, ((w - big.width) // 2 + int(w * 0.03), h - big.height), big)
    p = kuwahara(canvas, max(3, w // 120))
    p = kuwahara(p, max(2, w // 220))
    p = p.filter(ImageFilter.UnsharpMask(radius=3, percent=70, threshold=2))

    def noise(sy, sx):
        n = rng.normal(0, 1, (max(2, h // sy), max(2, w // sx)))
        n = ((n - n.min()) / max(1e-6, np.ptp(n)) * 255).astype(np.uint8)
        return np.asarray(Image.fromarray(n).resize((w, h), Image.BICUBIC)).astype(np.float32) / 255 - 0.5
    arr = np.asarray(p).astype(np.float32)
    arr *= (1 + 0.08 * noise(6, 2) + 0.05 * noise(3, 3))[..., None]        # brush strokes + canvas weave
    vig = np.clip(1.15 - np.hypot((xx - w / 2) / (w * 0.75), (yy - h * 0.45) / (h * 0.8)), 0.55, 1)
    arr *= vig[..., None]
    arr[..., 0] *= 1.04
    arr[..., 2] *= 0.88                                                       # old varnish
    return ImageEnhance.Contrast(Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))).enhance(1.05)


def portrait(root, log=print):
    """game/art/portrait_reveal.jpg (the card) and game/items/portrait.png (the item icon): the painter's portrait
    of Guybrush posing with Filbert, eye patch and the lime scowl, from his own frames, in our gilded frame."""
    game = os.path.join(root, 'game')
    frame_p = os.path.join(game, 'art', 'portrait_frame.jpg')
    spec_p = os.path.join(game, 'art', 'portrait_frame.json')
    actor = json.load(open(os.path.join(game, 'actors', 'guybrush', 'actor.json')))
    cel = actor['cels'].get('9001') or actor['cels'].get('9000')
    if not (os.path.isfile(frame_p) and os.path.isfile(spec_p) and cel):
        log('portrait: skipped (no frame or no posing frame)')
        return
    x0, y0, x1, y1 = json.load(open(spec_p))['canvas']
    figure = Image.open(os.path.join(game, 'actors', 'guybrush', cel['file'])).convert('RGBA')
    card = Image.open(frame_p).convert('RGB')
    card.paste(painting(figure, x1 - x0, y1 - y0), (x0, y0))
    out = os.path.join(game, 'art', 'portrait_reveal.jpg')
    if os.path.exists(out):
        gamedir.aside(out)
    card.save(out, quality=90)
    # the item: the framed painting, fitted into the 80x56 inventory cell (art 320x224)
    fx0, fy0 = max(0, x0 - int((x1 - x0) * 0.30)), max(0, y0 - int((y1 - y0) * 0.24))
    fx1, fy1 = min(card.width, x1 + int((x1 - x0) * 0.30)), min(card.height, y1 + int((y1 - y0) * 0.24))
    thumb = card.crop((fx0, fy0, fx1, fy1))
    k = min(300 / thumb.width, 216 / thumb.height)
    thumb = thumb.resize((round(thumb.width * k), round(thumb.height * k)), Image.LANCZOS)
    icon = Image.new('RGBA', (320, 224), (0, 0, 0, 0))
    icon.paste(thumb, ((320 - thumb.width) // 2, (224 - thumb.height) // 2))
    ip = os.path.join(game, 'items', 'portrait.png')
    if os.path.exists(ip):
        gamedir.aside(ip)
    icon.save(ip)
    log('portrait -> game/art/portrait_reveal.jpg + game/items/portrait.png')


def voice_clips(view, root, log=print):
    """The CMI clips game/voice.json points at (cmi/voice/<TAG>.wav) from the player's own voice bundles, by
    tools/bun_extract.py (GPL, a port of ScummVM's decoder) run as its own program. In the browser (no processes) the
    tags are returned and engine/byog/worker.js runs it in a separate Python."""
    import subprocess
    vmap = json.load(open(os.path.join(root, 'game', 'voice.json')))
    tags = sorted({os.path.splitext(os.path.basename(p))[0] for p in vmap.values() if p.startswith('cmi/voice/')})
    if not tags:
        return
    if sys.platform == 'emscripten':
        return tags
    out = os.path.join(root, 'cmi', 'voice')
    os.makedirs(out, exist_ok=True)
    tool = os.path.join(TOOLS, 'bun_extract.py')
    for disk in ('VOXDISK1.BUN', 'VOXDISK2.BUN'):
        subprocess.run([sys.executable, tool, os.path.join(view, 'RESOURCE', disk), '--extract', *tags, '--out', out],
                       capture_output=True)
    got = {t for t in tags if os.path.isfile(os.path.join(out, t + '.wav'))}
    missing = [t for t in tags if t not in got]
    log(f'voice clips -> cmi/voice: {", ".join(sorted(got))}' + (f' (not found: {", ".join(missing)})' if missing else ''))


def install(view, root, log=print):
    guybrush(root, log)
    try:                                    # the feather-fencing tickle (costume 254 + our feather): optional
        import fence
        fence.fence(view, root, log)
    except Exception as e:  # noqa: BLE001 - another game version: the gag plays without the lunge
        log(f'fence tickle skipped ({type(e).__name__}: {e})')
    if not os.path.isfile(os.path.join(root, 'game', 'art', 'portrait_reveal.jpg')):
        portrait(root, log)                 # only without the shipped painting: one from the player's own Guybrush
    return voice_clips(view, root, log)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--game', required=True, help='CMI folder with upper-case names (.byog/game)')
    ap.add_argument('--root', default=os.path.dirname(TOOLS))
    a = ap.parse_args()
    install(os.path.abspath(a.game), os.path.abspath(a.root))


if __name__ == '__main__':
    main()
