#!/usr/bin/env python3
"""Compiles the web game's handlers (JS, see jsgame.py) to SCUMM v8 assembly (v8asm.py text).

The JS subset of the game scripts: async functions, if/else, for(;;) dialog loops, for-of over
static arrays (unrolled), const locals, && || ! ?:, === !==, string +, calls of module functions
(inlined, with parameters and early returns) and the `g` API (engine/engine.js makeApi), which maps
to SCUMM ops as CMI's own scripts use them (see scumm/NOTES.md):

  g.say -> talkActor + wait.forMessage      g.choose -> CMI's dialog verbs 500.. (VAR_VERB_SCRIPT 13)
  g.flag/set/once/inc -> global variables   g.has/give/take/swap -> getOwner / pickupObject / setOwner
  g.state/setState/hide/show/hidden -> object states, class 32 (untouchable), 'hidden' variables
  g.walk/face/anim/setBase/showActor -> actor ops; g.cutscene -> beginCutscene/override with a skip
  path that replays the skipped state changes; g.goto/showImage -> room changes (global scripts).

Runtime values are compiled lazily: V objects know how to push themselves; Cond values are static
alternatives guarded by runtime tests (for strings built from runtime choices).
"""
import re
import hashlib
import itertools
import json
import os
import subprocess
import tempfile

import jsgame  # noqa: E402
from jsgame import Env, Func, NotStatic, parse_files, sval

FAR = 2147483647
VAR_OVERRIDE, VAR_ROOM, VAR_VERB_SCRIPT, VAR_EGO = 30, 31, 55, 126
ANY_ITEM_VERB = 250
TICKS_PER_SEC = 60
DIRS = {'N': 0, 'NE': 45, 'E': 90, 'SE': 135, 'S': 180, 'SW': 225, 'W': 270, 'NW': 315}


class CompileError(Exception):
    pass


# the build's text language (build.py --lang): English text -> shown text (game/lang/<code>.json +
# engine/lang/<code>.json); voice tags keep the English line's voice
TRANSLATION = {}


def tr(s):
    if not TRANSLATION:
        return s
    m = re.match(r'(/[A-Za-z0-9_]+/)(.*)$', s, re.S)
    if m:
        return m.group(1) + TRANSLATION.get(m.group(2), m.group(2))
    return TRANSLATION.get(s, s)


def js_quote(s, translate=True):
    """A display text as a v8 string literal (translated, Latin-1)."""
    if translate:
        s = tr(s)
    out = []
    for ch in s:
        o = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == '\\':
            out.append('\\\\')
        elif 32 <= o < 127:
            out.append(ch)
        elif o < 256:
            out.append(f'\\x{o:02x}')
        else:
            out.append({'’': "'", '‘': "'", '“': '"', '”': '"', '…': '...',
                        '–': '-', '—': '-'}.get(ch, '?'))
    return '"' + ''.join(out) + '"'


# ------------------------------------------------------------------ values
class V:
    """A runtime value: emit(sc) pushes it. kind: int, bool, item (object number), state (obj), choice."""

    def __init__(self, emit, kind='int', info=None, pure=True):
        self.emit = emit
        self.kind = kind
        self.info = info or {}
        self.pure = pure   # re-evaluable without side effects

    def __repr__(self):
        return f'<V {self.kind} {self.info}>'


def var_value(num, kind='int', info=None):
    return V(lambda sc: sc.e(f'pushvar {num}'), kind, dict(info or {}, var=num))


def const(n):
    return V(lambda sc: sc.e(f'push {int(n)}'), 'int', {'const': int(n)})


class Test:
    """A runtime condition (for Cond alternatives): jfalse(sc, label) jumps when false."""

    def __init__(self, jfalse):
        self.jfalse = jfalse


class Cond:
    """Static alternatives: [(tests, value)], tests = list of Test (all must hold); first match wins."""

    def __init__(self, alts):
        self.alts = alts

    def map(self, f):
        return Cond([(t, f(v)) for t, v in self.alts])


class CondList:
    """A compile-time list whose entries were pushed under runtime path conditions."""

    def __init__(self):
        self.entries = []   # (tests, value)


class NameOf:
    """Text piece: the name of the object/actor number held in a variable (0xFF 0x06 escape)."""

    def __init__(self, var):
        self.var = var


class Text:
    """A string with NameOf escapes."""

    def __init__(self, parts):
        self.parts = parts

    def encode(self):
        out = []
        for p in self.parts:
            if isinstance(p, NameOf):
                v = p.var & 0xFFFFFFFF
                out.append('\\xff\\x06' + ''.join(f'\\x{(v >> (8 * i)) & 0xFF:02x}' for i in range(4)))
            else:
                out.append(js_quote(str(p))[1:-1])
        return '"' + ''.join(out) + '"'


class G:
    """The `g` API object in handler scopes."""


class GEngine:
    """`g.engine` (shake, itemName, texts, fade)."""


class APIRef:
    def __init__(self, name, owner):
        self.name = name
        self.owner = owner

    def __bool__(self):
        return False   # engine internals read as values (e.overlay, e.started...) are falsy


class OpaqueActor:
    """g.actor(who): the web engine's actor object. Reads give neutral defaults, writes/calls are no-ops."""

    def __init__(self, who):
        self.who = who

    DEFAULTS = {'x': 0, 'y': 0, 'noTalk': False, 'visible': True, 'talking': False, 'dir': 'S'}


# Guybrush's gestures (CMI costume 2 anims, see art/guybrush and tools/akos_extract.py): anim, game frames
GUYBRUSH_GESTURES = {'pickup_low': (6, 9), 'use': (7, 5), 'pickup_high': (8, 10), 'gesture_both': (9, 12),
                     'arms_spread': (10, 12), 'give': (34, 10), 'give_other': (35, 10), 'shrug': (46, 12),
                     'gesture_right': (30, 10), 'gesture_left': (31, 10), 'hands_on_hips': (12, 12)}


# ------------------------------------------------------------------ scopes
class Scope:
    def __init__(self, parent=None, env=None, fn=None):
        self.vars = {}
        self.parent = parent
        self.env = env if env is not None else (parent.env if parent else None)
        self.fn = fn if fn is not None else (parent.fn if parent else None)   # FnFrame
        self.pathconds = list(parent.pathconds) if parent else []

    def lookup(self, name):
        s = self
        while s is not None:
            if name in s.vars:
                return s.vars[name]
            s = s.parent
        if self.env is not None and self.env.has(name):
            return self.env.lookup(name)
        raise CompileError('unknown name ' + name)

    def set(self, name, v):
        self.vars[name] = v


class FnFrame:
    def __init__(self, ret_label):
        self.ret_label = ret_label


# ------------------------------------------------------------------ script
class Script:
    """Code of one SCUMM script (object verb, ENCD, global script)."""

    def __init__(self, cc, room, name, kind='object'):
        self.cc = cc            # Compiler
        self.room = room        # current room id (for object references)
        self.name = name
        self.kind = kind        # 'object' | 'global' | 'encd'
        self.lines = []
        self.nlab = 0
        self.nlocal = 0
        self.loops = []         # (break_label, continue_label)
        self.implicit = False   # inside the implicit input-blocking cutscene
        self.cut = None         # explicit cutscene recorder: list of (k, fn)
        self.silent = False     # skip-path compilation: no presentation
        self.changes_room = False
        self.caption = None
        self.has_dialog = False # uses choose() (item combinations then close CMI's chest first)
        self.takes = set()      # items removed from the inventory (setOwner 0 kills that item's scripts)

    def e(self, line):
        self.lines.append('    ' + line)

    def lab(self, hint='L'):
        self.nlab += 1
        return f'{hint}{self.nlab}'

    def place(self, label):
        self.lines.append(f'@{label}:')

    def local(self):
        if self.nlocal >= 24:
            raise CompileError(f'{self.name}: too many locals')
        n = self.nlocal
        self.nlocal += 1
        return 0x40000000 | n

    def text(self):
        return '\n'.join(self.lines) + '\n'


