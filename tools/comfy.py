#!/usr/bin/env python3
"""ComfyUI client for the level editor's picture generation (the ✨ buttons): builds the API graphs in code.

  klein()      Flux.2 Klein: text-to-image or edit, with reference images (ReferenceLatent); optional background
               removal (BiRefNet) and SAM 3 segmentation in the same run
  remove_bg()  background removal alone;  sam3()  text-prompted segmentation alone
  run()        queue any API-format graph and collect its images

The server address comes from the editor (⚙) or $COMFY_URL; the model file names from tools/comfy_models.json.
"""
import io
import json
import os
import time
import uuid

import requests
from PIL import Image

URL = os.environ.get('COMFY_URL', 'http://127.0.0.1:8188')
_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'comfy_models.json')
try:
    MODELS = json.load(open(_CFG, encoding='utf-8'))
except (OSError, ValueError):
    MODELS = {}
KLEIN_UNET = MODELS.get('klein_unet') or 'flux-2-klein-9b-fp8.safetensors'
KLEIN_CLIP = MODELS.get('klein_text_encoder') or 'qwen_3_8b_fp8mixed.safetensors'
FLUX2_VAE = MODELS.get('flux2_vae') or 'flux2-vae.safetensors'
BG_MODEL = MODELS.get('background_removal') or 'birefnet.safetensors'
SAM3_MODEL = MODELS.get('sam3') or 'sam3.1_multiplex_fp16.safetensors'
CONSISTENCY_LORA = MODELS.get('edit_lora') or None     # optional; callers pass it, empty names are skipped


