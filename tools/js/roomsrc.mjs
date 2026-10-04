// Room source patcher for the level editor: reads a room module (game/rooms/<id>.js) with acorn,
// evaluates the static parts of its default export (the editor's model: functions and runtime
// expressions become {$fn}/{$opaque} markers holding their source text) and rewrites single values
// in place, leaving every other byte of the file alone. Used by tools/serve.py (the editor's save
// endpoint) and usable from pipelines. Details: EDITOR_PLAN.md.
//
//   node tools/js/roomsrc.mjs dump game/rooms/records.js          -> {sha, value, loc}
//   node tools/js/roomsrc.mjs patch game/rooms/records.js < edits -> {text, sha, applied, conflicts, verify}
//   node tools/js/roomsrc.mjs patch game/rooms/records.js --write --set 'objects[id=bottle].states.on.x=166'
//   node tools/js/roomsrc.mjs selftest game/rooms/*.js
//
// Edits (JSON array, or {edits: [...]}):
//   {op: 'set', path, value, expect?}   replace a value (or insert the property when it is missing)
//   {op: 'del', path, expect?}          delete a property
//   {op: 'insert', path, index, value}  insert an array element (path = the array)
//   {op: 'remove', path, expect?}       remove an array element (with the comment lines above it)
//   {op: 'move', path, index}           move an array element, its text verbatim
// expect = the value the editor started from ({$missing: true}: absent); a different value on disk
// is a conflict and nothing is written.

import { fileURLToPath } from 'node:url';
import { resolve as pathResolve } from 'node:path';
import { readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, basename } from 'node:path';
import { parsePath, formatPath, getPath, setPath, deepEqual, clone, roundValue, hasCode, elementIndex } from '../../engine/editor/paths.js';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const MAXW = 110;          // wrap long point lists / objects at this column
const MAXLINE = 120;       // a new property joins the previous line if it stays within this
const FIELD_ORDER = ['id', 'name', 'box', 'hot', 'hotZ', 'z', 'walkTo', 'face', 'exit', 'states', 'state', 'verbs'];
const MISSING = { $missing: true };
const isMissing = v => v && typeof v === 'object' && v.$missing === true;

export const sha = text => createHash('sha1').update(text).digest('hex');

// ------------------------------------------------------------------ parsing + static values
export function parse(text) {
  const comments = [];
  const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true, onComment: comments });
  return { ast, comments, text };
}

function propKey(p) {
  if (p.type !== 'Property' || p.computed) return null;
  return p.key.type === 'Identifier' ? p.key.name : String(p.key.value);
}

