#!/usr/bin/env python3
"""The level editor's ComfyUI tools (tools/serve.py /api/ai/...): ideas for a new object in an area of a room, an
inventory item, a character or a background, and repainting a picture (whole, or a part of it), several candidates
at a time to pick from. Built on tools/comfy.py (Flux2 Klein, SAM 3, BiRefNet) and the art recipes of this project
(tools/objedit.py: crop + edit + feathered paste; tools/hires.py: the 4x jump of a background draft).

Art is 4x the logical screen (S = 4). Candidates are written to <project>/library/gen/<job>/ (not in the game until
used; "Keep for later" puts one in the library).
"""
import io
import os
import random
import re
import threading
import time
import traceback

import numpy as np
from PIL import Image, ImageFilter

from comfy import Comfy, CONSISTENCY_LORA
from objedit import crop_rect, feather_mask

S = 4
STYLE = ("in the style of the 1997 LucasArts adventure game The Curse of Monkey Island: hand-painted, painterly, "
         "thin restrained dark ink outlines, soft painted shading, warm colours")
KEEP = ("Keep everything else exactly the same: same hand-painted semi-realistic painterly style with thin restrained "
        "linework, same lighting, colors and perspective.")


# A project's style pack (games/<key>/style.json: {prompt, keep?, refs?: [images]}) replaces the CMI
# default in every prompt, so a game can have its own look end to end (projects.load_style reads the file).
def style_text(style=None):
    p = style.get('prompt') if isinstance(style, dict) else None
    return p.strip().rstrip('.') if p and p.strip() else STYLE


def keep_text(style=None):
    k = style.get('keep') if isinstance(style, dict) else None
    if k and k.strip():
        return k.strip().rstrip('.') + '.'
    if style_text(style) is STYLE:
        return KEEP
    return ("Keep everything else exactly the same: the same art style and linework, same lighting, "
            "colors and perspective.")
GREY = (128, 128, 128)
MAX_EDIT_PX = 1_600_000        # Klein edits above this are done on a smaller copy
URL_RE = re.compile(r'^https?://[A-Za-z0-9.\-]+(:\d{1,5})?/?$')
DEFAULT_URL = os.environ.get('COMFY_URL', 'http://127.0.0.1:8188')
GPU = threading.Lock()          # one generation at a time (ComfyUI queues anyway; this keeps jobs in order)


def comfy(url):
    url = (url or DEFAULT_URL).strip()
    if not URL_RE.match(url):
        raise ValueError('ComfyUI address: http://host:port')
    return Comfy(url)


def status(url):
    import requests
    c = comfy(url)
    r = requests.get(c.url + '/system_stats', timeout=4)
    r.raise_for_status()
    d = r.json()
    dev = (d.get('devices') or [{}])[0]
    return {'ok': True, 'url': c.url, 'gpu': dev.get('name'), 'vram_free_mb': (dev.get('vram_free') or 0) // 2**20,
            'comfyui': (d.get('system') or {}).get('comfyui_version')}


# ------------------------------------------------------------------ image helpers
def on_grey(rgba, pad=0.12):
    """A transparent picture on flat grey with a margin (what the models edit; BiRefNet cuts it out again)."""
    w, h = rgba.size
    px, py = int(w * pad) + 16, int(h * pad) + 16
    out = Image.new('RGB', (w + 2 * px, h + 2 * py), GREY)
    out.paste(rgba, (px, py), rgba)
    return out, (px, py)


def trim(rgba, thr=8):
    bb = rgba.split()[3].point(lambda v: 255 if v > thr else 0).getbbox()
    return (rgba.crop(bb), bb) if bb else (rgba, (0, 0, rgba.width, rgba.height))


