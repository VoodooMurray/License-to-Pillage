#!/usr/bin/env python3
"""SCUMM v8 (CMI) bytecode disassembler + assembler.

Operand encodings follow ScummVM engines/scumm/script_v8.cpp (+ o6_* ops from script_v6.cpp):
words are 4 bytes (LE), jumps are signed dword offsets relative to the end of the instruction,
strings are 0-terminated with 0xFF escapes followed by 5 bytes.

Assembly text format (one instruction per line, ';' comments, 'name:' labels):
    push 5                  ; 0x01 pushWord
    pushvar 0x40000001      ; 0x02 pushWordVar (raw var number: local 0x4000000n, bit 0x8000000n)
    talkActor "Hello."      ; strings: Python-style escapes; \\xff.. escapes kept raw
    ifNot @L1               ; jump target label
    actorOps.setCurActor    ; subop ops: <op>.<subop>
    wait.forActor @L2
  @L1:
Round-trip test: v8asm.py roundtrip  (disassembles + reassembles every script in the game)
"""
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# opcode -> (name, operand spec). spec letters: W = dword, J = jump dword (signed, relative),
# S = string, B = subop byte (then a subop table decides extra operands)
OPS = {
    0x01: ('push', 'W'), 0x02: ('pushvar', 'W'), 0x03: ('arrayRead', 'W'), 0x04: ('arrayIndexedRead', 'W'),
    0x05: ('dup', ''), 0x06: ('pop', ''), 0x07: ('not', ''), 0x08: ('eq', ''), 0x09: ('neq', ''), 0x0a: ('gt', ''),
    0x0b: ('lt', ''), 0x0c: ('le', ''), 0x0d: ('ge', ''), 0x0e: ('add', ''), 0x0f: ('sub', ''), 0x10: ('mul', ''),
    0x11: ('div', ''), 0x12: ('land', ''), 0x13: ('lor', ''), 0x14: ('band', ''), 0x15: ('bor', ''), 0x16: ('mod', ''),
    0x64: ('if', 'J'), 0x65: ('ifNot', 'J'), 0x66: ('jump', 'J'), 0x67: ('breakHere', ''),
    0x68: ('delayFrames', ''), 0x69: ('wait', 'B'), 0x6a: ('delay', ''), 0x6b: ('delaySeconds', ''),
    0x6c: ('delayMinutes', ''), 0x6d: ('writeVar', 'W'), 0x6e: ('varInc', 'W'), 0x6f: ('varDec', 'W'),
    0x70: ('dimArray', 'BW'), 0x71: ('arrayWrite', 'W'), 0x72: ('arrayInc', 'W'), 0x73: ('arrayDec', 'W'),
    0x74: ('dim2dimArray', 'BW'), 0x75: ('arrayIndexedWrite', 'W'), 0x76: ('arrayOps', 'BW'),
    0x79: ('startScript', ''), 0x7a: ('startScriptQuick', ''), 0x7b: ('stopObjectCode', ''), 0x7c: ('stopScript', ''),
    0x7d: ('jumpToScript', ''), 0x7e: ('return', ''), 0x7f: ('startObject', ''), 0x80: ('stopObjectScript', ''),
    0x81: ('cutscene', ''), 0x82: ('endCutscene', ''), 0x83: ('freezeUnfreeze', ''), 0x84: ('beginOverride', ''),
    0x85: ('endOverride', ''), 0x86: ('stopSentence', ''), 0x87: ('debug', ''), 0x89: ('setClass', ''), 0x8a: ('setState', ''),
    0x8b: ('setOwner', ''), 0x8c: ('panCameraTo', ''), 0x8d: ('actorFollowCamera', ''), 0x8e: ('setCameraAt', ''),
    0x8f: ('printActor', 'B'), 0x90: ('printEgo', 'B'), 0x91: ('talkActor', 'S'), 0x92: ('talkEgo', 'S'),
    0x93: ('printLine', 'B'), 0x94: ('printText', 'B'), 0x95: ('printDebug', 'B'), 0x96: ('printSystem', 'B'),
    0x97: ('blastText', 'B'), 0x98: ('drawObject', ''), 0x9c: ('cursorCommand', 'B'), 0x9d: ('loadRoom', ''),
    0x9e: ('loadRoomWithEgo', ''), 0x9f: ('walkActorToObj', ''), 0xa0: ('walkActorTo', ''), 0xa1: ('putActorAtXY', ''),
    0xa2: ('putActorAtObject', ''), 0xa3: ('faceActor', ''), 0xa4: ('animateActor', ''), 0xa5: ('doSentence', ''),
    0xa6: ('pickupObject', ''), 0xa7: ('setBoxFlags', ''), 0xa8: ('createBoxMatrix', ''), 0xaa: ('resourceRoutines', 'B'),
    0xab: ('roomOps', 'B'), 0xac: ('actorOps', 'B'), 0xad: ('cameraOps', 'B'), 0xae: ('verbOps', 'B'),
    0xaf: ('startSound', ''), 0xb0: ('startMusic', ''), 0xb1: ('stopSound', ''), 0xb2: ('soundKludge', ''),
    0xb3: ('systemOps', 'B'), 0xb4: ('saveRestoreVerbs', 'B'), 0xb5: ('setObjectName', 'S'), 0xb6: ('getDateTime', ''),
    0xb7: ('drawBox', ''), 0xb9: ('startVideo', 'S'), 0xba: ('kernelSetFunctions', ''), 0xc8: ('startScriptQuick2', ''),
    0xc9: ('startObjectQuick', ''), 0xca: ('pickOneOf', ''), 0xcb: ('pickOneOfDefault', ''), 0xcd: ('isAnyOf', ''),
    0xce: ('getRandomNumber', ''), 0xcf: ('getRandomNumberRange', ''), 0xd0: ('ifClassOfIs', ''), 0xd1: ('getState', ''),
    0xd2: ('getOwner', ''), 0xd3: ('isScriptRunning', ''), 0xd5: ('isSoundRunning', ''), 0xd6: ('abs', ''),
    0xd8: ('kernelGetFunctions', ''), 0xd9: ('isActorInBox', ''), 0xda: ('getVerbEntrypoint', ''),
    0xdb: ('getActorFromXY', ''), 0xdc: ('findObject', ''), 0xdd: ('getVerbFromXY', ''), 0xdf: ('findInventory', ''),
    0xe0: ('getInventoryCount', ''), 0xe1: ('getAnimateVariable', ''), 0xe2: ('getActorRoom', ''),
    0xe3: ('getActorWalkBox', ''), 0xe4: ('getActorMoving', ''), 0xe5: ('getActorCostume', ''),
    0xe6: ('getActorScaleX', ''), 0xe7: ('getActorLayer', ''), 0xe8: ('getActorElevation', ''),
    0xe9: ('getActorWidth', ''), 0xea: ('getObjectNewDir', ''), 0xeb: ('getObjectX', ''), 0xec: ('getObjectY', ''),
    0xed: ('getActorChore', ''), 0xee: ('distObjectObject', ''), 0xef: ('distPtPt', ''), 0xf0: ('getObjectImageX', ''),
    0xf1: ('getObjectImageY', ''), 0xf2: ('getObjectImageWidth', ''), 0xf3: ('getObjectImageHeight', ''),
    0xf6: ('getStringWidth', 'S'), 0xf7: ('getActorZPlane', ''),
}
NAME2OP = {v[0]: k for k, v in OPS.items()}