class Module {
  constructor(text) {
    Object.assign(this, parse(text));
    this.env = new Map();
    this.root = null;          // the default export's ObjectExpression
    const body = this.ast.body;
    for (const st of body) {
      const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st;
      if (decl?.type === 'FunctionDeclaration') this.env.set(decl.id.name, { $fn: this.src(decl) });
      if (st.type === 'ImportDeclaration') for (const sp of st.specifiers) this.env.set(sp.local.name, { $opaque: sp.local.name });
    }
    const consts = new Map();
    for (const st of body) {
      const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st;
      if (decl?.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          if (d.id.type !== 'Identifier' || !d.init) continue;
          this.env.set(d.id.name, this.sval(d.init));
          consts.set(d.id.name, d.init);
        }
      } else if (st.type === 'ExportDefaultDeclaration') {
        const dd = st.declaration;
        this.root = dd.type === 'ObjectExpression' ? dd : dd.type === 'Identifier' && consts.get(dd.name)?.type === 'ObjectExpression' ? consts.get(dd.name) : null;
      }
    }
    // the source formatter writes image paths as R + '...' when the module has such a const
    for (const [name, v] of this.env) if (typeof v === 'string' && /^rooms\/.+\/$/.test(v)) this.prefix ||= { name, value: v };
  }

  src(n) { return this.text.slice(n.start, n.end); }

  sval(n) {
    const op = () => ({ $opaque: this.src(n) });
    switch (n.type) {
      case 'Literal': return n.regex ? op() : n.value;
      case 'TemplateLiteral': return n.expressions.length ? op() : n.quasis[0].value.cooked;
      case 'ArrayExpression':
        if (n.elements.some(e => e?.type === 'SpreadElement')) return op();
        return n.elements.map(e => e == null ? null : this.sval(e));
      case 'ObjectExpression': {
        if (n.properties.some(p => p.type !== 'Property' || p.computed)) return op();
        const o = {};
        for (const p of n.properties) {
          const k = propKey(p);
          o[k] = (p.kind !== 'init' || p.method) ? { $fn: this.src(p) } : this.sval(p.value);
        }
        return o;
      }
      case 'Identifier':
        if (n.name === 'undefined') return undefined;
        return this.env.has(n.name) ? clone(this.env.get(n.name)) : op();
      case 'FunctionExpression': case 'ArrowFunctionExpression': return { $fn: this.src(n) };
      case 'UnaryExpression': {
        const v = this.sval(n.argument);
        if (typeof v !== 'number' && typeof v !== 'boolean') return op();
        if (n.operator === '-') return -v;
        if (n.operator === '+') return +v;
        if (n.operator === '!') return !v;
        return op();
      }
      case 'BinaryExpression': {
        const a = this.sval(n.left), b = this.sval(n.right);
        const ok = x => typeof x === 'number' || typeof x === 'string';
        if (!ok(a) || !ok(b)) return op();
        if (n.operator === '+') return a + b;
        if (typeof a !== 'number' || typeof b !== 'number') return op();
        if (n.operator === '-') return a - b;
        if (n.operator === '*') return a * b;
        if (n.operator === '/') return a / b;
        return op();
      }
      case 'MemberExpression': {
        const o = this.sval(n.object);
        if (o == null || typeof o !== 'object' || hasCode(o)) return op();
        const k = n.computed ? this.sval(n.property) : n.property.name;
        if (typeof k !== 'string' && typeof k !== 'number') return op();
        return k === 'length' && Array.isArray(o) ? o.length : clone(o[k]);
      }
      default: return op();
    }
  }

  model() { return this.root ? this.sval(this.root) : null; }

  // --- locating a path in the source
  // -> {node, prop?, array?, index?, container?} | {missing: true, obj, at} ; throws Locked
  locate(path) {
    const segs = typeof path === 'string' ? parsePath(path) : path;
    if (!this.root) throw new Locked('no default export object');
    let node = this.root;
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i], last = i === segs.length - 1;
      const here = formatPath(segs.slice(0, i));
      if (g.key != null) {
        if (node.type !== 'ObjectExpression') throw new Locked(`${here || 'root'} is not an object literal (${node.type})`);
        if (node.properties.some(p => p.type !== 'Property' || p.computed)) throw new Locked(`${here} has spreads or computed keys`);
        const prop = node.properties.findLast(p => propKey(p) === g.key);
        if (!prop) return { missing: true, obj: node, at: i, segs };
        if (prop.kind !== 'init' || prop.method || prop.shorthand) {
          if (last) return { node: prop, prop, container: node, code: true };
          throw new Locked(`${formatPath(segs.slice(0, i + 1))} is code`);
        }
        if (last) return { node: prop.value, prop, container: node };
        node = prop.value;
      } else {
        if (node.type !== 'ArrayExpression') throw new Locked(`${here} is not an array literal (${node.type})`);
        if (node.elements.some(e => e?.type === 'SpreadElement')) throw new Locked(`${here} has spreads`);
        const idx = g.index != null ? (g.index < node.elements.length ? g.index : -1)
          : node.elements.findIndex(e => e?.type === 'ObjectExpression' && this.sval(e)?.id === g.id);
        if (idx < 0) throw new Missing(`no element ${formatPath(segs.slice(0, i + 1))}`);
        if (last) return { node: node.elements[idx], array: node, index: idx };
        node = node.elements[idx];
      }
    }
    return { node: this.root };
  }

  valueAt(path) {
    try {
      const r = this.locate(path);
      if (r.missing) return MISSING;
      return r.code ? { $fn: this.src(r.node) } : this.sval(r.node);
    } catch (err) {
      if (err instanceof Missing) return MISSING;
      throw err;
    }
  }

  // line/column helpers
  lineStart(pos) { return this.text.lastIndexOf('\n', pos - 1) + 1; }
  lineEnd(pos) { const e = this.text.indexOf('\n', pos); return e < 0 ? this.text.length : e; }
  indentAt(pos) { const s = this.lineStart(pos); return /^[ \t]*/.exec(this.text.slice(s))[0]; }
  col(pos) { return pos - this.lineStart(pos); }
  skipWs(pos) { while (pos < this.text.length && (this.text[pos] === ' ' || this.text[pos] === '\t')) pos++; return pos; }
}

class Locked extends Error {}
class Missing extends Error {}

// ------------------------------------------------------------------ formatting values as source
function fmtNum(v) {
  const r = roundValue(v);
  return String(r);
}

