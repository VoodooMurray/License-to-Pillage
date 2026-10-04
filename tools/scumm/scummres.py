#!/usr/bin/env python3
"""Reader for SCUMM v8 (The Curse of Monkey Island) resource files: COMI.LA0 (index) and
COMI.LA1/LA2 (data, LECF -> LOFF + LFLF per room).

Spec: ScummVM engines/scumm/resource.cpp (readIndexFile / readIndexBlock / readMAXS v8 /
readGlobalObjects v8 / readResTypeList / readRoomsOffsets).

Usage:
  scummres.py index                 # MAXS + directory summary
  scummres.py tree [room]           # block tree of a room's LFLF
  scummres.py blocks                # top-level blocks of the data files
"""
import os
import struct
import sys

_VIEW = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), '.byog', 'game')
# the CMI data folder: $COMI_GAME, else a mod install's view of the player's game (setup.py), else ./cmi-game
GAME = os.path.expanduser(os.environ.get('COMI_GAME') or (_VIEW if os.path.isfile(os.path.join(_VIEW, 'COMI.LA0'))
                                                           else 'cmi-game'))


def be32(b, o=0):
    return struct.unpack_from('>I', b, o)[0]


def le32(b, o=0):
    return struct.unpack_from('<I', b, o)[0]


def le16(b, o=0):
    return struct.unpack_from('<H', b, o)[0]


def blocks(data, start=0, end=None):
    """Yields (tag, offset, size) of consecutive blocks (size includes the 8-byte header)."""
    end = len(data) if end is None else end
    o = start
    while o + 8 <= end:
        tag = data[o:o + 4].decode('latin1')
        size = be32(data, o + 4)
        if size < 8 or o + size > end:
            break
        yield tag, o, size
        o += size


CONTAINERS = {'LECF', 'LFLF', 'ROOM', 'RMIM', 'IM00', 'IM01', 'IM02', 'IM03', 'IM04', 'IM05', 'IM06', 'IM07',
              'IM08', 'IM09', 'IM0A', 'IM0B', 'IM0C', 'IM0D', 'IM0E', 'IM0F', 'IM10', 'IM11', 'IM12', 'IM13',
              'IM14', 'IM15', 'IM16', 'IM17', 'IM18', 'IM19', 'IM1A', 'IM1B', 'IM1C', 'IM1D', 'IM1E', 'IM1F',
              'OBIM', 'OBCD', 'RMSC', 'PALS', 'WRAP', 'SMAP', 'ZPLN', 'ZSTR', 'BSTR', 'SOUN', 'AKOS', 'ROOM',
              'IMAG', 'MULT'}


def tree(data, start, end, depth=0, out=None, maxdepth=9):
    out = [] if out is None else out
    for tag, o, size in blocks(data, start, end):
        out.append((depth, tag, o, size))
        if tag in CONTAINERS and depth < maxdepth:
            tree(data, o + 8, o + size, depth + 1, out, maxdepth)
    return out


