// Prints the ESTree AST (acorn) of the given ES module files as one JSON object {path: ast}.
// Used by tools/scumm/jsgame.py to read the web game's rooms/scripts (single source of truth).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const out = {};
for (const path of process.argv.slice(2)) {
  const src = readFileSync(path, 'utf8');
  out[path] = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
}
process.stdout.write(JSON.stringify(out));