function fmtStr(s, ctx) {
  const pre = ctx?.prefix;
  if (pre && s.length > pre.value.length && s.startsWith(pre.value)) return `${pre.name} + ${fmtStr(s.slice(pre.value.length))}`;
  if (!s.includes("'")) return "'" + JSON.stringify(s).slice(1, -1).replace(/\\"/g, '"') + "'";
  return JSON.stringify(s);
}

const fmtKey = k => /^[A-Za-z_$][\w$]*$/.test(k) ? k : fmtStr(k);

function inline(v, ctx) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return fmtStr(v, ctx);
  if (v.$fn != null) return v.$fn;
  if (v.$opaque != null) return v.$opaque;
  if (Array.isArray(v)) return '[' + v.map(x => inline(x, ctx)).join(', ') + ']';
  const ks = Object.keys(v).filter(k => v[k] !== undefined);
  if (!ks.length) return '{}';
  return '{ ' + ks.map(k => fmtKey(k) + ': ' + inline(v[k], ctx)).join(', ') + ' }';
}

const isFlat = x => x == null || typeof x !== 'object' || (Array.isArray(x) && x.every(y => y == null || typeof y !== 'object'));

// pack items ("a", "b", ...) into lines of at most MAXW columns, each item followed by a comma
function pack(items, indent) {
  const lines = [];
  let cur = '';
  for (const it of items) {
    const piece = it + ',';
    if (cur && indent.length + cur.length + 1 + piece.length > MAXW) { lines.push(indent + cur); cur = piece; }
    else cur = cur ? cur + ' ' + piece : piece;
  }
  if (cur) lines.push(indent + cur);
  return lines;
}

// value -> source text; col = the column it starts at, indent = its line's indentation
export function fmt(v, ctx) {
  const one = inline(v, ctx);
  if (ctx.col + one.length <= MAXW || v == null || typeof v !== 'object' || v.$fn != null || v.$opaque != null) return one;
  const inner = ctx.indent + '  ';
  const sub = x => fmt(x, { ...ctx, indent: inner, col: inner.length });
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every(isFlat)) return '[\n' + pack(v.map(x => inline(x, ctx)), inner).join('\n') + '\n' + ctx.indent + ']';
    // a single polygon: [[ points... ]] (the rooms' walk area style)
    if (v.length === 1 && Array.isArray(v[0]) && v[0].length && v[0].every(isFlat)) {
      return '[[\n' + pack(v[0].map(x => inline(x, ctx)), inner).join('\n') + '\n' + ctx.indent + ']]';
    }
    return '[\n' + v.map(x => inner + sub(x) + ',').join('\n') + '\n' + ctx.indent + ']';
  }
  const ks = Object.keys(v).filter(k => v[k] !== undefined);
  const items = ks.map(k => {
    const head = fmtKey(k) + ': ';
    return head + fmt(v[k], { ...ctx, indent: inner, col: inner.length + head.length });
  });
  // multi-line members get their own line
  const lines = [];
  let run = [];
  for (const it of items) {
    if (it.includes('\n')) { lines.push(...pack(run, inner)); run = []; lines.push(inner + it + ','); } else run.push(it);
  }
  lines.push(...pack(run, inner));
  return '{\n' + lines.join('\n') + '\n' + ctx.indent + '}';
}

// ------------------------------------------------------------------ edits on the source text
function splice(text, start, end, ins) { return text.slice(0, start) + ins + text.slice(end); }

function ctxAt(m, pos) { return { indent: m.indentAt(pos), col: m.col(pos), prefix: m.prefix }; }

// nested object value for a missing path tail: segs [a, b, c] + v -> {b: {c: v}} under key a
function nest(segs, v) {
  let out = v;
  for (let i = segs.length - 1; i >= 1; i--) {
    if (segs[i].key == null) throw new Missing(`cannot create array element ${formatPath(segs)}`);
    out = { [segs[i].key]: out };
  }
  return out;
}