# ------------------------------------------------------------------ compiler
class Compiler:
    def __init__(self, ids, game):
        self.ids = ids          # Ids (build.py): object/actor/var/state numbers
        self.game = game        # jsgame.Game
        self.G = G()
        self.GE = GEngine()
        self.globals_needed = []   # (name, builder) for room-changing handlers

    # -------------------------------------------------- entry points
    def handler_code(self, handler, room, name, args=(), kind='object', block=None):
        """Compiles a handler (str | [str] | Func | None) to v8asm text for one verb."""
        sc = Script(self, room, name, kind)
        self.compile_handler(sc, handler, args, block)
        sc.e('stopObjectCode')
        return sc

    def compile_handler(self, sc, handler, args=(), block=None):
        if handler is None:
            return
        if isinstance(handler, str):
            self.say(sc, 'player', handler)
            return
        if isinstance(handler, list):
            self.say_random(sc, 'player', handler)
            return
        if isinstance(handler, dict) and isinstance(handler.get('do'), list):
            handler = self.steps_func(handler, sc.room)        # a data script (engine/steps.js)
        if isinstance(handler, Func):
            blocking = block if block is not None else self.needs_block(handler)
            if blocking:
                self.begin_implicit(sc)
            self.inline(sc, handler, [self.G, *args], Scope())
            if blocking:
                self.end_implicit(sc)
            return
        raise CompileError(f'bad handler {handler!r}')

    def steps_func(self, h, room):
        """A data script ({do: [steps]}, the level editor's) as a Func: the very source the web engine runs
        (engine/steps.js through tools/js/steps_src.mjs), parsed like any other handler."""
        dl = dict(self.game.game.get('dialogues') or {})
        dl.update((self.game.rooms.get(room) or {}).get('dialogues') or {})
        cards = self.game.game.get('cards') or {}
        key = json.dumps([h, dl, cards], sort_keys=True)
        cache = self.__dict__.setdefault('_steps_cache', {})
        if key not in cache:
            root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
            gen = os.path.join(root, 'tools', 'js', 'steps_src.mjs')
            # generated sources are cached by content (shipped with the mod: no node needed to build its games)
            ckey = 'steps_' + jsgame.source_key(open(gen, 'rb').read() + open(os.path.join(root, 'engine', 'steps.js'), 'rb').read()
                                                + key.encode())
            src = jsgame._cache_get(ckey)
            if src is None:
                jsgame.need_node('data scripts')
                r = subprocess.run(['node', gen], input=json.dumps([{'handler': h, 'dialogues': dl, 'cards': cards}]),
                                   capture_output=True, text=True, check=True)
                src = json.loads(r.stdout)[0]
                jsgame._cache_put(ckey, src)
            # the generated module is kept (a look at what was compiled): /tmp/cmi-levels-steps/<hash>.mjs
            d = os.path.join(tempfile.gettempdir(), 'cmi-levels-steps')
            os.makedirs(d, exist_ok=True)
            path = os.path.join(d, hashlib.sha1(src.encode()).hexdigest()[:16] + '.mjs')
            with open(path, 'w') as f:
                f.write('export default ' + src + ';\n')
            ast = parse_files([path])[path]
            node = next(n for n in ast['body'] if n['type'] == 'ExportDefaultDeclaration')['declaration']
            cache[key] = Func(node, Env(), 'steps')
        return cache[key]

    def needs_block(self, fn):
        """Multi-step handlers block input (CMI wraps them in cutscenes); single lines do not."""
        count = [0]
        choose = [False]
        seen = set()

        def walk(node, env):
            if isinstance(node, dict):
                if node.get('type') == 'CallExpression':
                    c = node['callee']
                    if c.get('type') == 'MemberExpression' and not c.get('computed'):
                        name = c['property']['name']
                        if name in ('say', 'walk', 'wait', 'anim', 'walkTo', 'face', 'showImage'):
                            count[0] += 1
                        if name in ('choose', 'cutscene'):
                            choose[0] = True
                    if c.get('type') == 'Identifier':
                        try:
                            f = env.lookup(c['name'])
                            if isinstance(f, Func) and id(f.node) not in seen:
                                seen.add(id(f.node))
                                walk(f.node['body'], f.env)
                        except KeyError:
                            pass
                for v in node.values():
                    walk(v, env)
            elif isinstance(node, list):
                for v in node:
                    walk(v, env)
        walk(fn.node['body'], fn.env)
        return count[0] >= 2 or choose[0]

    def begin_implicit(self, sc):
        if sc.implicit or sc.cut is not None:
            return
        sc.e('push 2')
        sc.e('push 1')
        sc.e('cutscene')
        sc.implicit = True

    def end_implicit(self, sc):
        if not sc.implicit:
            return
        sc.e('endCutscene')
        sc.implicit = False

    # -------------------------------------------------- functions
    def inline(self, sc, fn, args, outer):
        """Inlines a JS function: binds params, compiles the body, returns land at its end label."""
        ret = sc.lab('ret')
        scope = Scope(None, env=fn.env, fn=FnFrame(ret))
        scope.pathconds = list(outer.pathconds) if outer else []
        for i, p in enumerate(fn.params):
            a = args[i] if i < len(args) else None
            if p['type'] == 'Identifier':
                scope.set(p['name'], a)
            elif p['type'] == 'AssignmentPattern':
                scope.set(p['left']['name'], a if a is not None else sval(p['right'], fn.env))
            else:
                raise CompileError('param pattern ' + p['type'])
        result = None
        if fn.expression_body:
            result = self.ev(sc, fn.body, scope)
        else:
            self.block(sc, fn.body, scope)
        sc.place(ret)
        return result

    # -------------------------------------------------- statements
    def block(self, sc, node, scope):
        for st in node['body']:
            self.stmt(sc, st, scope)

    def stmt(self, sc, node, scope):
        t = node['type']
        if t == 'BlockStatement':
            self.block(sc, node, Scope(scope))
        elif t == 'ExpressionStatement':
            self.ev(sc, node['expression'], scope, discard=True)
        elif t == 'VariableDeclaration':
            for d in node['declarations']:
                self.declare(sc, d, scope)
        elif t == 'IfStatement':
            self.if_stmt(sc, node, scope)
        elif t == 'ForStatement':
            self.for_stmt(sc, node, scope)
        elif t == 'ForOfStatement':
            self.for_of(sc, node, scope)
        elif t == 'ReturnStatement':
            if node['argument'] is not None:
                self.ev(sc, node['argument'], scope, discard=True)
            sc.e(f'jump @{scope.fn.ret_label}')
        elif t == 'BreakStatement':
            if not sc.loops:
                raise CompileError('break outside loop')
            sc.e(f'jump @{sc.loops[-1][0]}')
        elif t == 'ContinueStatement':
            sc.e(f'jump @{sc.loops[-1][1]}')
        elif t == 'EmptyStatement':
            pass
        else:
            raise CompileError('statement ' + t)

    def declare(self, sc, d, scope):
        name = d['id']['name'] if d['id']['type'] == 'Identifier' else None
        init = d['init']
        if init is not None and init['type'] == 'ArrayExpression' and not init['elements']:
            cl = CondList()
            cl.base = len(scope.pathconds)
            scope.set(name, cl)
            return
        v = self.ev(sc, init, scope) if init is not None else None
        if d['id']['type'] == 'ObjectPattern':
            self.bind_pattern(d['id'], v, scope)
            return
        if isinstance(v, V) and not (v.pure and 'var' in v.info):
            # materialize runtime values once (they may have side effects)
            loc = sc.local()
            v.emit(sc)
            sc.e(f'writeVar {loc}')
            v = var_value(loc, v.kind, {k: x for k, x in v.info.items() if k != 'var'})
        scope.set(name, v)

    def bind_pattern(self, pat, v, scope):
        if pat['type'] == 'Identifier':
            scope.set(pat['name'], v)
        elif pat['type'] == 'ObjectPattern':
            for p in pat['properties']:
                k = p['key']['name']
                self.bind_pattern(p['value'], v[k] if isinstance(v, dict) else None, scope)
        elif pat['type'] == 'ArrayPattern':
            for i, el in enumerate(pat['elements']):
                if el is not None:
                    self.bind_pattern(el, v[i] if isinstance(v, (list, tuple)) and i < len(v) else None, scope)
        else:
            raise CompileError('pattern ' + pat['type'])

    def if_stmt(self, sc, node, scope):
        test = node['test']
        st = self.static_test(sc, test, scope)
        if st is not None:
            branch = node['consequent'] if st else node['alternate']
            if branch is not None:
                self.stmt(sc, branch, scope)
            return
        l_else, l_end = sc.lab('else'), sc.lab('endif')
        room0 = sc.room
        self.jfalse(sc, test, scope, l_else)
        s1 = Scope(scope)
        s1.pathconds = scope.pathconds + [(test, scope, True)]
        self.stmt(sc, node['consequent'], s1)
        r1 = sc.room
        sc.room = room0
        if node['alternate'] is not None:
            sc.e(f'jump @{l_end}')
        sc.place(l_else)
        r2 = room0
        if node['alternate'] is not None:
            s2 = Scope(scope)
            s2.pathconds = scope.pathconds + [(test, scope, False)]
            self.stmt(sc, node['alternate'], s2)
            r2 = sc.room
            sc.place(l_end)
        # a branch that changed rooms (and returned) must not leak its room into the code after the if
        sc.room = r1 if r1 == r2 else room0

    def for_stmt(self, sc, node, scope):
        if node['init'] or node['test'] or node['update']:
            raise CompileError('only for(;;) loops are supported')
        top, brk = sc.lab('loop'), sc.lab('brk')
        sc.place(top)
        sc.loops.append((brk, top))
        self.stmt(sc, node['body'], Scope(scope))
        sc.loops.pop()
        sc.e(f'jump @{top}')
        sc.place(brk)

    def for_of(self, sc, node, scope):
        it = self.ev(sc, node['right'], scope)
        if not isinstance(it, list):
            raise CompileError('for-of over a runtime value')
        brk = sc.lab('brk')
        decl = node['left']
        pat = decl['declarations'][0]['id'] if decl['type'] == 'VariableDeclaration' else decl
        for item in it:
            s = Scope(scope)
            self.bind_pattern(pat, item, s)
            cont = sc.lab('cont')
            sc.loops.append((brk, cont))
            self.stmt(sc, node['body'], s)
            sc.loops.pop()
            sc.place(cont)
        sc.place(brk)

    # -------------------------------------------------- conditions
    def static_test(self, sc, node, scope):
        """True/False if the test is static, else None (never emits code)."""
        try:
            v = self.peek_static(node, scope)
        except (CompileError, NotStatic, KeyError):
            return None
        if isinstance(v, (V, Cond, CondList, APIRef)) or v is self.G:
            return None
        return bool(v)

    def peek_static(self, node, scope):
        t = node['type']
        if t == 'Literal':
            return node['value']
        if t == 'Identifier':
            v = scope.lookup(node['name'])
            return v
        if t == 'UnaryExpression' and node['operator'] == '!':
            v = self.peek_static(node['argument'], scope)
            if isinstance(v, (V, Cond, CondList)):
                raise NotStatic('runtime')
            return not v
        raise NotStatic(t)

    def jfalse(self, sc, node, scope, label):
        t = node['type']
        if t == 'LogicalExpression' and node['operator'] == '&&':
            self.jfalse(sc, node['left'], scope, label)
            self.jfalse(sc, node['right'], scope, label)
            return
        if t == 'LogicalExpression' and node['operator'] == '||':
            ok = sc.lab('or')
            self.jtrue(sc, node['left'], scope, ok)
            self.jfalse(sc, node['right'], scope, label)
            sc.place(ok)
            return
        if t == 'UnaryExpression' and node['operator'] == '!':
            self.jtrue(sc, node['argument'], scope, label)
            return
        v = self.ev(sc, node, scope)
        self.jfalse_value(sc, v, label)

    def jtrue(self, sc, node, scope, label):
        t = node['type']
        if t == 'LogicalExpression' and node['operator'] == '||':
            self.jtrue(sc, node['left'], scope, label)
            self.jtrue(sc, node['right'], scope, label)
            return
        if t == 'LogicalExpression' and node['operator'] == '&&':
            no = sc.lab('and')
            self.jfalse(sc, node['left'], scope, no)
            self.jtrue(sc, node['right'], scope, label)
            sc.place(no)
            return
        if t == 'UnaryExpression' and node['operator'] == '!':
            self.jfalse(sc, node['argument'], scope, label)
            return
        v = self.ev(sc, node, scope)
        self.jtrue_value(sc, v, label)

    def jfalse_value(self, sc, v, label):
        if isinstance(v, V):
            v.emit(sc)
            sc.e(f'ifNot @{label}')
        elif isinstance(v, Cond):
            ok = sc.lab('cok')
            for tests, val in v.alts:
                nxt = sc.lab('calt')
                for t in tests:
                    t.jfalse(sc, nxt)
                if val:
                    sc.e(f'jump @{ok}')
                else:
                    sc.e(f'jump @{label}')
                sc.place(nxt)
            sc.e(f'jump @{label}')
            sc.place(ok)
        elif isinstance(v, CondList):
            raise CompileError('CondList as condition (use .length)')
        elif not v:
            sc.e(f'jump @{label}')

    def jtrue_value(self, sc, v, label):
        if isinstance(v, V):
            v.emit(sc)
            sc.e(f'if @{label}')
        elif isinstance(v, Cond):
            no = sc.lab('cno')
            for tests, val in v.alts:
                nxt = sc.lab('calt')
                for t in tests:
                    t.jfalse(sc, nxt)
                sc.e(f'jump @{label}' if val else f'jump @{no}')
                sc.place(nxt)
            sc.place(no)
        elif v:
            sc.e(f'jump @{label}')

    def node_test(self, node, scope, polarity=True):
        """A re-emittable Test for a (side-effect free) condition node."""
        def jf(sc, label):
            if polarity:
                self.jfalse(sc, node, scope, label)
            else:
                self.jtrue(sc, node, scope, label)
        return Test(jf)

    # -------------------------------------------------- expressions
    def ev(self, sc, node, scope, discard=False):
        t = node['type']
        if t == 'Literal':
            return node['value']
        if t == 'TemplateLiteral':
            parts = []
            for i, q in enumerate(node['quasis']):
                parts.append(q['value']['cooked'])
                if i < len(node['expressions']):
                    parts.append(self.ev(sc, node['expressions'][i], scope))
            return self.concat_all(parts)
        if t == 'Identifier':
            if node['name'] == 'undefined':
                return None
            return scope.lookup(node['name'])
        if t == 'AwaitExpression':
            prev = getattr(self, 'awaited', False)
            self.awaited = True
            try:
                return self.ev(sc, node['argument'], scope, discard)
            finally:
                self.awaited = prev
        if t == 'ArrayExpression':
            return [self.ev(sc, el, scope) for el in node['elements']]
        if t == 'ObjectExpression':
            d = {}
            for p in node['properties']:
                k = p['key']['name'] if p['key']['type'] == 'Identifier' else p['key']['value']
                d[k] = scope.lookup(k) if p.get('shorthand') else self.ev(sc, p['value'], scope)
            return d
        if t in ('ArrowFunctionExpression', 'FunctionExpression'):
            return ClosureFunc(node, scope)
        if t == 'MemberExpression':
            return self.member(sc, node, scope)
        if t == 'CallExpression':
            return self.call(sc, node, scope, discard)
        if t == 'LogicalExpression':
            return self.logical(sc, node, scope)
        if t == 'UnaryExpression':
            return self.unary(sc, node, scope)
        if t == 'BinaryExpression':
            return self.binary(sc, node, scope)
        if t == 'ConditionalExpression':
            return self.conditional(sc, node, scope)
        if t == 'AssignmentExpression':
            return self.assign(sc, node, scope)
        raise CompileError('expression ' + t)

    def member(self, sc, node, scope):
        obj = self.ev(sc, node['object'], scope)
        if node['computed']:
            key = self.ev(sc, node['property'], scope)
        else:
            key = node['property']['name']
        if obj is self.G:
            if key == 'engine':
                return self.GE
            if key == 'room':
                return var_value(VAR_ROOM, 'room')
            return APIRef(key, 'g')
        if obj is self.GE:
            return APIRef(key, 'engine')
        if isinstance(obj, OpaqueActor):
            return APIRef(key, obj) if key in ('init', 'play', 'stand', 'walkTo') else OpaqueActor.DEFAULTS.get(key)
        if isinstance(obj, APIRef) and obj.owner == 'engine':
            return APIRef(obj.name + '.' + key, 'engine')
        if isinstance(obj, APIRef) and isinstance(obj.owner, str) and obj.owner == 'engine':
            return 0
        if isinstance(obj, CondList):
            if key == 'length':
                return self.condlist_length(obj)
            return APIRef(key, obj)
        if isinstance(obj, Cond):
            return obj.map(lambda v: self.index(v, key))
        if isinstance(key, V):
            # static list indexed by a runtime choice (choose result with a known domain)
            dom = key.info.get('domain')
            if not isinstance(obj, (list, tuple)) or not dom:
                raise CompileError('runtime index into ' + type(obj).__name__)
            alts = []
            for jsid, code in dom.items():
                idx = jsid if isinstance(jsid, int) else code
                alts.append(([self.eq_test(key, code)], obj[idx]))
            return Cond(alts)
        if isinstance(obj, (list, str)) and key in ('map', 'filter', 'join', 'includes', 'push', 'length'):
            if key == 'length':
                return len(obj)
            return APIRef(key, obj)
        return self.index(obj, key)

    def index(self, obj, key):
        if isinstance(obj, dict):
            return obj.get(key)
        if isinstance(obj, (list, tuple, str)):
            if key == 'length':
                return len(obj)
            return obj[int(key)]
        if obj is None:
            return None
        raise CompileError(f'member {key!r} of {type(obj).__name__}')

    def eq_test(self, v, code):
        def jf(sc, label):
            v.emit(sc)
            sc.e(f'push {code}')
            sc.e('eq')
            sc.e(f'ifNot @{label}')
        return Test(jf)

    def logical(self, sc, node, scope):
        op = node['operator']
        a = self.ev(sc, node['left'], scope)
        if not isinstance(a, (V, Cond)):
            if op == '&&':
                return self.ev(sc, node['right'], scope) if a else a
            if op == '||':
                return a if a else self.ev(sc, node['right'], scope)
            if op == '??':
                return a if a is not None else self.ev(sc, node['right'], scope)
        # runtime: produce 0/1 with jumps (only used in conditions / value contexts)
        def emit(sc2, n=node, s=scope):
            f, e = sc2.lab('lf'), sc2.lab('le')
            self.jfalse(sc2, n, s, f)
            sc2.e('push 1')
            sc2.e(f'jump @{e}')
            sc2.place(f)
            sc2.e('push 0')
            sc2.place(e)
        return V(emit, 'bool', pure=False)

    def unary(self, sc, node, scope):
        op = node['operator']
        v = self.ev(sc, node['argument'], scope)
        if op == '!':
            if isinstance(v, V):
                return V(lambda sc2, v=v: (v.emit(sc2), sc2.e('not')), 'bool', pure=v.pure)
            if isinstance(v, Cond):
                return v.map(lambda x: not x)
            return not v
        if op == '-':
            if isinstance(v, V):
                return V(lambda sc2, v=v: (sc2.e('push 0'), v.emit(sc2), sc2.e('sub')), 'int', pure=v.pure)
            return -v
        raise CompileError('unary ' + op)

    def binary(self, sc, node, scope):
        op = node['operator']
        a = self.ev(sc, node['left'], scope)
        b = self.ev(sc, node['right'], scope)
        if op == '+':
            return self.concat_all([a, b]) if (self.is_texty(a) or self.is_texty(b)) else self.arith(a, b, 'add')
        if op in ('===', '==', '!==', '!='):
            if not isinstance(a, (V, Cond)) and not isinstance(b, (V, Cond)):
                return (a == b) if op in ('===', '==') else (a != b)
            if isinstance(b, V) and not isinstance(a, V):
                a, b = b, a
            code = self.compare_code(a, b)
            neg = op in ('!==', '!=')

            def emit(sc2, a=a, code=code, neg=neg):
                a.emit(sc2)
                if isinstance(code, V):
                    code.emit(sc2)
                else:
                    sc2.e(f'push {code}')
                sc2.e('neq' if neg else 'eq')
            return V(emit, 'bool', pure=a.pure)
        if op in ('<', '>', '<=', '>='):
            if not isinstance(a, V) and not isinstance(b, V):
                return {'<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b}[op]
            return self.arith(a, b, {'<': 'lt', '>': 'gt', '<=': 'le', '>=': 'ge'}[op])
        if op in ('-', '*', '/', '%'):
            return self.arith(a, b, {'-': 'sub', '*': 'mul', '/': 'div', '%': 'mod'}[op])
        raise CompileError('binary ' + op)

    def arith(self, a, b, opname):
        if not isinstance(a, V) and not isinstance(b, V):
            return {'add': lambda: a + b, 'sub': lambda: a - b, 'mul': lambda: a * b, 'div': lambda: a // b,
                    'mod': lambda: a % b, 'lt': lambda: a < b, 'gt': lambda: a > b, 'le': lambda: a <= b,
                    'ge': lambda: a >= b}[opname]()

        def push(sc2, x):
            if isinstance(x, V):
                x.emit(sc2)
            else:
                sc2.e(f'push {int(x)}')

        def emit(sc2):
            push(sc2, a)
            push(sc2, b)
            sc2.e(opname)
        return V(emit, 'int', pure=all(not isinstance(x, V) or x.pure for x in (a, b)))

    def compare_code(self, v, other):
        """What to push to compare runtime value v with static `other` (object/state/choice ids)."""
        if isinstance(other, V):
            return other
        k = v.kind
        if k == 'state':
            return self.ids.state_num(v.info['room'], v.info['obj'], other)
        if k == 'item':
            if other is None:
                return 0
            return self.ids.item_obj(other)
        if k == 'choice':
            return v.info['domain'][other]
        if k == 'room':
            return self.ids.room_num(other)
        if isinstance(other, bool):
            return int(other)
        if isinstance(other, (int, float)):
            return int(other)
        if other is None:
            return 0
        raise CompileError(f'compare {k} with {other!r}')

    def conditional(self, sc, node, scope):
        st = self.static_test(sc, node['test'], scope)
        if st is not None:
            return self.ev(sc, node['consequent'] if st else node['alternate'], scope)
        a = self.ev(sc, node['consequent'], scope)
        b = self.ev(sc, node['alternate'], scope)
        tv = self.ev(sc, node['test'], scope)
        if isinstance(tv, V) and not tv.pure:
            # evaluate once (g.once has side effects)
            loc = sc.local()
            tv.emit(sc)
            sc.e(f'writeVar {loc}')
            tv = var_value(loc, 'bool')

        def jf(sc2, label, tv=tv):
            self.jfalse_value(sc2, tv, label)
        if isinstance(a, V) or isinstance(b, V):
            def emit(sc2):
                f, e = sc2.lab('cf'), sc2.lab('ce')
                jf(sc2, f)
                self.push_value(sc2, a)
                sc2.e(f'jump @{e}')
                sc2.place(f)
                self.push_value(sc2, b)
                sc2.place(e)
            return V(emit, 'int')
        return Cond([([Test(jf)], a), ([], b)])

    def push_value(self, sc, v):
        if isinstance(v, V):
            v.emit(sc)
        elif isinstance(v, bool):
            sc.e(f'push {int(v)}')
        elif isinstance(v, (int, float)):
            sc.e(f'push {int(v)}')
        elif v is None:
            sc.e('push 0')
        else:
            raise CompileError(f'cannot push {v!r}')

    def assign(self, sc, node, scope):
        tgt = node['left']
        if tgt['type'] == 'MemberExpression':
            try:
                base = self.ev(sc, tgt['object'], scope)
            except CompileError:
                base = None
            if isinstance(base, OpaqueActor):
                return None
            if tgt['property'].get('name') == 'a' and isinstance(base, APIRef) and base.name == 'fade':
                if not sc.silent:
                    self.intensity(sc, 0)
                return None
            if base is self.GE or isinstance(base, APIRef):
                return None     # other web-engine internals (e.started, ...)
        # g.engine.texts = g.engine.texts.filter(...)  -> caption off
        if tgt['type'] == 'MemberExpression' and not tgt['computed'] and tgt['property']['name'] == 'texts':
            sc.caption = None
            return None
        # e.fade.a = 1 -> black screen now
        if tgt['type'] == 'MemberExpression' and not tgt['computed'] and tgt['property']['name'] == 'a':
            if not sc.silent:
                self.intensity(sc, 0)
            return None
        raise CompileError('assignment')

    # -------------------------------------------------- text values
    def is_texty(self, v):
        return isinstance(v, (str, Text, NameOf)) or (isinstance(v, Cond) and any(self.is_texty(x) for _, x in v.alts))

    def concat_all(self, parts):
        # expand Conds (cartesian), keep NameOf pieces
        alts = [([], [])]
        for p in parts:
            if isinstance(p, Cond):
                new = []
                for tests, acc in alts:
                    for t2, v in p.alts:
                        new.append((tests + t2, acc + [v]))
                alts = new
            else:
                alts = [(t, acc + [p]) for t, acc in alts]

        def mk(acc):
            out = []
            for x in acc:
                if isinstance(x, Text):
                    out += x.parts
                elif isinstance(x, NameOf):
                    out.append(x)
                elif x is None:
                    out.append('undefined')
                else:
                    out.append(str(x) if not isinstance(x, float) or not x.is_integer() else str(int(x)))
            if all(isinstance(y, str) for y in out):
                return ''.join(out)
            return Text(out)
        if len(alts) == 1:
            return mk(alts[0][1])
        return Cond([(t, mk(acc)) for t, acc in alts])

    def condlist_length(self, cl):
        def emit(sc2):
            ok, e = sc2.lab('clok'), sc2.lab('cle')
            for tests, _ in cl.entries:
                nxt = sc2.lab('clnx')
                for t in tests:
                    t.jfalse(sc2, nxt)
                sc2.e(f'jump @{ok}')
                sc2.place(nxt)
            sc2.e('push 0')
            sc2.e(f'jump @{e}')
            sc2.place(ok)
            sc2.e('push 1')
            sc2.place(e)
        return V(emit, 'bool')

    def condlist_join(self, cl, sep):
        n = len(cl.entries)
        alts = []
        for mask in itertools.product([True, False], repeat=n):
            tests = []
            vals = []
            for (etests, val), present in zip(cl.entries, mask):
                if present:
                    tests += etests
                    vals.append(val)
                else:
                    tests.append(self.not_all(etests))
            alts.append((tests, sep.join(str(v) for v in vals)))
        return Cond(alts)

    def not_all(self, tests):
        def jf(sc, label):
            ok = sc.lab('na')
            for t in tests:
                t.jfalse(sc, ok)
            sc.e(f'jump @{label}')
            sc.place(ok)
        return Test(jf)

    # -------------------------------------------------- calls
    def call(self, sc, node, scope, discard):
        callee = node['callee']
        args_nodes = node['arguments']
        # function values
        f = self.ev(sc, callee, scope)
        if isinstance(f, APIRef):
            if isinstance(f.owner, OpaqueActor):
                # a.init() on Guybrush (after a special figure) = back to his own costume
                if f.name == 'init' and f.owner.who in ('guybrush', 'player'):
                    self.state_step(sc, lambda s2: self.restore_guybrush(s2))
                return None
            if f.owner == 'g':
                return self.api(sc, f.name, args_nodes, scope, discard)
            if f.owner == 'engine':
                return self.engine_api(sc, f.name, args_nodes, scope)
            return self.method(sc, f, args_nodes, scope)
        if isinstance(f, (Func, ClosureFunc)):
            args = [self.ev(sc, a, scope) for a in args_nodes]
            if isinstance(f, ClosureFunc):
                return self.inline_closure(sc, f, args)
            return self.inline(sc, f, args, scope)
        raise CompileError(f'call of {f!r}')

    def inline_closure(self, sc, f, args):
        ret = sc.lab('ret')
        scope = Scope(f.scope, fn=FnFrame(ret))
        for i, p in enumerate(f.node['params']):
            self.bind_pattern(p, args[i] if i < len(args) else None, scope)
        if f.node['body']['type'] != 'BlockStatement':
            v = self.ev(sc, f.node['body'], scope)
            sc.place(ret)
            return v
        self.block(sc, f.node['body'], scope)
        sc.place(ret)
        return None

    def method(self, sc, ref, args_nodes, scope):
        obj, name = ref.owner, ref.name
        if isinstance(obj, CondList):
            if name == 'push':
                v = self.ev(sc, args_nodes[0], scope)
                tests = [self.node_test(n, s, pol) for n, s, pol in scope.pathconds[getattr(obj, 'base', 0):]]
                obj.entries.append((tests, v))
                return None
            if name == 'join':
                sep = self.ev(sc, args_nodes[0], scope)
                return self.condlist_join(obj, sep)
        if isinstance(obj, list):
            if name == 'map':
                fn = self.ev(sc, args_nodes[0], scope)
                out = []
                for i, x in enumerate(obj):
                    out.append(self.call_static_fn(fn, [x, i]))
                return out
            if name == 'join':
                return self.ev(sc, args_nodes[0], scope).join(str(x) for x in obj)
            if name == 'includes':
                return self.ev(sc, args_nodes[0], scope) in obj
        raise CompileError(f'method {name} of {type(obj).__name__}')

    def call_static_fn(self, fn, args):
        """Evaluates a pure arrow function statically (a.map(([text], i) => ({ id: i, text })))."""
        node = fn.node
        scope = Scope(None, env=fn.env if isinstance(fn, Func) else fn.scope.env)
        if isinstance(fn, ClosureFunc):
            scope = Scope(fn.scope)
        for i, p in enumerate(node['params']):
            self.bind_pattern(p, args[i] if i < len(args) else None, scope)
        if node['body']['type'] == 'BlockStatement':
            raise CompileError('static function with a block body')
        return self.static_eval(node['body'], scope)

    def static_eval(self, node, scope):
        t = node['type']
        if t == 'ObjectExpression':
            d = {}
            for p in node['properties']:
                k = p['key']['name'] if p['key']['type'] == 'Identifier' else p['key']['value']
                d[k] = scope.lookup(k) if p.get('shorthand') else self.static_eval(p['value'], scope)
            return d
        if t == 'Identifier':
            return scope.lookup(node['name'])
        if t == 'Literal':
            return node['value']
        if t == 'ArrayExpression':
            return [self.static_eval(e, scope) for e in node['elements']]
        if t == 'MemberExpression':
            o = self.static_eval(node['object'], scope)
            k = self.static_eval(node['property'], scope) if node['computed'] else node['property']['name']
            return self.index(o, k)
        raise CompileError('static eval ' + t)

    # -------------------------------------------------- the g API
    def api(self, sc, name, args_nodes, scope, discard):
        ids = self.ids
        awaited = getattr(self, 'awaited', False)
        self.awaited = False
        cache = {}

        def A(i):
            if i >= len(args_nodes):
                return None
            if i not in cache:
                cache[i] = self.ev(sc, args_nodes[i], scope)
            return cache[i]

        if name == 'say':
            if len(args_nodes) >= 2 and not self.is_opts(args_nodes[1]):
                who, text, on = A(0), A(1), (args_nodes[2] if len(args_nodes) >= 3 else None)
            else:
                who, text, on = 'player', A(0), (args_nodes[1] if len(args_nodes) >= 2 else None)
            # options are read from the AST, not evaluated (some hold web-only values, e.g. `at` from camX)
            no_anim = bool(on and on.get('type') == 'ObjectExpression' and any(
                p.get('key', {}).get('name') == 'noAnim' and p.get('value', {}).get('value') is True
                for p in on.get('properties', [])))
            self.say(sc, who, text, {'noAnim': True} if no_anim else None)
            return None
        if name == 'caption':
            self.say(sc, '_narrator', A(0))
            return None
        if name == 'flag':
            return var_value(ids.flag_var(A(0)), 'int')
        if name == 'set':
            k = A(0)
            v = A(1) if len(args_nodes) > 1 else True
            self.state_step(sc, lambda s2: (self.push_value(s2, v), s2.e(f'writeVar {ids.flag_var(k)}')))
            return None
        if name == 'inc':
            var = ids.flag_var(A(0))
            sc.e(f'varInc {var}')
            return var_value(var, 'int')
        if name == 'once':
            var = ids.flag_var('once:' + A(0))

            def emit(sc2, var=var):
                skip = sc2.lab('once')
                sc2.e(f'pushvar {var}')
                sc2.e('not')
                sc2.e('dup')
                sc2.e(f'ifNot @{skip}')
                sc2.e('push 1')
                sc2.e(f'writeVar {var}')
                sc2.place(skip)
            return V(emit, 'bool', pure=False)
        if name == 'has':
            obj = ids.item_obj(A(0))
            return V(lambda sc2, o=obj: (sc2.e(f'push {o}'), sc2.e('getOwner'), sc2.e(f'pushvar {VAR_EGO}'), sc2.e('eq')),
                     'bool')
        if name == 'give':
            item = A(0)
            self.state_step(sc, lambda s2, i=item: self.give(s2, i))
            return None
        if name == 'take':
            item = A(0)
            self.state_step(sc, lambda s2, i=item: self.take(s2, i))
            return None
        if name == 'swap':
            a, b = A(0), A(1)
            self.state_step(sc, lambda s2: (self.take(s2, a), self.give(s2, b)))
            return None
        if name == 'state':
            room = A(1) or sc.room
            obj = A(0)
            onum = ids.obj(room, obj)
            return V(lambda sc2, o=onum: (sc2.e(f'push {o}'), sc2.e('getState')), 'state', {'room': room, 'obj': obj})
        if name == 'setState':
            obj, st, room = A(0), A(1), A(2) or sc.room
            self.state_step(sc, lambda s2: self.set_state(s2, room, obj, st))
            return None
        if name == 'hide':
            obj, room = A(0), A(1) or sc.room
            self.state_step(sc, lambda s2: self.hide(s2, room, obj, True))
            return None
        if name == 'show':
            obj, room = A(0), A(1) or sc.room
            self.state_step(sc, lambda s2: self.hide(s2, room, obj, False))
            return None
        if name == 'hidden':
            obj, room = A(0), A(1) or sc.room
            return var_value(ids.hidden_var(room, obj), 'bool')
        if name == 'wait':
            ms = A(0)
            if not sc.silent:
                sc.e(f'push {max(1, round(ms * TICKS_PER_SEC / 1000))}')
                sc.e('delay')
            return None
        if name == 'walk':
            x, y = A(0), A(1)
            face = A(2)
            who = A(3) or 'player'
            self.walk(sc, who, x, y, face)
            return None
        if name == 'walkTo':
            obj = A(0)
            self.walk_obj(sc, obj)
            return None
        if name == 'face':
            d, who = A(0), A(1) or 'player'
            a = ids.actor(who)
            self.state_step(sc, lambda s2: (s2.e(f'push {a}'), s2.e('actorOps.setCurActor'),
                                           s2.e(f'push {DIRS[d]}'), s2.e('actorOps.face' if s2.silent else 'actorOps.turn')))
            if not sc.silent:
                w = sc.lab('turn')
                sc.place(w)
                sc.e(f'push {a}')
                sc.e(f'wait.forTurn @{w}')
            return None
        if name == 'place':
            who, x, y, d = A(0), A(1), A(2), A(3)
            self.state_step(sc, lambda s2: self.put_actor(s2, who, x, y, d))
            return None
        if name == 'anim':
            who, an = A(0), A(1)
            opts = A(2) or {}
            self.anim(sc, who, an, opts)
            return None
        if name == 'setBase':
            who, role = A(0), A(1)
            self.state_step(sc, lambda s2: self.set_base(s2, who, role))
            return None
        if name == 'showActor':
            who, on = A(0), A(1) if len(args_nodes) > 1 else True
            self.state_step(sc, lambda s2: self.show_actor(s2, who, on))
            return None
        if name == 'moveActor':
            who, room, x, y, d = A(0), A(1), A(2), A(3), A(4)
            self.state_step(sc, lambda s2: self.move_actor(s2, who, room, x, y, d))
            return None
        if name == 'preloadAnim':
            return None
        if name == 'actor':
            return OpaqueActor(A(0))
        if name == 'gesture':
            role, who = A(0), A(1) or 'player'
            sp = getattr(self.ids, 'special', None)
            if who in ('player', 'guybrush') and sp and role in sp['anim_nums'] and not sc.silent:
                self.special_gesture(sc, sp, role)
                return None
            if who not in ('player', 'guybrush') or role not in GUYBRUSH_GESTURES or sc.silent:
                return None
            anim, frames = GUYBRUSH_GESTURES[role]
            if role in ('give', 'give_other'):
                # CMI's 34 reaches out on the screen-right side in the SW/W views, 35 on the left: facing west
                # (SW/W/NW, angle > 180) the hand towards the other person is the other anim (as the web roles)
                other = 35 if anim == 34 else 34
                east, done = sc.lab('give'), sc.lab('gived')
                sc.e('push 1')
                sc.e('getObjectNewDir')
                sc.e('push 180')
                sc.e('gt')
                sc.e(f'ifNot @{east}')
                sc.e('push 1')
                sc.e(f'push {other}')
                sc.e('animateActor')
                sc.e(f'jump @{done}')
                sc.place(east)
                sc.e('push 1')
                sc.e(f'push {anim}')
                sc.e('animateActor')
                sc.place(done)
            else:
                sc.e('push 1')
                sc.e(f'push {anim}')
                sc.e('animateActor')
            if awaited:
                sc.e(f'push {round(frames * TICKS_PER_SEC / 12)}')
                sc.e('delay')
                sc.e('push 1')
                sc.e('push 1003')
                sc.e('animateActor')
            return None
        if name == 'choose':
            return self.choose(sc, A(0), scope)
        if name == 'cutscene':
            fn = A(0)
            self.cutscene(sc, fn)
            return None
        if name == 'goto':
            room, x, y, d = A(0), A(1), A(2), A(3)
            opts = A(4) or {}
            self.state_step(sc, lambda s2: self.goto(s2, room, x, y, d))
            return None
        if name == 'fadeOut':
            if not sc.silent:
                self.fade(sc, 255, 0, A(0) if args_nodes else 0.5)
            return None
        if name == 'fadeIn':
            if not sc.silent:
                self.fade(sc, 0, 255, A(0) if args_nodes else 0.5)
            else:
                self.intensity(sc, 255)
            return None
        if name == 'showImage':
            img = A(0)
            opts = A(1) or {}
            self.show_image(sc, img, opts)
            return None
        if name == 'hideImage':
            self.hide_image(sc)
            return None
        if name == 'music':
            m = A(0)
            self.state_step(sc, lambda s2: self.music(s2, m))
            return None
        if name == 'stopMusic':
            self.state_step(sc, lambda s2: (s2.e('push 4096'), s2.e('push 0'), s2.e('push 2'), s2.e('soundKludge')))
            return None
        if name == 'sfx':
            # sound effects = new SOUN resources (build.py): startSound -> iMUSE SFX group
            n = (getattr(self.ids, 'sfx', None) or {}).get(A(0))
            if n and not sc.silent:
                sc.e(f'push {n}')
                sc.e('startSound')
            return None
        if name == 'moveObj':
            ms = A(3) or 0
            if ms and awaited and not sc.silent:
                sc.e(f'push {max(1, round(ms * TICKS_PER_SEC / 1000))}')
                sc.e('delay')
            return None
        self.warn(f'{sc.name}: g.{name}() is not supported in the SCUMM build (skipped)')
        return None

    def warn(self, msg):
        if not hasattr(self, 'warnings'):
            self.warnings = []
        if msg not in self.warnings:
            self.warnings.append(msg)

    def engine_api(self, sc, name, args_nodes, scope):
        if name == 'shake':
            return None          # no screen shake in SCUMM v8
        if name == 'itemName':
            v = self.ev(sc, args_nodes[0], scope)
            if isinstance(v, V) and 'var' in v.info:
                return NameOf(v.info['var'])
            if isinstance(v, str):
                return self.game.game['items'][v]['name']
            raise CompileError('itemName of ' + repr(v))
        if name == 'texts.push':
            d = self.ev(sc, args_nodes[0], scope)
            lines = d.get('lines') or ['']
            sc.caption = ' '.join(str(x) for x in lines)
            return None
        if name == 'texts':
            return None
        self.warn(f'{sc.name}: g.engine.{name} is not supported in the SCUMM build (skipped)')
        return None

    def is_opts(self, node):
        return node['type'] == 'ObjectExpression'

    # -------------------------------------------------- state steps (cutscene skip bookkeeping)
    def state_step(self, sc, fn):
        """Emits a state-changing operation; inside an explicit cutscene it is numbered so the skip path
        (ESC) can replay the steps that were not reached."""
        fn(sc)
        if sc.cut is not None and not sc.silent:
            k = len(sc.cut['steps']) + 1
            sc.cut['steps'].append(fn)
            sc.e(f'push {k}')
            sc.e(f'writeVar {sc.cut["prog"]}')

    # -------------------------------------------------- ops
    def give(self, sc, item):
        o = self.ids.item_obj(item)
        skip = sc.lab('give')
        sc.e(f'push {o}')
        sc.e('getOwner')
        sc.e(f'pushvar {VAR_EGO}')
        sc.e('neq')
        sc.e(f'ifNot @{skip}')
        sc.e(f'push {o}')
        sc.e('pickupObject')
        sc.place(skip)

    def take(self, sc, item):
        """CMI's item removal macro (e.g. global 327): icon untouchable, owner 0, chest page back in
        range, and the cursor back to the arrow if an item is held (bitvar19/20 = cursor flags)."""
        o = self.ids.item_obj(item)
        icon = self.ids.icons[item]
        sc.takes.add(item)
        done, page, cur = sc.lab('tk'), sc.lab('tkp'), sc.lab('tkc')
        for ln in (f'push {o}', 'getOwner', f'pushvar {VAR_EGO}', 'eq', f'ifNot @{done}',
                   f'push {icon}', 'push 160', 'push 1', 'setClass',
                   f'push {o}', 'push 0', 'setOwner',
                   'pushvar 315', f'pushvar {VAR_EGO}', 'getInventoryCount', 'gt', f'ifNot @{page}',
                   'push 1', 'writeVar 315'):
            sc.e(ln)
        sc.place(page)
        for ln in ('pushvar 290', 'push 105', 'neq', f'ifNot @{cur}',
                   'pushvar 291', 'writeVar 292', 'push 105', 'push 1', 'cursorCommand.image',
                   'push 105', 'writeVar 290', 'push 105', 'writeVar 291', 'push 0', 'writeVar 0x80000013'):
            sc.e(ln)
        sc.place(cur)
        sc.e('push 0')
        sc.e('writeVar 0x80000014')
        sc.place(done)

    def set_state(self, sc, room, obj, st):
        ids = self.ids
        n = ids.state_num(room, obj, st)
        for o in ids.state_objs(room, obj):
            sc.e(f'push {o}')
            sc.e(f'push {n}')
            sc.e('setState')
        name = ids.state_name(room, obj, st)
        if name is not None:
            sc.e(f'push {ids.obj(room, obj)}')
            sc.e(f'setObjectName {js_quote(name)}')

    def hide(self, sc, room, obj, hidden):
        ids = self.ids
        onum = ids.obj(room, obj)
        sc.e(f'push {int(hidden)}')
        sc.e(f'writeVar {ids.hidden_var(room, obj)}')
        sc.e(f'push {onum}')
        sc.e(f'push {160 if hidden else 32}')
        sc.e('push 1')
        sc.e('setClass')
        st = 0 if hidden else ids.default_state(room, obj)
        for o in ids.state_objs(room, obj):
            sc.e(f'push {o}')
            sc.e(f'push {st}')
            sc.e('setState')

    def walk(self, sc, who, x, y, face):
        a = self.ids.actor(who)
        if sc.silent:
            self.put_actor(sc, who, x, y, face)
            return
        sc.e(f'push {a}')
        sc.e(f'push {int(x)}')
        sc.e(f'push {int(y)}')
        sc.e('walkActorTo')
        w = sc.lab('walk')
        sc.place(w)
        sc.e(f'push {a}')
        sc.e(f'wait.forActor @{w}')
        if face:
            sc.e(f'push {a}')
            sc.e('actorOps.setCurActor')
            sc.e(f'push {DIRS[face]}')
            sc.e('actorOps.turn')
            t = sc.lab('turn')
            sc.place(t)
            sc.e(f'push {a}')
            sc.e(f'wait.forTurn @{t}')
        if sc.cut is not None:
            k = len(sc.cut['steps']) + 1
            sc.cut['steps'].append(lambda s2: self.put_actor(s2, who, x, y, face))
            sc.e(f'push {k}')
            sc.e(f'writeVar {sc.cut["prog"]}')

    def walk_obj(self, sc, obj):
        o = self.ids.obj(sc.room, obj)
        sc.e('push 1')
        sc.e(f'push {o}')
        sc.e('push 0')
        sc.e('walkActorToObj')
        w = sc.lab('walk')
        sc.place(w)
        sc.e('push 1')
        sc.e(f'wait.forActor @{w}')

    def put_actor(self, sc, who, x, y, face):
        a = self.ids.actor(who)
        sc.e(f'push {a}')
        sc.e(f'push {int(x)}')
        sc.e(f'push {int(y)}')
        sc.e(f'pushvar {VAR_ROOM}')
        sc.e('putActorAtXY')
        if face:
            sc.e(f'push {a}')
            sc.e('actorOps.setCurActor')
            sc.e(f'push {DIRS[face]}')
            sc.e('actorOps.face')

    def anim(self, sc, who, an, opts):
        if sc.silent:
            return
        a = self.ids.actor(who)
        n = self.ids.anim_num(who, an)
        if n is None:
            return
        sc.e(f'push {a}')
        sc.e(f'push {n}')
        sc.e('animateActor')
        if opts.get('wait', True) is not False and self.ids.anim_holds(who, an):
            # wait until the (non-looping) animation reached its last frame
            d = self.ids.anim_ticks(who, an)
            if d:
                sc.e(f'push {d}')
                sc.e('delay')

    def set_base(self, sc, who, role):
        if who in ('guybrush', 'player', self.game.game.get('player')):
            # Guybrush's special figures: swap in the pose costume (CMI style), 'stand'/None = back to 2
            pose = getattr(self.ids, 'pose', None)
            if not role or role == 'stand' or not pose or role not in pose['anim_nums']:
                self.restore_guybrush(sc)
                return
            n = pose['anim_nums'][role]
            for ln in ('push 1', 'actorOps.setCurActor', f'push {pose["num"]}', 'actorOps.setCostume',
                       f'push {n}', 'actorOps.standAnim', 'push 1', f'push {n}', 'animateActor'):
                sc.e(ln)
            return
        a = self.ids.actor(who)
        n = self.ids.anim_num(who, role)
        if n is None:
            return
        sc.e(f'push {n}')
        sc.e(f'writeVar {self.ids.base_var(who)}')
        sc.e(f'push {a}')
        sc.e('actorOps.setCurActor')
        sc.e(f'push {n}')
        sc.e('actorOps.standAnim')
        sc.e(f'push {a}')
        sc.e(f'push {n}')
        sc.e('animateActor')

    def restore_guybrush(self, sc):
        """Back to CMI's Guybrush costume (2), standing."""
        if getattr(self.ids, 'pose', None) is None:
            return
        for ln in ('push 1', 'actorOps.setCurActor', 'push 2', 'actorOps.setCostume', 'push 3', 'actorOps.standAnim',
                   'push 1', 'push 3', 'animateActor'):
            sc.e(ln)

    def special_gesture(self, sc, sp, role):
        """Guybrush's one-shot special anims (fence_tickle) live in an extra costume (build.py
        special_costume): swap it onto actor 1, play the anim and wait for it (always, even when the web
        version doesn't await it: nothing else would swap costume 2 back), then back to costume 2,
        standing. The restore is a state step, so ESC during the anim still gets costume 2 back."""
        for ln in ('push 1', 'actorOps.setCurActor', f'push {sp["num"]}', 'actorOps.setCostume',
                   'push 1', f'push {sp["anim_nums"][role]}', 'animateActor',
                   f'push {round(sp["frames"][role] * TICKS_PER_SEC / 12)}', 'delay'):
            sc.e(ln)

        def restore(s2):
            for ln in ('push 1', 'actorOps.setCurActor', 'push 2', 'actorOps.setCostume', 'push 3',
                       'actorOps.standAnim', 'push 1', 'push 3', 'animateActor'):
                s2.e(ln)
        self.state_step(sc, restore)

    def show_actor(self, sc, who, on):
        ids = self.ids
        a = ids.actor(who)
        if who in ('guybrush', 'player'):
            if not on:
                sc.e('push 1')
                sc.e('push 0')
                sc.e('push 0')
                sc.e('push 0')
                sc.e('putActorAtXY')
            return
        place = ids.actor_place(sc.room, who)
        hot = ids.npc_hotspot(sc.room, who)
        sc.e(f'push {int(on)}')
        sc.e(f'writeVar {ids.visible_var(who)}')
        skip = None
        if on and place and place.get('when') is not None:
            skip = sc.lab('when')
            self.jfalse_value(sc, self.when_value(sc, place['when']), skip)
        if on and place:
            sc.e(f'push {a}')
            sc.e(f'push {int(place["x"])}')
            sc.e(f'push {int(place["y"])}')
            sc.e(f'pushvar {VAR_ROOM}')
            sc.e('putActorAtXY')
        elif not on:
            sc.e(f'push {a}')
            sc.e('push 0')
            sc.e('push 0')
            sc.e('push 0')
            sc.e('putActorAtXY')
        if hot:
            sc.e(f'push {hot}')
            sc.e(f'push {32 if on else 160}')
            sc.e('push 1')
            sc.e('setClass')
        if skip:
            sc.place(skip)

    def when_value(self, sc, fn):
        """Runtime value of a `when: g => ...` condition."""
        if isinstance(fn, Func):
            scope = Scope(None, env=fn.env)
            scope.set(fn.params[0]['name'], self.G)
            if not fn.expression_body:
                raise CompileError('when() with a block body')
            return self.ev(sc, fn.body, scope)
        return fn

    def move_actor(self, sc, who, room, x, y, d):
        a = self.ids.actor(who)
        sc.e(f'push {a}')
        sc.e(f'push {int(x or 0)}')
        sc.e(f'push {int(y or 0)}')
        sc.e(f'push {self.ids.room_num(room)}')
        sc.e('putActorAtXY')

    def goto(self, sc, room, x, y, d):
        """A room change inside a script (cutscenes): loadRoom + put Guybrush there."""
        sc.changes_room = True
        r = self.ids.room_num(room)
        sc.e(f'push {r}')
        sc.e('loadRoom')
        sc.e('push 1')
        sc.e(f'push {int(x)}')
        sc.e(f'push {int(y)}')
        sc.e(f'push {r}')
        sc.e('putActorAtXY')
        if d:
            sc.e('push 1')
            sc.e('actorOps.setCurActor')
            sc.e(f'push {DIRS[d]}')
            sc.e('actorOps.face')
        sc.e('push 1')
        sc.e('actorFollowCamera')
        sc.room = room

    def intensity(self, sc, level):
        sc.e(f'push {level}')
        sc.e(f'push {level}')
        sc.e(f'push {level}')
        sc.e('push 24')
        sc.e('push 255')
        sc.e('roomOps.rgbIntensity')

    def fade(self, sc, a, b, secs):
        steps = max(2, round((secs or 0.5) * 12))
        for i in range(1, steps + 1):
            lv = round(a + (b - a) * i / steps)
            self.intensity(sc, lv)
            sc.e('breakHere')

    def music(self, sc, name):
        st = self.ids.music_state(name)
        if st is None:
            return
        kind = 4097 if st >= 2000 else 4096
        sc.e(f'push {kind}')
        sc.e(f'push {st}')
        sc.e('push 2')
        sc.e('soundKludge')

    def show_image(self, sc, img, opts):
        """Full-screen image = its own room (title/chapter cards, portrait, THE END). keep: the card stays
        (the script continues there until the next room change); without keep the game room comes back;
        a kept card with a very long wait is the final card and holds."""
        room = self.ids.image_room(img)
        if room is None:
            return
        keep = bool(opts.get('keep'))
        ms = opts.get('ms') or 6000
        final = keep and ms >= 60000
        if sc.silent and not final:
            return
        sc.changes_room = True
        if final:
            # the final card holds forever; as a state step it is also the end of a cutscene's Esc path
            def hold(s2, room=room):
                s2.e(f'push {room}')
                s2.e('loadRoom')
                loop = s2.lab('hold')
                s2.place(loop)
                s2.e('breakHere')
                s2.e(f'jump @{loop}')
            self.state_step(sc, hold)
            sc.room = '_card'
            return
        back = sc.room
        returning = not keep and back in self.ids.game_rooms()
        if keep and back in self.ids.game_rooms():
            # a kept card over a game room (g.showImage(.., {keep: true}) ... g.hideImage()): remember where Guybrush
            # stood; hide_image goes back there
            px, py = sc.local(), sc.local()
            sc.e('push 1')
            sc.e('getObjectX')
            sc.e(f'writeVar {px}')
            sc.e('push 1')
            sc.e('getObjectY')
            sc.e(f'writeVar {py}')
            sc.card_back = (back, room, px, py)
        if returning:
            # back to the room the card was opened in (item handlers are compiled as harbor code but run anywhere)
            px, py, rv = sc.local(), sc.local(), sc.local()
            sc.e('push 1')
            sc.e('getObjectX')
            sc.e(f'writeVar {px}')
            sc.e('push 1')
            sc.e('getObjectY')
            sc.e(f'writeVar {py}')
            sc.e(f'pushvar {VAR_ROOM}')
            sc.e(f'writeVar {rv}')
            sc.has_dialog = True    # opened from the inventory: CMI's chest closes first (like dialogue)
        sc.e(f'push {room}')
        sc.e('loadRoom')
        if not sc.silent:
            sc.e(f'push {max(1, round(min(ms, 9000) * TICKS_PER_SEC / 1000))}')
            sc.e('delay')
        if returning:
            # back to the game room as a cutscene state step: ESC during the card (the natural way to dismiss it)
            # jumps to the skip path, which must still leave the card room (it only acts if the card is up)
            def ret(s2, room=room, px=px, py=py, rv=rv):
                done = s2.lab('cardret')
                s2.e(f'pushvar {VAR_ROOM}')
                s2.e(f'push {room}')
                s2.e('eq')
                s2.e(f'ifNot @{done}')
                s2.e(f'pushvar {rv}')
                s2.e('loadRoom')
                s2.e('push 1')
                s2.e(f'pushvar {px}')
                s2.e(f'pushvar {py}')
                s2.e(f'pushvar {rv}')
                s2.e('putActorAtXY')
                s2.e('push 1')
                s2.e('actorFollowCamera')
                s2.place(done)
            self.state_step(sc, ret)
        else:
            sc.room = '_card'

    def hide_image(self, sc):
        """End of a kept card shown over a game room: back to that room where Guybrush stood. A cutscene state step,
        so ESC while the card is up still returns (the replay only acts if the card room is the current room)."""
        cb = getattr(sc, 'card_back', None)
        if cb is None:
            return
        back, card, px, py = cb
        r = self.ids.room_num(back)

        def ret(s2, r=r, card=card, px=px, py=py):
            done = s2.lab('cardback')
            s2.e(f'pushvar {VAR_ROOM}')
            s2.e(f'push {card}')
            s2.e('eq')
            s2.e(f'ifNot @{done}')
            s2.e(f'push {r}')
            s2.e('loadRoom')
            s2.e('push 1')
            s2.e(f'pushvar {px}')
            s2.e(f'pushvar {py}')
            s2.e(f'push {r}')
            s2.e('putActorAtXY')
            s2.e('push 1')
            s2.e('actorFollowCamera')
            s2.place(done)
        self.state_step(sc, ret)
        sc.room = back
        sc.card_back = None

    # -------------------------------------------------- talking
    def say(self, sc, who, text, opts=None):
        if sc.silent:
            return
        if opts and opts.get('noAnim') and who in self.ids.costumes:
            # an NPC talking without his talk anim (e.g. Mort laughing): for this line his talk frames are his
            # current base anim (setBase; 0 = stand 3), then SCUMM's default talk frames 4/5 again
            a = self.ids.actor(who)
            loc, std, done = sc.local(), sc.lab('nas'), sc.lab('nad')
            bv = self.ids.base_var(who)
            for ln in (f'pushvar {bv}', f'ifNot @{std}', f'pushvar {bv}', f'writeVar {loc}', f'jump @{done}'):
                sc.e(ln)
            sc.place(std)
            sc.e('push 3')
            sc.e(f'writeVar {loc}')
            sc.place(done)
            for ln in (f'push {a}', 'actorOps.setCurActor', f'pushvar {loc}', f'pushvar {loc}', 'actorOps.talkAnim'):
                sc.e(ln)
            self.say(sc, who, text)
            for ln in (f'push {a}', 'actorOps.setCurActor', 'push 4', 'push 5', 'actorOps.talkAnim'):
                sc.e(ln)
            return
        if isinstance(text, Cond):
            end = sc.lab('sayend')
            for tests, val in text.alts:
                nxt = sc.lab('saynx')
                for t in tests:
                    t.jfalse(sc, nxt)
                self.say(sc, who, val)
                sc.e(f'jump @{end}')
                sc.place(nxt)
            sc.place(end)
            return
        if isinstance(text, list):
            self.say_random(sc, who, text)
            return
        if text is None:
            return
        who = 'player' if who in (None, 'player', self.game.game.get('player')) else who
        a = self.ids.talker(sc, who)
        if isinstance(text, Text):
            s = text.encode()
        else:
            t = str(text)
            # voiced line: "/TAG/text" -> CMI plays TAG.IMX from the voice bundle (audio.py)
            voices = getattr(self, 'voices', None)
            tag = voices.tag(self.game.game.get('player') if who == 'player' else who, t) if voices else None
            s = js_quote(f'/{tag}/{t}' if tag else t)
        sc.e(f'push {a}')
        sc.e(f'talkActor {s}')
        sc.e('wait.forMessage')

    def say_random(self, sc, who, lines):
        if sc.silent:
            return
        if len(lines) == 1:
            self.say(sc, who, lines[0])
            return
        loc = sc.local()
        sc.e('push 0')
        sc.e(f'push {len(lines) - 1}')
        sc.e('getRandomNumberRange')
        sc.e(f'writeVar {loc}')
        end = sc.lab('rnd')
        for i, line in enumerate(lines):
            nxt = sc.lab('rn')
            sc.e(f'pushvar {loc}')
            sc.e(f'push {i}')
            sc.e('eq')
            sc.e(f'ifNot @{nxt}')
            self.say(sc, who, line)
            sc.e(f'jump @{end}')
            sc.place(nxt)
        sc.place(end)

    # -------------------------------------------------- dialog choices (CMI's verbs 500..539)
    def choose(self, sc, options, scope):
        opts = [o for o in options if o is not None and o is not False]
        if isinstance(options, list) and any(isinstance(o, (V, Cond)) for o in options):
            raise CompileError('runtime choice options')
        entries = []
        # options come as evaluated values; conditions were && chains -> re-read the AST for tests
        cond_nodes = self._choose_nodes
        for i, o in enumerate(options):
            node = cond_nodes[i] if cond_nodes and i < len(cond_nodes) else None
            entries.append((o, node))
        was_implicit = sc.implicit
        sc.has_dialog = True
        self.end_implicit(sc)
        self.dialog_enter(sc)
        loop, chosen = sc.lab('dlg'), sc.lab('chosen')
        sc.place(loop)
        sc.e('pushvar 255')
        sc.e('not')
        sc.e(f'ifNot @{chosen}')
        # clear choice verbs + silent flags
        cl, cld = sc.lab('clr'), sc.lab('clrd')
        sc.e('push 500')
        sc.e('writeVar 606')
        sc.place(cl)
        sc.e('pushvar 606')
        sc.e('push 539')
        sc.e('le')
        sc.e(f'ifNot @{cld}')
        sc.e('pushvar 606')
        sc.e('verbOps.init')
        sc.e('verbOps.off')
        sc.e('varInc 606')
        sc.e(f'jump @{cl}')
        sc.place(cld)
        # CMI lays choices out from (var594, var595) = (5, 330) down, 24 px apart: room for 6 lines.
        # Longer lists start higher so that the last choice stays on screen (var606 = count).
        sc.e('push 0')
        sc.e('writeVar 606')
        for o, node in entries:
            if o is None or o is False:
                continue
            cskip = sc.lab('cnt')
            test_node = node['left'] if node is not None and node['type'] == 'LogicalExpression' else None
            if test_node is not None:
                self.jfalse(sc, test_node, scope, cskip)
            sc.e('varInc 606')
            sc.place(cskip)
        sc.e('pushvar 595')
        sc.e('writeVar 256')
        top = sc.lab('top')
        for ln in ('push 474', 'pushvar 606', 'pushvar 596', 'mul', 'sub', 'pushvar 256', 'lt', f'ifNot @{top}',
                   'push 474', 'pushvar 606', 'pushvar 596', 'mul', 'sub', 'writeVar 256'):
            sc.e(ln)
        sc.place(top)
        if sc.caption:
            self.caption_blast(sc, sc.caption)
        domain = {}
        k = 0
        for o, node in entries:
            if o is None or o is False:
                continue
            j = k
            k += 1
            oid = o.get('id', o.get('text'))
            domain[oid] = j
            skip = sc.lab('opt')
            test_node = node['left'] if node is not None and node['type'] == 'LogicalExpression' else None
            if test_node is not None:
                self.jfalse(sc, test_node, scope, skip)
            sc.e(f'push {j + 1}')
            sc.e(f'push {0 if o.get("say", True) else 1}')
            sc.e('arrayWrite 329')
            sc.e(f'push {j + 1}')
            sc.e('push 0')
            sc.e('arrayWrite 330')
            sc.e(f'push {j + 1}')
            sc.e('push 0')
            sc.e('arrayWrite 331')
            sc.e(f'push {500 + j}')
            sc.e('verbOps.init')
            sc.e('pushvar 594')
            sc.e('pushvar 256')
            sc.e('verbOps.at')
            # a spoken choice carries Guybrush's voice tag: CMI's dialog script 13 says it with
            # talkActor("/M1GT001/" + verb), and the verb's own "/TAG/" becomes the line's voice
            text = str(o['text'])
            voices = getattr(self, 'voices', None)
            tag = voices.tag(self.game.game.get('player'), text) if voices and o.get('say', True) else None
            sc.e(f'verbOps.name {js_quote(f"/{tag}/{text}" if tag else text)}')
            sc.e('verbOps.on')
            sc.e('pushvar 256')
            sc.e('pushvar 596')
            sc.e('add')
            sc.e('writeVar 256')
            sc.place(skip)
        sc.e('breakHere')
        sc.e(f'jump @{loop}')
        sc.place(chosen)
        sc.e('push 0')
        sc.e('writeVar 603')
        sc.e('wait.forMessage')
        res = sc.local()
        sc.e('pushvar 255')
        sc.e('push 500')
        sc.e('sub')
        sc.e(f'writeVar {res}')
        self.dialog_exit(sc)
        if was_implicit:
            self.begin_implicit(sc)
        return var_value(res, 'choice', {'domain': domain})

    def caption_blast(self, sc, text):
        sc.e('blastText.baseop')
        sc.e('blastText.wrap')
        sc.e('push 1')
        sc.e('blastText.charset')
        sc.e('push 19')
        sc.e('blastText.color')
        sc.e('blastText.center')
        sc.e('push 320')
        sc.e('push 24')
        sc.e('blastText.at')
        sc.e(f'blastText.msg {js_quote(text)}')

    def dialog_enter(self, sc):
        for ln in ('push 1', 'cursorCommand.initCharset', 'push 39', 'stopScript', 'push 24', 'push 1',
                   'kernelSetFunctions', 'push 41', 'stopScript', 'push 13', f'writeVar {VAR_VERB_SCRIPT}',
                   'push 5', 'push 5', 'push 1', 'startScriptQuick', 'push 0', 'writeVar 255', 'push 0',
                   'writeVar 604', 'push 0', 'writeVar 603', 'push 0', 'writeVar 609',
                   'cursorCommand.cursorOn', 'cursorCommand.userputOn'):
            sc.e(ln)

    def dialog_exit(self, sc):
        for ln in ('push 0', 'writeVar 603', 'push 1', 'cursorCommand.initCharset', 'push 32', f'writeVar {VAR_VERB_SCRIPT}',
                   'push 1', 'writeVar 312', 'push 1', 'push 39', 'push 0', 'startScript', 'push 1', 'push 41', 'push 0',
                   'startScript', 'push 5', 'push 2', 'push 1', 'startScriptQuick', 'cursorCommand.cursorOn',
                   'cursorCommand.userputOn'):
            sc.e(ln)

    # -------------------------------------------------- cutscenes
    def cutscene(self, sc, fn):
        if sc.silent:
            # skip path of an outer cutscene: just the state steps
            self.inline_any(sc, fn, [self.G])
            return
        was_implicit = sc.implicit
        outer_cut = sc.cut
        prog = sc.local()
        sc.cut = {'prog': prog, 'steps': []}
        sc.implicit = False
        sc.e('push 2')
        sc.e('push 1')
        sc.e('cutscene')
        sc.e('push 0')
        sc.e(f'writeVar {prog}')
        sc.e('beginOverride')
        skip = sc.lab('skip')
        sc.e(f'jump @{skip}')
        self.inline_any(sc, fn, [self.G])
        steps = sc.cut['steps']
        sc.place(skip)
        norm, after = sc.lab('norm'), sc.lab('after')
        sc.e(f'pushvar {VAR_OVERRIDE}')
        sc.e(f'ifNot @{norm}')
        sc.e('endOverride')
        sc.e('printLine.baseop')
        sc.e('printLine.msg " "')
        silent_was = sc.silent
        sc.silent = True
        sc.cut = None
        for k, step in enumerate(steps, 1):
            nx = sc.lab('st')
            sc.e(f'pushvar {prog}')
            sc.e(f'push {k}')
            sc.e('lt')
            sc.e(f'ifNot @{nx}')
            step(sc)
            sc.place(nx)
        sc.silent = silent_was
        sc.e(f'jump @{after}')
        sc.place(norm)
        sc.e('endOverride')
        sc.place(after)
        sc.e('endCutscene')
        sc.cut = outer_cut
        sc.implicit = was_implicit
        if outer_cut is not None:
            # the whole inner cutscene counts as one step of the outer one (replayed silently)
            pass

    def inline_any(self, sc, fn, args):
        if isinstance(fn, ClosureFunc):
            return self.inline_closure(sc, fn, args)
        return self.inline(sc, fn, args, None)


class ClosureFunc:
    """An arrow function defined inside a compiled function (captures compile-time locals)."""

    def __init__(self, node, scope):
        self.node = node
        self.scope = scope


def obj_scope_base(cl):
    return getattr(cl, 'base_conds', [])


# The choose() call needs the option nodes (their && conditions); patch api() through a hook:
_orig_api = Compiler.api


def _api(self, sc, name, args_nodes, scope, discard):
    if name == 'choose':
        arr = args_nodes[0]
        if arr['type'] == 'ArrayExpression':
            self._choose_nodes = arr['elements']
            # evaluate options: conditional ones are `cond && {...}`: take the object part statically
            opts = []
            for el in arr['elements']:
                if el['type'] == 'LogicalExpression' and el['operator'] == '&&':
                    opts.append(self.static_eval_obj(el['right'], scope))
                else:
                    opts.append(self.static_eval_obj(el, scope))
            return self.choose(sc, opts, scope)
        self._choose_nodes = None
        opts = self.ev(sc, arr, scope)
        return self.choose(sc, opts, scope)
    return _orig_api(self, sc, name, args_nodes, scope, discard)


def _static_eval_obj(self, node, scope):
    if node['type'] == 'ObjectExpression':
        d = {}
        for p in node['properties']:
            k = p['key']['name'] if p['key']['type'] == 'Identifier' else p['key']['value']
            d[k] = scope.lookup(k) if p.get('shorthand') else self.static_eval(p['value'], scope)
        return d
    if node['type'] == 'Literal':
        return {'id': node['value'], 'text': node['value']}
    return self.static_eval(node, scope)


Compiler.api = _api
Compiler.static_eval_obj = _static_eval_obj
Compiler._choose_nodes = None
