#!/usr/bin/env python3
"""Guybrush's 'feather fencing' tickle (License to Pillage), made on the player's machine from their own CMI:
CMI's fencing costume 254 (Guybrush's sword fight, facing W) with the sabre replaced by our feather item.

A port of tools/guybrush_fence.py (the developer's version, cv2 + a private HD pack) to numpy + Pillow: the cels are
decoded from the player's COMI.LA2 (decoders.py), the masks of blade, cup hilt and the blade's ground shadow are found
on the palette-exact 1x cels and applied to the 4x ones (upscale.scale4x), a fist is painted where the hilt was and
game/items/feather.png is put in it, following the hilt / blade angle of each cel.

  fence(game, root)  -> game/actors/guybrush: cels 9100+ (cels/fence_*.webp), anim fence_tickle_W, role fence_tickle
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import decoders as dec  # noqa: E402
import upscale  # noqa: E402

COSTUME = 254
S = 4
from extract import CEL_EXT  # noqa: E402
SAVE = {'format': 'WEBP', 'lossless': True, 'method': 4} if CEL_EXT == 'webp' else {'format': 'PNG'}
ANCHOR = (-52, 94)          # costume-254 coordinates of the feet
FEATHER_LEN = 46            # logical px, quill end to tip
FIST = (4.3, 3.4)           # fist semi axes (logical px): along the quill, across
SKIN, SKIN2, INK = (255, 199, 175), (223, 175, 150), (17, 14, 10)
GUARD_RGB = (255, 191, 67)  # the cup hilt's yellow (palette-exact at 1x)
# en garde -> extend -> lunge with the feather wiggling -> recover (costume 254 anim 10, frames 26, 15, 16, 17, 19, 22)
SEQ = [
    dict(cel=190, hold=2, dang=0, bend=0.06, push=0),
    dict(cel=23, hold=1, dang=0, bend=0.10, push=0),
    dict(cel=36, hold=2, dang=0, bend=0.16, push=0),
    dict(cel=36, hold=1, dang=10, bend=-0.08, push=2),
    dict(cel=36, hold=1, dang=-6, bend=0.20, push=-1),
    dict(cel=36, hold=1, dang=9, bend=-0.06, push=2),
    dict(cel=38, hold=1, dang=0, bend=0.18, push=0),
    dict(cel=202, hold=1, dang=0, bend=0.12, push=0),
    dict(cel=195, hold=1, dang=0, bend=0.02, push=0),
    dict(cel=190, hold=2, dang=0, bend=0.06, push=0),
]


# ---------------------------------------------------------------- morphology (numpy; ellipse kernels like cv2's)
def kernel(n):
    """Offsets of OpenCV's MORPH_ELLIPSE n x n structuring element (getStructuringElement), exactly."""
    r = c = n // 2
    out = []
    for i in range(n):
        dy = i - r
        if abs(dy) <= r:
            dx = int(round(c * math.sqrt((r * r - dy * dy) / (r * r)))) if r else 0
            out += [(dy, j - c) for j in range(max(c - dx, 0), min(c + dx + 1, n))]
    return out


def _shift(m, dy, dx):
    out = np.zeros_like(m)
    H, W = m.shape
    ys, yd = (slice(max(0, -dy), H - max(0, dy)), slice(max(0, dy), H - max(0, -dy)))
    xs, xd = (slice(max(0, -dx), W - max(0, dx)), slice(max(0, dx), W - max(0, -dx)))
    out[yd, xd] = m[ys, xs]
    return out


def dilate(m, n):
    m = m.astype(bool)
    out = np.zeros_like(m)
    for dy, dx in kernel(n):
        out |= _shift(m, dy, dx)
    return out


def erode(m, n):
    return ~dilate(~m.astype(bool), n)


def opening(m, n):
    return dilate(erode(m, n), n)


def closing(m, n):
    return erode(dilate(m, n), n)