// the full-line comments directly above pos (returns the start of the first such line)
function commentsAbove(m, pos) {
  let s = m.lineStart(pos);
  for (;;) {
    if (s === 0) return s;
    const ps = m.lineStart(s - 1);
    const line = m.text.slice(ps, s - 1);
    if (/^[ \t]*\/\//.test(line)) s = ps; else return s;
  }
}

function insertProp(m, obj, key, value) {
  const props = obj.properties;
  const text = m.text;
  if (!props.length) {
    const ind = m.indentAt(obj.start);
    const one = '{ ' + fmtKey(key) + ': ' + fmt(value, { indent: ind, col: m.col(obj.start) + 2 + key.length + 2, prefix: m.prefix }) + ' }';
    return splice(text, obj.start, obj.end, one);
  }
  // position: after the nearest earlier key in FIELD_ORDER, else first (known keys) / last (others)
  const order = FIELD_ORDER.indexOf(key);
  let after = null;
  if (order < 0) after = props[props.length - 1];
  else {
    let best = -1;
    for (const p of props) { const o = FIELD_ORDER.indexOf(propKey(p)); if (o >= 0 && o < order && o >= best) { best = o; after = p; } }
  }
  if (!after) {
    const first = props[0];
    const ind = m.indentAt(first.start);
    const head = fmtKey(key) + ': ';
    const val = fmt(value, { indent: ind, col: m.col(first.start) + head.length, prefix: m.prefix });
    const oneLine = head + val + ', ';
    if (!val.includes('\n') && m.lineEnd(first.start) - m.lineStart(first.start) + oneLine.length <= MAXLINE) return splice(text, first.start, first.start, oneLine);
    const ownLine = /^[ \t]*$/.test(text.slice(m.lineStart(first.start), first.start));
    return splice(text, first.start, first.start, head + val + (ownLine ? ',\n' + ind : ', '));
  }
  const i = props.indexOf(after);
  const next = props[i + 1];
  let p = m.skipWs(after.end);
  const comma = text[p] === ',';
  const afterComma = comma ? p + 1 : after.end;
  const head = fmtKey(key) + ': ';
  const sameLineNext = next && m.lineStart(next.start) === m.lineStart(after.end);
  const closeSameLine = !next && m.lineStart(obj.end - 1) === m.lineStart(after.end);
  if (sameLineNext || closeSameLine) {
    // inline: "a, NEW, b" or "{ a, NEW }"
    const val = fmt(value, { indent: m.indentAt(after.end), col: m.col(after.end) + 2 + head.length, prefix: m.prefix });
    // a one-line object that would grow past the line limit is laid out again as a whole (if it holds no code)
    const oneLine = m.lineStart(obj.start) === m.lineStart(obj.end - 1);
    if (oneLine && m.lineEnd(obj.start) - m.lineStart(obj.start) + 2 + head.length + val.length > MAXLINE) {
      const cur = m.sval(obj);
      if (!hasCode(cur)) {
        const ents = Object.entries(cur), at = ents.findIndex(([k]) => k === propKey(after)) + 1;
        ents.splice(at, 0, [key, value]);
        return splice(text, obj.start, obj.end, fmt(Object.fromEntries(ents), ctxAt(m, obj.start)));
      }
    }
    return splice(text, after.end, after.end, ', ' + head + val);
  }
  // after on the end of its line: join the line if short enough, else a new line
  const ind = m.indentAt(after.end);
  const eol = m.lineEnd(after.end);
  const val1 = fmt(value, { indent: ind, col: (afterComma - m.lineStart(after.end)) + 1 + head.length, prefix: m.prefix });
  const trail = comma ? ',' : '';
  if (!val1.includes('\n') && m.lineStart(after.start) === m.lineStart(after.end) && (eol - m.lineStart(after.end)) + 1 + head.length + val1.length + trail.length <= MAXLINE && /^[ \t]*$/.test(text.slice(afterComma, eol))) {
    return splice(text, afterComma, afterComma, (comma ? ' ' : ', ') + head + val1 + trail);
  }
  const val2 = fmt(value, { indent: ind, col: ind.length + head.length, prefix: m.prefix });
  if (comma) return splice(text, eol, eol, '\n' + ind + head + val2 + ',');
  return splice(text, after.end, after.end, ',\n' + ind + head + val2);
}

function deleteProp(m, obj, prop) {
  const props = obj.properties, i = props.indexOf(prop), text = m.text;
  const next = props[i + 1], prev = props[i - 1];
  const p = m.skipWs(prop.end);
  const comma = text[p] === ',';
  const afterComma = comma ? p + 1 : prop.end;
  const ownStart = /^[ \t]*$/.test(text.slice(m.lineStart(prop.start), prop.start));
  const ownEnd = /^[ \t]*$/.test(text.slice(afterComma, m.lineEnd(afterComma)));
  if (ownStart && ownEnd) {
    // whole lines, with the comment lines directly above
    let out = splice(text, commentsAbove(m, prop.start), Math.min(text.length, m.lineEnd(afterComma) + 1), '');
    if (!next && !comma && prev) {
      // the new last property keeps the no-trailing-comma style
      const q = m.skipWs(prev.end);
      if (out[q] === ',') out = splice(out, q, q + 1, '');
    }
    return out;
  }
  if (ownEnd && prev && m.lineStart(prev.end) === m.lineStart(prop.start)) return splice(text, prev.end, prop.end, '');  // "a, b: 1," -> "a,"
  if (next) return splice(text, prop.start, next.start, '');      // "a: 1, b" -> "b"
  if (prev) return splice(text, prev.end, prop.end, '');          // "{ a, b: 1 }" -> "{ a }"
  return splice(text, obj.start, obj.end, '{}');
}

// an array element's text chunk: whole lines (with the comment lines above) when it sits on its own lines
function chunk(m, arr, idx) {
  const el = arr.elements[idx], text = m.text;
  let p = m.skipWs(el.end);
  const comma = text[p] === ',';
  if (comma) p = m.skipWs(p + 1);
  const ownStart = /^[ \t]*$/.test(text.slice(m.lineStart(el.start), el.start));
  const ownEnd = text[p] === '\n' || p >= text.length || (text[p] === '/' && text[p + 1] === '/');
  if (ownStart && ownEnd) return { line: true, start: commentsAbove(m, el.start), end: Math.min(text.length, m.lineEnd(p) + 1), comma };
  return { line: false, start: el.start, end: el.end, comma };
}

// -> {text, piece, line, comma, elEnd (the element's end inside piece)}
function removeElement(m, arr, idx) {
  const text = m.text, els = arr.elements;
  const c = chunk(m, arr, idx);
  if (c.line) {
    let out = splice(text, c.start, c.end, '');
    if (!c.comma && idx > 0) {
      // the new last element had a comma only because this one followed
      const q = m.skipWs(els[idx - 1].end);
      if (out[q] === ',') out = splice(out, q, q + 1, '');
    }
    return { text: out, piece: text.slice(c.start, c.end), line: true, comma: c.comma, elEnd: els[idx].end - c.start };
  }
  const piece = text.slice(els[idx].start, els[idx].end);
  if (idx + 1 < els.length) return { text: splice(text, els[idx].start, els[idx + 1].start, ''), piece, line: false };
  if (idx > 0) return { text: splice(text, els[idx - 1].end, els[idx].end, ''), piece, line: false };
  return { text: splice(text, els[idx].start, els[idx].end, ''), piece, line: false };
}

// cut = {piece, line, comma, elEnd} from removeElement (or a new formatted element)
function insertElement(m, arr, idx, cut) {
  const text = m.text, els = arr.elements;
  let piece = cut.piece;
  if (cut.line && els.length) {
    if (!cut.comma) piece = piece.slice(0, cut.elEnd) + ',' + piece.slice(cut.elEnd);
    if (!piece.endsWith('\n')) piece += '\n';
    if (idx < els.length) {
      const c = chunk(m, arr, idx);
      if (c.line) return splice(text, c.start, c.start, piece);
    } else {
      const last = els[els.length - 1];
      const ls = m.lineStart(arr.end - 1);
      if (/^[ \t]*$/.test(text.slice(ls, arr.end - 1)) && ls > last.end) {    // "]" on its own line
        let out = splice(text, ls, ls, piece);
        if (text[m.skipWs(last.end)] !== ',') out = splice(out, last.end, last.end, ',');
        return out;
      }
    }
  }
  const val = cut.line ? piece.trim().replace(/,$/, '') : piece;
  if (!els.length) return splice(text, arr.start + 1, arr.end - 1, val);
  if (idx < els.length) return splice(text, els[idx].start, els[idx].start, val + ', ');
  return splice(text, els[els.length - 1].end, els[els.length - 1].end, ', ' + val);
}

// one edit on the text of module m -> new text (throws Locked / Missing / Conflict)
class Conflict extends Error { constructor(path, disk, expect) { super(`${path} changed on disk`); this.path = path; this.disk = disk; this.expect = expect; } }

function applyEdit(m, e) {
  const segs = parsePath(e.path);
  if ('expect' in e) {
    const disk = m.valueAt(segs);
    const want = e.expect;
    if (!(isMissing(want) ? isMissing(disk) : !isMissing(disk) && deepEqual(roundValue(disk), roundValue(want)))) throw new Conflict(e.path, disk, want);
  }
  const op = e.op || 'set';
  if (op === 'set') {
    const value = roundValue(e.value);
    const r = m.locate(segs);
    if (r.missing) {
      const key = segs[r.at].key;
      return insertProp(m, r.obj, key, nest(segs.slice(r.at), value));
    }
    if (r.code) throw new Locked(`${e.path} is code`);
    const cur = m.sval(r.node);
    if (hasCode(cur)) throw new Locked(`${e.path} holds code`);
    if (deepEqual(cur, value)) return m.text;               // no-op: bytes untouched
    return splice(m.text, r.node.start, r.node.end, fmt(value, ctxAt(m, r.node.start)));
  }
  if (op === 'del') {
    const r = m.locate(segs);
    if (r.missing) return m.text;
    if (r.array) throw new Error(`del on an array element (${e.path}): use remove`);
    return deleteProp(m, r.container, r.prop);
  }
  if (op === 'remove') {
    const r = m.locate(segs);
    if (!r.array) throw new Error(`remove needs an array element path (${e.path})`);
    return removeElement(m, r.array, r.index).text;
  }
  if (op === 'insert') {
    const r = m.locate(segs);
    if (r.missing || r.node.type !== 'ArrayExpression') throw new Error(`insert needs an array (${e.path})`);
    const arr = r.node, idx = Math.max(0, Math.min(e.index ?? arr.elements.length, arr.elements.length));
    const multi = arr.elements.length && chunk(m, arr, 0).line;
    const value = roundValue(e.value);
    // the first object into an empty list (a new room's objects: []): one element per line, like the rooms by hand
    if (!arr.elements.length && value && typeof value === 'object' && !Array.isArray(value)) {
      const ind = m.indentAt(arr.start), inner = ind + '  ';
      return splice(m.text, arr.start, arr.end, `[\n${inner}${fmt(value, { indent: inner, col: inner.length, prefix: m.prefix })},\n${ind}]`);
    }
    if (multi) {
      const ind = m.indentAt(arr.elements[0].start);
      const piece = ind + fmt(value, { indent: ind, col: ind.length, prefix: m.prefix });
      return insertElement(m, arr, idx, { piece: piece + ',\n', line: true, comma: true });
    }
    return insertElement(m, arr, idx, { piece: fmt(value, ctxAt(m, arr.start + 1)), line: false });
  }
  if (op === 'move') {
    const r = m.locate(segs);
    if (!r.array) throw new Error(`move needs an array element path (${e.path})`);
    const n = r.array.elements.length;
    const to = Math.max(0, Math.min(e.index, n - 1));
    if (to === r.index) return m.text;
    const cut = removeElement(m, r.array, r.index);
    const m2 = new Module(cut.text);
    const arr2 = m2.locate(segs.slice(0, -1)).node;
    return insertElement(m2, arr2, to, cut);
  }
  throw new Error('unknown op ' + op);
}

// the same edit on a model (for verification)
function applyModel(model, e) {
  const op = e.op || 'set';
  const segs = parsePath(e.path);
  if (op === 'set') {
    if (!setPath(model, segs, roundValue(e.value))) throw new Error('model: cannot set ' + e.path);
  } else if (op === 'del') setPath(model, segs, undefined);
  else if (op === 'remove') setPath(model, segs, undefined);
  else if (op === 'insert') {
    const arr = getPath(model, segs);
    arr.splice(Math.max(0, Math.min(e.index ?? arr.length, arr.length)), 0, roundValue(e.value));
  } else if (op === 'move') {
    const arr = getPath(model, segs.slice(0, -1));
    const i = elementIndex(arr, segs[segs.length - 1]);
    const [el] = arr.splice(i, 1);
    arr.splice(Math.max(0, Math.min(e.index, arr.length)), 0, el);
  }
}

function firstDiff(a, b, path = '') {
  if (deepEqual(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) { const d = firstDiff(a[k], b[k], path + (Array.isArray(a) ? `[${k}]` : '.' + k)); if (d) return d; }
  }
  return { path: path || '(root)', got: a, want: b };
}

// Applies edits (one at a time, re-parsing after each), then verifies the whole result.
export function patch(text, edits, { force = false } = {}) {
  const orig = new Module(text);
  const expected = clone(orig.model());
  let cur = text, m = orig;
  const applied = [], conflicts = [], errors = [];
  for (const e0 of edits) {
    const e = { ...e0 };
    if (force) delete e.expect;
    try {
      const out = applyEdit(m, e);
      applyModel(expected, e);
      applied.push({ path: e.path, op: e.op || 'set', changed: out !== cur });
      if (out !== cur) { cur = out; m = new Module(cur); }
    } catch (err) {
      if (err instanceof Conflict) conflicts.push({ path: err.path, disk: err.disk, expect: err.expect });
      else errors.push({ path: e.path, error: `${err.constructor.name}: ${err.message}` });
    }
  }
  let verify = { ok: true };
  if (conflicts.length || errors.length) verify = { ok: false, error: 'not applied' };
  else if (cur !== text) {
    try {
      const got = new Module(cur).model();
      const d = firstDiff(got, expected);
      if (d) verify = { ok: false, error: `model mismatch at ${d.path}`, got: d.got, want: d.want };
    } catch (err) { verify = { ok: false, error: 'reparse: ' + err.message }; }
  }
  return { text: cur, sha: sha(cur), changed: cur !== text, applied, conflicts, errors, verify };
}

// ------------------------------------------------------------------ dump: model + source lines
export function dump(text) {
  const m = new Module(text);
  const value = m.model();
  const loc = {};
  const walk = (node, path) => {
    if (!node) return;
    if (node.type === 'ObjectExpression') {
      for (const p of node.properties) {
        const k = propKey(p);
        if (k == null) continue;
        const pp = formatPath([...parsePath(path || ''), { key: k }]);
        loc[pp] = p.loc.start.line;
        if (p.kind === 'init' && !p.method) walk(p.value, pp);
      }
    } else if (node.type === 'ArrayExpression') {
      const vals = node.elements.map(e => e?.type === 'ObjectExpression' ? m.sval(e) : null);
      const ids = vals.map(v => v && typeof v.id === 'string' ? v.id : null);
      node.elements.forEach((e, i) => {
        if (!e) return;
        const unique = ids[i] != null && ids.indexOf(ids[i]) === ids.lastIndexOf(ids[i]);
        const pp = formatPath([...parsePath(path || ''), unique ? { id: ids[i] } : { index: i }]);
        loc[pp] = e.loc.start.line;
        walk(e, pp);
      });
    }
  };
  walk(m.root, '');
  return { sha: sha(text), value, loc };
}

// every path in a model value (containers and leaves), skipping code
export function paths(v, base = '', out = []) {
  if (v == null || typeof v !== 'object' || v.$fn != null || v.$opaque != null) return out;
  if (Array.isArray(v)) {
    const ids = v.map(x => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string' ? x.id : null);
    v.forEach((x, i) => {
      const unique = ids[i] != null && ids.indexOf(ids[i]) === ids.lastIndexOf(ids[i]);
      const p = formatPath([...parsePath(base || ''), unique ? { id: ids[i] } : { index: i }]);
      out.push(p); paths(x, p, out);
    });
  } else {
    for (const [k, x] of Object.entries(v)) {
      const p = formatPath([...parsePath(base || ''), { key: k }]);
      out.push(p); paths(x, p, out);
    }
  }
  return out;
}

// ------------------------------------------------------------------ self-test (EDITOR_PLAN.md §9)
function mutate(v) {
  if (typeof v === 'number') return v + 1;
  if (typeof v === 'string') return v + ' x';
  if (typeof v === 'boolean') return !v;
  if (Array.isArray(v)) return v.map(mutate);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mutate(x)]));
  return 1;
}

