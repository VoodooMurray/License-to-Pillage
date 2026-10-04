#!/usr/bin/env python3
"""Loads the web game (game/game.js + its imports) through acorn (tools/scumm/js/parse.mjs) and
evaluates its static parts in Python: object literals, strings, arrays, consts, imports. Functions
stay as closures (Func: AST node + module scope) for the SCUMM compiler (compiler.py) to compile.

  python3 tools/scumm/jsgame.py        # summary of the loaded game
"""
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
GAME_DIR = os.path.join(ROOT, 'game')
PARSER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'js', 'parse.mjs')


class NotStatic(Exception):
    pass


class Func:
    """A JS function value: AST node + defining scope."""

    def __init__(self, node, env, name=None):
        self.node = node
        self.env = env
        self.name = name or (node.get('id') or {}).get('name') or '<anon>'

    @property
    def params(self):
        return self.node['params']

    @property
    def body(self):
        return self.node['body']

    @property
    def expression_body(self):
        return self.node['body']['type'] != 'BlockStatement'

    def __repr__(self):
        loc = self.node.get('loc', {}).get('start', {})
        return f'<Func {self.name} @{loc.get("line")}>'


class Env:
    def __init__(self, parent=None, module=None):
        self.vars = {}
        self.parent = parent
        self.module = module or (parent.module if parent else None)

    def lookup(self, name):
        e = self
        while e is not None:
            if name in e.vars:
                return e.vars[name]
            e = e.parent
        raise KeyError(name)

    def has(self, name):
        e = self
        while e is not None:
            if name in e.vars:
                return True
            e = e.parent
        return False

    def set(self, name, value):
        self.vars[name] = value


class Module:
    def __init__(self, path):
        self.path = path
        self.env = Env(module=self)
        self.default = None
        self.exports = {}


# ASTs are cached by source content (gzip JSON): a cache shipped with the mod lets players build without node
PARSE_CACHE = os.environ.get('LTP_PARSE_CACHE') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'parse_cache')
PARSE_KEY = b'acorn-8 ecmaVersion=latest sourceType=module locations=true\0'


def source_key(data):
    return hashlib.sha1(PARSE_KEY + data).hexdigest()[:24]


def _cache_get(key):
    path = os.path.join(PARSE_CACHE, key + '.json.gz')
    if os.path.exists(path):
        with gzip.open(path, 'rt', encoding='utf-8') as f:
            return json.load(f)
    return None


def _cache_put(key, value):
    try:
        os.makedirs(PARSE_CACHE, exist_ok=True)
        path = os.path.join(PARSE_CACHE, key + '.json.gz')
        tmp = f'{path}.{os.getpid()}.tmp'
        with gzip.open(tmp, 'wt', encoding='utf-8', compresslevel=6) as f:
            json.dump(value, f, separators=(',', ':'))
        os.replace(tmp, path)
    except OSError:
        pass        # a read-only install: just no cache


def need_node(what):
    if not shutil.which('node'):
        raise RuntimeError(f'Node.js is needed to read {what} (changed since this copy was made): '
                           'install it from https://nodejs.org and try again')


def parse_files(paths):
    out, missing = {}, []
    for p in paths:
        with open(p, 'rb') as f:
            key = source_key(f.read())
        ast = _cache_get(key)
        if ast is None:
            missing.append((p, key))
        else:
            out[p] = ast
    if missing:
        need_node(', '.join(os.path.basename(p) for p, _ in missing))
        res = json.loads(subprocess.run(['node', PARSER, *[p for p, _ in missing]], capture_output=True, text=True,
                                        check=True).stdout)
        for p, key in missing:
            out[p] = res[p]
            _cache_put(key, res[p])
    return out


def prop_key(p):
    k = p['key']
    if p.get('computed'):
        raise NotStatic('computed key')
    return k['name'] if k['type'] == 'Identifier' else k['value']


