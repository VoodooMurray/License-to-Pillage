#!/usr/bin/env python3
"""AKOS costume encoder for SCUMM v8 (CMI layout, see tools/akos_extract.py for the decoder):

  AKHD(version 1, flags 0x8001 = 4 directions + never mirror, chores, cels, codec 1, 16 layers)
  AKPL(32 palette indices) RGBS(32 x RGB) AKSQ(programs) AKCH(chore table) AKOF(cel offsets)
  AKCI(4 bytes per cel: w, h) AKCD(codec 1 "byle RLE" cel data)

Programs are CMI style: one DrawMany command (0xC020, n, dx, dy, cel) per game frame (12 fps),
ending in GoToState (loop, or back to the last frame to hold it). Chore n*4+d = anim n, direction d
(all four directions share the anim). Color 0 = transparent; codec 1 packs color << 3 | run (32 colors).
"""
import struct

import numpy as np


def blk(tag, data):
    return tag.encode('latin1') + struct.pack('>I', len(data) + 8) + data


def rle_codec1(codes, ncolors=32):
    """codes: HxW uint8 color codes (0 = transparent). Column-major runs; runs flow across columns."""
    shr = {16: 4, 32: 3, 64: 2}[ncolors]
    mask = (1 << shr) - 1
    flat = np.asarray(codes, np.uint8).T.reshape(-1)   # column-major
    out = bytearray()
    i, n = 0, len(flat)
    while i < n:
        c = int(flat[i])
        j = i
        while j < n and flat[j] == c and j - i < 255:
            j += 1
        run = j - i
        if run <= mask:
            out.append((c << shr) | run)
        else:
            out.append(c << shr)
            out.append(run)
        i = j
    return bytes(out)


def build(anims, cels, akpl, rgbs, ncolors=32):
    """anims: {anim_number: {'frames': [(cel_index, dx, dy)], 'loop': bool}} (one entry per game frame), or
    {anim_number: {'dirs': [W, E, S, N]}} with one such program per direction (the player: SCUMM's chore
    anim * 4 + old direction, 0 W 1 E 2 S 3 N);
    cels: list of HxW uint8 code arrays; akpl: list of ncolors palette indices; rgbs: list of (r,g,b)."""
    nanim = max(anims) + 1 if anims else 1
    # AKSQ
    aksq = bytearray()
    starts = {}
    progs = {(num, d): (a['dirs'][d] if 'dirs' in a else a) for num, a in anims.items() for d in range(4)}
    for key in sorted(progs):
        a = progs[key]
        if 'dirs' not in anims[key[0]] and key[1] > 0:
            starts[key] = starts[(key[0], 0)]
            continue
        starts[key] = len(aksq)
        pos = []
        for cel, dx, dy in a['frames']:
            pos.append(len(aksq))
            aksq += b'\xc0\x20\x01' + struct.pack('<hh', int(round(dx)), int(round(dy)))
            if cel < 0x80:
                aksq.append(cel)
            else:
                aksq += struct.pack('>H', 0x8000 | cel)
        target = starts[key] if a.get('loop', True) else pos[-1]
        aksq += b'\xc0\x30' + struct.pack('<H', target)
    # AKCH: offset table (uint16 per chore) + chore records (mask 0x8000: limb 0 only)
    nchores = nanim * 4
    table = [0] * nchores
    recs = bytearray()
    base = nchores * 2
    rec_off = {}
    for key in sorted(starts):
        if starts[key] not in rec_off:
            rec_off[starts[key]] = base + len(recs)
            recs += struct.pack('<H', 0x8000) + bytes([6]) + struct.pack('<HH', starts[key], 0)
        table[key[0] * 4 + key[1]] = rec_off[starts[key]]
    akch = struct.pack(f'<{nchores}H', *table) + bytes(recs)
    # cels
    akcd = bytearray()
    akof = bytearray()
    akci = bytearray()
    for i, c in enumerate(cels):
        h, w = c.shape
        akof += struct.pack('<IH', len(akcd), len(akci))
        akci += struct.pack('<HH', w, h)
        akcd += rle_codec1(c, ncolors)
    akhd = struct.pack('<6H', 1, 0x8001, nchores, len(cels), 1, 16)
    pal = bytes(akpl[:ncolors]) + bytes(max(0, ncolors - len(akpl)))
    rgb = b''.join(bytes(x) for x in rgbs[:ncolors]) + bytes(3 * max(0, ncolors - len(rgbs)))
    return blk('AKOS', blk('AKHD', akhd) + blk('AKPL', pal) + blk('RGBS', rgb) + blk('AKSQ', bytes(aksq)) +
               blk('AKCH', akch) + blk('AKOF', bytes(akof)) + blk('AKCI', bytes(akci)) + blk('AKCD', bytes(akcd)))


def decode_check(akos_bytes):
    """Round trip through tools/akos_extract-style parsing of the first chore (sanity check)."""
    p = 8
    parts = {}
    while p < len(akos_bytes):
        tag = akos_bytes[p:p + 4].decode()
        size = struct.unpack('>I', akos_bytes[p + 4:p + 8])[0]
        parts[tag] = akos_bytes[p + 8:p + size]
        p += size
    return {k: len(v) for k, v in parts.items()}