export function selftest(file) {
  const text = readFileSync(file, 'utf8');
  const res = { file, paths: 0, identity: 0, mutated: 0, deleted: 0, inserted: 0, moves: 0, restoreExact: 0, restoreModel: 0, failures: [] };
  const fail = (what, extra) => { if (res.failures.length < 20) res.failures.push({ what, ...extra }); };
  let d;
  try { d = dump(text); } catch (err) { fail('dump', { error: err.message }); return res; }
  if (d.value == null) return res;
  if (patch(text, []).text !== text) fail('empty patch changed bytes');
  const all = paths(d.value);
  res.paths = all.length;
  for (const p of all) {
    const cur = getPath(d.value, p);
    if (hasCode(cur)) continue;
    // load -> save without edits: byte-identical
    const r0 = patch(text, [{ op: 'set', path: p, value: cur, expect: cur }]);
    if (r0.text !== text) fail('identity set changed bytes', { path: p });
    else res.identity++;
    // a real change verifies (only that path changes)
    const r1 = patch(text, [{ op: 'set', path: p, value: mutate(cur) }]);
    if (!r1.verify.ok || r1.errors.length) { fail('mutated set', { path: p, verify: r1.verify, errors: r1.errors }); continue; }
    res.mutated++;
    // set back: model equal (bytes when the node was canonical); an id change moves the path
    if (parsePath(p).at(-1).key === 'id' || (cur && typeof cur === 'object' && !Array.isArray(cur) && 'id' in cur)) continue;
    const r2 = patch(r1.text, [{ op: 'set', path: p, value: cur }]);
    if (!r2.verify.ok || !deepEqual(new Module(r2.text).model(), d.value)) fail('set back', { path: p, verify: r2.verify });
    else if (r2.text === text) res.restoreExact++; else res.restoreModel++;
  }
  // stale expect -> conflict, nothing written
  const leaf = all.find(p => typeof getPath(d.value, p) === 'number');
  if (leaf) {
    const r = patch(text, [{ op: 'set', path: leaf, value: 1234, expect: getPath(d.value, leaf) + 99 }]);
    if (!r.conflicts.length || r.text !== text) fail('stale expect not a conflict', { path: leaf });
  }
  // property deletes + insert of missing fields, per object in arrays of objects
  for (const p of all) {
    const v = getPath(d.value, p);
    if (!v || typeof v !== 'object' || Array.isArray(v) || v.$fn != null || v.$opaque != null) continue;
    for (const k of Object.keys(v)) {
      const kp = formatPath([...parsePath(p), { key: k }]);
      const r = patch(text, [{ op: 'del', path: kp }]);
      if (!r.verify.ok || r.errors.length) fail('del', { path: kp, verify: r.verify, errors: r.errors });
      else res.deleted++;
    }
    if (typeof v.id === 'string') {
      for (const [k, val] of [['hotZ', 3], ['walkTo', [100, 400]], ['face', 'NW'], ['zzz', { a: [1, 2] }]]) {
        if (k in v) continue;
        const kp = formatPath([...parsePath(p), { key: k }]);
        const r = patch(text, [{ op: 'set', path: kp, value: val }]);
        if (!r.verify.ok || r.errors.length) fail('insert prop', { path: kp, verify: r.verify, errors: r.errors });
        else {
          res.inserted++;
          const back = patch(r.text, [{ op: 'del', path: kp }]);
          if (back.text !== text) fail('insert prop + del not byte-identical', { path: kp, diff: lineDiff(text, back.text) });
        }
      }
    }
  }
  // arrays of objects: move first to last and back (bytes), remove + insert (model)
  for (const p of all) {
    const v = getPath(d.value, p);
    if (!Array.isArray(v) || v.length < 2 || !v.every(x => x && typeof x === 'object' && !Array.isArray(x))) continue;
    const first = formatPath([...parsePath(p), typeof v[0].id === 'string' ? { id: v[0].id } : { index: 0 }]);
    const r1 = patch(text, [{ op: 'move', path: first, index: v.length - 1 }]);
    if (!r1.verify.ok || r1.errors.length) { fail('move', { path: first, verify: r1.verify, errors: r1.errors }); continue; }
    const moved = typeof v[0].id === 'string' ? first : formatPath([...parsePath(p), { index: v.length - 1 }]);
    const r2 = patch(r1.text, [{ op: 'move', path: moved, index: 0 }]);
    if (r2.text !== text) fail('move + move back not byte-identical', { path: first, diff: lineDiff(text, r2.text) });
    else res.moves++;
    const r3 = patch(text, [{ op: 'remove', path: first }]);
    const r4 = r3.verify.ok ? patch(r3.text, [{ op: 'insert', path: p, index: 0, value: v[0] }]) : null;
    if (!r3.verify.ok || !r4 || r4.errors.length || !r4.verify.ok) {
      // elements holding functions can't be re-inserted from a model value: only check the removal
      if (!r3.verify.ok) fail('remove', { path: first, verify: r3.verify, errors: r3.errors });
      else if (!hasCode(v[0])) fail('insert', { path: p, verify: r4?.verify, errors: r4?.errors });
    }
  }
  return res;
}

