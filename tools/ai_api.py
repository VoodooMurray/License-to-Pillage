"""The level editor's ComfyUI endpoints (tools/serve.py routes /api/ai/... here; generation in tools/ai_gen.py).

  POST /api/ai/status                 {comfy}  -> {ok, url, gpu, vram_free_mb}
  POST /api/ai/generate?game=         {comfy, kind: object|item|character|background, mode: new|repaint|inpaint,
                                       prompt, count, room?, area? [x, y, w, h] (logical: new objects),
                                       region? [x, y, w, h] (inpaint, in the picture's px), target? {kind, id, room, state},
                                       style? (background: match the room's look)} -> {job}
  GET  /api/ai/job/<id>                -> {status, done, total, candidates: [{i, preview, image, pos, size}], ...}
  POST /api/ai/job/<id>/cancel
  POST /api/ai/job/<id>/use?game=      {i, name?, id?, height?, look?, room?, newRoom?: {id, name}} -> the candidate into
                                       the game (written at once; the old picture backed up); backgrounds finish later
                                       (4x jump): poll the job (use: {status, result})
  POST /api/ai/job/<id>/keep?game=     {i, name} -> into the library
"""
import io
import json
import os
import re
import threading
import time
import uuid

from PIL import Image

import ai_gen
import library
import projects
from projects import ProjectError, project_dir, node, roomsrc_patch, write_atomic, backup, ID, S

JOBS = {}


def url_of(root):
    return lambda p: '/' + os.path.relpath(p, root).replace(os.sep, '/') if p else None


def room_def(gd, rid):
    f = os.path.join(gd, 'rooms', f'{rid}.js')
    if not ID.match(rid or '') or not os.path.isfile(f):
        raise ProjectError('no such room', 404)
    return f, node('roomsrc.mjs', 'dump', f)['value']


def bg_path(gd, rdef):
    img = ((rdef.get('layers') or [{}])[0] or {}).get('img')
    if not isinstance(img, str):
        raise ProjectError("the room's first layer is not a plain image path", 422)
    return os.path.join(gd, img)


def on_grey_ref(path, size=None):
    im = Image.open(path).convert('RGBA')
    if size:
        im.thumbnail(size)
    base = Image.new('RGB', (im.width + 64, im.height + 64), ai_gen.GREY)
    base.paste(im, (32, 32), im)
    return base


def target_image(root, gd, t):
    """The picture a repaint / inpaint works on: (PIL image, path, cut out?)."""
    k = t.get('kind')
    if k == 'background':
        _, rdef = room_def(gd, t.get('room'))
        p = bg_path(gd, rdef)
        return Image.open(p).convert('RGB'), p, False
    if k == 'object':
        _, rdef = room_def(gd, t.get('room'))
        o = next((x for x in rdef.get('objects') or [] if isinstance(x, dict) and x.get('id') == t.get('id')), None)
        sts = (o or {}).get('states') if isinstance((o or {}).get('states'), dict) else {}
        key = t.get('state') if t.get('state') in sts else (o or {}).get('state')
        st = sts.get(key) if key in sts else next((v for v in sts.values() if isinstance(v, dict) and isinstance(v.get('img'), str)), None)
        if not st or not isinstance(st.get('img'), str):
            raise ProjectError('this hotspot has no picture to repaint', 422)
        p = os.path.join(gd, st['img'])
        return Image.open(p).convert('RGBA'), p, True
    if k == 'item':
        it = (node('roomsrc.mjs', 'dump', os.path.join(gd, 'game.js'))['value'].get('items') or {}).get(t.get('id'))
        if not it or not isinstance(it.get('icon'), str):
            raise ProjectError('no such item', 404)
        p = os.path.join(gd, it['icon'])
        return Image.open(p).convert('RGBA'), p, True
    if k == 'character':
        f = os.path.join(gd, 'actors', t.get('id') or '', 'actor.json')
        if not os.path.isfile(f):
            raise ProjectError('no costume of this character in the project', 404)
        a = json.load(open(f))
        if not projects.is_picture_costume(a) and len(a.get('cels') or {}) != 1:
            raise ProjectError('an animated costume (several pictures): only characters made from pictures are repainted here', 422)
        # the standing picture (also for a new talking picture: made from it)
        p = os.path.join(os.path.dirname(f), (a['cels'].get('0') or next(iter(a['cels'].values())))['file'])
        return Image.open(p).convert('RGBA'), p, True
    raise ProjectError('repaint: object, item, character or background')