class Index:
    def __init__(self, path=None):
        path = path or os.path.join(GAME, 'COMI.LA0')
        self.data = open(path, 'rb').read()
        self.blocks = []
        self.dirs = {}
        o = 0
        d = self.data
        while o + 8 <= len(d):
            tag = d[o:o + 4].decode('latin1')
            size = be32(d, o + 4)
            body = d[o + 8:o + size]
            self.blocks.append((tag, o, size))
            if tag == 'MAXS':
                self.maxs_raw = body
                self.engine_version = body[:50].split(b'\0')[0].decode('latin1')
                self.data_version = body[50:100].split(b'\0')[0].decode('latin1')
                vals = struct.unpack_from('<17I', body, 100)
                names = ['numVariables', 'numBitVariables', 'unk40', 'numScripts', 'numSounds', 'numCharsets',
                         'numCostumes', 'numRooms', 'unk80', 'numGlobalObjects', 'unk60', 'numLocalObjects',
                         'numNewNames', 'numFlObject', 'numInventory', 'numArray', 'numVerbs']
                self.maxs = dict(zip(names, vals))
            elif tag in ('DIRR', 'DROO', 'DIRS', 'DSCR', 'DIRC', 'DCOS', 'DIRN', 'DSOU', 'DIRF', 'DCHR', 'DRSC', 'DIRI'):
                n = le32(body, 0)
                disks = list(body[4:4 + n])
                offs = list(struct.unpack_from(f'<{n}I', body, 4 + n))
                self.dirs[tag] = (disks, offs)
            elif tag == 'DOBJ':
                n = le32(body, 0)
                objs = []
                p = 4
                for i in range(n):
                    name = body[p:p + 40].split(b'\0')[0].decode('latin1')
                    state, room = body[p + 40], body[p + 41]
                    cls = le32(body, p + 42)
                    objs.append((name, state, room, cls))
                    p += 46
                self.objects = objs
            elif tag == 'RNAM':
                names = {}
                p = 0
                while p < len(body):
                    r = body[p]
                    if r == 0:
                        break
                    names[r] = bytes(x ^ 0xFF for x in body[p + 1:p + 10]).split(b'\0')[0].decode('latin1')
                    p += 10
                self.room_names = names
            elif tag == 'AARY':
                self.aary = body
            elif tag == 'ANAM':
                n = le16(body, 0)
                self.audio_names = [body[2 + i * 9:2 + i * 9 + 9].split(b'\0')[0].decode('latin1') for i in range(n)]
            o += size

    def dir(self, *tags):
        for t in tags:
            if t in self.dirs:
                return self.dirs[t]
        return None


class DataFile:
    """COMI.LA1 / LA2: LECF container, LOFF room offset table, LFLF per room."""

    def __init__(self, disk):
        self.disk = disk
        self.path = os.path.join(GAME, f'COMI.LA{disk}')
        self.data = open(self.path, 'rb').read()
        d = self.data
        assert d[:4] == b'LECF', d[:4]
        # LOFF at offset 8
        assert d[8:12] == b'LOFF'
        n = d[16]
        self.room_offsets = {}
        for i in range(n):
            room = d[17 + i * 5]
            off = le32(d, 18 + i * 5)
            self.room_offsets[room] = off

    def room_block(self, room):
        """Returns (start, end) of the room's ROOM block contents inside the LFLF (the offset points at ROOM)."""
        off = self.room_offsets[room]
        return off

    def lflf_of(self, room):
        lf = self.room_offsets[room]   # v8: LOFF points at the LFLF block
        assert self.data[lf:lf + 4] == b'LFLF', (room, self.data[lf:lf + 4])
        return lf, be32(self.data, lf + 4)


def find_room(room, idx=None):
    idx = idx or Index()
    disks, offs = idx.dir('DIRR', 'DROO')
    disk = disks[room]
    df = DataFile(disk)
    return df, df.lflf_of(room)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'index'
    idx = Index()
    if cmd == 'index':
        print('engine:', idx.engine_version, '| data:', idx.data_version)
        for k, v in idx.maxs.items():
            print(f'  {k} = {v}')
        for tag, o, size in idx.blocks:
            print(f'{tag} @{o} size {size}')
        for tag, (disks, offs) in idx.dirs.items():
            used = sum(1 for x in offs if x not in (0, 0xFFFFFFFF))
            print(f'{tag}: {len(disks)} entries, {used} used; disks {sorted(set(disks))}')
        print('objects:', len(idx.objects), 'e.g.', idx.objects[100:105])
        print('rooms named:', len(idx.room_names), list(idx.room_names.items())[:12])
    elif cmd == 'tree':
        room = int(sys.argv[2])
        df, (lf, size) = find_room(room, idx)
        print(f'room {room} on disk {df.disk} LFLF @{lf} size {size}')
        for depth, tag, o, sz in tree(df.data, lf + 8, lf + size, maxdepth=int(sys.argv[3]) if len(sys.argv) > 3 else 3):
            print('  ' * depth + f'{tag} @{o} size {sz}')
    elif cmd == 'blocks':
        for disk in (1, 2):
            df = DataFile(disk)
            print(f'disk {disk}: rooms {sorted(df.room_offsets)}')
            for tag, o, size in blocks(df.data, 8, len(df.data)):
                pass
            top = list(blocks(df.data, 8, len(df.data)))
            print('  LECF children:', len(top), [t for t, _, _ in top[:5]])


if __name__ == '__main__':
    main()
