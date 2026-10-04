// Scripts as data (the level editor writes these; hand-written games can use them too). A handler may be
//   { do: [step, ...] }
// instead of a function / string / list of strings, and a room or the game may hold `dialogues: { id: tree }`.
// stepsToJs()/dialogToJs() turn them into the same g.* code a script author would write by hand (the pattern of
// game/rooms/office.js talkAgatha), so the web engine runs the generated function and the ScummVM build can compile
// the very same source (tools/scumm: the generated text goes through its JS parser like any other handler).
//
// Steps:
//   { say: 'text', who?: 'actor' }               a line (the player's without who)
//   { give: 'item' } { take: 'item' }            inventory
//   { set: 'flag' } { unset: 'flag' }            flags
//   { state: 'object', to: 'state', room? }      an object's state (its sprite)
//   { show: 'object' } { hide: 'object' }        objects on/off
//   { goto: 'room', x, y, dir }                  go to another room
//   { walk: [x, y], face? }                      Guybrush walks
//   { sfx: 'name' } { wait: ms }                 a sound effect (game.sfx); a pause
//   { music: 'name' } { stopMusic: true }        a music track (game.music) from now on; silence
//   { talk: 'dialogue id' }                      a conversation (dialogues of the room, else of the game)
//   { card: 'id', seconds?, keep? }              a full-screen card (game.cards.<id>: its picture; a click skips)
//   { hideCard: true }                           a kept card goes away
//   { if: 'flag' | ifNot | ifHas: 'item' | ifNotHas | once: 'key', then: [...], else?: [...] }
//   { end: true }                                stop here
// Dialogue tree: { hello?: [steps] (first time), again?: [steps], options: [{ text, do: [steps], once?, end?,
//   if?/ifNot?/ifHas?/ifNotHas? }] }. Without any `end` option a "Goodbye." option ends it.

const J = v => JSON.stringify(v);
const id = s => String(s).replace(/[^A-Za-z0-9_]/g, '_');
const COND = { if: k => `g.flag(${J(k)})`, ifNot: k => `!g.flag(${J(k)})`, ifHas: k => `g.has(${J(k)})`, ifNotHas: k => `!g.has(${J(k)})` };

function cond(o) {
  const parts = Object.keys(COND).filter(k => o[k] != null).map(k => COND[k](o[k]));
  return parts.join(' && ');
}

// steps -> lines of JS (ctx.dialogues: id -> tree, for talk steps)
export function stepsToJs(steps, ctx = {}, ind = '  ', depth = 0) {
  const out = [];
  for (const s of steps || []) {
    if (!s || typeof s !== 'object') continue;
    if (s.say != null) out.push(s.who ? `await g.say(${J(s.who)}, ${J(String(s.say))});` : `await g.say(${J(String(s.say))});`);
    else if (s.give) out.push(`g.give(${J(s.give)});`);
    else if (s.take) out.push(`g.take(${J(s.take)});`);
    else if (s.set) out.push(`g.set(${J(s.set)});`);
    else if (s.unset) out.push(`g.set(${J(s.unset)}, false);`);
    else if (s.state) out.push(`g.setState(${J(s.state)}, ${J(s.to)}${s.room ? ', ' + J(s.room) : ''});`);
    else if (s.show) out.push(`g.show(${J(s.show)});`);
    else if (s.hide) out.push(`g.hide(${J(s.hide)});`);
    else if (s.goto) out.push(`await g.goto(${J(s.goto)}, ${+s.x || 320}, ${+s.y || 420}, ${J(s.dir || 'S')});`);
    else if (s.walk) out.push(`await g.walk(${+s.walk[0]}, ${+s.walk[1]}${s.face ? ', ' + J(s.face) : ''});`);
    else if (s.sfx) out.push(`g.sfx(${J(s.sfx)});`);
    else if (s.music) out.push(`g.music(${J(s.music)});`);
    else if (s.stopMusic) out.push('g.stopMusic();');
    else if (s.wait != null) out.push(`await g.wait(${Math.max(0, +s.wait || 0)});`);
    else if (s.card) {
      const p = ctx.cards?.[s.card];
      const img = typeof p === 'string' ? p : p?.img;
      if (!img) out.push(`await g.say(${J(`(no card "${s.card}")`)});`);
      else out.push(`await g.showImage(${J(img)}, { ms: ${Math.max(300, Math.round((+s.seconds || 6) * 1000))}${s.keep ? ', keep: true' : ''} });`);
    } else if (s.hideCard) out.push('g.hideImage();');
    else if (s.talk) {
      const tree = ctx.dialogues?.[s.talk];
      if (!tree) out.push(`await g.say(${J(`(no dialogue "${s.talk}")`)});`);
      else if (depth > 3) out.push('return;');
      else out.push(...dialogToJs(tree, s.talk, ctx, '', depth + 1).split('\n'));
    } else if (s.once || cond(s)) {
      const c = s.once ? `g.once(${J('step_' + id(s.once))})` : cond(s);
      out.push(`if (${c}) {`, ...stepsToJs(s.then, ctx, '  ', depth), ...(s.else?.length ? ['} else {', ...stepsToJs(s.else, ctx, '  ', depth)] : []), '}');
    } else if (s.end) out.push('return;');
  }
  return out.map(l => ind + l);
}

