#!/usr/bin/env python3
"""Writer for SCUMM v8 (CMI) resources: new rooms (LFLF), a new disk file (COMI.LA3) and a patched
index (COMI.LA0). Layout mirrors the original files exactly (see scumm/NOTES.md):

LFLF
  ROOM: RMHD(800,w,h,numObjects,numZPlanes,transparent) CYCL PALS(WRAP(OFFS APAL)) IMAG(WRAP(OFFS SMAP))
        OBIM*(IMHD [IMAG(WRAP(OFFS SMAP*))]) BOXD BOXM SCAL
  RMSC: ENCD EXCD LSCR* OBCD*(CDHD OBNA VERB)
SMAP = BSTR(WRAP(OFFS strips...)) ZPLN(WRAP(OFFS ZSTR(WRAP(OFFS masks...))*))
"""
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scummres as sr
import v8asm


def blk(tag, *parts):
    data = b''.join(parts)
    return tag.encode('latin1') + struct.pack('>I', len(data) + 8) + data


def wrap_offs(chunks, raw=False):
    """WRAP(OFFS + chunks): OFFS entries are offsets relative to the OFFS chunk start."""
    offs_size = 8 + 4 * len(chunks)
    pos = offs_size
    table = []
    for c in chunks:
        table.append(pos)
        pos += len(c)
    return blk('WRAP', blk('OFFS', struct.pack(f'<{len(chunks)}I', *table)), *chunks)


# ---------------------------------------------------------------- image strips
def strip_raw(img, sx, h):
    """codec 1 (BMCOMP_RAW256): code byte + 8 x h bytes, row major."""
    return bytes([1]) + img[:h, sx * 8:sx * 8 + 8].astype(np.uint8).tobytes()


def mask_rle(bits_col):
    """decompressMaskImg format: per row one byte (8 px); runs: 0x80|n + byte, literals: n + bytes."""
    out = bytearray()
    i = 0
    n = len(bits_col)
    while i < n:
        j = i
        while j < n and j - i < 127 and bits_col[j] == bits_col[i]:
            j += 1
        if j - i >= 3:
            out += bytes([0x80 | (j - i), bits_col[i]])
            i = j
        else:
            k = i
            while k < n and k - i < 127:
                if k + 2 < n and bits_col[k] == bits_col[k + 1] == bits_col[k + 2]:
                    break
                k += 1
            out += bytes([k - i]) + bytes(bits_col[i:k])
            i = k
    return bytes(out)


def smap(indices, masks=()):
    """indices: HxW uint8 (W multiple of 8). masks: list of HxW bool arrays (z-planes 1..n)."""
    h, w = indices.shape
    if w == 0:  # image-less room (like room 3 'icons'): SMAP(ZPLN(WRAP(OFFS())))
        return blk('SMAP', blk('ZPLN', blk('WRAP', blk('OFFS', b'')))), 0
    ns = w // 8
    strips = [strip_raw(indices, s, h) for s in range(ns)]
    offs_size = 8 + 4 * ns
    table, pos = [], offs_size
    for s in strips:
        table.append(pos)
        pos += len(s)
    bstr = blk('BSTR', blk('WRAP', blk('OFFS', struct.pack(f'<{ns}I', *table)), *strips))
    zstrs = []
    for m in masks:
        cols = []
        for s in range(ns):
            col = m[:h, s * 8:s * 8 + 8]
            if not col.any():
                cols.append(None)
                continue
            bits = [int(''.join('1' if v else '0' for v in row), 2) for row in col]
            cols.append(mask_rle(bits))
        offs_size = 8 + 4 * ns
        table, pos, data = [], offs_size, []
        for c in cols:
            if c is None:
                table.append(0)
            else:
                table.append(pos)
                data.append(c)
                pos += len(c)
        zstrs.append(blk('ZSTR', blk('WRAP', blk('OFFS', struct.pack(f'<{ns}I', *table)), *data)))
    if not zstrs:
        # one empty plane: all strip offsets 0 (= mask cleared)
        zstrs.append(blk('ZSTR', blk('WRAP', blk('OFFS', struct.pack(f'<{ns}I', *([0] * ns))))))
    zpln = blk('ZPLN', wrap_offs(zstrs))
    return blk('SMAP', bstr, zpln), len(zstrs)


