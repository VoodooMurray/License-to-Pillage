// Extracts every spoken line from the game scripts (game/**/*.js) with its speaker, for voice
// recording and translation. Output: JSON [{speaker, text, file, line}] on stdout.
//   node tools/js/lines.mjs > game/lines.json
//   node tools/js/lines.mjs games/<key> > games/<key>/lines.json     (a level-editor project)
//
// Rules: g.say('who', 'text') -> who; g.say('text') -> player; handler strings/arrays under
// verb keys (look/hand/mouth/use map values, item and object defs, defaults) -> player;
// g.choose([{text}]) options -> player unless say: false; form.js QUESTIONS answers/comments -> player;
// scripts as data (engine/steps.js): { say, who? } steps -> who or player, dialogue options' text -> player.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));     // (not .pathname: Windows drive letters, %20)
const BASE = process.argv[2] ? process.cwd() : ROOT;          // a project path is taken from the current dir
const GAME = resolve(BASE, process.argv[2] || 'game');
// the player speaks all unattributed lines; game.js names them (player: '...'), Guybrush by default
let PLAYER = 'guybrush';
try { PLAYER = readFileSync(join(GAME, 'game.js'), 'utf8').match(/\bplayer:\s*['"]([a-z0-9_]+)['"]/)?.[1] || PLAYER; } catch { /* keep the default */ }
const STEP_LISTS = new Set(['do', 'then', 'else', 'hello', 'again']);
const keyOf = p => p && p.type === 'Property' ? (p.key?.name ?? p.key?.value) : null;
const VERB_KEYS = new Set(['look', 'hand', 'mouth', 'use', 'push', 'talk', 'give', 'combine', 'lookItem', 'handItem', 'mouthItem']);

function files(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (n.endsWith('.js')) out.push(p);
  }
  return out;
}

const str = n => (n && n.type === 'Literal' && typeof n.value === 'string') ? n.value
  : (n && n.type === 'TemplateLiteral' && n.expressions.length === 0) ? n.quasis[0].value.cooked : null;

const lines = [];
const seen = new Set();
function add(speaker, text, file, node) {
  if (!text || !text.trim()) return;
  const key = speaker + '\u0000' + text;
  if (seen.has(key)) return;
  seen.add(key);
  lines.push({ speaker, text, file: relative(BASE, file), line: node.loc.start.line });
}

for (const f of files(GAME)) {
  const src = readFileSync(f, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  walk.ancestor(ast, {
    CallExpression(node) {
      const c = node.callee;
      const name = c.type === 'MemberExpression' ? c.property.name : c.name;
      if (name === 'say') {
        const a0 = str(node.arguments[0]), a1 = str(node.arguments[1]);
        const second = node.arguments[1];
        const dynamicLine = second && second.type !== 'ObjectExpression' && a1 === null;   // g.say('who', expr): can't voice
        if (a0 !== null && a1 !== null) add(a0, a1, f, node);
        else if (a0 !== null && !dynamicLine) add(PLAYER, a0, f, node);
        else if (node.arguments[0]?.type === 'ArrayExpression') {
          for (const el of node.arguments[0].elements) if (str(el) !== null) add(PLAYER, str(el), f, el);
        }
      } else if (name === 'choose' && node.arguments[0]?.type === 'ArrayExpression') {
        for (const el of node.arguments[0].elements) {
          const obj = el && (el.type === 'LogicalExpression' ? el.right : el);
          if (!obj || obj.type !== 'ObjectExpression') continue;
          const props = Object.fromEntries(obj.properties.filter(p => p.key).map(p => [p.key.name, p.value]));
          if (props.say && props.say.type === 'Literal' && props.say.value === false) continue;
          if (str(props.text) !== null) add(PLAYER, str(props.text), f, obj);
        }
      }
    },
    Property(node, ancestors) {
      const key = node.key && (node.key.name ?? node.key.value);
      // data steps: [..., { say: 'text', who? }, ...] in do/then/else/hello/again lists; dialogue options' text
      const n = ancestors.length, obj = ancestors[n - 2], arr = ancestors[n - 3], list = ancestors[n - 4];
      if (obj?.type === 'ObjectExpression' && arr?.type === 'ArrayExpression') {
        const props = Object.fromEntries(obj.properties.filter(p => p.key).map(p => [p.key.name ?? p.key.value, p.value]));
        if (key === 'say' && STEP_LISTS.has(keyOf(list)) && str(node.value) !== null) add(str(props.who) || PLAYER, str(node.value), f, node);
        if (key === 'text' && keyOf(list) === 'options' && str(node.value) !== null && !(props.say?.type === 'Literal' && props.say.value === false)) add(PLAYER, str(node.value), f, node);
      }
      // verb labels (verbs: { hand: 'pick up' }) are not spoken
      if (ancestors.some(a => a.type === 'Property' && (a.key?.name ?? a.key?.value) === 'verbs')) return;
      // handler strings: look: "...", hand: [...], and use-maps { item: "..." }
      const parentProp = ancestors.slice(0, -1).reverse().find(a => a.type === 'Property');
      const inVerbMap = parentProp && VERB_KEYS.has(parentProp.key?.name ?? parentProp.key?.value) && parentProp !== node;
      if (VERB_KEYS.has(key) || inVerbMap) {
        const v = node.value;
        if (str(v) !== null) add(PLAYER, str(v), f, node);
        else if (v.type === 'ArrayExpression') for (const el of v.elements) if (str(el) !== null) add(PLAYER, str(el), f, el);
      }
    },
    VariableDeclarator(node) {
      // form.js: const QUESTIONS = [{ q, a: [[text, comment], ...] }]
      if (node.id.name !== 'QUESTIONS' || node.init?.type !== 'ArrayExpression') return;
      for (const q of node.init.elements) {
        const a = q.properties.find(p => p.key.name === 'a');
        for (const pair of a.value.elements) for (const el of pair.elements) if (str(el) !== null) add(PLAYER, str(el), f, el);
      }
    },
  });
}

process.stdout.write(JSON.stringify(lines, null, 1) + '\n');
const by = {};
for (const l of lines) by[l.speaker] = (by[l.speaker] || 0) + 1;
process.stderr.write(`${lines.length} lines: ${JSON.stringify(by)}\n`);