def components(m):
    """Connected components (8-neighbourhood): [(mask, area, top y, centroid (x, y))]."""
    m = m.astype(bool)
    H, W = m.shape
    lab = np.zeros((H, W), np.int32)
    out = []
    ys, xs = np.nonzero(m)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]:
            continue
        n = len(out) + 1
        lab[y0, x0] = n
        stack, pts = [(y0, x0)], []
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < H and 0 <= xx < W and m[yy, xx] and not lab[yy, xx]:
                        lab[yy, xx] = n
                        stack.append((yy, xx))
        py = np.array([p[0] for p in pts])
        px = np.array([p[1] for p in pts])
        out.append((lab == n, len(pts), int(py.min()), (float(px.mean()), float(py.mean()))))
    return out


def big_components(m, min_area, block=S):
    """Keeps the parts of a (large, 4x) mask whose connected component has at least min_area pixels: components are
    found on the 1x blocks (block x block cells, set if any pixel is), which keeps it fast in pure Python."""
    H, W = m.shape
    h, w = -(-H // block), -(-W // block)
    pad = np.zeros((h * block, w * block), bool)
    pad[:H, :W] = m
    cells = pad.reshape(h, block, w, block).any(axis=(1, 3))
    counts = pad.reshape(h, block, w, block).sum(axis=(1, 3))
    keep_cells = np.zeros((h, w), bool)
    for mask, _area, _top, _c in components(cells):
        if counts[mask].sum() >= min_area:
            keep_cells |= mask
    keep = np.repeat(np.repeat(keep_cells, block, 0), block, 1)[:H, :W]
    return keep & m


def hull_mask(points, shape, tol=0.5):
    """Filled convex hull of (x, y) points (monotone chain); pixels within `tol` px outside an edge count too (like
    OpenCV's fillConvexPoly, which rasterizes the edges as well)."""
    pts = sorted(set((int(x), int(y)) for x, y in points))
    m = np.zeros(shape, bool)
    if len(pts) < 3:
        for x, y in pts:
            m[y, x] = True
        return m

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]          # counter-clockwise in x-right/y-down = clockwise on screen
    xs = [p[0] for p in hull]
    ys = [p[1] for p in hull]
    x0, x1, y0, y1 = max(0, min(xs) - 1), min(shape[1], max(xs) + 2), max(0, min(ys) - 1), min(shape[0], max(ys) + 2)
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float64)
    inside = np.ones(yy.shape, bool)
    for i in range(len(hull)):
        ax_, ay_ = hull[i]
        bx_, by_ = hull[(i + 1) % len(hull)]
        ex, ey = bx_ - ax_, by_ - ay_
        ln = math.hypot(ex, ey) or 1.0
        inside &= (ex * (yy - ay_) - ey * (xx - ax_)) / ln >= -tol
    m[y0:y1, x0:x1] = inside
    return m


# ---------------------------------------------------------------- analysis (1x) and cleaning (4x)
def analyse(lo):
    a = lo
    O = a[:, :, 3] == 255
    Sh = (a[:, :, 3] > 0) & (a[:, :, 3] < 255)
    yel = np.all(a[:, :, :3] == GUARD_RGB, -1) & O
    comps = components(yel)
    cands = [c for c in comps if c[2] > 50] or comps                 # not the hair
    main = max(cands, key=lambda c: c[1])
    gc = np.array(main[3])
    g = np.zeros(O.shape, bool)
    for c in comps:
        if math.hypot(c[3][0] - gc[0], c[3][1] - gc[1]) < 9:
            g |= c[0]
    gy, gx = np.nonzero(g)
    guard = hull_mask(list(zip(gx, gy)), O.shape)
    gy, gx = np.nonzero(guard)
    gc = np.array([gx.mean(), gy.mean()])
    guard = dilate(guard, 3)
    rest = O & ~guard
    rc = components(rest)
    body = max(rc, key=lambda c: c[1])[0]
    near = dilate(guard, 7)
    blade = np.zeros(O.shape, bool)
    for c in rc:
        if c[0] is body:
            continue
        if (c[0] & near).any() or c[1] < 12:
            blade |= c[0]
    ys, xs = np.nonzero(blade)
    d = np.hypot(xs - gc[0], ys - gc[1])
    sel = d < 30
    v = np.array([xs[sel].mean() - gc[0], ys[sel].mean() - gc[1]])
    u = v / np.linalg.norm(v)
    core = opening(Sh, 7)
    keep = dilate(core, 3) & Sh
    return dict(guard=guard, blade=blade, shadow_keep=keep, figure=O, g=gc, u=u)


