#!/usr/bin/env python3
"""The optional HD pack's model on this computer (setup.py hd): Real-ESRGAN x4plus_anime_6B as ONNX, run by
onnxruntime, in tiles of 256 px with a 16 px margin. upscale.MODEL = OnnxModel(path).

  python3 tools/byog/hdmodel.py <model.onnx> <in.png> <out.png>      # one picture, for a look
"""
import os
import sys

import numpy as np


def tiled(run, rgb, tile=256, pad=16):
    """rgb (HxWx3 float32 0..255) -> 4x, run(x: 1x3xhxw float32 0..1) -> 1x3x4hx4w, tile by tile."""
    h, w = rgb.shape[:2]
    x = np.ascontiguousarray((rgb.transpose(2, 0, 1)[None] / 255.0).astype(np.float32))
    out = np.zeros((3, h * 4, w * 4), np.float32)
    for y0 in range(0, h, tile):
        for x0 in range(0, w, tile):
            ya, yb = max(0, y0 - pad), min(h, y0 + tile + pad)
            xa, xb = max(0, x0 - pad), min(w, x0 + tile + pad)
            o = run(np.ascontiguousarray(x[:, :, ya:yb, xa:xb]))[0]
            oy, ox = (y0 - ya) * 4, (x0 - xa) * 4
            th, tw = min(tile, h - y0) * 4, min(tile, w - x0) * 4
            out[:, y0 * 4:y0 * 4 + th, x0 * 4:x0 * 4 + tw] = o[:, oy:oy + th, ox:ox + tw]
    return out.clip(0, 1).transpose(1, 2, 0) * 255.0


class OnnxModel:
    def __init__(self, path):
        import onnxruntime as ort
        ort.set_default_logger_severity(3)
        gpu = [p for p in ('CoreMLExecutionProvider', 'CUDAExecutionProvider', 'DmlExecutionProvider')
               if p in ort.get_available_providers()]           # (CoreML: about 5x the Mac's CPU)
        self.session = ort.InferenceSession(path, providers=gpu + ['CPUExecutionProvider'])
        self.name = self.session.get_inputs()[0].name

    def run(self, x):
        return self.session.run(None, {self.name: x})[0]

    def __call__(self, rgb):
        return tiled(self.run, rgb)


if __name__ == '__main__':
    from PIL import Image
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import upscale
    upscale.MODEL = OnnxModel(sys.argv[1])
    Image.fromarray(upscale.hd4x(np.asarray(Image.open(sys.argv[2]).convert('RGBA')))).save(sys.argv[3])
