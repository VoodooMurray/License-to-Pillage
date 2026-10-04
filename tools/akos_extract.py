#!/usr/bin/env python3
"""Extracts a Curse of Monkey Island (SCUMM v8) AKOS costume into engine-ready animation data.

Reads the user's own game files (read-only) and follows ScummVM's engines/scumm/akos.cpp:
  index COMI.LA0: DROO (room -> disk), DCOS (costume -> room, offset inside the room's LFLF)
  disk COMI.LA<n>: LECF/LOFF (room -> file offset); the AKOS block is at room offset + costume offset
  AKOS: AKHD header, AKCH chores (anim * ndirs + dir), AKSQ sequence programs, AKOF cel offsets,
        AKCI cel sizes (CMI: 4 bytes, width/height), AKCD cel data (decoded by the user's dumper).

Model (identical to SCUMM, see actor.json "notes"):
  * An actor has limbs (Guybrush: 0 = body, 1 = head), drawn in limb order.
  * Playing anim F in direction D applies chore F*ndirs+D: per limb one op
      set    start the limb's program (frames, then loop_to)
      stop   hide the limb (its program keeps its state)
      resume show the limb again
      clear  empty the limb
    Limbs the chore does not mention keep what they are doing (talk = head only, over any body anim).
  * Each limb remembers the anim that last set it; when the actor changes facing, every limb re-applies
    its remembered anim's op for the new direction (programs restart). That is how heads follow bodies.
  * Programs advance one frame per game frame: CMI runs at 12 frames/s (boot script: VAR_TIMER_NEXT=5
    jiffies), costumes animate every game frame (_animSpeed 0). A frame's "hold" counts game frames.
  * CMI draws every cel with AKC_DrawMany: explicit (x, y) = cel top-left relative to the feet, in the
    640x480 logical space. Unmirrored (Guybrush has 8 real directions; costume flag 1 = never mirror).

Usage:
  tools/akos_extract.py --costume 2 --out game/actors/guybrush [--id guybrush] [--hd DIR] [--sheets DIR] [--webp]
  tools/akos_extract.py --costume 12 --out game/actors/murray --id murray --webp     (Murray, MURRAY_ROLES)
"""
import argparse
import json
import os
import shutil
import struct
import sys

_VIEW = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.byog', 'game')
GAME = os.environ.get('COMI_GAME') or (_VIEW if os.path.isfile(os.path.join(_VIEW, 'COMI.LA0')) else 'cmi-game')   # mod install first
# an optional private dump / HD pack with cNNNN/cNNNN_CCCC.png cels (tools/byog decodes the cels itself instead)
DUMP = os.path.expanduser(os.environ.get('CMI_DUMP_COSTUMES', 'cmi-dump/costumes'))
HD = os.path.expanduser(os.environ.get('CMI_HD_COSTUMES', 'hd-pack/costumes'))

DIR8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']   # toSimpleDir(1, facing): index i = i * 45 degrees
DIR4 = ['W', 'E', 'S', 'N']                           # newDirToOldDir order for 4-direction costumes

C = 0xC000
AKC = dict(EmptyCel=C | 0x01, SetVar=C | 0x10, StartSound=C | 0x15, IfSoundInVarRunningGoTo=C | 0x16,
           IfNotSoundInVarRunningGoTo=C | 0x17, IfSoundRunningGoTo=C | 0x18, IfNotSoundRunningGoTo=C | 0x19,
           DrawMany=C | 0x20, CondDrawMany=C | 0x21, CondRelativeOffsetDrawMany=C | 0x22,
           RelativeOffsetDrawMany=C | 0x25, GoToState=C | 0x30, IfVarGoTo=C | 0x31, AddVar=C | 0x40,
           SoftSound=C | 0x42, SoftVarSound=C | 0x44, SetUserCondition=C | 0x45, SetVarToUserCondition=C | 0x46,
           SetTalkCondition=C | 0x47, SetVarToTalkCondition=C | 0x48, StartScript=C | 0x50, IncVar=C | 0x60,
           StartSound_SpecialCase=C | 0x61, IfVarEQJump=C | 0x70, IfVarNEJump=C | 0x71, IfVarLTJump=C | 0x72,
           IfVarLEJump=C | 0x73, IfVarGTJump=C | 0x74, IfVarGEJump=C | 0x75, StartAnim=C | 0x80,
           StartVarAnim=C | 0x81, SetVarRandom=C | 0x82, SetActorZClipping=C | 0x83, StartActorAnim=C | 0x84,
           SetActorVar=C | 0x85, HideActor=C | 0x86, SetDrawOffs=C | 0x87, JumpToOffsetInVar=C | 0x88,
           SoundStuff=C | 0x89, Flip=C | 0x8A, StartActionOn=C | 0x8B, StartScriptVar=C | 0x8C,
           StartSoundVar=C | 0x8D, DisplayAuxFrame=C | 0x8E, IfVarEQDo=C | 0x90, IfVarNEDo=C | 0x91,
           IfVarLTDo=C | 0x92, IfVarLEDo=C | 0x93, IfVarGTDo=C | 0x94, IfVarGEDo=C | 0x95, EndOfIfDo=C | 0x9F,
           StartActorTalkie=C | 0xA0, IfTalkingGoTo=C | 0xA1, IfNotTalkingGoTo=C | 0xA2,
           StartTalkieInVar=C | 0xA3, IfAnyTalkingGoTo=C | 0xA4, IfNotAnyTalkingGoTo=C | 0xA5,
           EndSeq=C | 0xFF)
