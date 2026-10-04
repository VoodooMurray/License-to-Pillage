#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# A Python port of parts of ScummVM's engines/scumm/imuse_digi/ (bundle reader and codecs),
# Copyright (C) the ScummVM Team (https://www.scummvm.org). This file alone is licensed under the GNU General Public
# License version 3 or later: see tools/LICENSE-GPL-3.0.txt. The rest of License to Pillage runs it as a separate program.
"""Extracts sounds from The Curse of Monkey Island's iMUSE digital bundles (VOXDISK*.BUN, MUSDISK*.BUN) as WAV.

Reads the user's own game files (read-only) and follows ScummVM's engines/scumm/imuse_digi/:
  dimuse_bndmgr.cpp   'LB83' header: BE dir offset + entry count; dir entries = 8-byte name, 4-byte extension,
                      BE offset, BE size ("B2GT301" + "IMX" -> B2GT301.IMX). An entry is a plain 'iMUS' file or a
                      'COMP' table (count, ?, lastBlockDecompressedSize, then offset/size/codec/? per block).
                      Block i decompresses to stream bytes [i*0x2000, ...); the stream is
                      (count-1)*0x2000 + lastBlockDecompressedSize bytes long.
  dimuse_codecs.cpp   BundleCodecs::decompressCodec: 0 raw, 1-3 LZ (compDecode) + byte deltas, 4-6/10-12 LZ + 12-bit
                      repacking, 13/15 "IMC" = IMA ADPCM with 2..7-bit codes (mono/stereo). A 13/15 block starts with
                      a BE16 word: != 0 -> that many raw bytes follow (the iMUS header); == 0 -> per channel a seed
                      (table index u8, 4 unused bytes, BE32 predictor). Every 13/15 block yields 0x2000 bytes
                      (0x1000 int16 values; stereo: channel 0's codes then channel 1's, interleaved on output).
                      CMI only uses 13 (all voice) and 15 (all music); verified bit-exact: each block's final decoder
                      state equals the seed stored in the next block. Codecs 0-12 are ported but untested (unused).
  dimuse_dispatch.cpp the stream is an iMUS file: 'iMUS' size, 'MAP ' size {FRMT offset,?,bits,rate,channels |
                      REGN offset,length | TEXT offset,marker | SYNC lip sync | JUMP | STOP offset}, 'DATA' size,
                      samples. 16-bit samples are native little-endian (written by the decoder), 12-bit are packed
                      2-in-3 bytes (unsigned, 2048 = 0), 8-bit unsigned. WAV output is always 16-bit.
Voice entries are named <room:2><speaker:2><number>.IMX (GT = Guybrush Threepwood); LANGUAGE.TAB next to the bundles
maps every name (without extension) to its English line, shown by --list --text.

Usage (a bare bundle name is looked up in the mod install's view of your game, .byog/game/RESOURCE, or $COMI_GAME/RESOURCE):
  tools/bun_extract.py VOXDISK1.BUN --list ['??GT*'] [--text]      name, packed bytes, rate/ch/bits, seconds
  tools/bun_extract.py VOXDISK1.BUN --extract B2GT301 'ATGT3*' --out DIR [-v]
  tools/bun_extract.py VOXDISK2.BUN --all --out DIR [--jobs 8]
Names and patterns are case-insensitive shell globs; the .IMX extension is optional.
"""
import argparse
import concurrent.futures
import fnmatch
import math
import os
import struct
import sys
import wave
from array import array

_VIEW = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.byog', 'game', 'RESOURCE')
RESOURCE = _VIEW if os.path.isdir(_VIEW) else os.path.join(os.environ.get('COMI_GAME', 'cmi-game'), 'RESOURCE')   # mod install first
CHUNK = 0x2000  # DIMUSE_BUN_CHUNK_SIZE

# ---------------------------------------------------------------------------------------------------------------
# IMC tables (BundleCodecs::initializeImcTables + imxOtherTable; Audio::Ima_ADPCMStream::_imaTable)
IMA_TABLE = (
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
    494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
    2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
    12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767)