function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) return { line: i + 1, was: A[i], now: B[i] };
  return null;
}

// ------------------------------------------------------------------ CLI
function parseSet(s) {
  // the first '=' outside [..] path selectors (values may be arrays: scale=[[360,0.7],[480,1]])
  let i = -1;
  for (let k = 0, depth = 0; k < s.length && i < 0; k++) {
    if (s[k] === '[') depth++;
    else if (s[k] === ']') depth--;
    else if (s[k] === '=' && depth === 0) i = k;
  }
  const path = s.slice(0, i), raw = s.slice(i + 1);
  let value;
  try { value = JSON.parse(raw); } catch { value = raw; }
  return { op: 'set', path, value };
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const out = o => process.stdout.write(JSON.stringify(o) + '\n');
  if (cmd === 'dump') {
    out(dump(readFileSync(args[0], 'utf8')));
  } else if (cmd === 'patch') {
    const file = args[0];
    const sets = [];
    for (let i = 1; i < args.length; i++) if (args[i] === '--set') sets.push(parseSet(args[++i]));
    let edits = sets;
    if (!sets.length) {
      const input = JSON.parse(readFileSync(0, 'utf8') || '[]');
      edits = Array.isArray(input) ? input : input.edits || [];
      if (input.force) args.push('--force');
    }
    const text = readFileSync(file, 'utf8');
    const r = patch(text, edits, { force: args.includes('--force') });
    if (args.includes('--write')) {
      const ok = r.verify.ok && !r.conflicts.length && !r.errors.length;
      if (ok && r.changed) {
        const tmp = join(dirname(file), '.' + basename(file) + '.tmp');
        writeFileSync(tmp, r.text);
        renameSync(tmp, file);
      }
      const { text: _, ...rest } = r;
      out(rest);
      process.exit(ok ? 0 : 1);
    }
    out(r);
  } else if (cmd === 'selftest') {
    let bad = 0;
    for (const f of args) {
      const r = selftest(f);
      if (r.failures.length) bad++;
      out(r);
    }
    process.exit(bad ? 1 : 0);
  } else {
    process.stderr.write('usage: roomsrc.mjs dump|patch|selftest <file...>\n');
    process.exit(2);
  }
}

// run as a CLI (compare real paths: a URL has %20 for spaces and file:///C:/ on Windows, and Node resolves symlinks
// in the module's path but not in argv, e.g. for files under macOS's /tmp)
const realPath = p => { try { return realpathSync(p); } catch (err) { return pathResolve(p); } };
if (process.argv[1] && realPath(fileURLToPath(import.meta.url)) === realPath(process.argv[1])) main();