# subop tables per opcode: subop -> (name, extra operand spec)
PRINT_SUB = {200: ('baseop', ''), 201: ('end', ''), 202: ('at', ''), 203: ('color', ''), 204: ('center', ''),
             205: ('charset', ''), 206: ('left', ''), 207: ('overhead', ''), 208: ('mumble', ''),
             209: ('msg', 'S'), 210: ('wrap', '')}
SUBS = {
    'wait': {30: ('forActor', 'J'), 31: ('forMessage', ''), 32: ('forCamera', ''), 33: ('forSentence', ''),
             34: ('forAnimation', 'J'), 35: ('forTurn', 'J')},
    'dimArray': {10: ('int', ''), 11: ('string', ''), 12: ('undim', '')},
    'dim2dimArray': {10: ('int', ''), 11: ('string', ''), 12: ('undim', '')},
    'arrayOps': {20: ('assignString', 'S'), 21: ('assignIntList', ''), 22: ('assign2dimList', '')},
    'systemOps': {40: ('restart', ''), 41: ('quit', '')},
    'cameraOps': {50: ('pause', ''), 51: ('resume', '')},
    'resourceRoutines': {60 + i: (n, '') for i, n in enumerate(
        ['loadCharset', 'loadCostume', 'loadObject', 'loadRoom', 'loadScript', 'loadSound', 'lockCostume', 'lockRoom',
         'lockScript', 'lockSound', 'unlockCostume', 'unlockRoom', 'unlockScript', 'unlockSound', 'nukeCostume',
         'nukeRoom', 'nukeScript', 'nukeSound'])},
    'roomOps': {82: ('setPalette', ''), 87: ('fade', ''), 88: ('rgbIntensity', ''), 89: ('transform', ''),
                92: ('newPalette', ''), 93: ('saveGame', ''), 94: ('loadGame', ''), 95: ('saturation', '')},
    'actorOps': {100: ('setCostume', ''), 101: ('stepDist', ''), 103: ('animDefault', ''), 104: ('initAnim', ''),
                 105: ('talkAnim', ''), 106: ('walkAnim', ''), 107: ('standAnim', ''), 108: ('animSpeed', ''),
                 109: ('default', ''), 110: ('elevation', ''), 111: ('palette', ''), 112: ('talkColor', ''),
                 113: ('name', 'S'), 114: ('width', ''), 115: ('scale', ''), 116: ('neverZClip', ''),
                 117: ('alwaysZClip', ''), 118: ('ignoreBoxes', ''), 119: ('followBoxes', ''), 120: ('shadow', ''),
                 121: ('textOffset', ''), 122: ('setCurActor', ''), 123: ('actorVar', ''), 124: ('ignoreTurnsOn', ''),
                 125: ('ignoreTurnsOff', ''), 126: ('new', ''), 127: ('depth', ''), 128: ('stop', ''), 129: ('face', ''),
                 130: ('turn', ''), 131: ('walkScript', ''), 132: ('talkScript', ''), 133: ('walkPause', ''),
                 134: ('walkResume', ''), 135: ('volume', ''), 136: ('frequency', ''), 137: ('pan', '')},
    'verbOps': {150: ('init', ''), 151: ('new', ''), 152: ('delete', ''), 153: ('name', 'S'), 154: ('at', ''),
                155: ('on', ''), 156: ('off', ''), 157: ('color', ''), 158: ('hicolor', ''), 160: ('dimcolor', ''),
                161: ('dim', ''), 162: ('key', ''), 163: ('image', ''), 164: ('nameStr', ''), 165: ('center', ''),
                166: ('charset', ''), 167: ('lineSpacing', '')},
    'saveRestoreVerbs': {180: ('save', ''), 181: ('restore', ''), 182: ('delete', '')},
    'cursorCommand': {220 + i: (n, '') for i, n in enumerate(
        ['cursorOn', 'cursorOff', 'softCursorOn', 'softCursorOff', 'userputOn', 'userputOff', 'softUserputOn',
         'softUserputOff', 'image', 'hotspot', 'transparent', 'initCharset', 'charsetColor', 'put'])},
}
for n in ('printActor', 'printEgo', 'printLine', 'printText', 'printDebug', 'printSystem', 'blastText'):
    SUBS[n] = PRINT_SUB
