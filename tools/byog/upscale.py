#!/usr/bin/env python3
"""1x -> 4x for the web engine's HD view (the engine's art is 4x everywhere).

  scale4x(rgba)   pixel art (cels, cursors, glyphs): Scale2x/EPX applied twice (AdvMAME4x). Smooths stair steps
                  on diagonals without inventing colours; flat areas stay exactly as the original pixels.
  nearest4x(rgba) the original pixels, 4x4 each (the low-res view: identical to the game at 1x)
  smooth4x(rgba)  painted images (backgrounds): Lanczos
  hd4x(rgba)      the HD view's 4x image: an SR model when one is set (MODEL, the optional HD pack: Real-ESRGAN
                  x4plus_anime_6B, tools/byog/hdmodel.py), else scale4x (smooth4x for painted images)
  hd_glyph(rgba)  a font glyph at 4x: with the HD pack through a signed distance field per colour (crisp, round),
                  else scale4x

The model path: colours bled into transparent areas first (no dark fringes), the alpha through the same model
(edges line up), near-transparent and near-opaque cleaned.
"""
import numpy as np

# an SR model: f(rgb float32 HxWx3, 0..255) -> 4H x 4W x 3 float32 (0..255); None: no HD pack
MODEL = None


def _pack(a):
    """HxWx4 uint8 -> HxW uint32 (for equality tests)."""
    a = np.ascontiguousarray(a)
    return a.view(np.uint32).reshape(a.shape[:2])


def scale2x(a):
    """Scale2x / EPX on an RGBA array (HxWx4 uint8) -> 2H x 2W x 4."""
    p = _pack(a)
    pad = np.pad(p, 1, mode='edge')
    B = pad[:-2, 1:-1]   # up
    D = pad[1:-1, :-2]   # left
    F = pad[1:-1, 2:]    # right
    H = pad[2:, 1:-1]    # down
    E = p
    e0 = np.where((D == B) & (B != F) & (D != H), D, E)
    e1 = np.where((B == F) & (B != D) & (F != H), F, E)
    e2 = np.where((D == H) & (D != B) & (H != F), D, E)
    e3 = np.where((H == F) & (D != H) & (B != F), F, E)
    h, w = p.shape
    out = np.empty((h * 2, w * 2), np.uint32)
    out[0::2, 0::2] = e0
    out[0::2, 1::2] = e1
    out[1::2, 0::2] = e2
    out[1::2, 1::2] = e3
    return np.ascontiguousarray(out).view(np.uint8).reshape(h * 2, w * 2, 4)


def scale4x(a):
    return scale2x(scale2x(a))


def nearest4x(a):
    return np.repeat(np.repeat(a, 4, axis=0), 4, axis=1)


def smooth4x(a):
    from PIL import Image
    im = Image.fromarray(np.ascontiguousarray(a))
    return np.asarray(im.resize((im.width * 4, im.height * 4), Image.LANCZOS))


# ---------------------------------------------------------------- the HD pack's model
def bleed_rgb(rgb, alpha, iterations=8):
    """Extend opaque colours into transparent areas so the model does not pull in black."""
    rgb = rgb.astype(np.float32)
    known = alpha > 0
    if known.all() or not known.any():
        return rgb
    acc = rgb * known[..., None]
    cnt = known.astype(np.float32)
    for _ in range(iterations):
        pad_a = np.pad(acc, ((1, 1), (1, 1), (0, 0)), mode='edge')
        pad_c = np.pad(cnt, ((1, 1), (1, 1)), mode='edge')
        s = np.zeros_like(acc)
        c = np.zeros_like(cnt)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                s += pad_a[dy:dy + acc.shape[0], dx:dx + acc.shape[1]]
                c += pad_c[dy:dy + cnt.shape[0], dx:dx + cnt.shape[1]]
        fill = (~known) & (c > 0)
        acc[fill] = s[fill] / c[fill][..., None]
        cnt[fill] = 1.0
        known = known | fill
    return acc


def model_rgba(a):
    """RGBA (HxWx4 uint8) -> 4x through MODEL: colours bled, alpha through the model too, then cleaned."""
    alpha = a[..., 3]
    if a.shape[2] == 3 or alpha.min() == 255:
        up = MODEL(a[..., :3].astype(np.float32))
        return np.dstack([np.clip(up, 0, 255), np.full(up.shape[:2], 255, np.float32)]).astype(np.uint8)
    up = MODEL(bleed_rgb(a[..., :3], alpha))
    au = MODEL(np.repeat(alpha[..., None], 3, axis=2).astype(np.float32)).mean(axis=2)
    au = np.clip((au - 8.0) * 255.0 / 239.0, 0, 255)
    return np.dstack([np.clip(up, 0, 255), au]).astype(np.uint8)


def hd4x(a, painted=False):
    if MODEL is not None:
        return model_rgba(a)
    return smooth4x(a) if painted else scale4x(a)


# ---------------------------------------------------------------- font glyphs through a signed distance field
def _edt(mask):
    """Euclidean distance from every pixel to the nearest False pixel (brute force: glyphs are tiny)."""
    h, w = mask.shape
    ys, xs = np.nonzero(~mask)
    if len(ys) == 0:
        return np.full(mask.shape, float(h + w), np.float32)
    gy, gx = np.mgrid[0:h, 0:w]
    d2 = (gy.reshape(-1, 1) - ys.reshape(1, -1)) ** 2 + (gx.reshape(-1, 1) - xs.reshape(1, -1)) ** 2
    return np.sqrt(d2.min(axis=1)).reshape(h, w).astype(np.float32)


def _blur(f, sigma=0.35):
    """A small separable Gaussian (sigma 0.35 rounds the pixel staircase off)."""
    k = np.exp(-0.5 * (np.arange(-1, 2) / sigma) ** 2)
    k /= k.sum()
    p = np.pad(f, 1, mode='edge')
    f = k[0] * p[:-2, 1:-1] + k[1] * p[1:-1, 1:-1] + k[2] * p[2:, 1:-1]
    p = np.pad(f, 1, mode='edge')
    return k[0] * p[1:-1, :-2] + k[1] * p[1:-1, 1:-1] + k[2] * p[1:-1, 2:]


def _sdf_layer(mask, scale=4):
    from PIL import Image
    sdf = _blur(_edt(mask) - _edt(~mask)).astype(np.float32)
    up = np.asarray(Image.fromarray(sdf, 'F').resize((mask.shape[1] * scale, mask.shape[0] * scale), Image.BICUBIC))
    edge = 0.5 / scale
    return np.clip((up + edge) / (2 * edge) * 255.0, 0, 255)


def sdf_glyph(a, scale=4):
    """A glyph (fill + outline colours) at 4x: one SDF layer per colour, darker first, brighter on top."""
    rgb, on = a[..., :3], a[..., 3] > 0
    h, w = on.shape
    out_rgb = np.zeros((h * scale, w * scale, 3), np.float32)
    out_a = np.zeros((h * scale, w * scale), np.float32)
    colors = {tuple(int(v) for v in c) for c in rgb[on].reshape(-1, 3)} if on.any() else set()
    for col in sorted(colors, key=sum):
        m = on & np.all(rgb == np.array(col, np.uint8), axis=-1)
        cov = _sdf_layer(m, scale) / 255.0
        out_rgb = out_rgb * (1 - cov[..., None]) + np.array(col, np.float32) * cov[..., None]
        out_a = np.maximum(out_a, cov * 255.0)
    return np.dstack([out_rgb, out_a]).clip(0, 255).astype(np.uint8)


def hd_glyph(a):
    return sdf_glyph(a) if MODEL is not None and a.size else scale4x(a)