def sval(node, env):
    """Static value of an expression (raises NotStatic for runtime expressions)."""
    t = node['type']
    if t == 'Literal':
        return node['value']
    if t == 'TemplateLiteral':
        if node['expressions']:
            raise NotStatic('template with expressions')
        return node['quasis'][0]['value']['cooked']
    if t == 'ArrayExpression':
        return [None if el is None else sval(el, env) for el in node['elements']]
    if t == 'ObjectExpression':
        d = {}
        for p in node['properties']:
            if p['type'] != 'Property':
                raise NotStatic(p['type'])
            k = prop_key(p)
            if p.get('shorthand'):
                d[k] = env.lookup(k)
            elif p['value']['type'] in ('FunctionExpression', 'ArrowFunctionExpression'):
                d[k] = Func(p['value'], env, k)
            else:
                d[k] = sval(p['value'], env)
        return d
    if t == 'Identifier':
        if node['name'] == 'undefined':
            return None
        try:
            return env.lookup(node['name'])
        except KeyError:
            raise NotStatic('unknown identifier ' + node['name'])
    if t in ('ArrowFunctionExpression', 'FunctionExpression'):
        return Func(node, env)
    if t == 'BinaryExpression':
        a, b = sval(node['left'], env), sval(node['right'], env)
        op = node['operator']
        if op == '+':
            if isinstance(a, str) or isinstance(b, str):
                return f'{a}{b}'
            return a + b
        if op == '-':
            return a - b
        if op == '*':
            return a * b
        if op == '/':
            return a / b
        if op in ('===', '=='):
            return a == b
        if op in ('!==', '!='):
            return a != b
        raise NotStatic('binary ' + op)
    if t == 'UnaryExpression':
        v = sval(node['argument'], env)
        if node['operator'] == '-':
            return -v
        if node['operator'] == '!':
            return not v
        raise NotStatic('unary ' + node['operator'])
    if t == 'MemberExpression':
        obj = sval(node['object'], env)
        if node['computed']:
            key = sval(node['property'], env)
        else:
            key = node['property']['name']
        if isinstance(obj, dict):
            return obj.get(key)
        if isinstance(obj, (list, str)):
            if key == 'length':
                return len(obj)
            return obj[int(key)]
        raise NotStatic('member of ' + type(obj).__name__)
    if t == 'ConditionalExpression':
        return sval(node['consequent'] if sval(node['test'], env) else node['alternate'], env)
    raise NotStatic(t)


class Game:
    """The loaded web game: modules, the game object, rooms."""

    def __init__(self, game_dir=GAME_DIR):
        self.dir = game_dir
        self.modules = {}
        entry = os.path.join(game_dir, 'game.js')
        # parse every .js under game/ in one node call
        paths = []
        for base, _, files in os.walk(game_dir):
            for f in files:
                if f.endswith('.js'):
                    paths.append(os.path.join(base, f))
        self.asts = parse_files(sorted(paths))
        self.main = self.load(entry)
        self.game = self.main.default
        self.rooms = {r['id']: r for r in self.game['rooms']}

    def load(self, path):
        path = os.path.normpath(path)
        if path in self.modules:
            return self.modules[path]
        m = Module(path)
        self.modules[path] = m
        ast = self.asts[path]
        env = m.env
        body = ast['body']
        # imports
        for st in body:
            if st['type'] == 'ImportDeclaration':
                src = os.path.normpath(os.path.join(os.path.dirname(path), st['source']['value']))
                dep = self.load(src)
                for sp in st['specifiers']:
                    if sp['type'] == 'ImportDefaultSpecifier':
                        env.set(sp['local']['name'], dep.default)
                    elif sp['type'] == 'ImportSpecifier':
                        env.set(sp['local']['name'], dep.exports[sp['imported']['name']])
        # hoisted functions
        for st in body:
            decl = st.get('declaration') if st['type'] in ('ExportNamedDeclaration',) else st
            if decl and decl['type'] == 'FunctionDeclaration':
                f = Func(decl, env)
                env.set(decl['id']['name'], f)
                if st['type'] == 'ExportNamedDeclaration':
                    m.exports[decl['id']['name']] = f
        # consts and the default export, in order
        for st in body:
            decl = st
            if st['type'] == 'ExportNamedDeclaration':
                decl = st['declaration']
            if decl and decl['type'] == 'VariableDeclaration':
                for d in decl['declarations']:
                    name = d['id']['name']
                    try:
                        env.set(name, sval(d['init'], env))
                    except NotStatic as e:
                        raise NotStatic(f'{path}: const {name}: {e}')
                    if st['type'] == 'ExportNamedDeclaration':
                        m.exports[name] = env.lookup(name)
            elif st['type'] == 'ExportDefaultDeclaration':
                dd = st['declaration']
                if dd['type'] == 'FunctionDeclaration':
                    m.default = env.lookup(dd['id']['name']) if dd.get('id') else Func(dd, env)
                else:
                    m.default = sval(dd, env)
        return m


def main():
    g = Game()
    game = g.game
    print('title:', game.get('title'), '| player:', game.get('player'))
    print('actors:', list(game['actors']))
    print('items:', list(game['items']))
    for rid, r in g.rooms.items():
        objs = [o['id'] for o in r.get('objects', [])]
        print(f'room {rid}: size {r.get("size")} objects {len(objs)} npcs {list((r.get("npcs") or {}).keys())} '
              f'actors {list((r.get("actors") or {}).keys())}')
        for o in r.get('objects', []):
            hs = {k: type(v).__name__ for k, v in o.items() if k in ('look', 'hand', 'mouth', 'use')}
            print('   ', o['id'], hs)


if __name__ == '__main__':
    main()