export function dialogToJs(tree, name, ctx = {}, ind = '', depth = 0) {
  const k = 'dlg_' + id(name);
  const opts = (tree.options || []).filter(o => o && o.text);
  const hasEnd = opts.some(o => o.end);
  // an option's once-flag: its own id if it has one (stable when options are reordered), else its position
  const oflag = (o, i) => `${k}_${o.id != null ? id(String(o.id)) : i}`;
  const L = [];
  if (tree.hello?.length || tree.again?.length) {
    L.push(`if (g.once(${J(k + '_hello')})) {`, ...stepsToJs(tree.hello, ctx, '  ', depth));
    if (tree.again?.length) L.push('} else {', ...stepsToJs(tree.again, ctx, '  ', depth));
    L.push('}');
  }
  L.push('for (;;) {', '  const c = await g.choose([');
  opts.forEach((o, i) => {
    const c = [o.once ? `!g.flag(${J(oflag(o, i))})` : '', cond(o)].filter(Boolean).join(' && ');
    L.push(`    ${c ? c + ' && ' : ''}{ id: ${J('o' + i)}, text: ${J(o.text)} },`);
  });
  if (!hasEnd) L.push(`    { id: 'bye', text: "Goodbye." },`);
  L.push('  ]);');
  opts.forEach((o, i) => {
    L.push(`  ${i ? '} else if' : 'if'} (c === ${J('o' + i)}) {`);
    if (o.once) L.push(`    g.set(${J(oflag(o, i))});`);
    L.push(...stepsToJs(o.do, ctx, '    ', depth));
    if (o.end) L.push('    return;');
  });
  if (!hasEnd) L.push(`  ${opts.length ? '} else {' : 'if (c === "bye") {'}`, '    return;');
  if (opts.length || !hasEnd) L.push('  }');
  L.push('}');
  return L.map(l => ind + l).join('\n');
}

// handler -> the whole function source (what the ScummVM build compiles)
export function handlerSource(h, ctx = {}) {
  return `async g => {\n${stepsToJs(h.do, ctx).join('\n')}\n}`;
}

export const isSteps = h => !!h && typeof h === 'object' && !Array.isArray(h) && Array.isArray(h.do);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const cache = new WeakMap();
let version = 0;

// the level editor calls this after editing steps or dialogue trees: cached compilations are stale
// (a talk step inlines its tree at compile time, so a changed tree needs a recompile)
export function bumpSteps() { version++; }

// a runnable function for a { do } handler (cached per handler object; dialogues come from ctx)
export function compileSteps(h, ctx = {}) {
  let f = cache.get(h);
  if (!f || f.ctx !== ctx.dialogues || f.v !== version) {
    const fn = new AsyncFunction('g', stepsToJs(h.do, ctx).join('\n'));
    f = { fn, ctx: ctx.dialogues, v: version };
    cache.set(h, f);
  }
  return f.fn;
}