def big(m, shape):
    return np.repeat(np.repeat(m, S, 0), S, 1)[:shape[0], :shape[1]]


def clean_hd(hd, an):
    out = hd.copy()
    H, W = hd.shape[:2]
    kill = dilate(big(an['blade'] | an['guard'], (H, W)), 9)
    fig = erode(big(an['figure'] & ~an['blade'] & ~an['guard'], (H, W)), 3)
    out[kill & ~fig, 3] = 0
    yy, xx = np.mgrid[0:H, 0:W]
    cx, cy = an['g'][0] * S + S / 2, an['g'][1] * S + S / 2
    near = (xx - cx) ** 2 + (yy - cy) ** 2 <= (10 * S) ** 2
    hsv = np.asarray(Image.fromarray(np.ascontiguousarray(out[:, :, :3])).convert('HSV')).astype(np.float32)
    hue = hsv[:, :, 0] * 180 / 255                                   # cv2's 0..180 hue scale
    cup = near & (hsv[:, :, 1] > 120) & (hue >= 3) & (hue <= 30)
    out[cup, 3] = 0
    solid = out[:, :, 3] > 0
    thin = solid & ~opening(solid, 9) & near
    out[thin, 3] = 0
    sh_hd = (hd[:, :, 3] > 0) & (hd[:, :, 3] < 200) & ~fig
    keep = dilate(big(an['shadow_keep'], (H, W)), 5)
    out[sh_hd & ~keep, 3] = 0
    core = closing(big(an['shadow_keep'], (H, W)), 25)
    out[core & (out[:, :, 3] == 0)] = (0, 0, 0, 125)
    solid = big_components(out[:, :, 3] > 0, 1500)                   # crumbs of the removed parts
    out[~solid, 3] = 0
    return out


# ---------------------------------------------------------------- feather + fist
def sample(img, mx, my):
    """Bilinear sample of an RGBA uint8 image at float coordinates (out-of-range = transparent)."""
    H, W = img.shape[:2]
    x0 = np.floor(mx).astype(np.int64)
    y0 = np.floor(my).astype(np.int64)
    fx, fy = (mx - x0)[..., None], (my - y0)[..., None]
    pad = np.zeros((H + 2, W + 2, 4), np.float32)
    pad[1:-1, 1:-1] = img
    x0c, y0c = np.clip(x0 + 1, 0, W + 1), np.clip(y0 + 1, 0, H + 1)
    x1c, y1c = np.clip(x0 + 2, 0, W + 1), np.clip(y0 + 2, 0, H + 1)
    out = (pad[y0c, x0c] * (1 - fx) * (1 - fy) + pad[y0c, x1c] * fx * (1 - fy)
           + pad[y1c, x0c] * (1 - fx) * fy + pad[y1c, x1c] * fx * fy)
    return np.clip(out, 0, 255).astype(np.uint8)


def feather_sprite(path):
    im = np.asarray(Image.open(path).convert('RGBA')).copy()
    al = im[:, :, 3] > 128
    ys, xs = np.nonzero(al)
    pts = np.stack([xs, ys], 1).astype(np.float64)
    m = pts.mean(0)
    w, v = np.linalg.eigh(np.cov((pts - m).T))
    ax = v[:, np.argmax(w)]
    if ax[0] < 0:
        ax = -ax
    p = (pts - m) @ ax
    q, t = pts[np.argmin(p)], pts[np.argmax(p)]
    axis = (t - q) / np.linalg.norm(t - q)
    return im, q, axis, float(np.linalg.norm(t - q))


