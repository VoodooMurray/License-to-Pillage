// The level editor's script editor: handlers as steps ({ do: [...] }) and conversations (dialogue trees), both
// plain data (engine/steps.js), as forms in the side panel. Every change replaces the whole handler / tree at its
// root path (one unsaved edit per handler), so adding, moving and removing steps never leaves stale index paths.

import { getPath, setPath, clone } from './paths.js';
import { DIRS } from './geom.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const STEP_TYPES = [
  ['say', 'Say'], ['give', 'Give item'], ['take', 'Take item'], ['set', 'Set flag'], ['unset', 'Clear flag'],
  ['state', 'Object state'], ['show', 'Show object'], ['hide', 'Hide object'], ['goto', 'Go to room'],
  ['walk', 'Walk to'], ['sfx', 'Sound'], ['music', 'Play music'], ['stopMusic', 'Stop music'], ['wait', 'Wait'], ['talk', 'Conversation'],
  ['card', 'Show a card'], ['hideCard', 'Hide the card'],
  ['if', 'If flag is set'], ['ifNot', 'If flag is not set'], ['ifHas', 'If carrying'], ['ifNotHas', 'If not carrying'],
  ['once', 'Only the first time'], ['end', 'Stop here'],
];
const BRANCH = new Set(['if', 'ifNot', 'ifHas', 'ifNotHas', 'once']);
const ORDER = ['if', 'ifNot', 'ifHas', 'ifNotHas', 'once', 'card', 'hideCard', 'say', 'give', 'take', 'set', 'unset', 'state', 'show', 'hide', 'goto', 'walk', 'sfx', 'music', 'stopMusic', 'wait', 'talk', 'end'];

export const stepType = s => ORDER.find(k => s && s[k] != null) || 'say';

// a new step of a type, filled in with the likeliest values: an object step targets the hotspot whose script it
// is in (root: objects[id=x]...); Show object a hidden one, if the room has one
export function newStep(type, ed, root = '') {
  const items = Object.keys(ed.e.game.items || {}), objs = [...(ed.room?.objects.keys() || [])];
  const own = /^objects\[id=([^\]]+)\]/.exec(root)?.[1];
  const here = own && ed.room?.objects.has(own) ? own : objs[0] || 'object';
  const hidden = [...(ed.room?.objects.values() || [])].find(o => o.hidden === true && o.id !== own)?.id;
  switch (type) {
    case 'say': return { say: '...' };
    case 'give': case 'take': return { [type]: items[0] || 'item' };
    case 'set': case 'unset': return { [type]: 'flag' };
    case 'state': {
      // another of its states than the one it starts in (a closed door: open)
      const o = ed.room?.objects.get(here), sts = Object.keys(o?.states && typeof o.states === 'object' ? o.states : {});
      return { state: here, to: sts.find(k => k !== o?.state) || sts[0] || 'open' };
    }
    case 'hide': return { hide: here };
    case 'show': return { show: hidden || here };
    case 'goto': return toGoto(ed.project.arrival([...ed.e.rooms.keys()].find(r => r !== ed.room?.id) || ed.room.id));
    case 'walk': return { walk: [320, 420] };
    case 'sfx': return { sfx: Object.keys(ed.e.game.sfx || {})[0] || 'sound' };
    case 'music': return { music: Object.keys(ed.e.game.music || {})[0] || 'music' };
    case 'stopMusic': return { stopMusic: true };
    case 'wait': return { wait: 500 };
    case 'talk': return { talk: Object.keys(dialogues(ed))[0] || 'conversation' };
    case 'card': return { card: Object.keys(ed.e.game.cards || {})[0] || 'title', seconds: 6 };
    case 'hideCard': return { hideCard: true };
    case 'ifHas': case 'ifNotHas': return { [type]: items[0] || 'item', then: [{ say: '...' }] };
    case 'once': return { once: uniqueOnceKey(ed), then: [{ say: '...' }] };
    case 'end': return { end: true };
    default: return { [type]: 'flag', then: [{ say: '...' }] };
  }
}

const toGoto = a => ({ goto: a.room, x: a.x, y: a.y, dir: a.dir });

// "Only the first time" keys are game-wide flags (g.once): a fresh step needs one no other step uses
function collectOnce(v, out, depth = 0) {
  if (depth > 12 || v == null || typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const x of v) collectOnce(x, out, depth + 1); return; }
  if (typeof v.once === 'string') out.add(v.once);
  for (const x of Object.values(v)) if (typeof x === 'object') collectOnce(x, out, depth + 1);
}

export function uniqueOnceKey(ed) {
  const used = new Set();
  for (const room of ed.e.rooms.values()) collectOnce(room.def, used);
  collectOnce(ed.e.game.dialogues, used);
  let n = 1;
  while (used.has(n === 1 ? 'first' : `first${n}`)) n++;
  return n === 1 ? 'first' : `first${n}`;
}