def edit(c, img, prompt, seed, refs=(), lora=0.3, name='edit', cutout=False, segment=None):
    """Klein edit at the image's size (done on a smaller copy for big images, scaled back). cutout / segment: the
    background removal / SAM 3 mask in the same ComfyUI run (see Comfy.klein): -> RGBA / (image, mask)."""
    img = img.convert('RGB')
    W, H = img.size
    k = min(1.0, (MAX_EDIT_PX / (W * H)) ** 0.5)
    small = img.resize((max(16, int(W * k) // 16 * 16), max(16, int(H * k) // 16 * 16)), Image.LANCZOS) if k < 1 or W % 16 or H % 16 else img
    loras = [(CONSISTENCY_LORA, lora)] if lora else []
    out = c.klein(prompt, edit=small, refs=list(refs), seed=seed, loras=loras, name=name, cutout=cutout, segment=segment)
    if segment:
        out, mask = out
        return out.resize((W, H), Image.LANCZOS), mask.resize((W, H), Image.LANCZOS)
    return out.resize((W, H), Image.LANCZOS)


def cutout(c, rgb, name='cut'):
    """BiRefNet background removal -> RGBA, trimmed."""
    return trim(c.remove_bg(rgb, name=name))[0]


# ------------------------------------------------------------------ the generators (one candidate each)
def object_in_area(c, bg4, area, prompt, seed, name='obj', style=None):
    """A new object painted into the background inside `area` (logical [x, y, w, h]), cut out as a sprite.
    -> (sprite RGBA at 4x, [x, y] of its top-left in logical px, preview RGB of the edited area)"""
    x, y, w, h = [v * S for v in area]
    X0, Y0, X1, Y1 = crop_rect(bg4.size, (x, y, x + w, y + h), 0.45)
    orig = bg4.crop((X0, Y0, X1, Y1)).convert('RGB')
    text = (f"Add {prompt} in the middle of the picture, where the empty space is, standing naturally in the scene with "
            f"matching perspective, scale and lighting, {style_text(style)}. " + keep_text(style))
    out, sam_mask = edit(c, orig, text, seed, name=name, segment=prompt[:80])     # SAM 3 in the same run
    a, b = np.asarray(orig).astype(np.int16), np.asarray(out).astype(np.int16)
    diff = np.abs(a - b).sum(2) > 70
    inner = np.zeros_like(diff)
    m = 0.12
    ix0, iy0 = int(x - X0 - w * m), int(y - Y0 - h * m)
    ix1, iy1 = int(x - X0 + w * (1 + m)), int(y - Y0 + h * (1 + m))
    inner[max(0, iy0):max(0, iy1), max(0, ix0):max(0, ix1)] = True
    diff &= inner
    dm = Image.fromarray((diff * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(9))
    sam = (np.asarray(sam_mask) > 128) & inner
    dmask = np.asarray(dm) > 128
    mask = sam if sam.sum() > 0.25 * max(1, dmask.sum()) and (sam & dmask).sum() > 0.2 * sam.sum() else dmask
    alpha = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))
    rgba = out.convert('RGBA')
    rgba.putalpha(alpha)
    sprite, bb = trim(rgba, 24)
    if bb[2] - bb[0] < 8 or bb[3] - bb[1] < 8:
        raise RuntimeError('nothing new was painted there')
    pos = [round((X0 + bb[0]) / S, 2), round((Y0 + bb[1]) / S, 2)]
    prev = out.crop((max(0, ix0), max(0, iy0), min(out.width, ix1), min(out.height, iy1)))
    return sprite, pos, prev


def item_icon(c, prompt, seed, ref=None, name='item', style=None):
    text = (f"{prompt}: one single object, an inventory icon {style_text(style)}, the whole object visible and centered, isolated on a "
            f"plain flat grey background, no text, no frame, no shadow")
    if ref is not None:
        text += '. Use the same art style as image 1 (but a different object).'
    img = c.klein(text, (1024, 704), refs=[ref] if ref is not None else [], seed=seed, name=name, cutout=True)
    return trim(img)[0], img


def character(c, prompt, seed, ref=None, name='char', style=None, ref_is_character=True):
    figure = 'one full-body cartoon character standing' if style_text(style) is STYLE else 'one full-body character standing'
    text = (f"{prompt}: {figure}, seen from the front at a slight angle, {style_text(style)}, "
            f"the whole figure visible from head to feet, isolated on a plain flat grey "
            f"background, no text, no shadow")
    if style_text(style) is STYLE:
        text += ', exaggerated proportions'
    if ref is not None:
        text += ('. Draw them in the same art style as the character in image 1 (but a different person).'
                 if ref_is_character else '. Use the same art style as image 1 (but your own, different character).')
    img = c.klein(text, (768, 1344), refs=[ref] if ref is not None else [], seed=seed, name=name, cutout=True)
    return trim(img)[0], img


def background_draft(c, prompt, size, seed, ref=None, name='bg', style=None):
    """A background draft (2x the logical size); the 4x jump (hires) happens when it is used."""
    w, h = size
    text = (f"{prompt}. A background painting for a point-and-click adventure game {style_text(style)}, an open walkable floor "
            f"area in the lower third, no characters, no people, no text, no icons, no logos, no signature, no user interface")
    refs = []
    if ref is not None:
        # small, so it gives the painting style and not the layout
        refs = [ref.convert('RGB').resize((448, 336), Image.LANCZOS)]
        text += ('. Paint it in the same painting style as image 1, but it is a completely different place with its own '
                 'composition: do not copy anything from image 1.')
    return c.klein(text, (w * 2, h * 2), refs=refs, seed=seed, ref_mp=0.15, name=name)


# ------------------------------------------------------------------ a whole UI theme (theme.json pieces)
THEME_ANGLES = {'N': 0, 'NE': -45, 'E': -90, 'SE': -135, 'S': 180, 'SW': 135, 'W': 90, 'NW': 45}


def tinted(rgba, color, k=0.8):
    """CMI's 'hot' variant: the sprite recolored toward `color` by its own luminance."""
    a = np.asarray(rgba.convert('RGBA')).astype(np.float32)
    lum = (a[..., :3].mean(-1, keepdims=True) / 255) ** 0.75
    a[..., :3] = a[..., :3] * (1 - k) + np.array(color, np.float32) * lum * k
    return Image.fromarray(a.clip(0, 255).astype(np.uint8))


def fit_into(rgba, size, center=None, fill=0.9):
    """The sprite scaled to `fill` of the box and pasted centered at `center` on a transparent canvas
    (the engine draws these at fixed sizes with fixed hot spots)."""
    bw, bh = size
    s = min(bw * fill / rgba.width, bh * fill / rgba.height)
    w, h = max(1, round(rgba.width * s)), max(1, round(rgba.height * s))
    im = rgba.resize((w, h), Image.LANCZOS)
    cx, cy = center or (bw / 2, bh / 2)
    x, y = round(min(max(0, cx - w / 2), bw - w)), round(min(max(0, cy - h / 2), bh - h))
    out = Image.new('RGBA', (bw, bh), (0, 0, 0, 0))
    out.paste(im, (x, y), im)
    return out


def theme_set(c, prompt, seed, style=None, name='theme', highlight=(255, 60, 10)):
    """One consistent interface set, keyed like theme.json: the verb coin's four states from ONE
    generation (a strip, so they are the same coin), a cursor (+ a recolored hot variant), an hourglass,
    one arrow rotated into the 8 exit arrows and the page/dialogue arrows, and the chest screen. The
    images come back at the engine's sizes (4x logical px)."""
    sty = style_text(style)
    what = prompt or 'matching the game'
    out = {}
    strip = c.klein(
        f"A sprite strip on a plain flat grey background: four identical round verb-coin medallions in one row, "
        f"for a point-and-click adventure game interface, {what}, {sty}. Every medallion has the same three "
        f"symbols on it: a grasping hand on the left, an eye at the top, an open mouth on the right. In the "
        f"first medallion nothing glows, in the second only the hand glows brightly, in the third only the eye "
        f"glows brightly, in the fourth only the mouth glows brightly. Bold, crisp, no text",
        (1792, 448), seed=seed, name=f'{name}_coin')
    for i, slot in enumerate(('idle', 'hand', 'look', 'mouth')):
        cell = strip.crop((i * 448, 0, (i + 1) * 448, 448)).convert('RGB')
        out[f'coin.{slot}'] = fit_into(cutout(c, cell, f'{name}_coin{i}'), (464, 472), fill=0.94)
    cur = cutout(c, c.klein(
        f"One single mouse-pointer cursor for a point-and-click adventure game, {what}, {sty}: a clear pointed "
        f"cross or X shape, isolated on a plain flat grey background, no text", (448, 320), seed=seed + 1,
        name=f'{name}_cursor').convert('RGB'), f'{name}_cursor')
    out['cursor'] = fit_into(cur, (320, 224), center=(136, 100), fill=0.55)
    out['cursorHot'] = tinted(out['cursor'], highlight)
    out['wait'] = fit_into(cutout(c, c.klein(
        f"One single hourglass, a waiting symbol for a game interface, {what}, {sty}, isolated on a plain flat "
        f"grey background, no text", (448, 320), seed=seed + 2, name=f'{name}_wait').convert('RGB'), f'{name}_wait'),
        (320, 224), center=(156, 96), fill=0.6)
    arrow = cutout(c, c.klein(
        f"One single arrow pointing straight up, an exit arrow for a game interface, {what}, {sty}, isolated on "
        f"a plain flat grey background, no text", (448, 448), seed=seed + 3, name=f'{name}_arrow').convert('RGB'),
        f'{name}_arrow')
    for d, ang in THEME_ANGLES.items():
        out[f'arrows.{d}'] = fit_into(arrow.rotate(ang, expand=True, resample=Image.BICUBIC), (320, 224), center=(156, 96), fill=0.62)
    out['invPrev'] = fit_into(arrow.rotate(90, expand=True, resample=Image.BICUBIC), (320, 160), fill=0.8)
    out['invNext'] = fit_into(arrow.rotate(-90, expand=True, resample=Image.BICUBIC), (320, 160), fill=0.8)
    out['dlgUp'] = fit_into(arrow, (128, 160), fill=0.85)
    out['dlgDown'] = fit_into(arrow.rotate(180, resample=Image.BICUBIC), (128, 128), fill=0.85)
    chest = c.klein(
        f"A full-screen inventory background for a point-and-click adventure game: a large open {prompt or 'chest'} "
        f"seen from slightly above, {sty}. Its open inside is one large dark flat empty area filling most of the "
        f"picture (item icons will be laid out on it), the rim and lid around the edges. No items, no text, no "
        f"interface icons", (1280, 944), seed=seed + 4, name=f'{name}_chest')
    out['chest'] = chest.convert('RGB').resize((2560, 1888), Image.LANCZOS)
    return out


def theme_montage(files):
    """One preview picture: the chest as the backdrop, the coin states and cursors over it."""
    out = files['chest'].resize((640, 472)).convert('RGB')
    x = 12
    for slot in ('coin.idle', 'coin.hand', 'coin.look', 'coin.mouth'):
        im = files[slot].resize((116, 118), Image.LANCZOS)
        out.paste(im, (x, 12), im)
        x += 130
    x = 12
    for slot in ('cursor', 'cursorHot', 'wait', 'arrows.N', 'arrows.E', 'invNext'):
        im = files[slot].resize((80, 56), Image.LANCZOS)
        out.paste(im, (x, 150), im)
        x += 92
    return out


def card_draft(c, prompt, seed, ref=None, name='card', style=None, title=None):
    """A full-screen card (title / chapter / THE END; 4:3). The title lettering is painted into the
    picture when given — regenerate until it reads right, or bake no text and keep the art clean."""
    text = (f"{prompt}. A full-screen title card illustration for a point-and-click adventure game "
            f"{style_text(style)}, cinematic composition, no user interface, no watermark")
    if title:
        text += f'. Large ornate title lettering reading "{title}" integrated into the picture'
    else:
        text += ', no text'
    refs = []
    if ref is not None:
        refs = [ref.convert('RGB').resize((448, 336), Image.LANCZOS)]
        text += '. Paint it in the same painting style as image 1 (its own composition, nothing copied).'
    return c.klein(text, (1280, 960), refs=refs, seed=seed, ref_mp=0.15, name=name)


def repaint(c, img, prompt, seed, cut, name='rep', style=None):
    """A changed version of a picture (prompt = what to change). cut: a transparent picture (sprite, icon, character)
    is edited on grey and cut out again, at its old size."""
    if cut:
        base, (px, py) = on_grey(img)
        rgba = edit(c, base, f"{prompt}. Keep the same thing, the same framing and the same art style ({style_text(style)}). "
                             f"Keep the plain flat grey background.", seed, name=name, cutout=True)
        return rgba.crop((px, py, px + img.width, py + img.height)), rgba
    out = edit(c, img, f"{prompt}. {keep_text(style)}", seed, name=name)
    return out, out


def inpaint(c, img, region, prompt, seed, cut, name='inp', style=None):
    """Only `region` ([x, y, w, h] in image px) of a picture is redone (feathered into the rest); a transparent
    picture keeps its old outline outside the region."""
    x, y, w, h = [int(v) for v in region]
    if cut:
        rgba = img.convert('RGBA')
        base, (px, py) = on_grey(rgba, 0.0)
    else:
        base, (px, py) = img.convert('RGB'), (0, 0)
    bx, by = x + px, y + py
    X0, Y0, X1, Y1 = crop_rect(base.size, (bx, by, bx + w, by + h), 0.35)
    crop = base.crop((X0, Y0, X1, Y1))
    out = edit(c, crop, f"Change the middle of the picture: {prompt}. {keep_text(style)}", seed, name=name)
    fm = feather_mask(crop.size, (bx - X0, by - Y0, bx - X0 + w, by - Y0 + h), max(4, min(w, h) // 12))
    full = base.copy()
    full.paste(out, (X0, Y0), fm)
    if not cut:
        return full, full.crop((X0, Y0, X1, Y1))
    region_full = Image.new('L', base.size, 0)
    region_full.paste(fm, (X0, Y0))
    new = c.remove_bg(full, name=name + '_cut').crop((px, py, px + rgba.width, py + rgba.height))
    rm = np.asarray(region_full.crop((px, py, px + rgba.width, py + rgba.height))).astype(np.float32) / 255
    a_old = np.asarray(rgba.split()[3]).astype(np.float32)
    a_new = np.asarray(new.split()[3]).astype(np.float32)
    new.putalpha(Image.fromarray((a_old * (1 - rm) + a_new * rm).clip(0, 255).astype(np.uint8)))
    return new, full.crop((X0, Y0, X1, Y1))


# ------------------------------------------------------------------ jobs
class Job:
    def __init__(self, jid, spec, out_dir):
        self.id, self.spec, self.dir = jid, spec, out_dir
        self.kind, self.mode = spec['kind'], spec.get('mode', 'new')
        self.total = int(spec.get('count') or 6)
        self.candidates, self.errors = [], []
        self.status, self.error, self.cancel = 'queued', None, False
        self.t0 = time.time()

    def info(self, url_of):
        return {'id': self.id, 'kind': self.kind, 'mode': self.mode, 'status': self.status, 'total': self.total,
                'done': len(self.candidates), 'error': self.error, 'errors': self.errors[-3:],
                'seconds': round(time.time() - self.t0),
                'candidates': [{'i': cd['i'], 'preview': url_of(cd['preview']), 'image': url_of(cd['image']),
                                'size': cd.get('size'), 'pos': cd.get('pos')} for cd in self.candidates]}


def save_png(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG', optimize=False)
    return path


def run(job, c, ctx):
    """Makes job.total candidates (ctx: what the generator needs: images, sizes, references)."""
    with GPU:
        job.status = 'running'
        base_seed = random.randrange(1, 10**6)
        k, mode, prompt = job.kind, job.mode, job.spec.get('prompt', '').strip()
        style = ctx.get('style')
        for i in range(job.total):
            if job.cancel:
                break
            seed = base_seed + i * 7
            name = f'ed_{job.id}_{i}'
            try:
                cd = {'i': i}
                if mode == 'new' and k == 'object':
                    sprite, pos, prev = object_in_area(c, ctx['bg4'], job.spec['area'], prompt, seed, name, style=style)
                    cd.update(image=save_png(sprite, f'{job.dir}/c{i}.png'), preview=save_png(prev, f'{job.dir}/c{i}_prev.png'),
                              pos=pos, size=[round(sprite.width / S, 2), round(sprite.height / S, 2)])
                elif mode == 'new' and k == 'item':
                    rgba, raw = item_icon(c, prompt, seed, ctx.get('ref'), name, style=style)
                    cd.update(image=save_png(rgba, f'{job.dir}/c{i}.png'), preview=save_png(rgba, f'{job.dir}/c{i}_prev.png'))
                elif mode == 'new' and k == 'character':
                    rgba, raw = character(c, prompt, seed, ctx.get('ref'), name, style=style,
                                          ref_is_character=ctx.get('ref_is_character', True))
                    cd.update(image=save_png(rgba, f'{job.dir}/c{i}.png'), preview=save_png(rgba, f'{job.dir}/c{i}_prev.png'))
                elif mode == 'new' and k == 'background':
                    img = background_draft(c, prompt, ctx['size'], seed, ctx.get('ref'), name, style=style)
                    cd.update(image=save_png(img, f'{job.dir}/c{i}.png'), preview=save_png(img.resize((img.width // 2, img.height // 2)), f'{job.dir}/c{i}_prev.png'))
                elif mode == 'new' and k == 'card':
                    img = card_draft(c, prompt, seed, ctx.get('ref'), name, style=style, title=ctx.get('title'))
                    cd.update(image=save_png(img, f'{job.dir}/c{i}.png'),
                              preview=save_png(img.resize((img.width // 2, img.height // 2)), f'{job.dir}/c{i}_prev.png'))
                elif mode == 'new' and k == 'theme':
                    files = theme_set(c, prompt, seed, style=style, name=name, highlight=ctx.get('highlight') or (255, 60, 10))
                    paths = {}
                    for slot, im in files.items():
                        fp = f"{job.dir}/c{i}_{slot.replace('.', '_')}" + ('.jpg' if slot == 'chest' else '.png')
                        if slot == 'chest':
                            os.makedirs(job.dir, exist_ok=True)
                            im.save(fp, 'JPEG', quality=90)
                        else:
                            save_png(im, fp)
                        paths[slot] = fp
                    mont = theme_montage(files)
                    cd.update(image=save_png(mont, f'{job.dir}/c{i}.png'), preview=save_png(mont, f'{job.dir}/c{i}_prev.png'),
                              files=paths)
                elif mode == 'repaint':
                    img, prev = repaint(c, ctx['image'], prompt, seed, ctx['cut'], name, style=style)
                    cd.update(image=save_png(img, f'{job.dir}/c{i}.png'), preview=save_png(img if ctx['cut'] else prev, f'{job.dir}/c{i}_prev.png'))
                elif mode == 'inpaint':
                    img, prev = inpaint(c, ctx['image'], job.spec['region'], prompt, seed, ctx['cut'], name, style=style)
                    cd.update(image=save_png(img, f'{job.dir}/c{i}.png'), preview=save_png(prev, f'{job.dir}/c{i}_prev.png'))
                else:
                    raise ValueError(f'unknown generation {k}/{mode}')
                job.candidates.append(cd)
            except Exception as e:  # noqa: BLE001 - one bad candidate doesn't stop the job
                job.errors.append(f'{type(e).__name__}: {e}')
                traceback.print_exc()
                if len(job.errors) >= 3 and not job.candidates:
                    job.status, job.error = 'error', job.errors[-1]
                    return
        job.status = 'cancelled' if job.cancel else 'done'
