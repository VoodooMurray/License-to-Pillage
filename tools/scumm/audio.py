#!/usr/bin/env python3
"""Voices and music for License to Pillage inside CMI, through CMI's own iMUSE (no engine change).

ScummVM's bundle directory cache has exactly 4 slots (VOXDISK1/2, MUSDISK1/2 are indexed at startup),
so new audio cannot live in extra bundle files (a VOXDISK3.BUN aborts the game): we write combined
copies of VOXDISK1.BUN / MUSDISK1.BUN into scumm/game/RESOURCE (the original entries byte for byte +
ours; overridden music entries dropped from the directory). iMUSE looks sounds up on the current disk,
then disk 1, then 2 (our rooms set VAR_CURRENTDISK = 1 on entry, the originals stay untouched).

Voices: game/voice.json maps "speaker|text" -> game/voice/<speaker>/<hash>.mp3. The compiler tags each
voiced line "/LTxxxxxx/text" (LT + 6 hex digits of the file hash, <= 8 chars: bundle names are 8.3);
for such a line CMI plays <TAG>.IMX from VOXDISK<current disk>.BUN (ScummVM: ScummEngine_v7::playSpeech,
iMUSE then falls back to disks 1 and 2). Our rooms live on disk 3, so we write RESOURCE/VOXDISK3.BUN.

Music: CMI music = iMUSE states (soundKludge 4096) whose files come from MUSDISK<disk>.BUN the same way.
MUSDISK3.BUN holds our tracks (game/music/*.mp3) under the file names of the states our rooms set
(e.g. 1260-T~1.IMX = stateTown = the harbor), looped with a JUMP; everything else falls back to disks 1/2.

Bundles are "LB83" files. Our entries are iMUS files { MAP { FRMT(16 bit, 22050 Hz, channels) [TEXT] REGN
[JUMP] STOP } DATA(PCM) } (header fields big-endian, PCM 16 bit little-endian, like CMI's decoded bundle audio),
stored as COMP entries with codec 0 (plain copy) blocks of 0x2000 bytes: every ScummVM since the first one with
CMI support reads those (ScummVM 2.0.0, which Steam ships with CMI, aborts on raw 'iMUS' entries: "Compressed
sound ... invalid (iMUS)"; newer versions read both).

Decoding mp3 needs ffmpeg; decoded PCM is cached by CONTENT (sha1 of the mp3 + channels + filter), so a cache
folder built once (shipped with the mod: scumm/audio_cache) makes ffmpeg unnecessary on other machines.

  python3 tools/scumm/audio.py check <bundle>     # list a bundle
"""
import hashlib
import json
import os
import struct
import subprocess
import sys

RATE = 22050


# extra read-only caches searched after cache_dir (e.g. the PCM shipped with the mod): set by build.py
EXTRA_CACHES = []


def pcm_key(path, channels, af):
    """Cache key of a decoded file: its content, the channel count and the ffmpeg filter (machine-independent)."""
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return hashlib.sha1(f'{h.hexdigest()}|{channels}|{af}|{RATE}'.encode()).hexdigest()[:20]


def pcmz_pack(pcm, channels, shift=0):
    """Packing of s16le PCM for shipping: second differences per channel (wrapping int16), low and high bytes split,
    lzma. shift > 0 drops that many low bits first (rounded; shift 2 = 14-bit samples, noise far below the mp3
    sources'). v1: 'PCMZ' u8 1, u8 channels, u32 frames, data; v2 adds u8 shift after the frames."""
    import lzma
    import numpy as np
    a = np.frombuffer(pcm, '<i2').reshape(-1, channels).astype(np.int32)
    if shift:
        a = (a + (1 << (shift - 1))) >> shift
    d1 = np.diff(a, axis=0, prepend=np.zeros((1, channels), np.int32))
    d2 = np.diff(d1, axis=0, prepend=np.zeros((1, channels), np.int32)).astype('<i2')
    b = d2.view(np.uint8).reshape(-1, 2)
    head = struct.pack('<BBI', 2, channels, len(a)) + bytes([shift]) if shift else struct.pack('<BBI', 1, channels, len(a))
    return b'PCMZ' + head + lzma.compress(b[:, 0].tobytes() + b[:, 1].tobytes(), preset=6)


