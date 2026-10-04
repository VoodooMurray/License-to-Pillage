// Game module edits that are code, not values, for the level editor's project tools (tools/serve.py): adding a
// room to a game (an import line + the identifier in the game's `rooms: [...]` array). Value edits of game.js
// (items, actors, title...) go through roomsrc.mjs patch, which reads game.js the same way it reads rooms.
//
//   node tools/js/gamesrc.mjs add-room games/<id>/game.js <room id>   -> {text, ident} (stdout JSON; --write writes)
//   node tools/js/gamesrc.mjs rooms games/<id>/game.js                -> {rooms: [{ident, file}]}

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, basename } from 'node:path';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const parse = text => acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', ranges: true });

// the game object: `export default {...}` or `export default game` with a top-level `const game = {...}`
function gameObject(ast) {
  const ex = ast.body.find(n => n.type === 'ExportDefaultDeclaration');
  if (!ex) throw new Error('no default export');
  let d = ex.declaration;
  if (d.type === 'Identifier') {
    for (const n of ast.body) {
      if (n.type !== 'VariableDeclaration') continue;
      for (const v of n.declarations) if (v.id.name === d.name) d = v.init;
    }
  }
  if (d?.type !== 'ObjectExpression') throw new Error('the default export is not an object literal');
  return d;
}

function prop(obj, key) {
  return obj.properties.find(p => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === key);
}

// imported room modules: ident -> './rooms/x.js'
function imports(ast) {
  const out = new Map();
  for (const n of ast.body) {
    if (n.type === 'ImportDeclaration') for (const s of n.specifiers) out.set(s.local.name, n.source.value);
  }
  return out;
}

function topNames(ast) {
  const names = new Set(imports(ast).keys());
  for (const n of ast.body) {
    if (n.type === 'VariableDeclaration') for (const v of n.declarations) if (v.id.type === 'Identifier') names.add(v.id.name);
    if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') names.add(n.id.name);
  }
  return names;
}

export function rooms(text) {
  const ast = parse(text);
  const arr = prop(gameObject(ast), 'rooms')?.value;
  if (arr?.type !== 'ArrayExpression') throw new Error('rooms is not an array literal');
  const imp = imports(ast);
  return arr.elements.map(el => ({ ident: el.type === 'Identifier' ? el.name : null, file: el.type === 'Identifier' ? imp.get(el.name) || null : null }));
}

export function addRoom(text, roomId) {
  if (!/^[a-z][a-z0-9_]*$/.test(roomId)) throw new Error('room ids are lower case letters, digits and _, starting with a letter');
  const ast = parse(text);
  const file = `./rooms/${roomId}.js`;
  if ([...imports(ast).values()].includes(file)) throw new Error(`${file} is already imported`);
  const names = topNames(ast);
  let ident = roomId;
  for (let i = 2; names.has(ident) || RESERVED.has(ident); i++) ident = `${roomId}_room${i > 2 ? i : ''}`;
  const arr = prop(gameObject(ast), 'rooms')?.value;
  if (arr?.type !== 'ArrayExpression') throw new Error('rooms is not an array literal');
  // 1. the array element (later in the file, so first: earlier offsets stay valid)
  let out = text;
  const els = arr.elements;
  if (els.length) {
    const last = els[els.length - 1];
    out = out.slice(0, last.end) + ', ' + ident + out.slice(last.end);
  } else {
    out = out.slice(0, arr.start + 1) + ident + out.slice(arr.end - 1);
  }
  // 2. the import, after the last import (or at the top, after the leading comment block)
  const lastImp = [...ast.body].reverse().find(n => n.type === 'ImportDeclaration');
  const line = `import ${ident} from '${file}';`;
  if (lastImp) out = out.slice(0, lastImp.end) + '\n' + line + out.slice(lastImp.end);
  else {
    const first = ast.body[0];
    out = out.slice(0, first.start) + line + '\n\n' + out.slice(first.start);
  }
  // verify: parses, and the rooms list gained exactly this room
  const after = rooms(out);
  if (after.length !== els.length + 1 || after[after.length - 1].file !== file) throw new Error('verify failed');
  return { text: out, ident };
}

const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return',
  'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
  'enum', 'await', 'game', 'g']);

function main() {
  const [cmd, file, arg] = process.argv.slice(2);
  const text = readFileSync(file, 'utf8');
  let r;
  if (cmd === 'rooms') r = { rooms: rooms(text) };
  else if (cmd === 'add-room') {
    r = addRoom(text, arg);
    if (process.argv.includes('--write')) {
      const tmp = join(dirname(file), '.' + basename(file) + '.tmp');
      writeFileSync(tmp, r.text);
      renameSync(tmp, file);
    }
  } else throw new Error('usage: gamesrc.mjs add-room|rooms <game.js> [room id] [--write]');
  process.stdout.write(JSON.stringify(r));
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  try { main(); } catch (err) { process.stdout.write(JSON.stringify({ error: err.message })); process.exit(1); }
}