SUBNAME = {op: {v[0]: k for k, v in t.items()} for op, t in SUBS.items()}


def read_str(code, p):
    q = p
    while code[q] != 0:
        q += 6 if code[q] == 0xFF else 1
    return code[p:q], q + 1


def fmt_str(b):
    out = []
    i = 0
    while i < len(b):
        c = b[i]
        if c == 0xFF:
            out.append('\\xff' + ''.join(f'\\x{x:02x}' for x in b[i + 1:i + 6]))
            i += 6
            continue
        if c == ord('"'):
            out.append('\\"')
        elif c == ord('\\'):
            out.append('\\\\')
        elif 32 <= c < 127:
            out.append(chr(c))
        else:
            out.append(f'\\x{c:02x}')
        i += 1
    return '"' + ''.join(out) + '"'


def parse_str(s):
    assert s[0] == '"' and s[-1] == '"', s
    s = s[1:-1]
    out = bytearray()
    i = 0
    while i < len(s):
        c = s[i]
        if c == '\\':
            n = s[i + 1]
            if n == 'x':
                out.append(int(s[i + 2:i + 4], 16)); i += 4; continue
            out.append(ord(n)); i += 2; continue
        out.extend(c.encode('latin1')); i += 1
    return bytes(out)


def disasm(code, start=0, end=None):
    """Returns a list of (offset, text-with-@targets, target_or_None)."""
    end = len(code) if end is None else end
    out = []
    p = start
    while p < end:
        o = p
        op = code[p]; p += 1
        if op not in OPS:
            raise ValueError(f'unknown opcode 0x{op:02x} at {o}')
        name, spec = OPS[op]
        parts = [name]
        targets = []
        sub = None
        spec = list(spec)
        k = 0
        while k < len(spec):
            ch = spec[k]; k += 1
            if ch == 'W':
                parts.append(str(struct.unpack_from('<i', code, p)[0])); p += 4
            elif ch == 'J':
                rel = struct.unpack_from('<i', code, p)[0]; p += 4
                targets.append(p + rel); parts.append(f'@{p + rel}')
            elif ch == 'S':
                s, p = read_str(code, p); parts.append(fmt_str(s))
            elif ch == 'B':
                sub = code[p]; p += 1
                t = SUBS[name]
                if sub not in t:
                    raise ValueError(f'unknown subop {sub} for {name} at {o}')
                sname, sspec = t[sub]
                parts[0] = f'{name}.{sname}'
                spec += list(sspec)   # subop operands follow the main operands (e.g. arrayOps: B W S)
        # dimArray/arrayOps: B then W -> spec 'BW' handled: B sets subop, W appended above in order
        out.append((o, ' '.join(parts), targets))
    return out