def pcmz_unpack(data):
    import lzma
    import numpy as np
    assert data[:4] == b'PCMZ' and data[4] in (1, 2), 'not a PCMZ v1/v2 file'
    channels, frames = data[5], struct.unpack('<I', data[6:10])[0]
    shift, body = (data[10], data[11:]) if data[4] == 2 else (0, data[10:])
    raw = np.frombuffer(lzma.decompress(body), np.uint8)
    n = len(raw) // 2
    d2 = (raw[:n].astype(np.uint16) | (raw[n:].astype(np.uint16) << 8)).view(np.int16).reshape(frames, channels)
    d1 = np.cumsum(d2.astype(np.int64), axis=0).astype(np.int16)
    a = np.cumsum(d1.astype(np.int64), axis=0).astype(np.int16)
    if shift:
        a = np.clip(a.astype(np.int32) << shift, -32768, 32767)
    return a.astype('<i2').tobytes()


def ffmpeg_pcm(path, channels, cache_dir, af):
    """Decoded s16le PCM at 22050 Hz (cached by content, channels and filter: see pcm_key)."""
    key = pcm_key(path, channels, af)
    cp = os.path.join(cache_dir, key + '.pcm')
    for d in [cache_dir] + EXTRA_CACHES:
        p = os.path.join(d, key + '.pcm')
        if os.path.exists(p):
            return open(p, 'rb').read()
        if os.path.exists(p + 'z'):
            return pcmz_unpack(open(p + 'z', 'rb').read())
    os.makedirs(cache_dir, exist_ok=True)
    cmd = ['ffmpeg', '-v', 'error', '-i', path, '-ac', str(channels), '-ar', str(RATE)]
    if af:
        cmd += ['-af', af]
    cmd += ['-f', 's16le', '-acodec', 'pcm_s16le', '-']
    try:
        pcm = subprocess.run(cmd, capture_output=True, check=True).stdout
    except FileNotFoundError:
        raise RuntimeError(f'{path}: not in the audio cache and ffmpeg is not installed (needed for new audio)')
    pcm = pcm[:len(pcm) // (2 * channels) * 2 * channels]
    with open(cp + '.tmp', 'wb') as f:
        f.write(pcm)
    os.replace(cp + '.tmp', cp)
    return pcm


def blk(tag, data):
    return tag + struct.pack('>I', len(data)) + data


COMP_BLOCK = 0x2000


def comp(data):
    """A bundle entry in CMI's COMP layout around raw bytes (an iMUS file): 'COMP', block count, 0, size of the
    last decompressed block, then per block (offset from the entry start, size, codec 0 = copy, 0), then the
    blocks. ScummVM's BundleMgr decodes block by block and needs every block but the last to give 0x2000 bytes."""
    blocks = [data[i:i + COMP_BLOCK] for i in range(0, len(data), COMP_BLOCK)] or [b'']
    n = len(blocks)
    out = [b'COMP', struct.pack('>3I', n, 0, len(blocks[-1]))]
    off = 16 + 16 * n
    for b in blocks:
        out.append(struct.pack('>4I', off, len(b), 0, 0))
        off += len(b)
    return b''.join(out + blocks)


def imus(pcm, channels, name=None, loop=False):
    """An uncompressed iMUS file: map events at byte offsets of the file, data right after the map."""
    def events(data_off):
        n = len(pcm)
        ev = [blk(b'FRMT', struct.pack('>5I', data_off, 0, 16, RATE, channels))]
        if name:
            ev.append(blk(b'TEXT', struct.pack('>I', data_off) + name.encode('latin1') + b'\0'))
        ev.append(blk(b'REGN', struct.pack('>2I', data_off, n)))
        if loop:
            # at the end of the region jump back to its start (hook 0 = always), no crossfade
            ev.append(blk(b'JUMP', struct.pack('>4I', data_off + n, data_off, 0, 0)))
        ev.append(blk(b'STOP', struct.pack('>I', data_off + n)))
        return b''.join(ev)
    # data offset = iMUS header 8 + MAP header 8 + map content + DATA header 8
    size = len(events(0))
    data_off = 8 + 8 + size + 8
    body = blk(b'MAP ', events(data_off)) + blk(b'DATA', pcm)
    return blk(b'iMUS', body)


def read_dir(path):
    """(tag, dir offset, [(name, offset, size)]) of an LB83 bundle."""
    with open(path, 'rb') as f:
        tag = f.read(4)
        off, n = struct.unpack('>II', f.read(8))
        f.seek(off)
        ents = []
        for _ in range(n):
            e = f.read(20)
            name = e[:8].rstrip(b'\0').decode('latin1') + '.' + e[8:12].rstrip(b'\0').decode('latin1')
            o, size = struct.unpack('>II', e[12:20])
            ents.append((name, o, size))
    return tag, off, ents


def cmi_entry(path, name):
    """Raw bytes of one entry of a CMI bundle (a COMP entry's block offsets are relative to the entry: copyable)."""
    _, _, ents = read_dir(path)
    for n, o, size in ents:
        if n.upper() == name.upper():
            with open(path, 'rb') as f:
                f.seek(o)
                return f.read(size)
    raise KeyError(f'{name} not in {path}')


def merge_bundle(orig, out_path, files, stamp):
    """Original bundle bytes up to its directory + our files, then a directory of the original entries
    (minus names we replace) and ours. Skipped when out_path already has the same stamp."""
    stamp_path = out_path + '.stamp'
    if os.path.exists(out_path) and not os.path.islink(out_path) and os.path.exists(stamp_path) \
            and open(stamp_path).read() == stamp:
        return os.path.getsize(out_path)
    tag, dir_off, ents = read_dir(orig)
    ours = {name.upper() for name, _ in files}
    table = [(n, o, s) for n, o, s in ents if n.upper() not in ours]
    tmp = out_path + '.tmp'
    with open(orig, 'rb') as src, open(tmp, 'wb') as out:
        left = dir_off
        while left:
            chunk = src.read(min(left, 1 << 24))
            out.write(chunk)
            left -= len(chunk)
        pos = dir_off
        for name, data in files:
            table.append((name, pos, len(data)))
            out.write(data)
            pos += len(data)
        new_dir = pos
        for name, o, size in table:
            stem, ext = name.split('.')
            out.write(stem.encode('latin1').ljust(8, b'\0')[:8] + ext.encode('latin1').ljust(4, b'\0')[:4] +
                      struct.pack('>2I', o, size))
        out.seek(4)
        out.write(struct.pack('>2I', new_dir, len(table)))
    if os.path.lexists(out_path) and os.path.islink(out_path):
        raise RuntimeError(f'{out_path} is a link: move it away first')
    os.replace(tmp, out_path)
    with open(stamp_path, 'w') as f:
        f.write(stamp)
    return os.path.getsize(out_path)


def write_bundle(path, files):
    """files: [(8.3 name, bytes)] -> LB83 bundle (entries at 32, directory at the end)."""
    out = bytearray(b'LB83' + b'\0' * 28)
    table = []
    for name, data in files:
        stem, ext = name.split('.')
        assert len(stem) <= 8 and len(ext) <= 4, name
        table.append((stem, ext, len(out), len(data)))
        out += data
    dir_off = len(out)
    for stem, ext, off, size in table:
        out += stem.encode().ljust(8, b'\0') + ext.encode().ljust(4, b'\0') + struct.pack('>2I', off, size)
    out[4:12] = struct.pack('>2I', dir_off, len(files))
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(out)
    os.replace(tmp, path)
    return len(out)


PLAYER_LINES = {}       # build.py --hero drybrush: English line -> the stand-in's own recording


class Voices:
    """Voice lines of the web game, tagged for CMI."""

    def __init__(self, game_dir):
        self.dir = game_dir
        path = os.path.join(game_dir, 'voice.json')
        self.map = json.load(open(path)) if os.path.exists(path) else {}
        self.used = {}      # tag -> mp3 path
        # lines voiced by CMI's own clips (tools/voice_fixed.json: "speaker|text" -> "CMI:TDGT306") keep their
        # original tag; a clip that only exists on disk 2 is copied byte for byte into our VOXDISK1 (build()), so it
        # plays without relying on iMUSE's disk fallback
        fixed = os.path.join(os.path.dirname(os.path.abspath(game_dir)), 'tools', 'voice_fixed.json')
        self.fixed = {k: v.split(':', 1)[1] for k, v in (json.load(open(fixed)) if os.path.exists(fixed) else {}).items()}
        self.cmi_used = set()   # CMI tags used by fixed lines

    def tag(self, speaker, text):
        if f'{speaker}|{text}' in self.fixed and not (PLAYER_LINES and speaker in ('guybrush', 'player')):
            tag = self.fixed[f'{speaker}|{text}']
            self.cmi_used.add(tag)
            return tag
        if PLAYER_LINES and speaker in ('guybrush', 'player'):     # the stand-in: his voice or none (never Guybrush's)
            path = PLAYER_LINES.get(text)
            if not path:
                return None
            rel = os.path.relpath(path, self.dir)
        else:
            rel = self.map.get(f'{speaker}|{text}')
            if not rel:
                return None
            path = os.path.join(self.dir, rel)
        if not os.path.exists(path):
            return None
        h = os.path.splitext(os.path.basename(rel))[0]
        tag = ('LT' + ''.join(c for c in h if c.isalnum())[:6]).upper()
        other = self.used.get(tag)
        if other and other != path:
            # (astronomically rare) hash prefix clash: extend with a digit
            for k in range(10):
                t2 = tag[:7] + str(k)
                if self.used.get(t2) in (None, path):
                    tag = t2
                    break
        self.used[tag] = path
        return tag

    VOICE_AF = 'loudnorm=I=-17:TP=-1.5:LRA=11'

    def build(self, orig, out_path, cache_dir):
        """VOXDISK1.BUN = CMI's voices + every used line of ours (mono, loudness-normalized)."""
        if not self.used:
            return None
        stamp = 'comp1' + json.dumps(sorted((t, pcm_key(p, 1, self.VOICE_AF)) for t, p in self.used.items())) + self.VOICE_AF
        files = []
        for tag, path in sorted(self.used.items()):
            pcm = ffmpeg_pcm(path, 1, cache_dir, self.VOICE_AF)
            files.append((f'{tag}.IMX', comp(imus(pcm, 1))))
        have = {n.upper() for n, _, _ in read_dir(orig)[2]}
        for tag in sorted(self.cmi_used):
            if f'{tag}.IMX' not in have:
                raw = cmi_entry(os.path.join(os.path.dirname(orig), 'VOXDISK2.BUN'), f'{tag}.IMX')
                files.append((f'{tag}.IMX', raw))
                stamp += f' {tag}:{len(raw)}'
        return len(files), merge_bundle(orig, out_path, files, hashlib.sha1(stamp.encode()).hexdigest())


MUSIC_AF = 'loudnorm=I=-20:TP=-2:LRA=11'


def build_music(orig, out_path, tracks, cache_dir):
    """tracks: [(8.3 file name, mp3 path, loop)] -> MUSDISK1.BUN = CMI's music with those state files
    replaced by ours (stereo)."""
    if not tracks:
        return None
    stamp = 'comp1' + json.dumps(sorted((n, pcm_key(p, 2, MUSIC_AF), lp) for n, p, lp in tracks)) + MUSIC_AF
    files = []
    for name, path, loop in tracks:
        pcm = ffmpeg_pcm(path, 2, cache_dir, MUSIC_AF)
        files.append((name, comp(imus(pcm, 2, name=os.path.splitext(os.path.basename(path))[0], loop=loop))))
    return len(files), merge_bundle(orig, out_path, files, hashlib.sha1(stamp.encode()).hexdigest())


def check(path):
    f = open(path, 'rb')
    tag = f.read(4)
    off, n = struct.unpack('>II', f.read(8))
    f.seek(off)
    for _ in range(n):
        e = f.read(20)
        name = e[:8].rstrip(b'\0').decode() + '.' + e[8:12].rstrip(b'\0').decode()
        o, size = struct.unpack('>II', e[12:20])
        here = f.tell()
        f.seek(o)
        head = f.read(64)
        kind = head[:4].decode('latin1')
        if head[:4] == b'COMP':
            first_off, first_size, codec = struct.unpack('>3I', head[16:28])
            if codec == 0:      # ours: the iMUS file starts in the first (stored) block
                f.seek(o + first_off)
                head = f.read(64)
                kind = 'COMP0'
        f.seek(here)
        fr = head.find(b'FRMT')
        bits, rate, ch = struct.unpack('>3I', head[fr + 16:fr + 28]) if fr >= 0 else (0, 0, 0)
        secs = (size - 80) / (bits // 8 * ch * rate) if bits else 0
        print(f'{name:14s} {size:9d}  {kind} {bits}bit {rate}Hz {ch}ch {secs:6.1f}s')
    print(tag.decode(), n, 'files')


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'check':
        check(sys.argv[2])
    else:
        print(__doc__)