export function dialogues(ed) {
  return { ...(ed.e.game.dialogues || {}), ...(ed.room?.def.dialogues || {}) };
}

export const newDialogue = (who) => ({
  hello: [{ say: 'Hello there.', who }],
  options: [
    { text: 'Who are you?', once: true, do: [{ say: 'Nobody important.', who }] },
    { text: 'Goodbye.', end: true, do: [{ say: 'Goodbye.', who }] },
  ],
});

function sel(attrs, options, cur, blank) {
  return `<select ${attrs}>${blank != null ? `<option value="">${esc(blank)}</option>` : ''}${options.map(o => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    return `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
  }).join('')}${cur != null && cur !== '' && !options.some(o => (Array.isArray(o) ? o[0] : o) === cur) ? `<option selected>${esc(cur)}</option>` : ''}</select>`;
}

export class Scripts {
  constructor(ed) {
    this.ed = ed;
    // "Steps…" opened on a plain-text handler: the steps live here, not in the room, until a real change
    // is made (looking at a handler must not edit the file)
    this.drafts = new Map();
  }

  dkey(root) { return `${this.ed.doc?.id}|${root}`; }

  attrs(root, sub, field) { return `data-kind="script" data-root="${esc(root)}" data-sub="${esc(sub)}" data-field="${esc(field)}"`; }

  // a verb handler: text (string), steps ({do}), or scripted in the source
  handlerHtml(root, label, v, placeholder) {
    const voiced = typeof v === 'string' && this.ed.e.voiceMap?.[`${this.ed.e.game.player}|${v}`];
    const head = `<span>${esc(label)}${voiced ? ' <em class="ed-warn" title="This line has a recorded voice; a changed text needs a new recording">voiced</em>' : ''}</span>`;
    if (v != null && typeof v === 'object' && Array.isArray(v.do)) {
      return `<div class="ed-script"><div class="ed-sh">${head}<span class="ed-buttons"><button data-act="script-clear" data-root="${esc(root)}" title="Back to the game's default">×</button></span></div>${this.stepsHtml(root, 'do', v.do)}</div>`;
    }
    if (v != null && typeof v !== 'string') return `<div class="ed-row ed-dim">${esc(label)}: ${typeof v === 'function' ? 'scripted' : 'a list of lines'} (edit in the source)</div>`;
    const draft = this.drafts.get(this.dkey(root));
    if (draft) {
      return `<div class="ed-script"><div class="ed-sh">${head}<span class="ed-buttons"><button data-act="script-clear" data-root="${esc(root)}" title="Back to the plain text (nothing was changed yet)">×</button></span></div>${this.stepsHtml(root, 'do', draft.do)}</div>`;
    }
    return `<label class="ed-text">${head}<textarea rows="2" data-key="${esc(root)}" data-path="${esc(root)}" data-kind="text" placeholder="${esc(placeholder)}">${esc(v || '')}</textarea>
      <span class="ed-buttons"><button data-act="script-steps" data-root="${esc(root)}" title="Turn it into steps: give items, set flags, open doors, start conversations...">Steps…</button></span></label>`;
  }

  stepsHtml(root, sub, steps, depth = 0) {
    const ed = this.ed;
    const rows = (steps || []).map((s, i) => {
      const t = stepType(s), p = `${sub}[${i}]`;
      return `<div class="ed-step" style="--d:${depth}"><div class="ed-step-head"><b>${esc(STEP_TYPES.find(x => x[0] === t)?.[1] || t)}</b>
        <span class="ed-buttons"><button data-act="script-up" data-root="${esc(root)}" data-sub="${esc(sub)}" data-i="${i}" ${i ? '' : 'disabled'}>↑</button><button data-act="script-down" data-root="${esc(root)}" data-sub="${esc(sub)}" data-i="${i}" ${i < steps.length - 1 ? '' : 'disabled'}>↓</button><button data-act="script-del" data-root="${esc(root)}" data-sub="${esc(sub)}" data-i="${i}">✕</button></span></div>
        ${this.fieldsHtml(root, p, t, s, depth)}</div>`;
    });
    return `<div class="ed-steps">${rows.join('')}
      <div class="ed-addstep">${sel(`data-kind="script-add" data-root="${esc(root)}" data-sub="${esc(sub)}"`, STEP_TYPES, '', '+ step…')}</div></div>`;
  }

  fieldsHtml(root, p, t, s, depth) {
    const ed = this.ed, a = f => this.attrs(root, p, f);
    const items = Object.keys(ed.e.game.items || {}).map(k => [k, ed.e.itemName(k)]);
    const objs = [...(ed.room?.objects.values() || [])].map(o => [o.id, typeof o.name === 'string' ? `${o.name} (${o.id})` : o.id]);
    const actors = Object.keys(ed.e.game.actors || {}).filter(x => x !== ed.e.game.player && !x.startsWith('_'));
    switch (t) {
      case 'say': return `<div class="ed-fields"><label>Who${sel(a('who'), [['', 'Guybrush'], ...actors.map(x => [x, ed.e.game.actors[x].name || x])], s.who || '')}</label></div>
        <textarea rows="2" ${a('say')}>${esc(s.say)}</textarea>`;
      case 'give': case 'take': return `<div class="ed-fields"><label>Item${sel(a(t), items, s[t])}</label></div>`;
      case 'set': case 'unset': return `<div class="ed-fields"><label>Flag<input type="text" ${a(t)} value="${esc(s[t])}"></label></div>`;
      case 'state': {
        const sts = Object.keys(ed.room?.objects.get(s.state)?.states || {});
        return `<div class="ed-fields"><label>Object${sel(a('state'), objs, s.state)}</label><label>State${sts.length ? sel(a('to'), sts, s.to) : `<input type="text" ${a('to')} value="${esc(s.to)}">`}</label></div>`;
      }
      case 'show': case 'hide': return `<div class="ed-fields"><label>Object${sel(a(t), objs, s[t])}</label></div>`;
      case 'goto': return `<div class="ed-fields"><label>Room${sel(a('goto'), [...ed.e.rooms.keys()], s.goto)}</label><span class="ed-dim">at ${s.x}, ${s.y} ${esc(s.dir || '')}</span></div>`;
      case 'walk': return `<div class="ed-fields"><label>x<input type="number" ${a('walk.0')} value="${s.walk?.[0] ?? ''}"></label><label>y<input type="number" ${a('walk.1')} value="${s.walk?.[1] ?? ''}"></label>
        <label>Face${sel(a('face'), DIRS, s.face || '', '—')}</label></div>`;
      case 'sfx': return `<div class="ed-fields"><label>Sound${sel(a('sfx'), Object.keys(ed.e.game.sfx || {}), s.sfx)}</label></div>`;
      case 'music': return `<div class="ed-fields"><label>Music${sel(a('music'), Object.keys(ed.e.game.music || {}), s.music)}</label></div>`;
      case 'stopMusic': return '';
      case 'wait': return `<div class="ed-fields"><label>ms<input type="number" step="100" ${a('wait')} value="${s.wait ?? 500}"></label></div>`;
      case 'talk': return `<div class="ed-fields"><label>Conversation${sel(a('talk'), Object.keys(dialogues(ed)), s.talk)}</label></div>`;
      case 'card': return `<div class="ed-fields"><label>Card${sel(a('card'), Object.keys(ed.e.game.cards || {}), s.card)}</label><label>Seconds<input type="number" step="1" min="1" ${a('seconds')} value="${s.seconds ?? 6}"></label><label><input type="checkbox" ${a('keep')} ${s.keep ? 'checked' : ''}> stays until Hide</label></div>`;
      case 'hideCard': return '';
      case 'end': return '';
      default: {
        const field = t === 'ifHas' || t === 'ifNotHas' ? `<label>Item${sel(a(t), items, s[t])}</label>` : `<label>${t === 'once' ? 'Key' : 'Flag'}<input type="text" ${a(t)} value="${esc(s[t])}"></label>`;
        return `<div class="ed-fields">${field}</div><div class="ed-branch">then</div>${this.stepsHtml(root, `${p}.then`, s.then || [], depth + 1)}
          <div class="ed-branch">else</div>${this.stepsHtml(root, `${p}.else`, s.else || [], depth + 1)}`;
      }
    }
  }

  // a conversation (dialogue tree) at root (e.g. dialogues.keeper)
  dialogueHtml(root, tree) {
    if (!tree || typeof tree !== 'object') return '';
    const a = (sub, f) => this.attrs(root, sub, f);
    const opts = (tree.options || []).map((o, i) => `
      <div class="ed-option"><div class="ed-step-head"><b>Option ${i + 1}</b><span class="ed-buttons">
        <button data-act="script-up" data-root="${esc(root)}" data-sub="options" data-i="${i}" ${i ? '' : 'disabled'}>↑</button><button data-act="script-down" data-root="${esc(root)}" data-sub="options" data-i="${i}" ${i < tree.options.length - 1 ? '' : 'disabled'}>↓</button><button data-act="script-del" data-root="${esc(root)}" data-sub="options" data-i="${i}">✕</button></span></div>
        <input type="text" class="ed-wide" ${a(`options[${i}]`, 'text')} value="${esc(o.text)}" placeholder="What Guybrush asks">
        <div class="ed-fields"><label><input type="checkbox" ${a(`options[${i}]`, 'once')} ${o.once ? 'checked' : ''}> once</label>
          <label><input type="checkbox" ${a(`options[${i}]`, 'end')} ${o.end ? 'checked' : ''}> ends it</label>
          <label>only if flag<input type="text" ${a(`options[${i}]`, 'if')} value="${esc(o.if || '')}" placeholder="(always)"></label></div>
        ${this.stepsHtml(root, `options[${i}].do`, o.do || [], 1)}</div>`).join('');
    return `<div class="ed-dialogue">
      <div class="ed-gh">First time</div>${this.stepsHtml(root, 'hello', tree.hello || [])}
      <div class="ed-gh">Later times</div>${this.stepsHtml(root, 'again', tree.again || [])}
      <div class="ed-gh">Options <span class="ed-buttons"><button data-act="script-addopt" data-root="${esc(root)}">+ option</button></span></div>${opts}</div>`;
  }

  // ------------------------------------------------------------ events (from the panel)
  // the value edits work on: an open draft (not yet in the room), else the room's value
  current(root) {
    const d = this.drafts.get(this.dkey(root));
    if (d) return clone(d);
    const v = this.ed.doc.get(root);
    // a draft-less text handler edited through the steps UI (shouldn't happen): wrap it
    return typeof v === 'string' ? { do: [{ say: v }] } : clone(v);
  }

  commit(root, value, label) {
    const ok = this.ed.edit(label, [{ path: root, after: value }]);
    if (ok) this.drafts.delete(this.dkey(root));
    return ok;
  }

  // options that are "once" keep their flag when moved or deleted: pin the flag to the option's
  // position the first time it could change (steps.js uses o.id for the flag when it is set)
  pinOptionIds(v) {
    for (const [i, o] of (v?.options || []).entries()) if (o && o.once && o.id == null) o.id = String(i);
  }

  change(inp) {
    const kind = inp.dataset.kind;
    if (kind !== 'script' && kind !== 'script-add') return false;
    const ed = this.ed, root = inp.dataset.root, sub = inp.dataset.sub;
    const v = this.current(root);
    if (kind === 'script-add') {
      const t = inp.value;
      inp.value = '';
      if (!t) return true;
      const list = getPath(v, sub) || [];
      list.push(newStep(t, ed, root));
      setPath(v, sub, list);
      return this.commit(root, v, 'add step'), true;
    }
    const field = inp.dataset.field, step = getPath(v, sub);
    if (!step) return true;
    let val = inp.type === 'checkbox' ? inp.checked : inp.value;
    if (inp.type === 'number') val = +val;
    // a "once" option gets a stable flag id (its position today) before any later reorder
    if (field === 'once' && val === true && step.id == null && /^options\[\d+\]$/.test(sub)) step.id = sub.match(/\d+/)[0];
    if (field === 'goto') Object.assign(step, toGoto(ed.project.arrival(val)));
    else if (field.startsWith('walk.')) { step.walk = [...(step.walk || [0, 0])]; step.walk[+field.slice(5)] = val; }
    else if (val === '' || val === false) delete step[field];
    else step[field] = val;
    return this.commit(root, v, 'edit step'), true;
  }

  click(b) {
    const act = b.dataset.act;
    if (!act?.startsWith('script-')) return false;
    const ed = this.ed, root = b.dataset.root, sub = b.dataset.sub, i = +b.dataset.i;
    if (act === 'script-steps') {
      // only a draft: the room is not edited until a step is really added or changed
      const v = ed.doc.get(root);
      const text = typeof v === 'string' ? v : '';
      this.drafts.set(this.dkey(root), { do: [{ say: text || '...' }] });
      ed.panel.refresh(['inspector']);
      return true;
    }
    if (act === 'script-clear' && this.drafts.has(this.dkey(root))) {
      this.drafts.delete(this.dkey(root));
      ed.panel.refresh(['inspector']);
      return true;
    }
    const v = this.current(root);
    if (act === 'script-clear') {
      if (confirm('Remove these steps (back to the game\'s default)?')) this.commit(root, undefined, 'remove steps');
    } else if (act === 'script-addopt') {
      v.options ||= [];
      const end = v.options.findIndex(o => o.end);
      v.options.splice(end >= 0 ? end : v.options.length, 0, { text: 'New question?', do: [{ say: '...' }] });
      this.commit(root, v, 'add option');
    } else {
      const list = getPath(v, sub);
      if (!Array.isArray(list)) return true;
      if (sub === 'options') this.pinOptionIds(v);
      if (act === 'script-del') list.splice(i, 1);
      else if (act === 'script-up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      else if (act === 'script-down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      this.commit(root, v, act.slice(7) + ' step');
    }
    return true;
  }
}
