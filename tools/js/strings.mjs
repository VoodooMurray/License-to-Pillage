// Every player-visible text of a game, for translation (game/lang/<code>.json, tools/lang.py):
// the spoken lines (lines.mjs) plus what is shown but not spoken: names of objects, items and
// characters, verb-coin labels (verbs: { hand: 'pick up' }), form questions (q:), card / caption texts.
// Output: JSON [{text, kind: 'line'|'name'|'verb'|'text', speaker?, file, line}] on stdout.
//   node tools/js/strings.mjs > /tmp/strings.json
//   node tools/js/strings.mjs games/<key>                (a level-editor project)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));     // (a URL's pathname has %20 and /C:/)
const BASE = process.argv[2] ? process.cwd() : ROOT;
const GAME = resolve(BASE, process.argv[2] || 'game');

const out = [];
const seen = new Set();
function add(kind, text, file, node, speaker) {
  if (!text || !text.trim() || seen.has(text)) return;
  seen.add(text);
  out.push({ text, kind, ...(speaker ? { speaker } : {}), file: relative(BASE, file), line: node.loc.start.line });
}

const lines = JSON.parse(execFileSync('node', [join(ROOT, 'tools/js/lines.mjs'), ...process.argv.slice(2)],
  { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }));
for (const l of lines) add('line', l.text, join(BASE, l.file), { loc: { start: { line: l.line } } }, l.speaker);

function files(dir) {
  const r = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) r.push(...files(p));
    else if (n.endsWith('.js')) r.push(p);
  }
  return r;
}
const str = n => (n && n.type === 'Literal' && typeof n.value === 'string') ? n.value
  : (n && n.type === 'TemplateLiteral' && n.expressions.length === 0) ? n.quasis[0].value.cooked : null;
// the texts an expression can produce: cond ? 'a' : 'b', x || 'a', g => (...)
const leaves = n => !n ? [] : str(n) !== null ? [str(n)]
  : n.type === 'ConditionalExpression' ? [...leaves(n.consequent), ...leaves(n.alternate)]
  : n.type === 'LogicalExpression' ? leaves(n.right)
  : n.type === 'ArrowFunctionExpression' && n.body.type !== 'BlockStatement' ? leaves(n.body) : [];
const keyOf = p => p && p.type === 'Property' ? (p.key?.name ?? p.key?.value) : null;

const choices = new Set();      // dialogue choices: one line each on screen, so length matters
for (const f of files(GAME)) {
  const ast = acorn.parse(readFileSync(f, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  walk.ancestor(ast, {
    Property(node, anc) {
      const key = keyOf(node), v = str(node.value);
      if (key === 'name' && v === null) for (const n of leaves(node.value)) add('name', n, f, node);   // name: g => ...
      if (v === null) return;
      const parent = anc[anc.length - 3];       // the Property holding this one's object
      if (key === 'text' && (keyOf(anc[anc.length - 4]) === 'options' || anc.some(a => a.type === 'CallExpression' && a.callee.property?.name === 'choose'))) choices.add(v);
      if (keyOf(parent) === 'verbs') add('verb', v, f, node);
      else if (key === 'name' && !/^[\w./-]*[_/.][\w./-]*$/.test(v)) add('name', v, f, node);     // not ids or file names
      else if (key === 'q' || key === 'caption') add('text', v, f, node);
      else if (key === 'text' && !seen.has(v)) add('text', v, f, node);
    },
    VariableDeclarator(node) {
      // form.js: const QUESTIONS = [{ q, a: [[answer, comment], ...] }]: the answers are choices
      if (node.id.name !== 'QUESTIONS' || node.init?.type !== 'ArrayExpression') return;
      for (const q of node.init.elements) for (const pair of q.properties.find(p => keyOf(p) === 'a').value.elements) choices.add(str(pair.elements[0]));
    },
    CallExpression(node) {
      const c = node.callee, name = c.type === 'MemberExpression' ? c.property.name : c.name;
      if (name === 'choose' && node.arguments[0]?.type === 'ArrayExpression') for (const el of node.arguments[0].elements) if (str(el) !== null) choices.add(str(el));
      if (name === 'caption' && str(node.arguments[0]) !== null) add('text', str(node.arguments[0]), f, node);
      // g.say(who, cond ? 'a' : 'b') / g.say(cond ? 'a' : 'b'): lines.mjs only reads plain strings
      if (name === 'say') for (const a of node.arguments.slice(0, 2)) if (str(a) === null) for (const t of leaves(a)) add('line', t, f, node);
    },
  });
}

for (const s of out) if (choices.has(s.text)) s.choice = true;
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
const by = {};
for (const s of out) by[s.kind] = (by[s.kind] || 0) + 1;
process.stderr.write(`${out.length} strings: ${JSON.stringify(by)}\n`);