NAME = {v: k for k, v in AKC.items()}
AKAT_Loop, AKAT_Run = 2, 3


# ---------------------------------------------------------------- resource files
def blocks(data, start, end):
    """Yields (tag, data_start, block_end) for the blocks in data[start:end] (8-byte headers, BE size)."""
    p = start
    while p + 8 <= end:
        tag = data[p:p + 4].decode('latin-1')
        size = struct.unpack('>I', data[p + 4:p + 8])[0]
        if size < 8:
            break
        yield tag, p + 8, p + size
        p += size


def read_index(game=GAME):
    """Resource directories of COMI.LA0: {'DIRR': (disk_or_room_list, offsets), 'DIRC': ..., ...}
    (v8: uint32 count, count room bytes, count uint32 offsets; CMI uses the old DROO/DSCR/DCOS names)."""
    idx = open(os.path.join(game, 'COMI.LA0'), 'rb').read()
    alias = {'DROO': 'DIRR', 'DSCR': 'DIRS', 'DCOS': 'DIRC', 'DCHR': 'DIRF', 'DSOU': 'DIRN'}
    dirs = {}
    for tag, s, e in blocks(idx, 0, len(idx)):
        if tag in alias or tag.startswith('DIR') or tag == 'DRSC':
            n = struct.unpack('<I', idx[s:s + 4])[0]
            rooms = list(idx[s + 4:s + 4 + n])
            offs = list(struct.unpack('<%dI' % n, idx[s + 4 + n:s + 4 + 5 * n]))
            dirs[alias.get(tag, tag)] = (rooms, offs)
    return dirs


def room_offsets(disk_file):
    d = open(disk_file, 'rb').read(17 + 5 * 256)
    assert d[:4] == b'LECF' and d[8:12] == b'LOFF', 'unexpected disk file header'
    return {d[17 + 5 * i]: struct.unpack('<I', d[18 + 5 * i:22 + 5 * i])[0] for i in range(d[16])}


def load_akos(costume, game=GAME):
    dirs = read_index(game)
    rooms_c, offs_c = dirs['DIRC']
    room = rooms_c[costume]
    disk = dirs['DIRR'][0][room]
    path = os.path.join(game, 'COMI.LA%d' % disk)
    p = room_offsets(path)[room] + offs_c[costume]
    with open(path, 'rb') as f:
        f.seek(p)
        head = f.read(8)
        assert head[:4] == b'AKOS', 'no AKOS at %d: %r' % (p, head[:4])
        size = struct.unpack('>I', head[4:8])[0]
        akos = head + f.read(size - 8)
    parts = {tag: akos[s:e] for tag, s, e in blocks(akos, 8, len(akos))}
    return dict(room=room, disk=disk, file=os.path.basename(path), offset=p, size=size, parts=parts)