# ---------------------------------------------------------------- room parts
def rmhd(w, h, nobj, nz, transparent=5):
    return blk('RMHD', struct.pack('<6I', 800, w, h, nobj, nz, transparent))


def pals(palette768):
    return blk('PALS', wrap_offs([blk('APAL', bytes(palette768))]))


def imhd(name, x, y, w, h, walk=(0, 0), actordir=180, image_count=0, flags=0):
    n = name.encode('latin1')[:31]
    return blk('IMHD', n + b'\0' * (32 - len(n)) + struct.pack('<2I8I2i', 0, 0, 801, image_count, x, y, w, h,
                                                                 actordir, flags, walk[0] - x, walk[1] - y))


def bomp(indices, transparent=255):
    """v8 BOMP block (blast object image): LE32 width, height, then per row LE16 size + RLE
    (code: num = (code >> 1) + 1; code & 1 = run of one color, else literal bytes)."""
    h, w = indices.shape
    rows = []
    for y in range(h):
        r = [int(v) for v in indices[y]]
        out = bytearray()
        i = 0
        while i < w:
            j = i
            while j < w and j - i < 128 and r[j] == r[i]:
                j += 1
            if j - i >= 2:
                out += bytes([((j - i - 1) << 1) | 1, r[i]])
                i = j
            else:
                k = i
                while k < w and k - i < 128 and not (k + 1 < w and r[k] == r[k + 1]):
                    k += 1
                k = max(k, i + 1)
                out += bytes([(k - i - 1) << 1]) + bytes(r[i:k])
                i = k
        rows.append(struct.pack('<H', len(out)) + bytes(out))
    return blk('BOMP', struct.pack('<II', w, h) + b''.join(rows))


def obim(name, x, y, w, h, walk, actordir=180, states=(), bomps=()):
    """states: list of HxW index arrays (SMAP object images per state); bomps: BOMP images per state
    (blast objects, e.g. inventory icons)."""
    n = len(states) or len(bomps)
    parts = [imhd(name, x, y, w, h, walk, actordir, n)]
    if states:
        parts.append(blk('IMAG', wrap_offs([smap(s)[0] for s in states])))
    elif bomps:
        parts.append(blk('IMAG', wrap_offs([bomp(b) for b in bomps])))
    return blk('OBIM', *parts)


def boxd(boxes):
    """boxes: list of dicts {ul, ur, lr, ll, mask, flags, slot, scale}; box 0 (dummy) is added."""
    out = [struct.pack('<8i5i', *([-32000] * 8), 0, 0, 0, 255, 0)]
    for b in boxes:
        out.append(struct.pack('<8i5i', *b['ul'], *b['ur'], *b['lr'], *b['ll'], b.get('mask', 1), b.get('flags', 0),
                               b.get('slot', 1), b.get('scale', 255), 0))
    return blk('BOXD', struct.pack('<I', len(out)), *out)


