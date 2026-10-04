#!/usr/bin/env python3
"""Local edits of a room image with Flux2 Klein: crop a region (plus context), edit it, paste it
back with a feathered mask so everything outside the box stays pixel-identical. Used to add or
remove objects (clean plates + object sprites) and to fix details.

  tools/objedit.py in.png out.png --box x0 y0 x1 y1 --prompt "add ..." [--pad 0.5] [--lora 0.4] [--seed 1]
Box in image pixels (or --logical S to give it in logical px, scaled by S).
"""
import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comfy import Comfy, CONSISTENCY_LORA  # noqa: E402


def crop_rect(size, box, pad):
    W, H = size
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    px, py = max(48, int(bw * pad)), max(48, int(bh * pad))
    X0, Y0 = max(0, x0 - px), max(0, y0 - py)
    X1, Y1 = min(W, x1 + px), min(H, y1 + py)
    # multiples of 16
    X1 = X0 + (X1 - X0) // 16 * 16
    Y1 = Y0 + (Y1 - Y0) // 16 * 16
    return X0, Y0, X1, Y1


def feather_mask(size, inner, radius):
    """White inside `inner` (crop-relative box), feathered by `radius` px."""
    m = Image.new('L', size, 0)
    x0, y0, x1, y1 = inner
    m.paste(255, (int(x0), int(y0), int(x1), int(y1)))
    return m.filter(ImageFilter.GaussianBlur(radius)) if radius > 0 else m


def edit(img, box, prompt, pad=0.5, lora=0.45, seed=1, mp=1.0, refs=(), feather=None, c=None, keep_outside=True):
    """Returns (new image, edited crop, crop rect). img: PIL RGB; box: image px."""
    c = c or Comfy()
    X0, Y0, X1, Y1 = crop_rect(img.size, box, pad)
    crop = img.crop((X0, Y0, X1, Y1))
    cw, ch = crop.size
    s = (mp * 2 ** 20 / (cw * ch)) ** 0.5
    work = crop.resize((max(256, int(cw * s) // 16 * 16), max(256, int(ch * s) // 16 * 16)), Image.LANCZOS)
    loras = [(CONSISTENCY_LORA, lora)] if lora > 0 else []
    out = c.klein(prompt, edit=work, refs=list(refs), seed=seed, loras=loras, name='objedit')
    out = out.resize((cw, ch), Image.LANCZOS)
    res = img.copy()
    if keep_outside:
        bx0, by0, bx1, by1 = box[0] - X0, box[1] - Y0, box[2] - X0, box[3] - Y0
        r = feather if feather is not None else max(4, min(cw, ch) // 40)
        m = feather_mask((cw, ch), (bx0, by0, bx1, by1), r)
        res.paste(out, (X0, Y0), m)
    else:
        res.paste(out, (X0, Y0))
    return res, out, (X0, Y0, X1, Y1)


def connected(mask, seed):
    """Pixels of the boolean array `mask` that are 8-connected to `seed` (morphological reconstruction)."""
    cur = mask & seed
    h, w = cur.shape
    while True:
        p = np.pad(cur, 1)
        nb = cur.copy()
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                nb |= p[dy:dy + h, dx:dx + w]
        nb &= mask
        if (nb == cur).all():
            return cur
        cur = nb


def sprite_from_diff(with_obj, without, box, thresh=18, grow=2, blur=1.5, seed=None):
    """Object sprite (RGBA) = pixels of with_obj that differ from without, inside box.
    seed: optional boolean array (box-sized); only diff pixels 8-connected to it are kept."""
    x0, y0, x1, y1 = [int(v) for v in box]
    a = np.asarray(with_obj.crop((x0, y0, x1, y1)).convert('RGB')).astype(np.int16)
    b = np.asarray(without.crop((x0, y0, x1, y1)).convert('RGB')).astype(np.int16)
    d = np.abs(a - b).max(2) > thresh
    if seed is not None:
        d = connected(d, seed)
    m = Image.fromarray((d * 255).astype(np.uint8))
    if grow:
        m = m.filter(ImageFilter.MaxFilter(grow * 2 + 1))
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(blur))
    spr = with_obj.crop((x0, y0, x1, y1)).convert('RGBA')
    spr.putalpha(m)
    return spr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--box', nargs=4, type=float, required=True)
    ap.add_argument('--logical', type=float, default=1.0, help='box is in logical px; scale to image px')
    ap.add_argument('--prompt', required=True)
    ap.add_argument('--pad', type=float, default=0.5)
    ap.add_argument('--lora', type=float, default=0.45)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--mp', type=float, default=1.0)
    a = ap.parse_args()
    img = Image.open(a.src).convert('RGB')
    box = [int(v * a.logical) for v in a.box]
    res, _, rect = edit(img, box, a.prompt, a.pad, a.lora, a.seed, a.mp)
    res.save(a.out)
    print(a.out, rect)


if __name__ == '__main__':
    main()