IMX_OTHER = (  # step-index adjustment per code width (2..7 bits), as int8 (0xFF = -1)
    (-1, 4),
    (-1, -1, 2, 8),
    (-1,) * 4 + (1, 2, 4, 6),
    (-1,) * 8 + (1, 2, 4, 6, 8, 12, 16, 32),
    (-1,) * 16 + (1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32),
    (-1,) * 32 + tuple(range(1, 33)),
)


def _imc_tables():
    """Returns (bits[pos], delta[pos*128+packet], nextpos[pos*128+packet]) precomputed from ScummVM's tables."""
    bits = []
    for pos in range(89):  # _destImcTable
        put, v = 1, ((IMA_TABLE[pos] * 4) // 7) // 2
        while v:
            v //= 2
            put += 1
        bits.append(min(max(put, 3), 8) - 1)
    table2 = [0] * (89 * 64)  # _destImcTable2
    for n in range(64):
        for pos in range(89):
            count, put, v = 32, 0, IMA_TABLE[pos]
            while count:
                if count & n:
                    put += v
                count //= 2
                v //= 2
            table2[n + pos * 64] = put
    delta, nextpos = [0] * (89 * 128), [0] * (89 * 128)
    for pos in range(89):  # the per-sample body of decompressADPCM, for every possible packet
        b = bits[pos]
        sign = 1 << (b - 1)
        for packet in range(1 << b):
            data = packet & (sign - 1)
            d = (IMA_TABLE[pos] >> (b - 1)) + table2[(data << (7 - b)) + pos * 64]
            delta[pos * 128 + packet] = -d if packet & sign else d
            nextpos[pos * 128 + packet] = min(max(pos + IMX_OTHER[b - 2][data], 0), 88)
    return bits, delta, nextpos


IMC_BITS, IMC_DELTA, IMC_NEXT = _imc_tables()


def decode_imc(inp, channels, out):
    """decompressADPCM (codecs 13/15): one block -> 0x2000 bytes written to out; returns 0x2000."""
    first = (inp[0] << 8) | inp[1]
    p, left, start = 2, 0x1000, 0
    seeds = [(0, 0), (0, 0)]
    if first:  # raw bytes (the iMUS header of the first block), then ADPCM from state 0/0
        out[0:first] = inp[2:2 + first]
        p += first
        start = first // 2
        left -= first // 2
    else:
        for ch in range(channels):
            seeds[ch] = (inp[p], struct.unpack_from('>i', inp, p + 5)[0])
            p += 9
    # the reader fetches a BE16 word at any byte offset; pad with zeros like ScummVM's "CMI hack" extra 0 byte
    # (the unused tail of the last block reads past the data; those samples lie beyond the stream end)
    src = bytes(inp[p:]) + bytes(max(3, (left * 7) // 8 + 3 - (len(inp) - p)))
    words = [a << 8 | b for a, b in zip(src, src[1:])]
    samples = array('h', bytes(2 * 0x1000))
    bits, dtab, ntab = IMC_BITS, IMC_DELTA, IMC_NEXT
    bitpos = 0  # totalBitOffset: channel 1's codes follow channel 0's in the same bit stream
    for ch in range(channels):
        tp, word = seeds[ch]
        di = start + ch
        n = left if channels == 1 else ((left + 1) // 2 if ch == 0 else left // 2)
        for _ in range(n):
            b = bits[tp]
            k = (tp << 7) | (((words[bitpos >> 3] << (bitpos & 7)) & 0xFFFF) >> (16 - b))
            bitpos += b
            word += dtab[k]
            if word > 32767:
                word = 32767
            elif word < -32768:
                word = -32768
            samples[di] = word
            di += channels
            tp = ntab[k]
    if sys.byteorder == 'big':
        samples.byteswap()
    out[first:CHUNK] = samples[start:].tobytes()
    return CHUNK


def comp_decode(src, dst):
    """compDecode: LZ77 variant with LE16 flag words, back references up to 4 KiB. Returns the output length."""
    st = {'mask': src[0] | (src[1] << 8), 'left': 16, 'sp': 2}

    def next_bit():
        bit = st['mask'] & 1
        st['mask'] >>= 1
        st['left'] -= 1
        if not st['left']:
            sp = st['sp']
            st['mask'] = src[sp] | (src[sp + 1] << 8)
            st['sp'] = sp + 2
            st['left'] = 16
        return bit

    d = 0
    while True:
        if next_bit():
            dst[d] = src[st['sp']]
            st['sp'] += 1
            d += 1
            continue
        if not next_bit():
            size = next_bit() << 1
            size = (size | next_bit()) + 3
            data = src[st['sp']] - 0x100
            st['sp'] += 1
        else:
            sp = st['sp']
            data, size = src[sp], src[sp + 1]
            st['sp'] = sp + 2
            data = (data | ((size & 0xF0) << 4)) - 0x1000
            size = (size & 0x0F) + 3
            if size == 3:
                st['sp'] += 1
                if src[st['sp'] - 1] == 0:
                    return d
        r = d + data
        for _ in range(size):
            dst[d] = dst[r]
            d += 1
            r += 1


def _undelta(p, n, start):
    for z in range(start, n):
        p[z] = (p[z] + p[z - 1]) & 0xFF


def _shuffle_12bit(src, n):
    """The interleave shared by codecs 10-12: returns t_table."""
    t = bytearray(src[:n]) + bytearray(16)
    o1 = n // 3
    o2 = o3 = o1 << 1
    while o1:
        o1 -= 1
        o2 -= 2
        o3 -= 1
        t[o2] = src[o1]
        t[o2 + 1] = src[o3]
    return t


def decompress_codec(codec, inp, size, out):
    """BundleCodecs::decompressCodec. inp = block bytes (+ padding), out = persistent 0x2000(+) byte buffer."""
    if codec == 0:
        out[0:size] = inp[:size]
        return size
    if codec in (13, 15):
        return decode_imc(inp, 1 if codec == 13 else 2, out)
    if codec not in (1, 2, 3, 4, 5, 6, 10, 11, 12):
        raise ValueError('unknown codec %d' % codec)
    n = comp_decode(inp, out)
    if codec == 1:
        return n
    if codec >= 3:
        _undelta(out, n, 2)
    _undelta(out, n, 1)
    if codec in (2, 3):
        return n
    src = out
    length = (n << 3) // 12
    if codec == 4:
        t = bytearray(n + 16)
        if length > 0:
            k = j = s = 0
            c = -12
            while True:
                q = length + (k >> 1)
                t2 = src[j]
                if k & 1:
                    r = c >> 3
                    t[r + 2] = ((t2 & 0x0F) << 4) | (src[q + 1] >> 4)
                    t[r + 1] = (t2 & 0xF0) | t[r + 1]
                else:
                    r = s >> 3
                    t[r] = ((t2 & 0x0F) << 4) | (src[q] & 0x0F)
                    t[r + 1] = t2 >> 4
                s += 12
                c += 12
                k += 1
                j += 1
                if k >= length:
                    break
        o1 = ((length - 1) * 3) >> 1
        t[o1 + 1] = t[o1 + 1] | (src[length - 1] & 0xF0)
        src[0:n] = t[:n]
    elif codec == 5:
        t = bytearray(n + 16)
        k, c, s, j = 1, 0, 12, 1
        t[0] = src[length] >> 4
        tt = length + k
        if tt > k:
            while True:
                t1 = src[length + (k >> 1)]
                t2 = src[j - 1]
                if k & 1:
                    r = c >> 3
                    t[r] = (t2 & 0xF0) | t[r]
                    t[r + 1] = ((t2 & 0x0F) << 4) | (t1 & 0x0F)
                else:
                    r = s >> 3
                    t[r] = t2 >> 4
                    t[r - 1] = ((t2 & 0x0F) << 4) | (t1 >> 4)
                s += 12
                c += 12
                k += 1
                j += 1
                if k >= tt:
                    break
        src[0:n] = t[:n]
    elif codec == 6:
        t = bytearray(n + 16)
        k = c = j = 0
        s = -12
        t[0] = src[n - 1]
        t[n - 1] = src[length - 1]
        tt = length - 1
        if tt > 0:
            while True:
                t1 = src[length + (k >> 1)]
                t2 = src[j]
                if k & 1:
                    r = s >> 3
                    t[r + 2] = (t2 & 0xF0) | t[r + 2]
                    t[r + 3] = ((t2 & 0x0F) << 4) | (t1 >> 4)
                else:
                    r = c >> 3
                    t[r + 2] = t2 >> 4
                    t[r + 1] = ((t2 & 0x0F) << 4) | (t1 & 0x0F)
                s += 12
                c += 12
                k += 1
                j += 1
                if k >= tt:
                    break
        src[0:n] = t[:n]
    elif codec == 10:
        t = _shuffle_12bit(src, n)
        if length > 0:
            k = s = 0
            c = -12
            while True:
                q = length + (k >> 1)
                t1 = t[k]
                if k & 1:
                    r = c >> 3
                    src[r + 2] = ((t1 & 0x0F) << 4) | (t[q + 1] >> 4)
                    src[r + 1] = src[r + 1] | (t1 & 0xF0)
                else:
                    r = s >> 3
                    src[r] = ((t1 & 0x0F) << 4) | (t[q] & 0x0F)
                    src[r + 1] = t1 >> 4
                s += 12
                c += 12
                k += 1
                if k >= length:
                    break
        o1 = ((length - 1) * 3) >> 1
        src[o1 + 1] = (t[length] & 0xF0) | src[o1 + 1]
    elif codec == 11:
        t = _shuffle_12bit(src, n)
        k, c, s = 1, 0, 12
        src[0] = t[length] >> 4
        tt = length + k
        if tt > k:
            while True:
                q = length + (k >> 1)
                t1, t2 = t[k - 1], t[q]
                if k & 1:
                    r = c >> 3
                    src[r] = src[r] | (t1 & 0xF0)
                    src[r + 1] = ((t1 & 0x0F) << 4) | (t2 & 0x0F)
                else:
                    r = s >> 3
                    src[r] = t1 >> 4
                    src[r - 1] = ((t1 & 0x0F) << 4) | (t2 >> 4)
                s += 12
                c += 12
                k += 1
                if k >= tt:
                    break
    elif codec == 12:
        t = _shuffle_12bit(src, n)
        k = c = 0
        s = -12
        src[0] = t[n - 1]
        src[n - 1] = t[length - 1]
        tt = length - 1
        if tt > 0:
            while True:
                q = length + (k >> 1)
                t1, t2 = t[k], t[q]
                if k & 1:
                    r = s >> 3
                    src[r + 2] = src[r + 2] | (t1 & 0xF0)
                    src[r + 3] = ((t1 & 0x0F) << 4) | (t2 >> 4)
                else:
                    r = c >> 3
                    src[r + 2] = t1 >> 4
                    src[r + 1] = ((t1 & 0x0F) << 4) | (t2 & 0x0F)
                s += 12
                c += 12
                k += 1
                if k >= tt:
                    break
    return n


# ---------------------------------------------------------------------------------------------------------------
class Bundle:
    def __init__(self, path):
        self.path = path
        self.f = open(path, 'rb')
        self.tag = self.f.read(4)
        dir_off, count = struct.unpack('>II', self.f.read(8))
        if self.tag not in (b'LB83', b'LB23'):
            raise ValueError('%s: not an iMUSE bundle (tag %r)' % (path, self.tag))
        esize = 32 if self.tag == b'LB23' else 20  # LB23 = ScummVM-recompressed bundle (24-byte names)
        self.f.seek(dir_off)
        d = self.f.read(count * esize)
        self.entries = []  # (name 'B2GT301.IMX', offset, size)
        for i in range(count):
            e = d[i * esize:(i + 1) * esize]
            if self.tag == b'LB23':
                name = e[:24].split(b'\0')[0].decode('latin1')
            else:
                name = e[:8].split(b'\0')[0].decode('latin1') + '.' + e[8:12].split(b'\0')[0].decode('latin1')
            off, size = struct.unpack('>II', e[esize - 8:])
            self.entries.append((name, off, size))
        self.by_name = {n.upper(): (n, o, s) for n, o, s in self.entries}

    def match(self, patterns):
        """Entries matching case-insensitive globs (extension optional), in bundle order, without duplicates."""
        out, seen = [], set()
        for pat in patterns:
            pat = pat.upper()
            hit = False
            for e in self.entries:
                up = e[0].upper()
                if fnmatch.fnmatchcase(up, pat) or fnmatch.fnmatchcase(up.rsplit('.', 1)[0], pat):
                    hit = True
                    if up not in seen:
                        seen.add(up)
                        out.append(e)
            if not hit:
                print('warning: no entry matches %r' % pat, file=sys.stderr)
        return out

    def read(self, entry):
        self.f.seek(entry[1])
        return self.f.read(entry[2])

    @staticmethod
    def comp_table(raw):
        count, _, last = struct.unpack_from('>III', raw, 4)
        return [struct.unpack_from('>III', raw, 16 + 16 * i) for i in range(count)], last

    def stream(self, entry):
        """The decompressed iMUS stream of an entry (BundleMgr::readFile over the whole sound)."""
        raw = self.read(entry)
        if raw[:4] == b'iMUS':
            return raw
        if raw[:4] != b'COMP':
            raise ValueError('not a sound (neither iMUS nor COMP: %r)' % raw[:4])
        table, last = self.comp_table(raw)
        total = (len(table) - 1) * CHUNK + last
        out = bytearray(len(table) * CHUNK)
        buf = bytearray(CHUNK + 64)  # _compOutputBuff: persists between blocks, like in ScummVM
        for i, (off, size, codec) in enumerate(table):
            inp = raw[off:off + size] + b'\0' * 4  # "CMI hack: one more zero byte at the end of input buffer"
            n = decompress_codec(codec, inp, size, buf)
            if n > CHUNK:
                raise ValueError('%s: block %d decompressed to %d bytes' % (entry[0], i, n))
            out[i * CHUNK:i * CHUNK + n] = buf[:n]
        return bytes(out[:total])

    def header(self, entry):
        """(parsed map, stream length) using only the first block when its header is stored raw."""
        raw = self.read(entry)
        if raw[:4] == b'COMP':
            table, last = self.comp_table(raw)
            off, size, codec = table[0]
            first = struct.unpack_from('>H', raw, off)[0]
            if codec in (13, 15) and first:
                return parse_imus(raw[off + 2:off + 2 + first], partial=True), (len(table) - 1) * CHUNK + last
        s = self.stream(entry)
        return parse_imus(s), len(s)


def parse_imus(s, partial=False):
    """Parses 'iMUS' 'MAP ' ... 'DATA'. Returns dict(bits, rate, channels, data_offset, data_size, events)."""
    if s[:4] != b'iMUS' or s[8:12] != b'MAP ':
        raise ValueError('not an iMUS stream (%r)' % s[:12])
    map_end = 16 + struct.unpack_from('>I', s, 12)[0]
    info = {'bits': None, 'rate': None, 'channels': None, 'events': []}
    p = 16
    while p + 8 <= map_end:
        tag = s[p:p + 4].decode('latin1')
        size = struct.unpack_from('>I', s, p + 4)[0]
        body = s[p + 8:p + 8 + size]
        if tag == 'FRMT':
            off, _, bits, rate, ch = struct.unpack_from('>5I', body)
            if info['bits'] is None:
                info.update(bits=bits, rate=rate, channels=ch)
            info['events'].append((tag, off, '%d-bit %d Hz %d ch' % (bits, rate, ch)))
        elif tag == 'REGN':
            info['events'].append((tag, *struct.unpack_from('>2I', body)))
        elif tag == 'TEXT':
            info['events'].append((tag, struct.unpack_from('>I', body)[0], body[4:].split(b'\0')[0].decode('latin1')))
        elif tag in ('STOP', 'JUMP', 'SYNC'):
            info['events'].append((tag, struct.unpack_from('>I', body)[0] if len(body) >= 4 else None,
                                   '%d bytes' % size))
        else:
            info['events'].append((tag, None, '%d bytes' % size))
        p += 8 + size
    if s[map_end:map_end + 4] != b'DATA' and not (partial and len(s) < map_end + 8):
        raise ValueError('no DATA after MAP (%r)' % s[map_end:map_end + 4])
    info['data_offset'] = map_end + 8
    info['data_size'] = struct.unpack_from('>I', s, map_end + 4)[0] if len(s) >= map_end + 8 else None
    if info['bits'] is None:
        raise ValueError('no FRMT block')
    return info


def pcm16(data, bits):
    """Sample bytes of a given word size -> 16-bit native-LE PCM bytes."""
    if bits == 16:
        return bytes(data[:len(data) & ~1])
    if bits == 8:
        a = array('h', ((b - 128) << 8 for b in data))
    elif bits == 12:
        a = array('h')
        for i in range(0, len(data) - 2, 3):
            b0, b1, b2 = data[i], data[i + 1], data[i + 2]
            a.append(((b0 | ((b1 & 0x0F) << 8)) - 2048) << 4)
            a.append(((b2 | ((b1 & 0xF0) << 4)) - 2048) << 4)
    else:
        raise ValueError('unsupported word size %d' % bits)
    if sys.byteorder == 'big':
        a.byteswap()
    return a.tobytes()


def levels(pcm):
    """(peak dBFS, RMS dBFS) of 16-bit PCM bytes."""
    a = array('h', pcm)
    if sys.byteorder == 'big':
        a.byteswap()
    if not a:
        return -120.0, -120.0
    peak = max(max(a), -min(a))
    rms = math.sqrt(sum(x * x for x in a) / len(a))
    db = lambda v: 20 * math.log10(v / 32768) if v > 0 else -120.0  # noqa: E731
    return db(peak), db(rms)


def extract(bundle, entry, out_dir, verbose=False):
    s = bundle.stream(entry)
    info = parse_imus(s)
    start = info['data_offset']
    end = min(len(s), start + (info['data_size'] or len(s)))
    pcm = pcm16(s[start:end], info['bits'])
    stem = entry[0].rsplit('.', 1)[0]
    path = os.path.join(out_dir, stem + '.wav')
    with wave.open(path, 'wb') as w:
        w.setnchannels(info['channels'])
        w.setsampwidth(2)
        w.setframerate(info['rate'])
        w.writeframes(pcm)
    secs = len(pcm) / (2 * info['channels'] * info['rate'])
    line = '%-14s %6d Hz %d ch %2d-bit %7.2f s' % (entry[0], info['rate'], info['channels'], info['bits'], secs)
    if verbose:
        pk, rms = levels(pcm)
        line += '  peak %6.1f dBFS  rms %6.1f dBFS' % (pk, rms)
        regions = [e for e in info['events'] if e[0] == 'REGN']  # (odd DATA sizes lose their last byte)
        if len(regions) != 1 or regions[0][1] != start or abs(regions[0][2] - (end - start)) > 1:
            line += '\n    note: regions %s differ from DATA [%d, %d)' % (regions, start, end)
        for e in info['events']:
            if e[0] in ('TEXT', 'JUMP', 'SYNC'):
                line += '\n    %s @%s %s' % e
    return line


_WORKER = {}


def _work(args):
    bun_path, entry, out_dir, verbose = args
    b = _WORKER.get(bun_path) or _WORKER.setdefault(bun_path, Bundle(bun_path))
    try:
        return extract(b, entry, out_dir, verbose)
    except Exception as ex:  # report and keep going
        return '%-14s ERROR %s' % (entry[0], ex)


def load_language_tab(path):
    tab = {}
    if path and os.path.exists(path):
        with open(path, 'rb') as f:
            for line in f.read().decode('latin1').splitlines():
                if '\t' in line:
                    k, v = line.split('\t', 1)
                    tab[k.upper()] = v
    return tab


def resolve(path):
    if os.path.exists(path):
        return path
    for cand in (os.path.join(RESOURCE, path), os.path.join(RESOURCE, path.upper())):
        if os.path.exists(cand):
            return cand
    sys.exit('bundle not found: %s' % path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog='\n'.join(__doc__.split('\n')[1:]))
    ap.add_argument('bundle', help='VOXDISK1.BUN etc. (bare names are looked up in %s)' % RESOURCE)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument('--list', nargs='*', metavar='PATTERN', help='list entries (optionally matching globs)')
    mode.add_argument('--extract', nargs='+', metavar='NAME', help='entry names or globs to extract')
    mode.add_argument('--all', action='store_true', help='extract every entry')
    ap.add_argument('--out', help='output directory for WAV files')
    ap.add_argument('--text', action='store_true', help='--list: add the English line from LANGUAGE.TAB')
    ap.add_argument('--tab', help='LANGUAGE.TAB path (default: next to the bundle)')
    ap.add_argument('--jobs', type=int, default=0, help='worker processes (default: CPU count, max 12)')
    ap.add_argument('-v', '--verbose', action='store_true', help='print levels and map markers when extracting')
    a = ap.parse_args()

    path = resolve(a.bundle)
    b = Bundle(path)
    if a.list is not None:
        tab = load_language_tab(a.tab or os.path.join(os.path.dirname(path), 'LANGUAGE.TAB')) if a.text else {}
        entries = b.match(a.list) if a.list else b.entries
        total_s = 0.0
        print('# %s: %s, %d entries' % (path, b.tag.decode(), len(b.entries)))
        print('%-14s %9s %6s %2s %4s %8s' % ('NAME', 'PACKED', 'RATE', 'CH', 'BITS', 'SECONDS'))
        for e in entries:
            try:
                info, length = b.header(e)
                size = min(length - info['data_offset'], info['data_size'] or length)
                secs = size * 8 / (info['bits'] * info['channels'] * info['rate'])
                total_s += secs
                row = '%-14s %9d %6d %2d %4d %8.2f' % (e[0], e[2], info['rate'], info['channels'], info['bits'], secs)
            except Exception as ex:
                row = '%-14s %9d  (%s)' % (e[0], e[2], ex)
            if a.text:
                row += '  ' + tab.get(e[0].rsplit('.', 1)[0].upper(), '')
            print(row)
        print('# %d listed, %.1f s of audio' % (len(entries), total_s))
        return

    if not a.out:
        ap.error('--out DIR is required with --extract/--all')
    os.makedirs(a.out, exist_ok=True)
    entries = b.entries if a.all else b.match(a.extract)
    jobs = a.jobs or min(12, os.cpu_count() or 1)
    if jobs <= 1 or len(entries) < 4:
        for e in entries:
            try:
                print(extract(b, e, a.out, a.verbose))
            except Exception as ex:  # report and keep going (e.g. the music bundles' non-audio PRELOAD entry)
                print('%-14s ERROR %s' % (e[0], ex))
        return
    work = [(path, e, a.out, a.verbose) for e in entries]
    errors = 0
    with concurrent.futures.ProcessPoolExecutor(max_workers=jobs) as ex:
        for line in ex.map(_work, work, chunksize=8):
            errors += ' ERROR ' in line
            print(line)
    print('# extracted %d of %d entries to %s' % (len(entries) - errors, len(entries), a.out))


if __name__ == '__main__':
    main()