def _neighbors(b1, b2):
    """Port of ScummEngine::areBoxesNeighbors (boxes.cpp)."""
    def rot(b):
        return {'ul': b['ur'], 'ur': b['lr'], 'lr': b['ll'], 'll': b['ul']}
    box2 = {k: list(b1[k]) for k in ('ul', 'ur', 'lr', 'll')}
    box = {k: list(b2[k]) for k in ('ul', 'ur', 'lr', 'll')}
    for _ in range(4):
        for _ in range(4):
            if box2['ur'][0] == box2['ul'][0] and box['ul'][0] == box2['ul'][0] and box['ur'][0] == box2['ul'][0]:
                a0, a1 = sorted([box2['ul'][1], box2['ur'][1]])
                c0, c1 = sorted([box['ul'][1], box['ur'][1]])
                if not (c1 < a0 or c0 > a1 or ((c0 == a1 or c1 == a0) and a1 != a0 and c0 != c1)):
                    return True
            if box2['ur'][1] == box2['ul'][1] and box['ul'][1] == box2['ul'][1] and box['ur'][1] == box2['ul'][1]:
                a0, a1 = sorted([box2['ul'][0], box2['ur'][0]])
                c0, c1 = sorted([box['ul'][0], box['ur'][0]])
                if not (c1 < a0 or c0 > a1 or ((c0 == a1 or c1 == a0) and a1 != a0 and c0 != c1)):
                    return True
            box2 = rot(box2)
        box = rot(box)
    return False


def boxm(boxes):
    """Box matrix in CMI's stored format: per box: (from, to, via) triples, then 0xFF."""
    allb = [None] + boxes
    n = len(allb)
    INF = 255
    dist = [[0 if i == j else (1 if i and j and _neighbors(allb[i], allb[j]) else INF) for j in range(n)] for i in range(n)]
    itin = [[j if dist[i][j] < INF else INF for j in range(n)] for i in range(n)]
    for k in range(n):
        for i in range(n):
            for j in range(n):
                if i != j and dist[i][j] > dist[i][k] + dist[k][j]:
                    dist[i][j] = dist[i][k] + dist[k][j]
                    itin[i][j] = itin[i][k]
    out = bytearray()
    for i in range(n):
        j = 0
        while j < n:
            it = itin[i][j]
            if it != INF:
                j0 = j
                while j < n - 1 and itin[i][j + 1] == it:
                    j += 1
                out += bytes([j0, j, it])
            j += 1
        out.append(0xFF)
    return blk('BOXM', bytes(out))


def scal(slots):
    """slots: up to 4 (s1, y1, s2, y2)."""
    vals = []
    for i in range(4):
        vals += list(slots[i]) if i < len(slots) else [0, 0, 0, 0]
    return blk('SCAL', struct.pack('<16I', *vals))


def verb_block(entries):
    """entries: list of (verb, asm_text). Returns the VERB block (table + code)."""
    codes = [v8asm.assemble(t) for _, t in entries]
    table_size = 8 * len(entries) + 4
    pos = table_size
    table = b''
    for (verb, _), c in zip(entries, codes):
        table += struct.pack('<II', verb, pos)
        pos += len(c)
    return blk('VERB', table + struct.pack('<I', 0) + b''.join(codes))


def obcd(obj_id, name, verbs, parent=0, parentstate=0):
    return blk('OBCD', blk('CDHD', struct.pack('<IHBB', 801, obj_id, parent, parentstate)),
               blk('OBNA', name.encode('latin1') + b'\0'), verb_block(verbs))


def room_lflf(width, height, palette768, indices, objects, boxes, scale_slots, encd, excd, lscrs=(), masks=()):
    """objects: list of dicts {id, name, obna, rect(x,y,w,h), walk(x,y), dir, verbs[(verb, asm)], states[]}."""
    sm, nz = smap(indices, masks)
    room = blk('ROOM',
               rmhd(width, height, len(objects), nz),
               blk('CYCL', b'\0'),
               pals(palette768),
               blk('IMAG', wrap_offs([sm])),
               *[obim(o['name'], *o['rect'], o['walk'], o.get('dir', 180), o.get('states', ()), o.get('bomps', ()))
                 for o in objects],
               boxd(boxes), boxm(boxes), scal(scale_slots))
    rmsc = blk('RMSC',
               blk('ENCD', v8asm.assemble(encd)),
               blk('EXCD', v8asm.assemble(excd)),
               *[blk('LSCR', struct.pack('<I', num) + v8asm.assemble(code)) for num, code in lscrs],
               *[obcd(o['id'], o.get('obna', o['name']), o['verbs']) for o in objects])
    lflf = blk('LFLF', room, rmsc)
    rmsc_offset = 8 + len(room)  # relative to the LFLF start (DRSC entry)
    return lflf, rmsc_offset