def generate(root, key, body):
    gd = project_dir(root, key)
    projects.guard(key, False)
    c = ai_gen.comfy(body.get('comfy'))
    kind, mode = body.get('kind'), body.get('mode') or 'new'
    prompt = (body.get('prompt') or '').strip()[:400]
    if not prompt:
        raise ProjectError('describe what to make')
    count = max(1, min(10, int(body.get('count') or 6)))
    ctx = {}
    # the project's style pack (style.json): its prompt replaces the CMI style everywhere, its first
    # reference image replaces the CMI-derived references (Guybrush, LP's chicken) below
    style = projects.load_style(gd)
    ctx['style'] = style
    custom = bool(style.get('prompt'))
    sref = next((os.path.join(gd, r) for r in style.get('refs') or [] if os.path.isfile(os.path.join(gd, r))), None)
    spec = {'kind': kind, 'mode': mode, 'prompt': prompt, 'count': count}
    if style:
        spec['style'] = {k: v for k, v in style.items() if k != 'keep'}
    if mode == 'new':
        if kind == 'object':
            _, rdef = room_def(gd, body.get('room'))
            area = [float(v) for v in body.get('area') or []]
            if len(area) != 4 or area[2] < 8 or area[3] < 8:
                raise ProjectError('drag an area in the room first')
            ctx['bg4'] = Image.open(bg_path(gd, rdef)).convert('RGB')
            spec.update(area=area, room=body.get('room'))
        elif kind == 'item':
            # an existing item of the game keeps the icons consistent; else the style ref; LP's chicken
            # only for the CMI default (it would fight a custom style prompt)
            refs = [os.path.join(gd, 'items', f) for f in sorted(os.listdir(os.path.join(gd, 'items')))] if os.path.isdir(os.path.join(gd, 'items')) else []
            refs = [r for r in refs if r.endswith('.png')]
            if not refs and sref:
                refs = [sref]
            elif not refs and not custom:
                refs = [os.path.join(root, 'game', 'items', 'chicken.png')]
            ctx['ref'] = on_grey_ref(refs[0], (320, 224)) if refs and os.path.isfile(refs[0]) else None
        elif kind == 'character':
            if sref:
                ctx['ref'] = on_grey_ref(sref, (600, 1000))
                ctx['ref_is_character'] = False
            elif not custom:
                # Guybrush's stand picture (cmi/actors/guybrush) as the style reference
                g = os.path.join(root, 'cmi', 'actors', 'guybrush')
                ref = None
                if os.path.isfile(os.path.join(g, 'actor.json')):
                    a = json.load(open(os.path.join(g, 'actor.json')))
                    stand = (a.get('roles') or {}).get('stand')
                    anim = stand.get('S') if isinstance(stand, dict) else stand
                    anim = anim.get('anim') if isinstance(anim, dict) else anim
                    try:
                        cel = a['anims'][anim]['limbs'][0]['frames'][0]['cels'][0]['cel']
                        ref = on_grey_ref(os.path.join(g, a['cels'][str(cel)]['file']), (600, 1000))
                    except (KeyError, IndexError, TypeError):
                        ref = None
                ctx['ref'] = ref
        elif kind == 'background':
            w, h = 640, 480
            if body.get('room'):
                _, rdef = room_def(gd, body.get('room'))
                w, h = (rdef.get('size') or [640, 480])
                if body.get('style'):
                    ctx['ref'] = Image.open(bg_path(gd, rdef)).convert('RGB').resize((w, h), Image.LANCZOS)
            if 'ref' not in ctx and sref:
                ctx['ref'] = Image.open(sref).convert('RGB')
            if body.get('width'):
                w = max(640, min(1920, int(body['width']) // 8 * 8))
            ctx['size'] = (w, h)
            spec.update(size=[w, h], room=body.get('room'))
        elif kind == 'theme':
            # the whole interface as one consistent set (coin, cursors, arrows, chest); heavier per
            # candidate (5 generations), so fewer by default
            if not body.get('count'):
                spec['count'] = count = 2
            hl = (projects.load_theme(gd).get('colors') or {}).get('highlight')
            if hl:
                ctx['highlight'] = tuple(int(hl[i:i + 2], 16) for i in (1, 3, 5))
        elif kind == 'card':
            # a full-screen card (game.cards.<id>); the title lettering painted in when given
            cid = body.get('card') or ''
            if not re.match(r'^[a-z][a-z0-9_]{0,40}$', cid):
                raise ProjectError('card: which card id this is for')
            spec['card'] = cid
            ctx['title'] = (body.get('title') or '').strip()[:60] or None
            if sref:
                ctx['ref'] = Image.open(sref).convert('RGB')
        else:
            raise ProjectError('generate: object, item, character, background, card or theme')
    elif mode in ('repaint', 'inpaint'):
        t = body.get('target') or {}
        img, path, cut = target_image(root, gd, t)
        ctx.update(image=img, cut=cut)
        spec.update(target=t, path=os.path.relpath(path, gd))
        if mode == 'inpaint':
            region = [int(round(float(v))) for v in body.get('region') or []]
            if len(region) != 4 or region[2] < 8 or region[3] < 8:
                raise ProjectError('drag the part to repaint first')
            spec['region'] = region
    else:
        raise ProjectError('mode: new, repaint or inpaint')
    # a new picture for something that exists (✨ New… under its picture): made from the description alone, and Use
    # puts it in place of the old one
    if mode == 'new' and body.get('replace'):
        r = body['replace']
        if not isinstance(r, dict) or r.get('kind') != kind or not r.get('id'):
            raise ProjectError('replace: {kind, id, room?} of the same kind')
        spec['replace'] = {'kind': kind, 'id': r['id'], 'room': r.get('room')}
    jid = time.strftime('%H%M%S') + '_' + uuid.uuid4().hex[:4]
    job = ai_gen.Job(jid, spec, os.path.join(gd, 'library', 'gen', jid))
    job.key = key
    JOBS[jid] = job
    threading.Thread(target=ai_gen.run, args=(job, c, ctx), daemon=True).start()
    return {'job': jid}


def job_of(jid):
    j = JOBS.get(jid)
    if not j:
        raise ProjectError('no such job (the server was restarted?)', 404)
    return j


def cand(j, i):
    cd = next((x for x in j.candidates if x['i'] == int(i)), None)
    if not cd:
        raise ProjectError('no such candidate', 404)
    return cd


def slug(s, n=30):
    return re.sub(r'[^a-z0-9]+', '_', (s or '').lower()).strip('_')[:n] or 'thing'


def short_name(prompt):
    words = re.sub(r'[^\w\s\'-]', ' ', prompt).split()
    stop = {'a', 'an', 'the', 'some', 'with', 'and', 'of', 'in', 'on'}
    while words and words[0].lower() in stop:
        words.pop(0)
    words = words[:3]
    while words and words[-1].lower() in stop:          # "wooden barrel of" -> "wooden barrel"
        words.pop()
    return ' '.join(words).lower() or 'thing'


def replace_with(root, key, gd, j, cd, img):
    """Use for ✨ New…: the new picture in place of the old one (backed up)."""
    t = j.spec['replace']
    data = open(cd['image'], 'rb').read()
    if t['kind'] == 'character':
        return {'kind': 'character', 'replaced': True, **projects.replace_actor_image(root, key, t['id'], data, origin='generated')}
    if t['kind'] == 'item':
        _, path, _ = target_image(root, gd, {'kind': 'item', 'id': t['id']})
        backup(root, path)
        write_atomic(path, projects.png(projects.fit_icon(data)))
        projects.provenance_note(gd, path, 'generated')
        return {'kind': 'item', 'replaced': True, 'path': os.path.relpath(path, gd)}
    if t['kind'] == 'object':
        # painted into the room where the old picture was: its state gets the new picture and position
        f, rdef = room_def(gd, t['room'])
        o = next((x for x in rdef.get('objects') or [] if isinstance(x, dict) and x.get('id') == t['id']), None)
        if not o:
            raise ProjectError('no such hotspot', 404)
        sts = o.get('states') if isinstance(o.get('states'), dict) else {}
        k = o.get('state') if o.get('state') in sts else next((n for n, v in sts.items() if isinstance(v, dict) and v.get('img')), None) or 'on'
        old = sts.get(k) if isinstance(sts.get(k), dict) else {}
        rel = f"rooms/{t['room']}/{t['id']}.png"
        if isinstance(old.get('img'), str) and old['img'] != rel and os.path.exists(os.path.join(gd, rel)):
            rel = f"rooms/{t['room']}/{t['id']}_{j.id}.png"
        backup(root, os.path.join(gd, rel))
        write_atomic(os.path.join(gd, rel), data)
        projects.provenance_note(gd, rel, 'generated')
        x, y = cd['pos']
        edits = [{'op': 'set', 'path': f"objects[id={t['id']}].states.{k}", 'value': {**old, 'img': rel, 'x': x, 'y': y}}]
        if o.get('state') != k:
            edits.append({'op': 'set', 'path': f"objects[id={t['id']}].state", 'value': k})
        roomsrc_patch(root, f, edits)
        return {'kind': 'object', 'replaced': True, 'id': t['id'], 'room': t['room'], 'path': rel}
    raise ProjectError('replace: object, item or character')


def use(root, key, jid, body):
    j = job_of(jid)
    gd = project_dir(root, key)
    cd = cand(j, body.get('i'))
    img = Image.open(cd['image'])
    k, mode = j.kind, j.mode
    name = (body.get('name') or short_name(j.spec['prompt'])).strip()[:60]
    if mode == 'new' and j.spec.get('replace'):
        return replace_with(root, key, gd, j, cd, img)
    if mode in ('repaint', 'inpaint'):
        t = j.spec['target']
        path = os.path.join(gd, j.spec['path'])
        if t['kind'] == 'character':
            b = io.BytesIO()
            img.save(b, 'PNG')
            if t.get('pose') == 'talk':
                return {'kind': 'character', 'replaced': True, **projects.actor_pose(root, key, t['id'], talk=b.getvalue(), origin='generated')}
            return {'kind': 'character', **projects.replace_actor_image(root, key, t['id'], b.getvalue())}
        backup(root, path)
        b = io.BytesIO()
        if path.lower().endswith(('.jpg', '.jpeg')):
            img.convert('RGB').save(b, 'JPEG', quality=92)
        else:
            img.save(b, 'PNG', optimize=True)
        write_atomic(path, b.getvalue())
        projects.provenance_note(gd, path, 'generated')
        return {'kind': t['kind'], 'path': os.path.relpath(path, gd), 'replaced': True}
    if k == 'object':
        room = j.spec['room']
        f, rdef = room_def(gd, room)
        ids = {o.get('id') for o in rdef.get('objects') or [] if isinstance(o, dict)}
        oid = library.unique(ids, slug(body.get('id') or name))
        rel = f'rooms/{room}/{oid}.png'
        write_atomic(os.path.join(gd, rel), open(cd['image'], 'rb').read())
        projects.provenance_note(gd, rel, 'generated')
        x, y = cd['pos']
        w, h = round(img.width / S, 2), round(img.height / S, 2)
        value = {'id': oid, 'name': name, 'box': [round(x), round(y), max(4, round(w)), max(4, round(h))],
                 'states': {'on': {'img': rel, 'x': x, 'y': y}}, 'state': 'on'}
        roomsrc_patch(root, f, [{'op': 'insert', 'path': 'objects', 'value': value}])
        return {'kind': 'object', 'id': oid, 'room': room}
    if k == 'item':
        items = node('roomsrc.mjs', 'dump', os.path.join(gd, 'game.js'))['value'].get('items') or {}
        iid = library.unique(set(items), slug(body.get('id') or name))
        return {'kind': 'item', **projects.create_item(root, key, iid, name, open(cd['image'], 'rb').read(), body.get('look'), origin='generated')}
    if k == 'character':
        actors = node('roomsrc.mjs', 'dump', os.path.join(gd, 'game.js'))['value'].get('actors') or {}
        aid = library.unique(set(actors), slug(body.get('id') or name))
        return {'kind': 'character', **projects.create_actor(root, key, aid, name, image=open(cd['image'], 'rb').read(),
                                                              height=body.get('height') or 280, color=body.get('color') or '#9fe0ff', origin='generated')}
    if k == 'card':
        cid = j.spec['card']
        rel = f'cards/{cid}.jpg'
        backup(root, os.path.join(gd, rel))
        b = io.BytesIO()
        img.convert('RGB').resize((2560, 1920), Image.LANCZOS).save(b, 'JPEG', quality=92)
        write_atomic(os.path.join(gd, rel), b.getvalue())
        projects.provenance_note(gd, rel, 'generated')
        roomsrc_patch(root, os.path.join(gd, 'game.js'), [{'op': 'set', 'path': f'cards.{cid}', 'value': rel}])
        return {'kind': 'card', 'card': cid, 'path': rel}
    if k == 'theme':
        # every generated piece into ui/, theme.json pointing at them (colors and fonts are kept)
        files = cd.get('files') or {}
        if not files:
            raise ProjectError('this candidate has no theme files', 422)
        theme = projects.load_theme(gd)
        for slot, src in sorted(files.items()):
            rel = 'ui/' + slot.replace('.', '_').lower() + os.path.splitext(src)[1]
            backup(root, os.path.join(gd, rel))
            write_atomic(os.path.join(gd, rel), open(src, 'rb').read())
            projects.provenance_note(gd, rel, 'generated')
            if '.' in slot:
                g, sub = slot.split('.', 1)
                theme.setdefault(g, {})[sub] = rel
            else:
                theme[slot] = rel
        return {'kind': 'theme', **projects.save_theme(root, key, theme)}
    if k == 'background':
        # the 4x jump takes a while: done in the background, the client polls the job
        if getattr(j, 'use_state', None) in ('running',):
            raise ProjectError('already being used', 409)
        j.use_state, j.use_result = 'running', None

        def finish():
            try:
                from hires import hires
                w, h = j.spec['size']
                with ai_gen.GPU:
                    big = hires(Image.open(cd['image']).convert('RGB'), w * S, h * S, c=ai_gen.comfy(body.get('comfy')), name=f'ed_{jid}_hires')
                b = io.BytesIO()
                big.save(b, 'JPEG', quality=92)
                nr = body.get('newRoom')
                if nr:
                    res = projects.create_room(root, key, nr.get('id'), nr.get('name') or name, b.getvalue(), origin='generated')
                else:
                    res = projects.replace_background(root, key, body.get('room') or j.spec.get('room'), b.getvalue(), origin='generated')
                j.use_state, j.use_result = 'done', res
            except Exception as e:  # noqa: BLE001
                j.use_state, j.use_result = 'error', {'error': f'{type(e).__name__}: {e}'}
        threading.Thread(target=finish, daemon=True).start()
        return {'kind': 'background', 'pending': True}
    raise ProjectError('cannot use this candidate')


def keep(root, key, jid, body):
    j = job_of(jid)
    cd = cand(j, body.get('i'))
    kind = j.kind if j.mode == 'new' else (j.spec.get('target') or {}).get('kind', j.kind)
    name = (body.get('name') or short_name(j.spec['prompt'])).strip()[:60]
    return library.add(root, key, kind, name, open(cd['image'], 'rb').read(), src='generated')


def get(root, path, query):
    if path.startswith('/api/ai/job/'):
        j = job_of(path.rsplit('/', 1)[1])
        info = j.info(url_of(root))
        info['use'] = {'status': getattr(j, 'use_state', None), 'result': getattr(j, 'use_result', None)}
        return 200, info
    return 404, {'error': 'not found'}


def post(root, path, key, body):
    if path == '/api/ai/status':
        try:
            return 200, ai_gen.status(body.get('comfy'))
        except Exception as e:  # noqa: BLE001
            return 200, {'ok': False, 'error': f'{type(e).__name__}: {e}'}
    if path == '/api/ai/generate':
        return 200, generate(root, key, body)
    m = re.match(r'^/api/ai/job/([^/]+)/(cancel|use|keep)$', path)
    if m:
        jid, op = m.groups()
        if op == 'cancel':
            job_of(jid).cancel = True
            return 200, {'ok': True}
        return 200, (use if op == 'use' else keep)(root, key, jid, body)
    return 404, {'error': 'not found'}