# ---------------------------------------------------------------- AKOS
class Akos:
    def __init__(self, costume, game=GAME):
        self.costume = costume
        self.info = load_akos(costume, game)
        P = self.P = self.info['parts']
        (self.version, self.flags, self.chores, self.cels, self.codec,
         self.layers) = struct.unpack('<6H', P['AKHD'][:12])
        self.aksq, self.akch, self.akof, self.akci = P['AKSQ'], P['AKCH'], P['AKOF'], P['AKCI']
        self.ndirs = 8 if self.flags & 2 else 4
        self.dirnames = DIR8 if self.ndirs == 8 else DIR4
        self.never_mirror = bool(self.flags & 1)

    def cel_info(self, cel):
        akcd, akci = struct.unpack('<IH', self.akof[cel * 6:cel * 6 + 6])
        if len(self.akci) // max(1, self.cels) >= 12:
            w, h, relx, rely, movex, movey = struct.unpack('<HHhhhh', self.akci[akci:akci + 12])
        else:   # CMI: 4-byte AKCI entries; positions come from DrawMany
            w, h = struct.unpack('<HH', self.akci[akci:akci + 4])
            relx = rely = movex = movey = 0
        return dict(w=w, h=h, relx=relx, rely=rely, movex=movex, movey=movey)

    def chore(self, anim, d):
        """Limb ops of chore anim*ndirs+d (costumeDecodeData): {limb: (code, start, end)}; None if absent.
        Limb i is mask bit 15-i; codes 1 clear, 4 stop, 5 resume, others = layer type + program."""
        n = anim * self.ndirs + d
        if n >= self.chores:
            return None
        off = struct.unpack('<H', self.akch[n * 2:n * 2 + 2])[0]
        if off == 0:
            return None
        r = off
        mask = struct.unpack('<H', self.akch[r:r + 2])[0]
        r += 2
        out, i = {}, 0
        while mask & 0xFFFF:
            if mask & 0x8000:
                code = self.akch[r]
                r += 1
                if code in (1, 4, 5):
                    out[i] = (code, None, None)
                else:
                    start, ln = struct.unpack('<HH', self.akch[r:r + 4])
                    r += 4
                    out[i] = (code, start, start + ln)
            i += 1
            mask = (mask << 1) & 0xFFFF
        return out

    def code_at(self, p):
        c = self.aksq[p]
        return struct.unpack('>H', self.aksq[p:p + 2])[0] if c & 0x80 else c

    def GW(self, p, o):
        return struct.unpack('<h', self.aksq[p + o:p + o + 2])[0]

    def GUW(self, p, o):
        return struct.unpack('<H', self.aksq[p + o:p + o + 2])[0]

    def insn_size(self, p):
        """Bytes an AlwaysRun layer steps over at p (akos_increaseAnim)."""
        code = self.code_at(p)
        n = NAME.get(code)
        if n in ('IfVarGoTo', 'AddVar', 'SetVar', 'IfVarGEDo', 'IfVarGTDo', 'IfVarLEDo', 'IfVarLTDo', 'IfVarNEDo',
                 'IfVarEQDo', 'IfSoundInVarRunningGoTo', 'IfNotSoundInVarRunningGoTo', 'IfSoundRunningGoTo',
                 'IfNotSoundRunningGoTo'):
            return 5
        if n in ('JumpToOffsetInVar', 'SetActorZClipping', 'StartScriptVar', 'StartSoundVar', 'StartScript',
                 'StartAnim', 'StartVarAnim', 'StartSound', 'SoftSound', 'SoftVarSound', 'StartTalkieInVar'):
            return 3
        if n == 'SoundStuff':
            return 8
        if n in ('StartActionOn', 'SetActorVar', 'SetDrawOffs'):
            return 6
        if n in ('EndOfIfDo', 'HideActor', 'IncVar', 'StartSound_SpecialCase', 'EmptyCel', 'EndSeq'):
            return 2
        if n in ('IfVarGEJump', 'IfVarGTJump', 'IfVarLEJump', 'IfVarLTJump', 'IfVarNEJump', 'IfVarEQJump',
                 'SetVarRandom'):
            return 7
        if n in ('Flip', 'GoToState', 'StartActorAnim', 'StartActorTalkie', 'IfTalkingGoTo', 'IfNotTalkingGoTo',
                 'DisplayAuxFrame'):
            return 4
        if n in ('DrawMany', 'RelativeOffsetDrawMany'):
            q = p + (4 if n == 'RelativeOffsetDrawMany' else 0) + 3
            for _ in range(self.aksq[q - 1]):
                q += 4
                q += 2 if (self.aksq[q] & 0x80) else 1
            return q - p
        if n in ('CondDrawMany', 'CondRelativeOffsetDrawMany', 'SetUserCondition', 'SetVarToUserCondition',
                 'SetTalkCondition', 'SetVarToTalkCondition'):
            return self.aksq[p + 2]
        return 2 if (code & 0x8000) else 1

    def draw_at(self, p):
        """Cels drawn at sequence position p: list of (cel, x, y), x/y = top-left relative to the feet;
        None for commands that draw nothing (EmptyCel, EndSeq), 'cmd' for control commands."""
        code = self.code_at(p)
        if code in (AKC['EmptyCel'], AKC['EndSeq']):
            return []
        if code in (AKC['CondDrawMany'], AKC['CondRelativeOffsetDrawMany']):
            p += self.aksq[p + 3] + 2
            code = AKC['DrawMany'] if code == AKC['CondDrawMany'] else AKC['RelativeOffsetDrawMany']
        if code in (AKC['DrawMany'], AKC['RelativeOffsetDrawMany']):
            q = p + (4 if code == AKC['RelativeOffsetDrawMany'] else 0)
            n = self.aksq[q + 2]
            q += 3
            out = []
            for _ in range(n):
                dx, dy = struct.unpack('<hh', self.aksq[q:q + 4])
                c = self.aksq[q + 4]
                if c & 0x80:
                    c = struct.unpack('>H', self.aksq[q + 4:q + 6])[0]
                out.append((c & 0xFFF, dx, dy))
                q += 6 if (self.aksq[q + 4] & 0x80) else 5
            return out
        if (code & 0xC000) == 0xC000:
            return 'cmd'
        ci = self.cel_info(code & 0xFFF)   # single cel: its own AKCI rel offsets (not used by CMI)
        return [(code & 0xFFF, ci['relx'], ci['rely'])]

    def program(self, start, end, layer_type):
        """A limb program -> (frames, loop_to). frames: [{'cels': [(cel, x, y)], 'vars': {var: value}}];
        loop_to: frame index played after the last one (the last index = it holds)."""
        frames, at = [], {}
        if layer_type in (AKAT_Loop, AKAT_Run):   # plain cel lists
            p = start
            while p <= end:
                at[p] = len(frames)
                frames.append({'cels': self.draw_at(p), 'vars': {}})
                p += 2 if self.code_at(p) & 0x8000 else 1
            return frames, (0 if layer_type == AKAT_Loop else len(frames) - 1)
        p, pending, loop_to = start, {}, len(frames) - 1
        for _ in range(10000):
            n = NAME.get(self.code_at(p))
            if n == 'GoToState':
                target = self.GUW(p, 2)
                while target not in at and target < p:   # a jump onto a SetVar lands on the next frame
                    target += self.insn_size(target)
                loop_to = at.get(target, 0)
                break
            if n == 'EndSeq':
                loop_to = max(0, len(frames) - 1)
                break
            if n == 'SetVar':
                pending[self.aksq[p + 4]] = self.GW(p, 2)
            elif n is None or n in ('DrawMany', 'RelativeOffsetDrawMany', 'CondDrawMany',
                                    'CondRelativeOffsetDrawMany', 'EmptyCel'):
                at[p] = len(frames)
                frames.append({'cels': self.draw_at(p), 'vars': pending})
                pending = {}
            elif n not in ('StartSound', 'SoftSound', 'StartScript', 'SetActorZClipping'):
                raise NotImplementedError('AKOS command %s at %d (costume %d)' % (n, p, self.costume))
            p += self.insn_size(p)
        return frames, loop_to


