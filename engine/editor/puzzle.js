// The puzzle chart: what can be done in which order, read from the game's scripts. Every handler (look / use /
// talk..., items used on hotspots and characters, conversation options, item combinations, room and game scripts)
// is an action that needs facts (being in a room, carrying an item, a flag, an object shown) and makes facts (gives an
// item, sets a flag, shows an object, goes to a room). Starting from the game's start, actions whose needs are met
// fire, round by round, until nothing new happens: an action's round is its column in the chart, its needs are the
// edges from the actions that first made them. What never happens is a problem (an item needed that nobody gives, a
// flag checked that is never set, a room nothing leads to).
//
// Data scripts ({ do: [steps] }, dialogue trees) are read exactly (an "if"'s needs only hold for its branch; "if not"
// and "only once" are assumed to pass). Hand-written code is read from its source text: its g.give / g.set /
// g.show / g.goto calls happen as soon as it can run (its own ifs are not followed), and calls in other functions
// it uses are not seen.

const VERBS = { look: 'Look at', hand: 'Use', mouth: 'Talk to', push: 'Push', talk: 'Talk' };
const CODE = {
  flag: /(!\s*)?\bg\.flag\(\s*['"](\w+)['"]/g,
  has: /(!\s*)?\bg\.has\(\s*['"](\w+)['"]/g,
};
const CALL = /^g\.(give|take|set|show|goto|swap)\(\s*['"](\w+)['"](?:\s*,\s*(?:['"](\w+)['"]|(false|0|null)))?/;

// facts: room:<id>, item:<id>, flag:<id>, shown:<room>.<object>
export const factKind = f => f.slice(0, f.indexOf(':'));
export const factId = f => f.slice(f.indexOf(':') + 1);

// what a function's source needs (positive g.flag / g.has: for `when` conditions; with item ids, also
// `item === 'x'` in a handler for any item: use: { '*': (g, item) => ... })
function reads(src, items) {
  src = String(src);
  const out = [];
  for (const m of src.matchAll(CODE.flag)) if (!m[1]) out.push('flag:' + m[2]);
  for (const m of src.matchAll(CODE.has)) if (!m[1]) out.push('item:' + m[2]);
  if (items) for (const m of src.matchAll(/[\w$\]]\s*===?\s*['"](\w+)['"]/g)) if (items.has(m[1])) out.push('item:' + m[1]);
  return out;
}

// the named imports of a module: [{local, name, from}]
function imports(text) {
  const out = [];
  for (const m of String(text).matchAll(/^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
    for (const part of m[1].split(',')) {
      const [name, local] = part.trim().split(/\s+as\s+/);
      if (name) out.push({ local: local || name, name, from: m[2] });
    }
  }
  return out;
}

const resolve = (base, rel) => new URL(rel, 'http://m/' + base).pathname.slice(1);

// skips a string / template / comment starting at i; returns the index after it (or i if there is none)
function skip(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); return j < 0 ? src.length : j; }
  if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); return j < 0 ? src.length : j + 2; }
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1, depth = 0;
    while (j < src.length) {
      const d = src[j];
      if (d === '\\') { j += 2; continue; }
      if (c === '`' && d === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
      if (c === '`' && depth && d === '}') { depth--; j++; continue; }
      if (d === c && !depth) return j + 1;
      j++;
    }
    return src.length;
  }
  return i;
}

// the index after the brace that closes the one at `open`
function closing(src, open) {
  let depth = 0;
  for (let i = open; i < src.length;) {
    const j = skip(src, i);
    if (j !== i) { i = j; continue; }
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i + 1;
    i++;
  }
  return src.length;
}

// the module-level functions of a module's text: name -> source (function declarations and const arrows)
export function moduleFunctions(text) {
  const out = new Map();
  if (!text) return out;
  const re = /^(?:export\s+)?(?:(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^{]*|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*))/gm;
  for (const m of text.matchAll(re)) {
    const at = m.index + m[0].length;
    if (text[at] === '{') out.set(m[1] || m[2], text.slice(m.index, closing(text, at)));
    else if (m[2]) { const eol = text.indexOf('\n', at); out.set(m[2], text.slice(m.index, eol < 0 ? text.length : eol)); }
  }
  return out;
}

// Hand-written code, read from its text: each g.give / g.take / g.set / g.show / g.goto / g.swap call with the
// positive g.has / g.flag of the ifs around it (an else, a "not" or an early return are not followed: they pass),
// and the module-level functions it calls (helpers: their calls with the call site's ifs added).
export class CodeReader {
  // modules: key -> {text, path} (the game's files: 'game', room ids, imported files by path); items: the item ids
  constructor(modules, items) { this.modules = modules || new Map(); this.items = items || new Set(); this.fns = new Map(); }

  // the functions a module's code can call: its own, and the ones it imports by name
  helpers(mod) {
    if (this.fns.has(mod)) return this.fns.get(mod);
    const m = this.modules.get(mod), out = new Map();
    this.fns.set(mod, out);
    if (!m) return out;
    for (const [name, src] of moduleFunctions(m.text)) out.set(name, { src, mod });
    for (const imp of imports(m.text)) {
      const key = resolve(m.path, imp.from), t = this.modules.get(key);
      const src = t && moduleFunctions(t.text).get(imp.name);
      if (src) out.set(imp.local, { src, mod: key });
    }
    return out;
  }

  read(src, room, mod, conds = [], seen = new Set(), out = { effects: [], uses: [], reads: new Set() }) {
    src = String(src);
    const helpers = this.helpers(mod), stack = [], items = this.items;
    for (const f of reads(src, items)) out.reads.add(f);
    let from = 0, inline = null;          // inline: an if without braces ({conds, depth}), until its statement ends
    const isIf = h => /^\s*(?:else\s+)?if\s*\(/.test(h);
    const here = () => [...conds, ...stack.flatMap(h => isIf(h) ? reads(h, items) : []), ...(inline ? inline.conds : [])];
    for (let i = 0; i < src.length;) {
      const j = skip(src, i);
      if (j !== i) { i = j; continue; }
      const c = src[i];
      if (c === '{') { stack.push(src.slice(from, i)); from = i + 1; }
      else if (c === '}') { stack.pop(); from = i + 1; if (inline && stack.length < inline.depth) inline = null; }
      else if (c === ';') { from = i + 1; if (inline && stack.length === inline.depth) inline = null; }
      else if (c === 'i' && src[i + 1] === 'f' && !/[\w$.]/.test(src[i - 1] || '') && /^if\s*\(/.test(src.slice(i, i + 8))) {
        // the condition's parentheses; no brace after them: it holds for the next statement only
        let k = src.indexOf('(', i), depth = 0;
        for (; k < src.length;) {
          const q = skip(src, k);
          if (q !== k) { k = q; continue; }
          if (src[k] === '(') depth++;
          else if (src[k] === ')' && --depth === 0) break;
          k++;
        }
        const rest = src.slice(k + 1).match(/^\s*/)[0].length;
        if (src[k + 1 + rest] !== '{') inline = { conds: reads(src.slice(i, k + 1), items), depth: stack.length };
        i += 2;
        continue;
      }
      else if (c === 'g' && src[i + 1] === '.' && !/[\w$.]/.test(src[i - 1] || '')) {
        const m = CALL.exec(src.slice(i, i + 120));
        if (m) {
          const [, op, a, b, off] = m, cs = here();
          if (op === 'give') out.effects.push({ fact: 'item:' + a, kind: 'give', conds: cs });
          else if (op === 'take') out.uses.push('item:' + a);
          else if (op === 'set' && !off) out.effects.push({ fact: 'flag:' + a, kind: 'set', conds: cs });
          else if (op === 'show') out.effects.push({ fact: `shown:${b || room}.${a}`, kind: 'show', conds: cs });
          else if (op === 'goto') out.effects.push({ fact: 'room:' + a, kind: 'goto', conds: cs });
          else if (op === 'swap' && b) { out.uses.push('item:' + a); out.effects.push({ fact: 'item:' + b, kind: 'give', conds: cs }); }
          i += m[0].length;
          continue;
        }
      } else if (/[A-Za-z_$]/.test(c) && !/[\w$.]/.test(src[i - 1] || '')) {
        const m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(i, i + 80));
        if (m && helpers.has(m[1]) && !seen.has(mod + ':' + m[1])) {
          seen.add(mod + ':' + m[1]);
          const h = helpers.get(m[1]);
          this.read(h.src, room, h.mod, here(), seen, out);
        }
        const w = /^[\w$]+/.exec(src.slice(i))[0];
        i += w.length;
        continue;
      }
      i++;
    }
    return out;
  }
}

// a hand-written function: its effects (first of each fact) and what it reads
function codeEffects(fn, room, reader, mod) {
  const r = reader.read(fn, room, mod), seen = new Set();
  const effects = r.effects.filter(ef => !seen.has(ef.fact) && seen.add(ef.fact));
  return { effects, uses: [...new Set(r.uses)], reads: [...r.reads] };
}

// data steps: effects with the needs of their branch; conversations started by talk steps
function stepEffects(steps, conds, out, ctx) {
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== 'object') continue;
    if (s.give) out.effects.push({ fact: 'item:' + s.give, kind: 'give', conds });
    else if (s.take) out.uses.push('item:' + s.take);
    else if (s.set) out.effects.push({ fact: 'flag:' + s.set, kind: 'set', conds });
    else if (s.show) out.effects.push({ fact: `shown:${s.room || ctx.room}.${s.show}`, kind: 'show', conds });
    else if (s.goto) out.effects.push({ fact: 'room:' + s.goto, kind: 'goto', conds });
    else if (s.talk) out.talks.push({ id: s.talk, conds });
    if (s.then || s.else) {
      const c = s.if ? ['flag:' + s.if] : s.ifHas ? ['item:' + s.ifHas] : [];
      stepEffects(s.then, [...conds, ...c], out, ctx);
      stepEffects(s.else, conds, out, ctx);
    }
  }
  return out;
}

const optConds = o => [...(o.if ? ['flag:' + o.if] : []), ...(o.ifHas ? ['item:' + o.ifHas] : [])];

// every action of the game
export function collect(e, opening, reader = new CodeReader()) {
  const game = e.game, actions = [], exits = [];
  const name = (v, id) => typeof v === 'string' ? v : id;
  const itemName = id => name(game.items?.[id]?.name, id);
  const push = a => { a.n = actions.length; actions.push(a); return a; };

  // one handler -> actions (a data handler's conversations become one action per option)
  const handler = (h, info, requires) => {
    if (h == null || typeof h === 'string' || Array.isArray(h)) return;
    if (typeof h === 'function') {
      const c = codeEffects(h, info.room, reader, info.room || 'game');
      if (c.effects.length || c.uses.length) push({ ...info, requires, ...c, code: true });
      return;
    }
    if (!Array.isArray(h.do)) return;
    const out = stepEffects(h.do, [], { effects: [], uses: [], talks: [] }, info);
    if (out.effects.length || out.uses.length) push({ ...info, requires, effects: out.effects, uses: out.uses, reads: [] });
    for (const t of out.talks) dialogue(t.id, info, [...requires, ...t.conds]);
  };
  const dialogue = (id, info, requires) => {
    const room = info.room && e.rooms.get(info.room);
    const tree = room?.def.dialogues?.[id] ?? game.dialogues?.[id];
    if (!tree || typeof tree !== 'object') return;
    const greet = stepEffects([...(tree.hello || []), ...(tree.again || [])], [], { effects: [], uses: [], talks: [] }, info);
    if (greet.effects.length) push({ ...info, label: `${info.who}: greeting`, requires, effects: greet.effects, uses: greet.uses, reads: [] });
    (tree.options || []).forEach((o, i) => {
      if (!o || typeof o !== 'object') return;
      const out = stepEffects(o.do, [], { effects: [], uses: [], talks: [] }, info);
      if (out.effects.length || out.uses.length || optConds(o).length) {
        push({ ...info, dialogue: id, option: i, label: `${info.who}: “${o.text || '…'}”`, requires: [...requires, ...optConds(o)], effects: out.effects, uses: out.uses, reads: [] });
      }
    });
  };
  const handlers = (d, info, gate) => {
    for (const [v, label] of Object.entries(VERBS)) if (d[v] != null) handler(d[v], { ...info, verb: v, label: `${label} ${info.name}` }, gate);
    if (d.use && typeof d.use === 'object') {
      for (const [it, h] of Object.entries(d.use)) {
        // any item: a hand-written one may branch on the item (item === 'x': that branch needs it)
        if (it === '*') { if (typeof h === 'function') handler(h, { ...info, verb: 'use', item: '*', label: info.kind === 'npc' ? `Give things to ${info.name}` : `Use things on ${info.name}` }, gate); continue; }
        handler(h, { ...info, verb: 'use', item: it, label: info.kind === 'npc' ? `Give ${itemName(it)} to ${info.name}` : `Use ${itemName(it)} on ${info.name}` }, [...gate, 'item:' + it]);
      }
    }
  };

  for (const r of e.rooms.values()) {
    const def = r.def, base = ['room:' + r.id];
    for (const o of def.objects || []) {
      if (!o?.id) continue;
      const gate = [...base];
      if (o.hidden === true) gate.push(`shown:${r.id}.${o.id}`);
      if (o.edition) gate.push('flag:' + o.edition);
      if (typeof o.when === 'function') gate.push(...reads(o.when));
      const info = { room: r.id, kind: 'object', id: o.id, name: name(o.name, o.id) };
      if (o.exit && typeof o.exit === 'object' && o.exit.room) {
        exits.push({ ...info, to: o.exit.room, requires: [...gate, ...(typeof o.exit.when === 'function' ? reads(o.exit.when) : [])] });
      }
      handlers(o, { ...info, who: info.name }, gate);
    }
    for (const [id, n] of Object.entries(def.npcs || {})) {
      if (!n || typeof n !== 'object') continue;
      const place = def.actors?.[id], gate = [...base];
      if (place && typeof place.when === 'function') gate.push(...reads(place.when));
      const who = n.name || game.actors?.[id]?.name || id;
      handlers(n, { room: r.id, kind: 'npc', id, name: who, who }, gate);
    }
    // the room's own code (enter, cutscenes...)
    for (const [k, v] of Object.entries(def)) {
      if (typeof v === 'function') handler(v, { room: r.id, kind: 'room', id: k, name: k, label: `${r.id}: ${k}` }, base);
    }
  }
  for (const [id, it] of Object.entries(game.items || {})) {
    if (!it || typeof it !== 'object') continue;
    for (const [b, h] of Object.entries(it.combine || {})) {
      handler(h, { kind: 'item', id, name: itemName(id), verb: 'combine', item: b, label: `Combine ${itemName(id)} + ${itemName(b)}` }, ['item:' + id, 'item:' + b]);
    }
    for (const v of ['look', 'hand', 'mouth']) if (it[v] != null) handler(it[v], { kind: 'item', id, name: itemName(id), verb: v, label: `${VERBS[v]} ${itemName(id)}` }, ['item:' + id]);
  }
  // the game's own code (the opening, the title...)
  for (const [k, v] of Object.entries(game)) {
    if (typeof v === 'function') handler(v, { kind: 'game', id: k, name: k, label: `game: ${k}` }, []);
  }
  const start = opening?.room || game.rooms?.[0]?.id;
  return { actions, exits, start };
}

// rounds until nothing new happens; facts: fact -> {round, by: action | exit | null}
export function simulate({ actions, exits, start }) {
  const facts = new Map();
  if (start) facts.set('room:' + start, { round: 0, by: null });
  const ok = needs => needs.every(f => facts.has(f));
  for (let round = 0; round < 200; round++) {
    // walking is free: rooms through open exits, in this round
    for (let grew = true; grew;) {
      grew = false;
      for (const x of exits) {
        if (facts.has('room:' + x.to) || !ok(x.requires)) continue;
        // a room behind a gated exit is a step of its own; else it comes with the room you walk from
        const gated = x.requires.some(f => !f.startsWith('room:'));
        facts.set('room:' + x.to, gated ? { round, by: x } : { ...facts.get('room:' + x.room) });
        if (gated) x.round ??= round;
        grew = true;
      }
    }
    const fresh = [];
    for (const a of actions) {
      if (!ok(a.requires)) continue;
      a.can ??= round;
      for (const ef of a.effects) if (!facts.has(ef.fact) && ok(ef.conds)) fresh.push([ef, a]);
    }
    if (!fresh.length) break;
    for (const [ef, a] of fresh) {
      if (facts.has(ef.fact)) continue;
      facts.set(ef.fact, { round: round + 1, by: a });
      a.round ??= round + 1;
      ef.first = round + 1;
    }
  }
  return facts;
}

// the whole analysis: actions, facts, chart nodes / edges, problems
export function analyze(e, opening, modules) {
  const model = collect(e, opening, new CodeReader(modules, new Set(Object.keys(e.game.items || {}))));
  const facts = simulate(model);
  const { actions, exits } = model;
  const game = e.game;
  const label = f => {
    const k = factKind(f), id = factId(f);
    if (k === 'item') return typeof game.items?.[id]?.name === 'string' ? game.items[id].name : id;
    if (k === 'room') { const n = e.rooms.get(id)?.def.name; return typeof n === 'string' ? n : id; }
    if (k === 'shown') return id.split('.').pop();
    return id;
  };
  // nodes: the actions (and gated exits) that first made something
  const nodes = [{ key: 'start', label: 'Start', sub: model.start ? `in ${label('room:' + model.start)}` : '', round: 0, makes: model.start ? ['room:' + model.start] : [], needs: [] }];
  const nodeOf = new Map();          // action -> round -> node; exit -> node
  for (const a of actions) {
    if (a.round == null) continue;
    // one node per round the action made something in (a handler that gives one thing now, another later)
    const rounds = [...new Set(a.effects.filter(ef => ef.first).map(ef => ef.first))].sort((x, y) => x - y);
    const per = new Map();
    for (const rd of rounds) {
      const efs = a.effects.filter(ef => ef.first === rd);
      const node = { key: `a${a.n}:${rd}`, action: a, label: a.label, sub: a.room ? label('room:' + a.room) : a.kind === 'item' ? 'inventory' : 'game', round: rd,
        makes: efs.map(ef => ef.fact), takes: rd === rounds[0] ? a.uses : [], code: !!a.code };
      // needs: the action's own, plus the branch needs of what it made then
      node.needs = [...new Set([...a.requires, ...efs.flatMap(ef => ef.conds)])];
      nodes.push(node);
      per.set(rd, node);
    }
    nodeOf.set(a, per);
  }
  for (const x of exits) {
    if (x.round == null) continue;
    const node = { key: `x:${x.room}:${x.id}`, exit: x, label: `${x.name} → ${label('room:' + x.to)}`, sub: label('room:' + x.room), round: x.round, makes: ['room:' + x.to], needs: x.requires };
    nodes.push(node);
    nodeOf.set(x, new Map([[null, node]]));
  }
  // the node that first made a fact
  const maker = f => {
    const st = facts.get(f), per = st?.by && nodeOf.get(st.by);
    return per ? per.get(per.has(null) ? null : st.round) || null : null;
  };
  // edges: from whoever first made a need (rooms only when they came through a step, not by walking from the start)
  const edges = [];
  for (const n of nodes) {
    for (const f of n.needs || []) {
      const from = maker(f);
      if (!from || from === n) continue;
      if (factKind(f) === 'room' && from.key === 'start') continue;
      edges.push({ from: from.key, to: n.key, fact: f, label: label(f) });
    }
    if (n.action?.reads?.length) {
      for (const f of n.action.reads) {
        const from = maker(f);
        if (from && from !== n && from.round < n.round && !n.needs.includes(f)) edges.push({ from: from.key, to: n.key, fact: f, label: label(f), maybe: true });
      }
    }
  }
  // problems
  const problems = [];
  const made = new Set(actions.flatMap(a => a.effects.map(ef => ef.fact)));
  const needed = new Map();
  const need = (f, a) => { if (!needed.has(f)) needed.set(f, []); needed.get(f).push(a); };
  for (const a of actions) { for (const f of a.requires) need(f, a); for (const ef of a.effects) for (const f of ef.conds) need(f, a); }
  for (const x of exits) for (const f of x.requires) need(f, x);
  for (const [f, who] of needed) {
    if (facts.has(f)) continue;
    const k = factKind(f), where = who.slice(0, 2).map(w => w.label || `${w.name} → ${w.to}`).join('; ');
    const sel = who[0];
    if (k === 'room') continue;
    if (!made.has(f)) {
      if (k === 'item') problems.push({ level: 'error', msg: `“${label(f)}” is needed (${where}) but nothing gives it`, at: sel });
      else if (k === 'flag') problems.push({ level: 'warn', msg: `flag “${factId(f)}” is checked (${where}) but never set`, at: sel });
      else if (k === 'shown') problems.push({ level: 'warn', msg: `“${factId(f)}” starts hidden and nothing shows it (${where})`, at: sel });
    } else {
      problems.push({ level: 'warn', msg: `“${label(f)}” (${k}) can never happen: what makes it is out of reach (needed by ${where})`, at: sel });
    }
  }
  for (const r of e.rooms.values()) if (!facts.has('room:' + r.id)) problems.push({ level: 'warn', msg: `room “${label('room:' + r.id)}” can't be reached`, room: r.id });
  const usedItems = new Set([...needed.keys()].filter(f => f.startsWith('item:')).concat(actions.flatMap(a => [...a.uses, ...(a.reads || [])])));
  for (const f of facts.keys()) {
    if (f.startsWith('item:') && !usedItems.has(f)) problems.push({ level: 'info', msg: `“${label(f)}” is given but never used (a red herring?)`, at: facts.get(f).by });
  }
  const order = { error: 0, warn: 1, info: 2 };
  problems.sort((a, b) => order[a.level] - order[b.level]);
  // facts that matter for the chart: something needs or checks them (items and rooms always do)
  const useful = new Set([...needed.keys(), ...actions.flatMap(a => a.reads || [])]);
  const matters = f => useful.has(f) || f.startsWith('item:') || f.startsWith('room:');
  for (const n of nodes) n.useful = n.key === 'start' || n.makes.some(matters);
  return { nodes, edges, facts, problems, actions, exits, matters, start: model.start, rounds: Math.max(0, ...nodes.map(n => n.round)), code: actions.some(a => a.code) };
}

// ------------------------------------------------------------------------------------------- the chart window
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COL = 250, NODE_W = 200, GAP = 14;
const CHIP = { item: 'ed-pz-item', flag: 'ed-pz-flag', room: 'ed-pz-room', shown: 'ed-pz-shown' };

export class PuzzleChart {
  constructor(ed) { this.ed = ed; this.box = null; }

  // the game's module texts (hand-written code calls helpers defined next to the room)
  async modules() {
    const e = this.ed.e, out = new Map();
    const get = async (key, path, depth = 0) => {
      let text = null;
      try { const r = await fetch(e.path(path), { cache: 'no-store' }); if (r.ok) text = await r.text(); } catch (err) { /* offline */ }
      if (text == null) return;
      out.set(key, { text, path });
      // the files it imports functions from (scripts/form.js...), by path
      if (depth < 3) {
        await Promise.all(imports(text).map(i => resolve(path, i.from)).filter((p, k, a) => a.indexOf(p) === k && !out.has(p) && /\.m?js$/.test(p))
          .map(p => { out.set(p, { text: '', path: p }); return get(p, p, depth + 1); }));
      }
    };
    await Promise.all([get('game', 'game.js'), ...[...e.rooms.keys()].map(id => get(id, `rooms/${id}.js`))]);
    return out;
  }

  async open() {
    this.close();
    const ed = this.ed;
    const r = this.result = analyze(ed.e, ed.gameOpening, await this.modules());
    const box = this.box = document.createElement('div');
    box.className = 'ed-modal ed-pz';
    const icon = { error: '✖', warn: '▲', info: '●' };
    box.innerHTML = `<div class="ed-pz-win">
      <header><h2>Puzzle chart</h2><span class="ed-dim">${r.nodes.length - 1} steps in ${r.rounds} round${r.rounds === 1 ? '' : 's'} · columns: what becomes possible after what · hover a step for its lines</span>
        <span class="ed-spacer"></span>
        <label title="Also steps that only set flags nothing checks (conversation bookkeeping...)"><input type="checkbox" data-act="pz-all" ${this.all ? 'checked' : ''}> All steps</label>
        ${r.code ? `<label title="Dashed: hand-written code that checks it somewhere (not necessarily a need)"><input type="checkbox" data-act="pz-maybe" ${this.maybe ? 'checked' : ''}> Code checks</label>` : ''}
        <button data-act="pz-close" title="Esc">Close</button></header>
      <div class="ed-pz-body"><div class="ed-pz-scroll"><div class="ed-pz-chart"><svg class="ed-pz-edges"></svg></div></div>
        <aside class="ed-pz-side"><h3>Problems <span class="ed-dim">${r.problems.length || 'none'}</span></h3>
          <ul class="ed-problems">${r.problems.map((p, i) => `<li class="ed-${p.level}" data-act="pz-problem" data-i="${i}"><span>${icon[p.level]}</span>${esc(p.msg)}</li>`).join('') || '<li class="ed-dim">Everything that is needed can be had.</li>'}</ul>
          <div class="ed-row ed-dim">Read from the scripts. Steps (data) exactly; hand-written code roughly${r.code ? ' (dashed: code that may check it)' : ''}: its gives / flags count as soon as it can run.</div>
          <div class="ed-pz-legend"><span class="ed-pz-item">item</span><span class="ed-pz-flag">flag</span><span class="ed-pz-room">room</span><span class="ed-pz-shown">shown</span></div></aside></div></div>`;
    document.getElementById('ed').append(box);
    this.layout();
    box.addEventListener('click', ev => this.click(ev));
    box.addEventListener('change', ev => {
      const a = ev.target.dataset.act;
      if (a === 'pz-all') { this.all = ev.target.checked; this.layout(); }
      else if (a === 'pz-maybe') { this.maybe = ev.target.checked; this.layout(); }
    });
    box.addEventListener('mouseover', ev => { const n = ev.target.closest('.ed-pz-node'); this.hover(n ? n.dataset.key : null); });
    this.onKey = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); this.close(); } };
    window.addEventListener('keydown', this.onKey, true);
  }

  close() {
    if (!this.box) return;
    this.box.remove();
    this.box = null;
    window.removeEventListener('keydown', this.onKey, true);
  }

  // columns by round; in a column, nodes ordered by where their predecessors are (fewer crossings)
  layout() {
    const r = this.result, chart = this.box.querySelector('.ed-pz-chart'), svg = chart.querySelector('svg');
    for (const el of chart.querySelectorAll('.ed-pz-node, .ed-pz-round')) el.remove();
    const shown = r.nodes.filter(n => this.all || n.useful);
    const keys = new Set(shown.map(n => n.key));
    const edges = r.edges.filter(e => keys.has(e.from) && keys.has(e.to) && (this.maybe || !e.maybe));
    this.edges = edges;
    const cols = [];
    for (const n of shown) (cols[n.round] ||= []).push(n);
    const preds = new Map(shown.map(n => [n.key, []]));
    for (const ed of edges) preds.get(ed.to)?.push(ed.from);
    const pos = new Map();
    for (const [i, col] of cols.entries()) {
      const head = document.createElement('div');
      head.className = 'ed-pz-round';
      head.style.left = `${16 + i * COL}px`;
      head.textContent = i === 0 ? 'Start' : `Round ${i}`;
      chart.append(head);
      if (!col) continue;
      const bary = n => { const p = preds.get(n.key).map(k => pos.get(k)?.y).filter(v => v != null); return p.length ? p.reduce((s, v) => s + v, 0) / p.length : 1e9; };
      col.sort((a, b) => bary(a) - bary(b) || (a.sub || '').localeCompare(b.sub || ''));
      let y = 40;
      for (const n of col) {
        const el = document.createElement('div');
        el.className = `ed-pz-node${n.code ? ' ed-pz-code' : ''}${n.key === 'start' ? ' ed-pz-start' : ''}`;
        el.dataset.act = 'pz-node';
        el.dataset.key = n.key;
        el.style.left = `${16 + i * COL}px`;
        el.style.top = `${y}px`;
        el.style.width = `${NODE_W}px`;
        const mk = this.all ? n.makes : n.makes.filter(r.matters), more = n.makes.length - mk.length;
        const chips = [...mk.map(f => `<span class="${CHIP[factKind(f)]}">+ ${esc(this.label(f))}</span>`),
          ...(more ? [`<span class="ed-pz-more">+${more} flag${more > 1 ? 's' : ''}</span>`] : []),
          ...(n.takes || []).map(f => `<span class="${CHIP.item} ed-pz-take">− ${esc(this.label(f))}</span>`)].join('');
        el.innerHTML = `<b>${esc(n.label)}</b>${n.sub ? `<em>${esc(n.sub)}${n.code ? ' · code' : ''}</em>` : ''}${chips ? `<div>${chips}</div>` : ''}`;
        chart.append(el);
        const h = el.offsetHeight;
        pos.set(n.key, { x: 16 + i * COL, y: y + h / 2, h, el });
        y += h + GAP;
      }
    }
    const W = 16 + cols.length * COL, H = Math.max(...[...pos.values()].map(p => p.y + p.h / 2), 100) + 24;
    chart.style.width = `${W}px`;
    chart.style.height = `${H}px`;
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    const paths = edges.map(e => {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) return '';
      const x0 = a.x + NODE_W, y0 = a.y, x1 = b.x, y1 = b.y, mx = (x0 + x1) / 2;
      const cls = `${CHIP[factKind(e.fact)]}${e.maybe ? ' ed-pz-maybe' : ''}`;
      const back = x1 <= x0;
      const d = back ? `M${x0},${y0} C${x0 + 60},${y0 - 80} ${x1 - 60},${y1 - 80} ${x1},${y1}` : `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
      const ends = `data-from="${esc(e.from)}" data-to="${esc(e.to)}"`;
      return `<path class="${cls}" ${ends} d="${d}"><title>${esc(e.label)}</title></path><text class="${cls}" ${ends} x="${back ? (x0 + x1) / 2 : x1 - 6}" y="${back ? (y0 + y1) / 2 - 3 : y1 - 4}" text-anchor="${back ? 'middle' : 'end'}">${esc(e.label)}</text>`;
    });
    svg.innerHTML = paths.join('');
  }

  // a step's lines in and out stand out (with their labels), the rest fades
  hover(key) {
    const svg = this.box?.querySelector('svg');
    if (!svg) return;
    svg.classList.toggle('ed-pz-focus', !!key);
    for (const el of svg.querySelectorAll('[data-from]')) el.classList.toggle('ed-pz-on', !!key && (el.dataset.from === key || el.dataset.to === key));
    for (const el of this.box.querySelectorAll('.ed-pz-node')) el.classList.toggle('ed-pz-on', el.dataset.key === key);
  }

  label(f) {
    const e = this.ed.e, k = factKind(f), id = factId(f);
    if (k === 'item') return typeof e.game.items?.[id]?.name === 'string' ? e.game.items[id].name : id;
    if (k === 'room') { const n = e.rooms.get(id)?.def.name; return typeof n === 'string' ? n : id; }
    if (k === 'shown') return id.split('.').pop() + ' shown';
    return id;
  }

  // where an action (or exit) is edited
  go(a) {
    const ed = this.ed;
    if (!a) return;
    this.close();
    if (a.kind === 'object' || a.kind === 'npc') ed.goSelect(a.room, { kind: a.kind, id: a.id });
    else if (a.kind === 'item') ed.select({ kind: 'item', id: a.id });
    else if (a.room) ed.switchRoom(a.room);
    else if (a.kind === 'game') ed.status(`game.js: ${a.id} (hand-written)`);
  }

  click(ev) {
    const b = ev.target.closest('[data-act]');
    if (ev.target === this.box) { this.close(); return; }
    if (!b || b.matches('input')) return;
    const act = b.dataset.act, r = this.result;
    if (act === 'pz-close') this.close();
    else if (act === 'pz-node') {
      const n = r.nodes.find(x => x.key === b.dataset.key);
      this.go(n?.action || n?.exit);
    } else if (act === 'pz-problem') {
      const p = r.problems[+b.dataset.i];
      if (p?.at) this.go(p.at);
      else if (p?.room) { this.close(); this.ed.switchRoom(p.room); }
    }
  }
}