def disk_file(rooms):
    """rooms: list of (room_number, lflf_bytes) -> LECF file bytes with LOFF."""
    loff_data = bytes([len(rooms)]) + b''.join(struct.pack('<BI', r, 0) for r, _ in rooms)
    loff = blk('LOFF', loff_data)
    pos = 8 + len(loff)
    offs = []
    for r, l in rooms:
        offs.append((r, pos))
        pos += len(l)
    loff = blk('LOFF', bytes([len(rooms)]) + b''.join(struct.pack('<BI', r, o) for r, o in offs))
    return blk('LECF', loff, *[l for _, l in rooms])


# ---------------------------------------------------------------- index patching
def patch_index(idx, new_rooms, new_objects):
    """new_rooms: list of (room, disk, name, rmsc_offset); new_objects: list of (id, name, state, room, class).
    Returns new COMI.LA0 bytes (room numbers and object ids must extend the tables contiguously)."""
    d = idx.data
    out = []
    maxs = dict(idx.maxs)
    nrooms = maxs['numRooms']
    nobj = maxs['numGlobalObjects']
    room_ids = sorted(r for r, *_ in new_rooms)
    obj_ids = sorted(o[0] for o in new_objects)
    assert room_ids == list(range(nrooms, nrooms + len(room_ids))), (room_ids, nrooms)
    assert obj_ids == list(range(nobj, nobj + len(obj_ids))), (obj_ids, nobj)
    maxs['numRooms'] = nrooms + len(room_ids)
    maxs['numGlobalObjects'] = nobj + len(obj_ids)
    for tag, o, size in idx.blocks:
        body = d[o + 8:o + size]
        if tag == 'MAXS':
            body = body[:100] + struct.pack('<17I', *maxs.values())
        elif tag == 'RNAM':
            entries = body[:body.rfind(b'\0')] if body.endswith(b'\0') else body
            # entries: room byte + 9 bytes xor 0xFF; terminated by 0
            add = b''
            for r, _, name, _ in new_rooms:
                n = name.encode('latin1')[:8].ljust(9, b'\0')
                add += bytes([r]) + bytes(x ^ 0xFF for x in n)
            body = entries + add + b'\0'
        elif tag in ('DROO', 'DRSC'):
            disks, offs = idx.dirs[tag]
            disks, offs = list(disks), list(offs)
            for r, disk, _, rmsc in sorted(new_rooms):
                if tag == 'DROO':
                    disks.append(disk); offs.append(0)
                else:
                    disks.append(r); offs.append(rmsc)
            n = len(disks)
            body = struct.pack('<I', n) + bytes(disks) + struct.pack(f'<{n}I', *offs)
        elif tag == 'DOBJ':
            n = sr.le32(body, 0)
            add = b''
            for oid, name, state, room, cls in sorted(new_objects):
                nm = name.encode('latin1')[:39]
                add += nm + b'\0' * (40 - len(nm)) + struct.pack('<BBI', state, room, cls)
            body = struct.pack('<I', n + len(new_objects)) + body[4:] + add
        out.append(blk(tag, body))
    return b''.join(out)


def quantize_room(img_rgb, ref_palette768, lo=24, hi=234):
    """Quantizes an RGB image (PIL) into palette indices lo..hi, keeping CMI's reserved entries
    (0-23 UI/text colors, 235-255 Guybrush colors) from ref_palette768."""
    from PIL import Image
    ncol = hi - lo + 1
    q = img_rgb.convert('RGB').quantize(colors=ncol, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    qp = q.getpalette()[:ncol * 3]
    pal = bytearray(ref_palette768)
    pal[lo * 3:(hi + 1) * 3] = bytes(qp) + bytes(ncol * 3 - len(qp))
    idx = np.array(q, dtype=np.uint16) + lo
    return idx.astype(np.uint8), bytes(pal)