def disasm_text(code, start=0, end=None):
    ins = disasm(code, start, end)
    tg = {t for _, _, ts in ins for t in ts}
    lines = []
    for o, txt, _ in ins:
        if o in tg:
            lines.append(f'@{o}:')
        lines.append('    ' + txt)
    end = len(code) if end is None else end
    if end in tg:
        lines.append(f'@{end}:')
    return '\n'.join(lines) + '\n'


TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|\S+')


def assemble(text, base=0):
    """Assembles text to bytes. Labels: '@name:' lines; operands '@name' refer to labels."""
    lines = []
    for raw in text.splitlines():
        line = raw.split(';', 1)[0] if not '"' in raw else raw  # keep strings containing ';'
        if '"' in raw:
            # strip trailing comment after the last quote only
            q = raw.rfind('"')
            c = raw.find(';', q)
            line = raw if c < 0 else raw[:c]
        line = line.strip()
        if line:
            lines.append(line)
    # two passes
    def encode(labels):
        out = bytearray()
        fix = []
        lab_pos = {}
        for line in lines:
            if line.endswith(':') and line.startswith('@'):
                lab_pos[line[1:-1]] = len(out)
                continue
            toks = TOKEN.findall(line)
            name = toks[0]
            args = toks[1:]
            base_name, _, subname = name.partition('.')
            op = NAME2OP[base_name]
            _, spec = OPS[op]
            out.append(op)
            ai = 0
            spec = list(spec)
            k = 0
            while k < len(spec):
                ch = spec[k]; k += 1
                if ch == 'W':
                    out += struct.pack('<I', int(args[ai], 0) & 0xFFFFFFFF); ai += 1   # vars: bit 0x8000000n
                elif ch == 'J':
                    lab = args[ai][1:]; ai += 1
                    pos = len(out)
                    out += b'\0\0\0\0'
                    fix.append((pos, lab))
                elif ch == 'S':
                    out += parse_str(args[ai]) + b'\0'; ai += 1
                elif ch == 'B':
                    sub = SUBNAME[base_name][subname]
                    out.append(sub)
                    spec += list(SUBS[base_name][sub][1])
        return out, fix, lab_pos
    out, fix, lab_pos = encode(None)
    for pos, lab in fix:
        tgt = lab_pos[lab] if lab in lab_pos else int(lab) - base
        struct.pack_into('<i', out, pos, tgt - (pos + 4))
    return bytes(out)


def all_scripts():
    """Yields (label, code_bytes) for every script block in the game (header stripped)."""
    import scummres as sr
    idx = sr.Index()
    disks, _ = idx.dir('DROO', 'DIRR')
    for disk in (1, 2):
        df = sr.DataFile(disk)
        d = df.data
        for room, lf in df.room_offsets.items():
            size = sr.be32(d, lf + 4)
            for tag, o, sz in sr.blocks(d, lf + 8, lf + size):
                if tag == 'SCRP':
                    yield f'r{room} SCRP@{o}', d[o + 8:o + sz], None
                elif tag == 'RMSC':
                    for t2, o2, sz2 in sr.blocks(d, o + 8, o + sz):
                        if t2 in ('ENCD', 'EXCD'):
                            yield f'r{room} {t2}', d[o2 + 8:o2 + sz2], None
                        elif t2 == 'LSCR':
                            yield f'r{room} LSCR {sr.le32(d, o2 + 8)}', d[o2 + 12:o2 + sz2], None
                        elif t2 == 'OBCD':
                            for t3, o3, sz3 in sr.blocks(d, o2 + 8, o2 + sz2):
                                if t3 == 'VERB':
                                    blk = d[o3 + 8:o3 + sz3]
                                    # verb table: (verb, offset)* 0 ; offsets relative to the VERB block start
                                    p = 0
                                    ents = []
                                    while True:
                                        v = sr.le32(blk, p)
                                        if v == 0:
                                            p += 4
                                            break
                                        ents.append((v, sr.le32(blk, p + 4)))
                                        p += 8
                                    yield f'r{room} VERB@{o3}', blk, (p, ents)


def roundtrip():
    n = ok = 0
    bad = []
    for label, code, verbinfo in all_scripts():
        n += 1
        try:
            start = verbinfo[0] if verbinfo else 0
            txt = disasm_text(code, start)
            re_code = assemble(txt, base=start)
            if re_code == code[start:]:
                ok += 1
            else:
                bad.append((label, 'mismatch'))
        except Exception as e:
            bad.append((label, str(e)[:120]))
    print(f'{ok}/{n} scripts round-trip identically')
    for b in bad[:20]:
        print('  ', b)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'roundtrip':
        roundtrip()
