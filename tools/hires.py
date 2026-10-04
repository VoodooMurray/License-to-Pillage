#!/usr/bin/env python3
"""The faithful jump to full resolution (the HD art recipe): Lanczos presize, Flux2
Klein edit at the target size with "same image in high resolution",
then color lock back to the draft. Wide images are done in overlapping tiles (<= ~4.7 MP each).

  tools/hires.py draft.png out.png --size 2560x1920
"""
import argparse
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comfy import Comfy, CONSISTENCY_LORA  # noqa: E402
from colorlock import colorlock  # noqa: E402

PROMPT = ("same image in high resolution, sharper and more detailed, keep everything exactly the same\n\n"
          "crisp clean ink outlines, smooth painted shading, fine detail")


def hires(draft, W, H, seed=2, lora=0.7, prompt=PROMPT, tile_w=2560, overlap=256, c=None, name='hires'):
    c = c or Comfy()
    big = draft.convert('RGB').resize((W, H), Image.LANCZOS)
    if W <= tile_w:
        out = c.klein(prompt, edit=big, seed=seed, loras=[(CONSISTENCY_LORA, lora)], name=name)
        out = out.resize((W, H), Image.LANCZOS)
    else:
        n = -(-(W - overlap) // (tile_w - overlap))
        step = (W - tile_w) / (n - 1)
        xs = [min(int(round(i * step)) // 16 * 16, W - tile_w) for i in range(n)]
        # one narrow crossfade centered in each overlap (never average two renders over a wide band)
        seams = [((xs[i + 1] + xs[i] + tile_w) // 2) for i in range(n - 1)]
        acc = np.zeros((H, W, 3), np.float32)
        wsum = np.zeros((H, W, 1), np.float32)
        X = np.arange(W, dtype=np.float32)
        for i, x0 in enumerate(xs):
            tile = big.crop((x0, 0, x0 + tile_w, H))
            t = c.klein(prompt, edit=tile, seed=seed, loras=[(CONSISTENCY_LORA, lora)], name=f'{name}_t{i}')
            t = np.asarray(t.resize((tile_w, H), Image.LANCZOS)).astype(np.float32)
            w = np.ones(W, np.float32)
            if i > 0:
                w = np.minimum(w, np.clip((X - (seams[i - 1] - overlap / 2)) / overlap, 0, 1))
            if i < n - 1:
                w = np.minimum(w, np.clip(((seams[i] + overlap / 2) - X) / overlap, 0, 1))
            w = w[x0:x0 + tile_w]
            acc[:, x0:x0 + tile_w] += t * w[None, :, None]
            wsum[:, x0:x0 + tile_w] += w[None, :, None]
            print(f'  tile {i + 1}/{n} x0={x0}', flush=True)
        out = Image.fromarray(np.clip(acc / np.maximum(wsum, 1e-6), 0, 255).astype(np.uint8))
    # lighting/colors from the draft (sigma in output px ~ 8 draft px)
    sigma = 8 * W / draft.width
    return colorlock(draft, out, sigma=sigma, light=1.0, color=1.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--size', default='2560x1920')
    ap.add_argument('--seed', type=int, default=2)
    ap.add_argument('--lora', type=float, default=0.7)
    a = ap.parse_args()
    W, H = (int(v) for v in a.size.split('x'))
    t0 = time.time()
    img = hires(Image.open(a.src), W, H, a.seed, a.lora)
    img.save(a.out)
    print(a.out, img.size, f'{time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