def feather_layer(shape, feather, base, u, length, bend=0.0, mirror=True):
    """The feather with its quill end at `base` (canvas px), pointing along u, `length` px long, bent by `bend`."""
    im, q, axis, L = feather
    H, W = shape[:2]
    k = length / L
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
    th = math.atan2(u[1], u[0])
    c, s = math.cos(th), math.sin(th)
    px, py = xx - base[0], yy - base[1]
    lx = c * px + s * py                    # along the feather (0 at the quill end)
    ly = -s * px + c * py                   # across
    if bend:
        t = np.clip(lx / length, 0, None)
        ly = ly - bend * length * t * t
    if mirror:
        ly = -ly
    a = math.atan2(axis[1], axis[0])
    ca, sa = math.cos(a), math.sin(a)
    sx = q[0] + (ca * lx - sa * ly) / k     # back into the sprite (rotate the local frame onto its axis, unscale)
    sy = q[1] + (sa * lx + ca * ly) / k
    return sample(im, sx, sy)


def over(dst, src):
    a = Image.fromarray(dst)
    a.alpha_composite(Image.fromarray(src))
    return np.asarray(a).copy()


def fist_layer(shape, c, u, ss=4):
    H, W = shape[:2]
    img = Image.new('RGBA', (W * ss, H * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = np.asarray(c, np.float64)
    v = np.array([-u[1], u[0]])
    if v[1] < 0:
        v = -v
    au, av = FIST[0] * S, FIST[1] * S
    ow = 1.1 * S

    def pt(p):
        return tuple(p * ss)

    def blob(cu, cv_, a1, a2, grow=0.0, n=56, sq=2.6):
        o = c + u * cu + v * cv_
        pts = []
        for i in range(n):
            t = 2 * np.pi * i / n
            ct, st = np.cos(t), np.sin(t)
            x = np.sign(ct) * abs(ct) ** (2 / sq) * (a1 + grow)
            y = np.sign(st) * abs(st) ** (2 / sq) * (a2 + grow)
            pts.append(pt(o + u * x + v * y))
        return pts
    d.polygon(blob(0.35 * au, -0.62 * av, 0.55 * au, 0.42 * av, ow), fill=INK + (255,))
    d.polygon(blob(0, 0, au, av, ow), fill=INK + (255,))
    d.polygon(blob(0, 0, au, av), fill=SKIN + (255,))
    d.polygon(blob(0, 0.45 * av, au * 0.92, av * 0.5), fill=SKIN2 + (255,))
    d.polygon(blob(0.35 * au, -0.62 * av, 0.55 * au, 0.42 * av), fill=SKIN + (255,))
    for f in (-0.42, 0.05, 0.5):
        p0 = c + u * au * f + v * av * 1.0
        p1 = c + u * au * (f + 0.06) + v * av * 0.15
        d.line([pt(p0), pt(p1)], fill=INK + (255,), width=int(0.6 * S * ss))
    d.line([pt(c + u * au * -0.15 - v * av * 0.25), pt(c + u * au * 0.85 - v * av * 0.3)], fill=INK + (255,),
           width=int(0.5 * S * ss))
    return np.asarray(img.resize((W, H), Image.LANCZOS)).copy()


def render_frame(costume, pos, fr, feather, cache):
    cel = fr['cel']
    if cel not in cache:
        lo = costume.cel(cel)
        an = analyse(lo)
        cache[cel] = (an, clean_hd(upscale.hd4x(lo), an))     # (the HD pack's model when one is set)
    an, clean = cache[cel]
    cx, cy = pos[cel]
    P = 60 * S
    H, W = clean.shape[:2]
    can = np.zeros((H + 2 * P, W + 2 * P, 4), np.uint8)
    can[P:P + H, P:P + W] = clean
    u0 = an['u'].copy()
    th = math.atan2(u0[1], u0[0])
    sgn = 1 if u0[0] < 0 else -1
    th += math.radians(fr.get('dang', 0)) * sgn
    u = np.array([math.cos(th), math.sin(th)])
    g = an['g'] * S + P + S / 2
    wrist = g
    for t in np.arange(0, 16 * S, 1.0):
        q = g - u0 * t
        if can[int(q[1]), int(q[0]), 3] > 200:
            wrist = q
            break
    fc = wrist + u0 * (FIST[0] - 1.6) * S
    uh = (u0 + u) / np.linalg.norm(u0 + u)
    base = fc + u * (fr.get('push', 0) - 1.0) * S
    bend = fr.get('bend', 0) * (1 if u[0] < 0 else -1)
    out = over(can, feather_layer(can.shape, feather, base, u, FEATHER_LEN * S, bend=-bend))
    out = over(out, fist_layer(can.shape, fc, uh))
    ys, xs = np.nonzero(out[:, :, 3] > 0)
    x0, y0 = (xs.min() // S) * S, (ys.min() // S) * S
    x1, y1 = -(-(xs.max() + 1) // S) * S, -(-(ys.max() + 1) // S) * S
    return out[y0:y1, x0:x1], cx + (x0 - P) / S, cy + (y0 - P) / S


def fence(game_folder, root, log=print):
    """Adds the tickle to game/actors/guybrush (made by ltp_extras.guybrush first)."""
    import akos_extract as ax
    gb = os.path.join(root, 'game', 'actors', 'guybrush')
    feather_png = os.path.join(root, 'game', 'items', 'feather.png')
    g = dec.Game(game_folder)
    costume = dec.Costume(g, COSTUME)
    anims, _ = ax.extract_anims(costume.ak)
    pos = {}
    for f in anims['a10_E']['limbs'][0]['frames']:
        c = f['cels'][0]
        pos.setdefault(c['cel'], (c['x'], c['y']))
    feather = feather_sprite(feather_png)
    actor = json.load(open(os.path.join(gb, 'actor.json')))
    cache, out_frames, ids = {}, [], {}
    for i, fr in enumerate(SEQ):
        img, x, y = render_frame(costume, pos, fr, feather, cache)
        key = json.dumps({k: v for k, v in fr.items() if k != 'hold'}, sort_keys=True)
        if key not in ids:
            cid = ids[key] = str(9100 + len(ids))
            fn = f'cels/fence_{i:02d}_c{fr["cel"]:03d}.{CEL_EXT}'
            Image.fromarray(img).save(os.path.join(gb, fn), **SAVE)
            actor['cels'][cid] = {'file': fn, 'w': img.shape[1] // S, 'h': img.shape[0] // S}
        out_frames.append({'cels': [{'cel': int(ids[key]), 'x': round(x - ANCHOR[0], 2), 'y': round(y - ANCHOR[1], 2)}],
                           'hold': fr['hold']})
    actor['anims']['fence_tickle_W'] = {
        'anim': 0, 'family': 'fence_tickle', 'dir': 'W', 'loop': False, 'fps': 12,
        'source': 'your CMI costume 254 anim 10, sabre -> feather (tools/byog/fence.py)',
        'limbs': [{'limb': 0, 'op': 'set', 'frames': out_frames, 'loop_to': len(out_frames) - 1}, {'limb': 1, 'op': 'stop'}]}
    actor['roles']['fence_tickle'] = {d: 'fence_tickle_W' for d in actor['dirs']}
    tmp = os.path.join(gb, 'actor.json.tmp')
    with open(tmp, 'w') as fh:
        json.dump(actor, fh, separators=(',', ':'))
    os.replace(tmp, os.path.join(gb, 'actor.json'))
    log(f'fence tickle -> game/actors/guybrush: {len(out_frames)} frames ({len(ids)} pictures)')


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--game', required=True)
    ap.add_argument('--root', default=os.path.dirname(os.path.dirname(HERE)))
    a = ap.parse_args()
    fence(os.path.abspath(a.game), os.path.abspath(a.root))
