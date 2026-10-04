#!/usr/bin/env python3
"""Color lock: keep the fine detail (linework, texture) of image B but take the low-frequency
lighting and color of image A (same framing). Works in YCbCr: B - blur(B) + blur(A).

  tools/colorlock.py lighting_src.png detail_src.png out.png [--sigma 12] [--light 0.8] [--color 1.0]
"""
import argparse

import numpy as np
from PIL import Image, ImageFilter


def lab(img):
    # YCbCr (unsigned chroma with 128 offset); PIL's LAB stores a/b as wrapped signed bytes
    return np.asarray(img.convert('RGB').convert('YCbCr')).astype(np.float32)


def blur(arr, sigma):
    out = np.empty_like(arr)
    for ch in range(arr.shape[2]):
        im = Image.fromarray(np.clip(arr[:, :, ch], 0, 255).astype(np.uint8))
        out[:, :, ch] = np.asarray(im.filter(ImageFilter.GaussianBlur(sigma))).astype(np.float32)
    return out


def colorlock(a, b, sigma=12.0, light=0.8, color=1.0):
    """a: lighting/color source, b: detail source (PIL). Returns PIL RGB at b's size."""
    a = a.convert('RGB').resize(b.size, Image.LANCZOS)
    A, B = lab(a), lab(b)
    lo_a, lo_b = blur(A, sigma), blur(B, sigma)
    out = B.copy()
    out[:, :, 0] = B[:, :, 0] + light * (lo_a[:, :, 0] - lo_b[:, :, 0])
    out[:, :, 1:] = B[:, :, 1:] + color * (lo_a[:, :, 1:] - lo_b[:, :, 1:])
    out = np.clip(out, 0, 255).astype(np.uint8)
    return Image.fromarray(out, 'YCbCr').convert('RGB')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a')
    ap.add_argument('b')
    ap.add_argument('out')
    ap.add_argument('--sigma', type=float, default=12.0)
    ap.add_argument('--light', type=float, default=0.8)
    ap.add_argument('--color', type=float, default=1.0)
    x = ap.parse_args()
    colorlock(Image.open(x.a), Image.open(x.b), x.sigma, x.light, x.color).save(x.out)


if __name__ == '__main__':
    main()