# ---------------------------------------------------------------- extraction
def pack_frames(frames, loop_to):
    """Merges runs of identical frames into holds; returns (frames, loop_to) in the packed indexing."""
    out, remap = [], {}
    for i, fr in enumerate(frames):
        cels = [{'cel': c, 'x': x, 'y': y} for (c, x, y) in fr['cels']]
        if out and out[-1]['cels'] == cels and not fr['vars'] and i != loop_to:
            out[-1]['hold'] += 1
        else:
            e = {'cels': cels, 'hold': 1}
            if fr['vars']:
                e['vars'] = {str(k): v for k, v in fr['vars'].items()}
            out.append(e)
        remap[i] = len(out) - 1
    return out, remap.get(loop_to, len(out) - 1)


def extract_anims(ak):
    anims, used = {}, set()
    for anim in range(ak.chores // ak.ndirs):
        for d, dn in enumerate(ak.dirnames):
            ch = ak.chore(anim, d)
            if not ch:
                continue
            limbs = []
            for limb, (code, s, e) in sorted(ch.items()):
                if code in (1, 4, 5):
                    limbs.append({'limb': limb, 'op': {1: 'clear', 4: 'stop', 5: 'resume'}[code]})
                    continue
                frames, loop_to = ak.program(s, e, code)
                for fr in frames:
                    used.update(c for c, _, _ in fr['cels'])
                packed, lt = pack_frames(frames, loop_to)
                limbs.append({'limb': limb, 'op': 'set', 'program': s, 'frames': packed, 'loop_to': lt})
            loops = any(l['op'] == 'set' and l['loop_to'] < len(l['frames']) - 1 for l in limbs)
            anims['a%02d_%s' % (anim, dn)] = {'anim': anim, 'family': 'a%02d' % anim, 'dir': dn, 'loop': loops,
                                             'limbs': limbs}
    return anims, used


# Guybrush (costume 2) anim numbers, identified from renders (art/guybrush/sheets). Body anims only exist
# in some directions; the rest share a back-view fallback program, so each facing is mapped to the nearest
# direction that has its own version (the actor should turn to that direction first).
GUYBRUSH_ROLES = {
    # role: (anim, kind)   kind: body = limb 0 (head resumed/stopped as the chore says), head = limb 1 only
    'init': (1, 'both'), 'walk': (2, 'body'), 'stand': (3, 'both'),
    'talk': (4, 'head'), 'talk_stop': (5, 'head'),
    'pickup_low': (6, 'body'),          # crouch, take from the floor, stand up
    'use': (7, 'body'),                 # reach at waist height (use, push, pick up from a table)
    'pickup_high': (8, 'body'),         # reach up high
    'gesture_both': (9, 'body'),        # both hands explain
    'arms_spread': (10, 'body'),        # arms out wide ("what?")
    'hands_on_hips_in': (11, 'body'), 'hands_on_hips': (12, 'body'), 'hands_on_hips_out': (13, 'body'),
    'head_angry': (14, 'head'), 'talk_angry': (15, 'head'),
    'blink': (16, 'head'),
    'head_sideglance': (17, 'head'), 'talk_sideglance': (18, 'head'),
    'head_surprised': (19, 'head'), 'talk_surprised': (20, 'head'),
    'head_worried': (21, 'head'), 'yuck': (22, 'head'),       # tongue out, disgusted
    'head_happy': (23, 'head'), 'talk_happy': (24, 'head'),
    'head_look_aside': (25, 'head'), 'talk_look_aside': (26, 'head'),
    'talk_smug': (27, 'head'),
    'head_suspicious': (28, 'head'), 'talk_suspicious': (29, 'head'),
    'gesture_right': (30, 'body'), 'gesture_left': (31, 'body'),
    'give': (34, 'body'),               # arm held out (give, show, point); 'give_other' = other arm
    'give_other': (35, 'body'),
    'hand_on_hip_in': (38, 'body'), 'hand_on_hip_other_in': (39, 'body'),
    'hand_on_hip_out': (42, 'body'), 'hand_on_hip_other_out': (43, 'body'),
    'shrug_in': (44, 'body'), 'shrug_out': (45, 'body'), 'shrug': (46, 'body'),
}
IDENTITY_ROLES = {'init', 'walk', 'stand', 'talk', 'talk_stop', 'blink'}

# Murray (costume 12: the green talking skull, CMI's default Murray costume, in room 1 like costume 2). One limb,
# 8 directions with identical chores (a 3/4 view facing screen-right), mirror allowed (AKHD flag 1 not set): SCUMM
# draws it mirrored when the actor faces W (AkosRenderer::setFacing, newDirToOldDir(facing) == 0). CMI scripts
# use setActorStandFrame/TalkFrame pairs (3 / 4,5), (7 / 8,7), (11 / 12,11) to switch his expression.
MURRAY_ROLES = {
    'init': 1, 'stand': 3, 'talk': 4, 'talk_stop': 5,
    'brows_in': 6, 'stand_brows': 7, 'talk_brows': 8, 'brows_out': 9,          # eyebrows raised (pleading/surprised)
    'glare_in': 10, 'stand_glare': 11, 'talk_glare': 12, 'glare_out': 14,      # narrowed eyes (menacing)
    'hop': 15,                                                                 # jumps up, spins, lands on his side
    'stand_tilted': 16, 'talk_tilted': 17,                                     # lying tilted on his side
}
ROLE_TABLES = {12: MURRAY_ROLES}
COSTUME_TALK_LOOPS = {12: {4: 'talk', 8: 'talk_brows', 12: 'talk_glare', 17: 'talk_tilted'}}
LIMB_NAMES = {2: {'0': 'body', '1': 'head'}, 12: {'0': 'skull'}}


def simple_roles(anims, dirs, table, talk_loops, mirror):
    """role -> {facing: anim name | {anim, flip}} for costumes whose chores need no view matching (every
    direction has its own chore). Talk anims use their looping family; facing W is flipped when the
    costume may be mirrored (SCUMM mirrors exactly the W facing)."""
    roles = {}
    for role, anim in table.items():
        m = {}
        for f in dirs:
            fam = talk_loops.get(anim)
            name = '%s_%s' % (fam, f) if fam else 'a%02d_%s' % (anim, f)
            if name not in anims:
                continue
            m[f] = {'anim': name, 'flip': True} if (mirror and f == 'W') else name
        if m:
            roles[role] = m
    return roles


def limb_image(frame_cels, celimg, box=(-140, -310, 140, 30)):
    import numpy as np
    from PIL import Image
    x0, y0, x1, y1 = box
    im = Image.new('RGBA', (x1 - x0, y1 - y0), (0, 0, 0, 0))
    for c in frame_cels:
        im.alpha_composite(celimg(c['cel']), (c['x'] - x0, c['y'] - y0))
    return np.asarray(im.reduce(2), dtype=np.float32)


def view_distance(a, b):
    """How different two limb renders look: masked RGB difference plus silhouette mismatch (front and back
    views share silhouettes, so colors decide: the back view shows the vest, the front the shirt)."""
    import numpy as np
    ma, mb = a[..., 3] > 128, b[..., 3] > 128
    union = ma | mb
    if not union.any():
        return 1e9
    iou = (ma & mb).sum() / union.sum()
    both = ma & mb
    rgb = np.abs(a[..., :3] - b[..., :3])[both].mean() if both.any() else 255
    return rgb + 100 * (1 - iou)


def native_views(anims, anim, dirs, celimg):
    """{dir: native view} for every direction of anim: the stand direction its first/last frame looks like
    (programs are shared between directions; a shared one is drawn for one view only)."""
    ref = {}
    for d in dirs:
        st = anims.get('a03_%s' % d)
        init = anims.get('a01_%s' % d)
        body = next((l for l in st['limbs'] if l['limb'] == 0 and l['op'] == 'set'), None) if st else None
        head = next((l for l in init['limbs'] if l['limb'] == 1 and l['op'] == 'set'), None) if init else None
        ref[d] = {0: limb_image(body['frames'][0]['cels'], celimg) if body else None,
                  1: limb_image(head['frames'][0]['cels'], celimg) if head else None}
    out, cache = {}, {}
    for d in dirs:
        a = anims.get('a%02d_%s' % (anim, d))
        if not a:
            continue
        sets = [l for l in a['limbs'] if l['op'] == 'set' and l['frames'] and l['frames'][0]['cels']]
        if not sets:
            continue
        l = sets[0]
        key = (l['limb'], l['program'])
        if key not in cache:
            # actions start and/or end in the stand pose of their view: best match of first or last frame
            imgs = [limb_image(fr['cels'], celimg) for fr in (l['frames'][0], l['frames'][-1]) if fr['cels']]
            scores = {e: min(view_distance(img, ref[e][l['limb']]) for img in imgs)
                      for e in dirs if ref[e][l['limb']] is not None}
            cache[key] = min(scores, key=scores.get)
        out[d] = cache[key]
    return out


def angle_dist(a, b, dirs):
    ia, ib = dirs.index(a), dirs.index(b)
    k = abs(ia - ib) % len(dirs)
    return min(k, len(dirs) - k)


def build_roles(anims, dirs, celimg, same_pose):
    """role -> {facing: anim name}. For each facing the version whose native view is closest to it
    (same_pose directions count as identical); ties prefer the facing's own chore."""
    same = {d: {d} for d in dirs}
    for a, b in same_pose:
        same[a].add(b)
        same[b].add(a)
    roles, views = {}, {}
    for role, (anim, kind) in GUYBRUSH_ROLES.items():
        nv = native_views(anims, anim, dirs, celimg)
        if not nv:
            continue
        views[role] = nv
        m = {}
        for f in dirs:
            fam = TALK_LOOPS.get(anim)
            if role in IDENTITY_ROLES:   # drawn for every direction (walk poses do not match stand poses)
                m[f] = '%s_%s' % (fam, f) if fam else 'a%02d_%s' % (anim, f)
                continue

            def dist(d):
                v = nv[d]
                return 0 if v in same[f] else min(angle_dist(v, g, dirs) for g in same[f])
            pick = min(nv, key=lambda d: (dist(d), 0 if d == f else 1, angle_dist(d, f, dirs)))
            if kind == 'head' and dist(pick) > 1:
                # expression heads exist for front views only: a back-facing actor keeps its own
                # plain talk / neutral head instead of a front face on a back-view body
                m[f] = ('talk_%s' % f) if role.startswith('talk') else 'a05_%s' % f
            else:
                m[f] = '%s_%s' % (fam, pick) if fam else 'a%02d_%s' % (anim, pick)
        roles[role] = m
    # CMI's 'give' (34) reaches out with the hand on the screen-right side in the SW/W views and 'give_other' (35)
    # with the screen-left one: facing west, Guybrush hands things over with 35 (playtest 3: handing Mort his ticket
    # he reached back towards the clerk). The SCUMM build picks 34/35 by facing the same way (compiler.py gesture).
    if 'give' in roles and 'give_other' in roles:
        for f, (west, east) in {'SW': ('a35_SW', 'a34_SW'), 'W': ('a35_W', 'a34_W'), 'NW': ('a35_W', 'a34_W')}.items():
            if f in roles['give']:
                roles['give'][f], roles['give_other'][f] = west, east
    return roles, views


TALK_LOOPS = {4: 'talk', 15: 'talk_angry', 18: 'talk_sideglance', 20: 'talk_surprised', 24: 'talk_happy',
              26: 'talk_look_aside', 27: 'talk_smug', 29: 'talk_suspicious'}


def derive_talk(anims, dirs, talk_loops=TALK_LOOPS):
    """Talk anims (a04 and the expression variants) play their mouth sequence once and then hold the last
    frame; the game restarts them per line. For an engine that talks until the text is done: the same
    head frames, looping (<family>_<dir>, e.g. talk_E, talk_angry_SW)."""
    for anim, fam in talk_loops.items():
        for d in dirs:
            a = anims.get('a%02d_%s' % (anim, d))
            if not a:
                continue
            limbs = []
            for l in a['limbs']:
                l = json.loads(json.dumps(l))
                if l['op'] == 'set':
                    fr = l['frames']
                    if len(fr) > 2 and l['loop_to'] == len(fr) - 1 and fr[-1]['hold'] == 1:
                        l['frames'] = fr[:-1]
                    l['loop_to'] = 0
                limbs.append(l)
            anims['%s_%s' % (fam, d)] = {'anim': anim, 'family': fam, 'dir': d, 'loop': True, 'limbs': limbs,
                                        'derived': 'a%02d looped' % anim}


def copy_cels(ak, used, out, hd=HD, dump=DUMP, webp=False):
    """HD cels -> out/cels/NNNN.png (or .webp: quality 92 / alpha 100, like the other game costumes)."""
    from PIL import Image
    os.makedirs(os.path.join(out, 'cels'), exist_ok=True)
    cels = {}
    ext = 'webp' if webp else 'png'
    for c in sorted(used):
        ci = ak.cel_info(c)
        dst = os.path.join(out, 'cels', '%04d.%s' % (c, ext))
        src = os.path.join(hd, 'c%04d' % ak.costume, 'c%04d_%04d.png' % (ak.costume, c))
        im = Image.open(src) if os.path.exists(src) else None
        if im is None or im.size != (ci['w'] * 4, ci['h'] * 4) or im.mode != 'RGBA':
            # missing/odd HD cel: nearest 4x of the original
            lo = Image.open(os.path.join(dump, 'c%04d' % ak.costume, 'c%04d_%04d.png' % (ak.costume, c))).convert('RGBA')
            im = lo.resize((lo.width * 4, lo.height * 4), Image.NEAREST)
            if webp:
                im.save(dst, 'WEBP', quality=92, alpha_quality=100, method=6)
            else:
                im.save(dst)
        elif webp:
            im.save(dst, 'WEBP', quality=92, alpha_quality=100, method=6)
        elif not os.path.exists(dst) or os.path.getsize(dst) != os.path.getsize(src):
            shutil.copyfile(src, dst)
        cels[str(c)] = {'file': 'cels/%04d.%s' % (c, ext), 'w': ci['w'], 'h': ci['h']}
    return cels


# ---------------------------------------------------------------- simulation (verification renders; the
# engine implements the same thing in JS)
class Limb:
    def __init__(self):
        self.frames, self.loop_to, self.idx, self.left = [], 0, 0, 1
        self.visible, self.anim = False, None

    def set(self, frames, loop_to, anim):
        self.frames, self.loop_to, self.idx, self.anim = frames, loop_to, 0, anim
        self.left = frames[0]['hold'] if frames else 1
        self.visible = bool(frames)

    def tick(self):
        if not self.frames:
            return
        if self.left > 1:
            self.left -= 1
            return
        self.idx = self.idx + 1 if self.idx + 1 < len(self.frames) else self.loop_to
        self.left = self.frames[self.idx]['hold']

    def cels(self):
        return self.frames[self.idx]['cels'] if self.visible and self.frames else []


class Puppet:
    """Minimal SCUMM-like actor: limbs, chores, facing changes re-apply the limbs' anims."""
    def __init__(self, anims, facing='SE'):
        self.anims, self.facing, self.limbs = anims, facing, {}
        self.play('a01'), self.play('a03')

    def _apply(self, a, only=None):
        for l in a['limbs']:
            if only is not None and l['limb'] != only:
                continue
            st = self.limbs.setdefault(l['limb'], Limb())
            if l['op'] == 'set':
                st.set(l['frames'], l['loop_to'], a['family'])
            elif l['op'] == 'stop':
                st.visible = False
            elif l['op'] == 'resume':
                st.visible = bool(st.frames)
            elif l['op'] == 'clear':
                st.set([], 0, a['family'])

    def play(self, base):
        """base: 'a03' (applied in the current facing) or a full name like 'a06_SE'."""
        name = base if '_' in base else '%s_%s' % (base, self.facing)
        if name in self.anims:
            self._apply(self.anims[name])

    def face(self, d):
        if d == self.facing:
            return
        self.facing = d
        for k, st in self.limbs.items():
            if st.anim is not None:
                name = '%s_%s' % (st.anim, d)
                if name in self.anims:
                    vis = st.visible
                    self._apply(self.anims[name], only=k)
                    st.visible = vis and bool(st.frames)

    def tick(self):
        for st in self.limbs.values():
            st.tick()

    def cels(self):
        return [c for k in sorted(self.limbs) for c in self.limbs[k].cels()]


def render(cels, celimg, scale, box):
    from PIL import Image
    x0, y0, x1, y1 = box
    im = Image.new('RGBA', ((x1 - x0) * scale, (y1 - y0) * scale), (0, 0, 0, 0))
    for c in cels:
        src = celimg(c['cel'])
        im.alpha_composite(src, ((c['x'] - x0) * scale, (c['y'] - y0) * scale))
    return im


def sheets(anims, roles, out_dir, celdir, dirs, table=None, ext='png'):
    """Verification sheets: per anim (rows = directions, columns = distinct frames), walk/talk strips."""
    from functools import lru_cache
    from PIL import Image, ImageDraw
    os.makedirs(out_dir, exist_ok=True)
    table = table or {r: a for r, (a, _) in GUYBRUSH_ROLES.items()}

    @lru_cache(None)
    def lo(c):
        return Image.open(os.path.join(celdir, '%04d.%s' % (c, ext))).convert('RGBA').reduce(4)

    box = (-140, -310, 140, 30)
    cw, chh = 140, 170
    nums = sorted({a['anim'] for a in anims.values() if 'derived' not in a})
    for anim in nums:
        rows = []
        for d in dirs:
            n = 'a%02d_%s' % (anim, d)
            if n not in anims:
                continue
            p = Puppet(anims, d)
            p.play(n)
            fr = []
            for _ in range(90):
                c = p.cels()
                if not fr or fr[-1] != c:
                    fr.append(c)
                p.tick()
            rows.append((d, fr[:24]))
        W = 40 + cw * max(len(r[1]) for r in rows)
        S = Image.new('RGB', (W, 18 + chh * len(rows)), (128, 128, 128))
        dr = ImageDraw.Draw(S)
        dr.text((4, 2), 'anim %d  %s' % (anim, ', '.join(r for r, a in table.items() if a == anim)),
                fill=(255, 255, 0))
        for ri, (d, fr) in enumerate(rows):
            dr.text((4, 18 + ri * chh + 70), d, fill=(255, 255, 0))
            for fi, c in enumerate(fr):
                im = render(c, lo, 1, box).resize((cw, chh), Image.LANCZOS)
                S.paste(im, (40 + fi * cw, 18 + ri * chh), im)
        S.save(os.path.join(out_dir, 'anim%02d.png' % anim))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--costume', type=int, required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--id', default=None)
    ap.add_argument('--game', default=GAME)
    ap.add_argument('--hd', default=HD, help='folder with cNNNN/cNNNN_CCCC.png 4x cels')
    ap.add_argument('--sheets', default=None, help='write verification sheets here')
    ap.add_argument('--webp', action='store_true', help='write the cels as WebP (q92, like the game costumes)')
    a = ap.parse_args()

    ak = Akos(a.costume, a.game)
    anims, used = extract_anims(ak)
    dirs = ak.dirnames
    talk_loops = TALK_LOOPS if a.costume == 2 else COSTUME_TALK_LOOPS.get(a.costume, {4: 'talk'})
    derive_talk(anims, dirs, talk_loops)
    cels = copy_cels(ak, used, a.out, a.hd, webp=a.webp)
    ext = 'webp' if a.webp else 'png'
    stand_cels = {d: [c['cel'] for c in anims['a03_%s' % d]['limbs'][0]['frames'][0]['cels']]
                  for d in dirs if 'a03_%s' % d in anims and anims['a03_%s' % d]['limbs'][0]['op'] == 'set'}
    same_pose = []
    for i, d in enumerate(dirs):
        for e in dirs[i + 1:]:
            if d in stand_cels and stand_cels.get(d) == stand_cels.get(e):
                same_pose.append([d, e])
    from functools import lru_cache
    from PIL import Image

    @lru_cache(None)
    def lo_cel(c):   # 1x cel for view matching
        return Image.open(os.path.join(a.out, 'cels', '%04d.%s' % (c, ext))).convert('RGBA').reduce(4)
    if a.costume == 2:
        roles, views = build_roles(anims, dirs, lo_cel, same_pose)
        table = None
    else:   # other costumes: their own role table (else the standard SCUMM anims), no view matching
        table = ROLE_TABLES.get(a.costume, {'init': 1, 'walk': 2, 'stand': 3, 'talk': 4, 'talk_stop': 5})
        roles, views = simple_roles(anims, dirs, table, talk_loops, not ak.never_mirror), {}
    actor = {
        'id': a.id or 'costume%d' % a.costume,
        'scale': 4,
        'fps': 12,
        'source': 'CMI costume %d (AKOS in %s @%d, %d cels, %d chores, %d dirs); cels: %s' % (
            a.costume, ak.info['file'], ak.info['offset'], ak.cels, ak.chores, ak.ndirs, a.hd),
        'dirs': dirs,
        'dir_angles': {d: i * (360 // len(dirs)) for i, d in enumerate(dirs)},
        'same_pose': same_pose,
        'limbs': LIMB_NAMES.get(a.costume, {}),
        'cels': cels,
        'anims': anims,
        'roles': roles,
        'native_views': views,
        'never_mirror': ak.never_mirror,
        'walk': {'speed_x': 13 * 12, 'speed_y': 4 * 12, 'step_per_frame': [13, 4], 'fps': 12,
                 'notes': 'logical px/s at scale 1; SCUMM moves speed*scale per game frame, limiting each axis '
                          'separately (|dx| <= speed_x, |dy| <= speed_y, the other axis follows the path '
                          'slope), so walking is fastest horizontally. CMI sets (13, 4) for Guybrush.'},
        'notes': (
            'Coordinates: logical CMI 640x480 px; cel x,y = top-left relative to the feet; images are 4x. '
            'Limbs are drawn in order (0 body, then 1 head). Anim names aNN_DIR = CMI anim NN (chore NN*8+dir). '
            'Playing an anim applies its limb ops: set (restart that limb with frames/loop_to), stop (hide, '
            'keep state), resume (show again), clear. Limbs not listed keep running (talk = head only). '
            'Each limb remembers the family of the anim that set it (anim["family"]); on a facing change '
            're-apply <family>_<newdir> to that limb only (restarting it). Frames advance at fps; hold = game frames to show. '
            'After the last frame continue at loop_to (loop_to == last index: hold). '
            'Standard SCUMM anims: 1 init, 2 walk, 3 stand, 4 talk start, 5 talk stop. talk_DIR = a04 '
            'looping (use while text is up, then play a05 = talk_stop); talk_angry_DIR etc. = the expression '
            'variants looping (stop them with the matching head_* role or a05). frame.vars = anim variables set on that '
            'frame (walk: var0/var1 = footsteps). Body actions are drawn only for some directions; roles map '
            'each facing to the anim to play: if its dir differs from the facing (and they are not same_pose), '
            'turn to that dir first. same_pose = directions that share the stand art (E=SE, W=SW). '
            'Turning: step the facing 45 degrees per game frame through the intermediate directions.'),
    }
    if a.costume == 12:
        actor['walk'] = None
        actor['notes'] = (
            'Murray, CMI costume 12 (the green talking skull; CMI sets it on actor 5 with setActorStandFrame(3), '
            'setActorTalkFrame(4,5), talk color 14). Coordinates: logical CMI 640x480 px; cel x,y = top-left '
            'relative to the actor position; images are 4x. CMI\'s actor point sits near his nose: the skull spans '
            'x -40..+19, y -40..+38 at scale 1 (78 px tall), so to rest him on a surface at y=Y put the actor at '
            'Y - 38*scale (CMI shows him at scale 100/255..130/255, i.e. 0.39..0.51). One limb; all 8 directions '
            'share the same 3/4 view facing screen-right; SCUMM mirrors the costume when the actor faces W '
            '(roles W = flip). Roles: stand/talk/talk_stop (default face), brows_in/stand_brows/talk_brows/brows_out '
            '(eyebrows raised), glare_in/stand_glare/talk_glare/glare_out (narrowed eyes), hop (jumps, spins, lands '
            'on his side) then stand_tilted/talk_tilted. CMI switches expressions by changing the stand/talk anims '
            '(7 / 8,7 and 11 / 12,11). aNN_DIR = CMI anim NN; talk families (talk_*) = the looping mouth anims.')

    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'actor.json'), 'w') as f:
        json.dump(actor, f, separators=(',', ':'))
    print('%s: %d anims (%d raw), %d cels, %d roles' % (os.path.join(a.out, 'actor.json'), len(anims),
          sum(1 for x in anims.values() if 'derived' not in x), len(cels), len(roles)))
    if a.sheets:
        sheets(anims, roles, a.sheets, os.path.join(a.out, 'cels'), dirs, table, ext)
        print('sheets in', a.sheets)


if __name__ == '__main__':
    main()
