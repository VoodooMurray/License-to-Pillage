#!/usr/bin/env python3
"""Decoders for The Curse of Monkey Island's image formats, reading the player's own game files (read-only).

  AKOS codec 1  costume cels (Guybrush, the verb coin, ...): column-major byte RLE, colours from the costume's
                own AKPL/RGBS (AKPL entries below 8 = CMI's shadow slots -> translucent black)
  BOMP          object images (room 3 holds the interface: cursors, exit arrows, chest, page arrows)
  NUT codec 44  RESOURCE/FONTn.NUT glyphs (fill + outline)
  APAL          room palettes (room 9 = the palette the interface and Guybrush are drawn with)

Everything returns numpy arrays at the original resolution (1x). Paths: `game` is a folder with COMI.LA0-2 and
RESOURCE/ under the upper-case names (tools/byog/gamedir.py make_view builds one from any copy).

Verified against the 1x images of a private dump of the same game: every interface image, coin cel, glint frame
and font glyph identical, and Guybrush's actor.json (anims, roles, views) identical to the dump-based one.
"""
import os
import struct
import sys

import numpy as np

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, TOOLS)
sys.path.insert(0, os.path.join(TOOLS, 'scumm'))
import scummres as sr       # noqa: E402  block/index reader
import akos_extract as ax   # noqa: E402  AKOS structure (chores, programs, roles)

ROOM_UI, ROOM_PAL = 3, 9
BOMP_TRANSPARENT = 255
SHADOW_MAX = 8                  # AKPL entries < 8: CMI's shadow palette slots (buildPaletteShadow 6, 7)
SHADOW_RGBA = (0, 0, 0, 128)    # how they are drawn in the web engine's cels (the look it was tuned with)


class Game:
    """One CMI data folder: the index, the data files (loaded lazily), helpers by number."""

    def __init__(self, folder):
        self.folder = os.path.abspath(folder)
        sr.GAME = self.folder           # scummres reads COMI.LA<disk> from its module-level GAME
        self.idx = sr.Index(os.path.join(self.folder, 'COMI.LA0'))
        self._files = {}

    def data_file(self, disk):
        if disk not in self._files:
            sr.GAME = self.folder
            self._files[disk] = sr.DataFile(disk)
        return self._files[disk]

    def room(self, room):
        """(DataFile, (lflf offset, size)) of a room."""
        disks, _ = self.idx.dir('DIRR', 'DROO')
        df = self.data_file(disks[room])
        return df, df.lflf_of(room)

    def akos(self, costume):
        return ax.Akos(costume, self.folder)

    def resource(self, name):
        return os.path.join(self.folder, 'RESOURCE', name)


# ---------------------------------------------------------------- palettes
def room_palette(game, room=ROOM_PAL):
    """ROOM/PALS/WRAP/APAL of a room -> (256, 3) uint8."""
    df, (lf, size) = game.room(room)
    for _depth, tag, o, _s in sr.tree(df.data, lf + 8, lf + size, maxdepth=4):
        if tag == 'APAL':
            return np.frombuffer(df.data[o + 8:o + 8 + 768], np.uint8).reshape(256, 3).copy()
    raise RuntimeError(f'no APAL in room {room}')


# ---------------------------------------------------------------- BOMP (object images)
def bomp_decode(d, o):
    """v8 BOMP body at offset o: LE32 width, height, then per row LE16 byte count + RLE
    (code: n = (code >> 1) + 1; code & 1 = one colour repeated n times, else n literal bytes)."""
    w, h = struct.unpack_from('<II', d, o)
    p = o + 8
    out = np.zeros((h, w), np.uint8)
    for y in range(h):
        n = struct.unpack_from('<H', d, p)[0]
        p += 2
        q, end, row = p, p + n, bytearray()
        while q < end and len(row) < w:
            code = d[q]
            q += 1
            num = (code >> 1) + 1
            if code & 1:
                row += bytes([d[q]]) * num
                q += 1
            else:
                row += d[q:q + num]
                q += num
        row = bytes(row[:w]).ljust(w, bytes([BOMP_TRANSPARENT]))
        out[y] = np.frombuffer(row, np.uint8)
        p = end
    return out


def room_bomps(game, room=ROOM_UI):
    """{(object number, state): HxW index array} for every BOMP object image of a room. v8 matches an OBIM to
    its object by name (IMHD name == the DOBJ entry's name); the states are the BOMP blocks of IMAG/WRAP in order."""
    by_name = {}
    for i, (name, _state, _home, _cls) in enumerate(game.idx.objects):
        by_name.setdefault(name, []).append(i)
    df, (lf, size) = game.room(room)
    d = df.data
    out = {}
    for _depth, tag, o, s in sr.tree(d, lf + 8, lf + size, maxdepth=1):
        if tag != 'OBIM':
            continue
        kids = list(sr.blocks(d, o + 8, o + s))
        imhd = [k for k in kids if k[0] == 'IMHD']
        imag = [k for k in kids if k[0] == 'IMAG']
        if not imhd or not imag:
            continue
        name = d[imhd[0][1] + 8:imhd[0][1] + 8 + 32].split(b'\0')[0].decode('latin1')
        wraps = list(sr.blocks(d, imag[0][1] + 8, imag[0][1] + imag[0][2]))
        if not wraps:
            continue
        wrap = wraps[0]
        states = [b for b in sr.blocks(d, wrap[1] + 8, wrap[1] + wrap[2]) if b[0] == 'BOMP']
        for si, (_t, o2, _s2) in enumerate(states):
            img = bomp_decode(d, o2 + 8)
            for obj in by_name.get(name, []):
                out[(obj, si + 1)] = img
    return out