class Comfy:
    def __init__(self, url=URL):
        self.url = url.rstrip('/')
        self.client_id = uuid.uuid4().hex
        self.last_exec = None

    def upload(self, img, name, subfolder='cmi-levels'):
        """Uploads a PIL image as PNG to the server's input folder; returns the LoadImage value."""
        buf = io.BytesIO()
        img.save(buf, 'PNG')
        r = requests.post(f'{self.url}/upload/image', files={'image': (name, buf.getvalue(), 'image/png')},
                          data={'overwrite': 'true', 'subfolder': subfolder, 'type': 'input'}, timeout=120)
        r.raise_for_status()
        j = r.json()
        return f"{j['subfolder']}/{j['name']}" if j.get('subfolder') else j['name']

    def run(self, graph, timeout=3600, want='images'):
        """Queues an API graph and waits. want='images' -> PIL images of all image outputs; 'by_node' -> {node id:
        [images]}."""
        r = requests.post(f'{self.url}/prompt', json={'prompt': graph, 'client_id': self.client_id}, timeout=60)
        if r.status_code != 200:
            raise RuntimeError(f'ComfyUI rejected the prompt: {r.text[:3000]}')
        pid = r.json()['prompt_id']
        t0 = time.time()
        while True:
            h = requests.get(f'{self.url}/history/{pid}', timeout=30).json()
            if pid in h:
                entry = h[pid]
                status = entry.get('status', {})
                if status.get('status_str') == 'error':
                    raise RuntimeError(f'ComfyUI error: {json.dumps(status)[:3000]}')
                if status.get('completed') or entry.get('outputs'):
                    break
            if time.time() - t0 > timeout:
                raise TimeoutError(f'ComfyUI prompt {pid} did not finish in {timeout} s')
            time.sleep(0.2)
        out = {} if want == 'by_node' else []
        for node_id, node_out in entry['outputs'].items():
            for it in node_out.get('images', []) or []:
                if not isinstance(it, dict) or 'filename' not in it:
                    continue
                v = requests.get(f'{self.url}/view', params={'filename': it['filename'], 'subfolder': it.get('subfolder', ''),
                                                              'type': it.get('type', 'output')}, timeout=300)
                v.raise_for_status()
                im = Image.open(io.BytesIO(v.content)).convert('RGBA')
                if want == 'by_node':
                    out.setdefault(node_id, []).append(im)
                else:
                    out.append(im)
        return out

    def klein(self, prompt, size=None, refs=(), seed=0, steps=5, loras=(), ref_mp=1.0, edit=None,
              edit_mp=None, name='img', cutout=False, segment=None, seg_threshold=0.35):
        """Flux.2 Klein. size=(w, h) for text-to-image (multiples of 16); edit: a PIL image to edit (image 1, its size
        sets the output size, or edit_mp megapixels); refs: more reference images; loras: [(file, strength)], empty
        names skipped. cutout=True -> transparent RGBA (background removal in the same run); segment='text' -> also
        SAM 3's mask of that text: (image, mask)."""
        g = {'unet': {'class_type': 'UNETLoader', 'inputs': {'unet_name': KLEIN_UNET, 'weight_dtype': 'default'}}}
        model = ['unet', 0]
        for i, (ln, ls) in enumerate(l for l in loras if l and l[0]):
            g[f'lora{i}'] = {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': model, 'lora_name': ln, 'strength_model': float(ls)}}
            model = [f'lora{i}', 0]
        g['clip'] = {'class_type': 'CLIPLoader', 'inputs': {'clip_name': KLEIN_CLIP, 'type': 'flux2', 'device': 'default'}}
        g['vae'] = {'class_type': 'VAELoader', 'inputs': {'vae_name': FLUX2_VAE}}
        g['pos'] = {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['clip', 0]}}
        g['neg'] = {'class_type': 'ConditioningZeroOut', 'inputs': {'conditioning': ['pos', 0]}}
        pos, neg = ['pos', 0], ['neg', 0]
        images = ([edit] if edit is not None else []) + list(refs)
        for i, im in enumerate(images):
            p = f'ref{i}'
            g[p + '_load'] = {'class_type': 'LoadImage', 'inputs': {'image': self.upload(im.convert('RGB'), f'{name}_ref{i}.png')}}
            mp = (edit_mp or 1.0) if (edit is not None and i == 0) else ref_mp
            if edit is not None and i == 0 and edit_mp is None:
                g[p + '_scale'] = {'class_type': 'ImageScale', 'inputs': {'image': [p + '_load', 0], 'upscale_method': 'lanczos',
                                                                          'width': im.width // 16 * 16, 'height': im.height // 16 * 16, 'crop': 'center'}}
            else:
                g[p + '_scale'] = {'class_type': 'ImageScaleToTotalPixels', 'inputs': {'image': [p + '_load', 0], 'upscale_method': 'lanczos',
                                                                                       'megapixels': float(mp), 'resolution_steps': 16}}
            g[p + '_enc'] = {'class_type': 'VAEEncode', 'inputs': {'pixels': [p + '_scale', 0], 'vae': ['vae', 0]}}
            g[p + '_pos'] = {'class_type': 'ReferenceLatent', 'inputs': {'conditioning': pos, 'latent': [p + '_enc', 0]}}
            g[p + '_neg'] = {'class_type': 'ReferenceLatent', 'inputs': {'conditioning': neg, 'latent': [p + '_enc', 0]}}
            pos, neg = [p + '_pos', 0], [p + '_neg', 0]
        if edit is not None:
            g['size'] = {'class_type': 'GetImageSize', 'inputs': {'image': ['ref0_scale', 0]}}
            w, h = ['size', 0], ['size', 1]
        else:
            w, h = int(size[0]) // 16 * 16, int(size[1]) // 16 * 16
        g['latent'] = {'class_type': 'EmptyFlux2LatentImage', 'inputs': {'width': w, 'height': h, 'batch_size': 1}}
        g['sched'] = {'class_type': 'Flux2Scheduler', 'inputs': {'steps': int(steps), 'width': w, 'height': h}}
        g['sampler'] = {'class_type': 'KSamplerSelect', 'inputs': {'sampler_name': 'euler'}}
        g['noise'] = {'class_type': 'RandomNoise', 'inputs': {'noise_seed': int(seed)}}
        g['guider'] = {'class_type': 'CFGGuider', 'inputs': {'cfg': 1, 'model': model, 'positive': pos, 'negative': neg}}
        g['sample'] = {'class_type': 'SamplerCustomAdvanced', 'inputs': {'noise': ['noise', 0], 'guider': ['guider', 0], 'sampler': ['sampler', 0],
                                                                         'sigmas': ['sched', 0], 'latent_image': ['latent', 0]}}
        g['decode'] = {'class_type': 'VAEDecode', 'inputs': {'samples': ['sample', 0], 'vae': ['vae', 0]}}
        img = ['decode', 0]
        if cutout:
            g['rbm'] = {'class_type': 'LoadBackgroundRemovalModel', 'inputs': {'bg_removal_name': BG_MODEL}}
            g['rb'] = {'class_type': 'RemoveBackground', 'inputs': {'image': img, 'bg_removal_model': ['rbm', 0]}}
            g['rbi'] = {'class_type': 'InvertMask', 'inputs': {'mask': ['rb', 0]}}        # JoinImageWithAlpha: 1 = transparent
            g['join'] = {'class_type': 'JoinImageWithAlpha', 'inputs': {'image': img, 'alpha': ['rbi', 0]}}
            img = ['join', 0]
        g['out'] = {'class_type': 'PreviewImage', 'inputs': {'images': img}}
        if segment:
            g['sk'] = {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': SAM3_MODEL}}
            g['stxt'] = {'class_type': 'CLIPTextEncode', 'inputs': {'text': segment, 'clip': ['sk', 1]}}
            g['sdet'] = {'class_type': 'SAM3_Detect', 'inputs': {'model': ['sk', 0], 'image': ['decode', 0], 'conditioning': ['stxt', 0],
                                                                 'threshold': float(seg_threshold), 'refine_iterations': 2,
                                                                 'individual_masks': False}}
            g['sm2i'] = {'class_type': 'MaskToImage', 'inputs': {'mask': ['sdet', 0]}}
            g['sout'] = {'class_type': 'PreviewImage', 'inputs': {'images': ['sm2i', 0]}}
        out = self.run(g, want='by_node')
        if not out.get('out'):
            raise RuntimeError('ComfyUI returned no image')
        res = out['out'][0] if cutout else out['out'][0].convert('RGB')
        if segment:
            m = out.get('sout')
            mask = m[0].convert('L').resize(res.size, Image.LANCZOS) if m else Image.new('L', res.size, 0)
            return res, mask
        return res

    def sam3(self, image, text, threshold=0.5, refine=2, points=None, neg_points=None, name='sam'):
        """SAM 3 text-prompted segmentation -> PIL 'L' mask (union of detections), same size as image."""
        g = {
            'ck': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': SAM3_MODEL}},
            'img': {'class_type': 'LoadImage', 'inputs': {'image': self.upload(image.convert('RGB'), f'{name}.png')}},
            'txt': {'class_type': 'CLIPTextEncode', 'inputs': {'text': text, 'clip': ['ck', 1]}},
            'det': {'class_type': 'SAM3_Detect', 'inputs': {'model': ['ck', 0], 'image': ['img', 0], 'conditioning': ['txt', 0],
                                                            'threshold': float(threshold), 'refine_iterations': int(refine),
                                                            'individual_masks': False}},
            'm2i': {'class_type': 'MaskToImage', 'inputs': {'mask': ['det', 0]}},
            'out': {'class_type': 'PreviewImage', 'inputs': {'images': ['m2i', 0]}},
        }
        if points:
            g['det']['inputs']['positive_coords'] = json.dumps([{'x': int(x), 'y': int(y)} for x, y in points])
        if neg_points:
            g['det']['inputs']['negative_coords'] = json.dumps([{'x': int(x), 'y': int(y)} for x, y in neg_points])
        out = self.run(g)
        return out[0].convert('L').resize(image.size, Image.LANCZOS) if out else Image.new('L', image.size, 0)

    def remove_bg(self, image, name='rbg'):
        """Background removal -> RGBA."""
        g = {
            'img': {'class_type': 'LoadImage', 'inputs': {'image': self.upload(image.convert('RGB'), f'{name}.png')}},
            'mdl': {'class_type': 'LoadBackgroundRemovalModel', 'inputs': {'bg_removal_name': BG_MODEL}},
            'rb': {'class_type': 'RemoveBackground', 'inputs': {'image': ['img', 0], 'bg_removal_model': ['mdl', 0]}},
            'm2i': {'class_type': 'MaskToImage', 'inputs': {'mask': ['rb', 0]}},
            'out': {'class_type': 'PreviewImage', 'inputs': {'images': ['m2i', 0]}},
        }
        out = self.run(g)
        m = out[0].convert('L').resize(image.size, Image.LANCZOS)
        rgba = image.convert('RGBA')
        rgba.putalpha(m)
        return rgba
