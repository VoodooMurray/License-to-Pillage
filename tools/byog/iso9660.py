#!/usr/bin/env python3
"""Reads CD images of The Curse of Monkey Island directly (no mounting): ISO 9660 images (.iso, 2048-byte sectors)
and raw CD dumps (.bin/.img/.mdf, 2352-byte sectors, or 2448 with subchannel data; mode 1 or mode 2 form 1).
Pure standard library.

  python3 tools/byog/iso9660.py list <image>                  # the files on the disc
  python3 tools/byog/iso9660.py extract <image...> <folder>    # CMI's game files of one or both CDs into a folder

The CMI CDs: disc 1 has COMI.LA0, COMI.LA1 and part of RESOURCE/, disc 2 COMI.LA2 and the rest; extracting both into
one folder gives what ScummVM (and the installer) want.
"""
import os
import struct
import sys

SECTOR = 2048
SYNC = b'\x00' + b'\xff' * 10 + b'\x00'


class IsoError(Exception):
    pass


class Iso:
    def __init__(self, path):
        self.path = path
        self.f = open(path, 'rb')
        self.raw, self.data_off = self._detect()
        pvd = None
        joliet = None
        for i in range(16, 64):
            d = self.sector(i)
            if d[1:6] != b'CD001':
                break
            if d[0] == 1 and pvd is None:
                pvd = d
            elif d[0] == 2 and d[88:91] in (b'%/@', b'%/C', b'%/E'):
                joliet = d
            elif d[0] == 255:
                break
        if pvd is None:
            raise IsoError(f'{os.path.basename(path)}: not an ISO 9660 CD image')
        self.joliet = joliet is not None
        root = (joliet or pvd)[156:156 + 34]
        self.root = (struct.unpack_from('<I', root, 2)[0], struct.unpack_from('<I', root, 10)[0])

    def _detect(self):
        """(raw sector size or None, user-data offset in a raw sector)."""
        self.f.seek(0, 2)
        size = self.f.tell()
        for raw, off in ((2352, 16), (2352, 24), (2448, 16), (2448, 24)):
            if size >= raw * 17:
                self.f.seek(raw * 16)
                head = self.f.read(raw)
                if head[:12] == SYNC and head[off + 1:off + 6] == b'CD001':
                    return raw, off
        return None, 0

    def sector(self, lba, n=1):
        if not self.raw:
            self.f.seek(lba * SECTOR)
            return self.f.read(SECTOR * n)
        out = []
        for k in range(n):
            self.f.seek((lba + k) * self.raw + self.data_off)
            out.append(self.f.read(SECTOR))
        return b''.join(out)

    def read(self, lba, size, offset=0, n=None):
        """`n` bytes (default: to the end) of a file at extent `lba`, `size` bytes long, from `offset`."""
        n = size - offset if n is None else max(0, min(n, size - offset))
        if not self.raw:
            self.f.seek(lba * SECTOR + offset)
            return self.f.read(n)
        out = bytearray()
        pos = offset
        while len(out) < n:
            s, o = divmod(pos, SECTOR)
            chunk = self.sector(lba + s)[o:o + (n - len(out))]
            if not chunk:
                break
            out += chunk
            pos += len(chunk)
        return bytes(out)

    def _records(self, lba, size):
        data = self.sector(lba, -(-size // SECTOR))[:size]
        p = 0
        while p < len(data):
            ln = data[p]
            if ln == 0:                         # no record crosses a sector: go to the next one
                p = (p // SECTOR + 1) * SECTOR
                continue
            r = data[p:p + ln]
            ext, dlen, flags, nl = struct.unpack_from('<I', r, 2)[0], struct.unpack_from('<I', r, 10)[0], r[25], r[32]
            ident = r[33:33 + nl]
            p += ln
            if ident in (b'\x00', b'\x01'):
                continue
            name = ident.decode('utf-16-be', errors='replace') if self.joliet else ident.decode('latin1')
            name = name.split(';')[0].rstrip('.')
            yield name, ext, dlen, bool(flags & 2)

    def walk(self):
        """(relative path, extent, size) of every file on the disc."""
        stack = [('', self.root[0], self.root[1])]
        seen = set()
        while stack:
            base, lba, size = stack.pop()
            if lba in seen:
                continue
            seen.add(lba)
            for name, ext, dlen, is_dir in self._records(lba, size):
                rel = f'{base}/{name}' if base else name
                if is_dir:
                    stack.append((rel, ext, dlen))
                else:
                    yield rel, ext, dlen

    def extract(self, ext, size, dst, chunk=1 << 22):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        tmp = dst + '.part'
        with open(tmp, 'wb') as out:
            off = 0
            while off < size:
                b = self.read(ext, size, off, chunk)
                if not b:
                    raise IsoError(f'{os.path.basename(self.path)}: short read at {off} of {size}')
                out.write(b)
                off += len(b)
        os.replace(tmp, dst)


IMAGE_EXT = ('.iso', '.bin', '.img', '.mdf', '.toast', '.cdr')


def is_image_name(name):
    return name.lower().endswith(IMAGE_EXT)


def is_image(path):
    return os.path.isfile(path) and is_image_name(path)


def game_files(iso):
    """{name in the game folder ('COMI.LA1', 'RESOURCE/FONT0.NUT'): (extent, size)} on this disc: the COMI.LA*
    files and everything in a RESOURCE folder, wherever they are on the disc."""
    out = {}
    for rel, ext, size in iso.walk():
        parts = rel.split('/')
        name = parts[-1].upper()
        if name.startswith('COMI.LA'):
            out[name] = (ext, size)
        elif len(parts) >= 2 and parts[-2].upper() == 'RESOURCE':
            out['RESOURCE/' + name] = (ext, size)
    return out


def blob_table(path):
    """{game file name: [byte offset, size]} for reading the files in place (plain 2048-byte-sector images: the
    browser version mounts these byte ranges as files without copying), or None for raw dumps."""
    iso = Iso(path)
    if iso.raw:
        return None
    return {name: [ext * SECTOR, size] for name, (ext, size) in game_files(iso).items()}


def extract_game(images, folder, log=print, only=None):
    """CMI's game files from one or more CD images into `folder` (both CDs merge into one game folder). Files already
    there with the right size are kept. Returns the list of names written or found."""
    names = []
    for img in images:
        iso = Iso(img)
        files = game_files(iso)
        if not files:
            log(f'  {os.path.basename(img)}: no CMI game files on this disc')
            continue
        total = sum(s for _, s in files.values())
        log(f'  {os.path.basename(img)}: {len(files)} files, {total / 1e6:.0f} MB')
        for name, (ext, size) in sorted(files.items()):
            if only and not only(name):
                continue
            dst = os.path.join(folder, *name.split('/'))
            if not (os.path.isfile(dst) and os.path.getsize(dst) == size):
                iso.extract(ext, size, dst)
            names.append(name)
    return names


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == 'list':
        iso = Iso(sys.argv[2])
        for rel, ext, size in sorted(iso.walk()):
            print(f'{size:12d}  {rel}')
    elif len(sys.argv) >= 4 and sys.argv[1] == 'extract':
        print(len(extract_game(sys.argv[2:-1], sys.argv[-1])), 'files')
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