def indexed_rgba(ix, pal, transparent=BOMP_TRANSPARENT):
    """Index image + (256, 3) palette -> RGBA; transparent pixels fully zeroed."""
    rgba = np.dstack([pal[ix], np.full(ix.shape, 255, np.uint8)])
    rgba[ix == transparent] = 0
    return rgba


# ---------------------------------------------------------------- AKOS codec 1 (costume cels)
def byle(data, w, h, ncolors):
    """AKOS codec 1: column-major runs that flow across columns; a byte = colour << shr | run (shr 4/3/2 for
    16/32/64 colours), run 0 -> the next byte is the length (0 = 256). -> HxW colour codes."""
    shr = {16: 4, 32: 3, 64: 2}[ncolors]
    mask = (1 << shr) - 1
    n = w * h
    out = bytearray(n)
    i = p = 0
    while i < n:
        b = data[p]
        p += 1
        c, r = b >> shr, b & mask
        if r == 0:
            r = data[p] or 256
            p += 1
        r = min(r, n - i)
        out[i:i + r] = bytes([c]) * r
        i += r
    return np.ascontiguousarray(np.frombuffer(bytes(out), np.uint8).reshape(w, h).T)


class Costume:
    """An AKOS costume: structure via akos_extract.Akos, pixels decoded here."""

    def __init__(self, game, number):
        self.number = number
        self.ak = game.akos(number)
        P = self.ak.P
        if self.ak.codec != 1:
            raise NotImplementedError(f'costume {number}: AKOS codec {self.ak.codec} (only 1 is used by CMI)')
        akpl = np.frombuffer(P['AKPL'], np.uint8)
        rgbs = np.frombuffer(P['RGBS'], np.uint8).reshape(-1, 3)
        self.ncolors = len(akpl)
        self.lut = np.zeros((self.ncolors, 4), np.uint8)
        for c in range(self.ncolors):
            if c == 0:
                self.lut[c] = (0, 0, 0, 0)
            elif akpl[c] < SHADOW_MAX:
                self.lut[c] = SHADOW_RGBA
            else:
                self.lut[c] = (*rgbs[c], 255)

    def cel(self, n):
        """Cel n as 1x RGBA (HxWx4)."""
        ak = self.ak
        off, ci = struct.unpack('<IH', ak.akof[n * 6:n * 6 + 6])
        w, h = struct.unpack('<HH', ak.akci[ci:ci + 4])
        if w * h == 0:
            return np.zeros((max(h, 1), max(w, 1), 4), np.uint8)
        return self.lut[byle(ak.P['AKCD'][off:], w, h, self.ncolors)]


# ---------------------------------------------------------------- NUT fonts (codec 44)
def nut_frames(d):
    """'ANIM' container -> (AHDR body, [FOBJ body per frame]); blocks are big-endian sized and word-padded."""
    if d[:4] != b'ANIM':
        raise ValueError('not a NUT/ANIM file')
    end = 8 + struct.unpack('>I', d[4:8])[0]
    p, ahdr, frames = 8, None, []
    while p + 8 <= end:
        tag = d[p:p + 4]
        size = struct.unpack('>I', d[p + 4:p + 8])[0]
        if tag == b'AHDR':
            ahdr = d[p + 8:p + 8 + size]
        elif tag == b'FRME':
            q, fe = p + 8, p + 8 + size
            while q + 8 <= fe:
                t2 = d[q:q + 4]
                s2 = struct.unpack('>I', d[q + 4:q + 8])[0]
                if t2 == b'FOBJ':
                    frames.append(d[q + 8:q + 8 + s2])
                q += 8 + s2 + (s2 & 1)
        p += 8 + size + (size & 1)
    return ahdr, frames


def codec44(src, w, h):
    """SMUSH codec 44 (= 21's layout): per row LE16 row size, then LE16 skip / LE16 count-1 + literal bytes.
    Skipped pixels are -1."""
    dst = np.full((h, w), -1, np.int16)
    p = 0
    for y in range(h):
        nxt = p + 2 + struct.unpack_from('<H', src, p)[0]
        p += 2
        x, ln = 0, w
        while ln > 0:
            off = struct.unpack_from('<H', src, p)[0]
            p += 2
            x += off
            ln -= off
            if ln <= 0:
                break
            n = struct.unpack_from('<H', src, p)[0] + 1
            p += 2
            ln -= n
            if ln < 0:
                n += ln
            dst[y, x:x + n] = np.frombuffer(src[p:p + n], np.uint8)
            p += n
            x += n
        p = nxt
    return dst


FOBJ_HDR = 14   # <HhhHH codec, x, y, w, h + 4 unused bytes


def nut_glyphs(path):
    """-> ([(w, h, RGBA 1x)] for codes 0-255, font height). White fill, black outline (the AHDR palette entry
    of a pixel decides: black = outline), skipped pixels transparent."""
    ahdr, frames = nut_frames(open(path, 'rb').read())
    pal = np.frombuffer(ahdr[6:6 + 768], np.uint8).reshape(256, 3)
    out, height = [], 0
    for code in range(min(256, len(frames))):
        f = frames[code]
        codec, x, y, w, h = struct.unpack_from('<HhhHH', f, 0)
        if codec != 44:
            raise NotImplementedError(f'{path}: glyph {code} uses codec {codec}')
        ix = codec44(f[FOBJ_HDR:], w, h)
        rgba = np.zeros((h, w, 4), np.uint8)
        lit = ix >= 0
        black = lit & (pal[np.clip(ix, 0, 255)].sum(2) == 0)
        rgba[lit & ~black] = (255, 255, 255, 255)
        rgba[black] = (0, 0, 0, 255)
        out.append((w, h, rgba))
        height = max(height, h)
    return out, height
