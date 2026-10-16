"""The stand-in hero (Drybrush Cheapwood, engine/theme/original/actors/hero) as the ScummVM player: build.py --hero
drybrush puts him in as costume 2, the number CMI's scripts and our compiler give Guybrush, so walking, talking,
turning and every swap back to costume 2 need no script change.

Four SCUMM directions (W E S N; W = E mirrored, as in the web costume's roles); anims 1 init, 2 walk, 3 stand,
4 talk, 5 talk stop, and every other number Guybrush's costume has (gestures 6..46, CMI's own) plays standing.
The live googly eyes of the web engine (engine/googly.js) can't run in SCUMM: their physics is run here over each
looping anim (the same constants, at the engine's 60 ticks a second) and the pupils are drawn into the frames.
"""
import json
import math
import os

from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
HERO = os.path.join(ROOT, 'engine', 'theme', 'original', 'actors', 'hero')
ART = os.path.join(ROOT, 'engine', 'theme', 'original')
DIRS = ('W', 'E', 'S', 'N')            # SCUMM's old direction order: chore = anim * 4 + d
G, BOUNCE, SLIDE = 2600.0, 0.82, 0.985  # engine/googly.js
TICK = 1 / 60
ANIM_MAX = 63                           # numbers up to this all exist (CMI's scripts may play any of Guybrush's)


def load():
    return json.load(open(os.path.join(HERO, 'actor.json')))


def aliases():
    return load().get('aliases', {})


def images():
    """game path -> file of his own version (his DOTT card, portrait, portrait icon)."""
    return {k: os.path.join(ART, v) for k, v in load().get('images', {}).items()}


def lines():
    """English line -> his recorded voice file."""
    return {k: os.path.join(HERO, v) for k, v in load().get('lines', {}).items()}


def simulate(eyes_per_frame, hold, loops=4):
    """Pupil offsets (eye-relative, logical px, y down) per game frame of one loop, after `loops` loops of
    warm-up: each pupil a disc loose in its eye under gravity, knocked by every jump of the eye between frames."""
    n_eyes = len(eyes_per_frame[0]) if eyes_per_frame and eyes_per_frame[0] else 0
    if not n_eyes:
        return [[] for _ in eyes_per_frame]
    ticks = []                             # eye centres per 60 Hz tick
    for e, h in zip(eyes_per_frame, hold):
        ticks += [e] * max(1, round(h * 5))   # a 12 fps game frame = 5 ticks
    st = [[0.0, max(0.2, e[2] - e[3]), 0.0, 0.0] for e in eyes_per_frame[0]]      # resting at the bottom
    out, prev = [], [(e[0], e[1]) for e in eyes_per_frame[0]]
    sub = 8
    h = TICK / sub
    for rep in range(loops + 1):
        f = 0
        for t, eyes in enumerate(ticks):
            for k, (x, y, R, r) in enumerate(eyes):
                ox, oy, vx, vy = st[k]
                travel = max(0.2, R - r)
                evx, evy = (x - prev[k][0]) / TICK, (y - prev[k][1]) / TICK
                for _ in range(sub):
                    vy += G * h
                    ox += (vx - evx) * h
                    oy += (vy - evy) * h
                    d = math.hypot(ox, oy)
                    if d > travel:
                        nx, ny = ox / d, oy / d
                        rx, ry = vx - evx, vy - evy
                        vn = rx * nx + ry * ny
                        ox, oy = nx * travel, ny * travel
                        if vn > 0:
                            rx, ry = (rx - vn * nx) * SLIDE - BOUNCE * vn * nx, (ry - vn * ny) * SLIDE - BOUNCE * vn * ny
                        vx, vy = rx + evx, ry + evy
                st[k] = [ox, oy, vx, vy]
                prev[k] = (x, y)
            if rep == loops:
                out.append([(s[0], s[1]) for s in st])
    # per game frame: the pupils at its first tick
    res, t = [], 0
    for h in hold:
        res.append(out[t] if out else [])
        t += max(1, round(h * 5))
    return res


def draw_pupils(im, cel, eyes, offs, flip):
    """Black pupils (a faint shine) on a 4x cel image; eyes [x, y, R, r] from the feet, logical px."""
    im = im.copy()
    d = ImageDraw.Draw(im)
    for (x, y, R, r), (ox, oy) in zip(eyes, offs):
        if flip:
            x, ox = -x, -ox
        cx, cy = (x + ox - cel['x']) * 4, (y + oy - cel['y']) * 4
        rr = r * 4
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(18, 18, 20, 255))
        s = rr * 0.3
        d.ellipse([cx - rr * 0.45 - s, cy - rr * 0.45 - s, cx - rr * 0.45 + s, cy - rr * 0.45 + s], fill=(140, 140, 150, 255))
    return im


def frames():
    """{anim number: [W, E, S, N] programs}, programs = [(4x RGBA image, x, y, hold)] (x, y: top-left from the feet,
    logical px), with the pupils drawn in."""
    d = load()
    cache = {}

    def prog(kind, dr):
        ref = d['roles'][kind][dr]
        name, flip = (ref['anim'], bool(ref.get('flip'))) if isinstance(ref, dict) else (ref, False)
        if (name, flip) in cache:
            return cache[(name, flip)]
        fr = d['anims'][name]['limbs'][0]['frames']
        hold = [int(f.get('hold', 1)) for f in fr]
        offs = simulate([f.get('eyes') or [] for f in fr], hold)
        out = []
        for f, o, h in zip(fr, offs, hold):
            c = f['cels'][0]
            info = d['cels'][str(c['cel'])]
            im = Image.open(os.path.join(HERO, info['file'])).convert('RGBA')
            if f.get('eyes'):
                im = draw_pupils(im, c, f['eyes'], o, False)
            x, y = c['x'], c['y']
            if flip:
                im = im.transpose(Image.FLIP_LEFT_RIGHT)
                x = -(c['x'] + info['w'])
            out.append((im, x, y, h, info['w'], info['h']))
        cache[(name, flip)] = out
        return out

    walk = [prog('walk', dr) for dr in DIRS]
    stand = [prog('stand', dr) for dr in DIRS]
    talk = [prog('talk', dr) for dr in DIRS]
    progs = {2: walk, 3: stand, 4: talk, 1: stand}
    progs[5] = [[p[0]] for p in stand]                          # talk stop: the first stand frame, held
    for n in range(6, ANIM_MAX + 1):
        progs.setdefault(n, stand)
    return progs


def palette(n):
    """n colours for his low-res cels (median cut over his stand frames): the build keeps them in every room."""
    d = load()
    px = []
    for k in ('stand_S', 'stand_E', 'stand_SE', 'stand_N', 'stand_NE'):
        for f in d['anims'][k]['limbs'][0]['frames'][:1]:
            im = Image.open(os.path.join(HERO, d['cels'][str(f['cels'][0]['cel'])]['file'])).convert('RGBA')
            im = im.resize((im.width // 4, im.height // 4))
            a = list(im.getdata())
            px += [p[:3] for p in a if p[3] >= 128]
    px += [(18, 18, 20), (140, 140, 150)]                       # the pupils and their shine
    sheet = Image.new('RGB', (len(px), 1))
    sheet.putdata(px)
    q = sheet.quantize(colors=n, method=Image.Quantize.MEDIANCUT)
    flat = q.getpalette()[:n * 3]
    return [tuple(flat[i:i + 3]) for i in range(0, len(flat), 3)]
