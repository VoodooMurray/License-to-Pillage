// Project tools of the level editor (EDITOR_PLAN.md 10c): switch between games and make new ones (games/<key>/,
// tools/projects.py), new rooms (an uploaded background or a placeholder), new inventory items, adding and
// deleting hotspots, a hotspot's sprite image, a room's background. Structural changes (new games, rooms, items,
// hotspots) are written at once through tools/serve.py; values (texts, exits, geometry) are unsaved edits like any
// other (Save). License to Pillage (game/) is the reference project: no new rooms, items or backgrounds there.

import { W } from '../engine.js';
import { api, getProject } from './api.js';
import { forget, preload } from '../assets.js';
import { Costume } from '../costume.js';
import { Actor } from '../actor.js';
import { newDialogue } from './scripts.js';
import { bumpSteps } from '../steps.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ID = /^[a-z][a-z0-9_]{0,40}$/;
const KEYRE = /^[a-z][a-z0-9_]{1,30}$/;

export const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  .replace(/^(\d)/, 'r$1').slice(0, 30);

export class ProjectTools {
  constructor(ed) {
    this.ed = ed;
    this.projects = [];
  }

  get reference() { return !getProject(); }

  async load() {
    const r = await api.projects();
    if (r.status === 200) this.projects = r.data.projects;
    return this.projects;
  }

  url(key, room) {
    return '?edit' + (key ? `&game=${key}` : '') + (room ? `&room=${room}` : '');
  }

  go(key, room) {
    if ([...this.ed.docs.values()].some(d => d.dirty().length) && !confirm('There are unsaved edits. Leave without saving them?')) return false;
    window.onbeforeunload = null;
    location.href = this.url(key, room);
    return true;
  }

  // ------------------------------------------------------------ dialogs
  // A small modal form; resolves to {name: value} (files as data URLs) or null.
  form(title, fields, submit = 'Create', note = '') {
    return new Promise(resolve => {
      const box = document.createElement('div');
      box.className = 'ed-modal';
      box.innerHTML = `<form class="ed-dialog"><h2>${esc(title)}</h2>${note ? `<div class="ed-row ed-dim">${note}</div>` : ''}
        ${fields.map(f => `<label class="ed-field"><span>${esc(f.label)}</span>${f.type === 'textarea'
          ? `<textarea name="${f.name}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
          : f.type === 'select' ? `<select name="${f.name}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${v === f.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
          : `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}"
              ${f.accept ? `accept="${f.accept}"` : ''} ${f.min != null ? `min="${f.min}" max="${f.max}" step="${f.step || 1}"` : ''}>`}
          ${f.hint ? `<em>${esc(f.hint)}</em>` : ''}</label>`).join('')}
        <div class="ed-err"></div>
        <div class="ed-buttons"><button type="submit" class="ed-primary">${esc(submit)}</button><button type="button" data-cancel>Cancel</button></div></form>`;
      document.getElementById('ed').append(box);
      const formEl = box.querySelector('form'), err = box.querySelector('.ed-err');
      const close = v => { box.remove(); resolve(v); };
      box.querySelector('[data-cancel]').onclick = () => close(null);
      box.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Escape') close(null); });
      // the id follows the name until it is typed in
      const name = formEl.querySelector('[name=name], [name=title]'), idIn = formEl.querySelector('[name=id], [name=key]');
      if (name && idIn) {
        let touched = false;
        idIn.addEventListener('input', () => { touched = true; });
        name.addEventListener('input', () => { if (!touched) idIn.value = slug(name.value); });
      }
      formEl.onsubmit = async ev => {
        ev.preventDefault();
        const out = {};
        for (const f of fields) {
          const el = formEl.querySelector(`[name=${f.name}]`);
          if (f.type === 'file') out[f.name] = el.files[0] ? await readDataUrl(el.files[0]) : null;
          else if (f.type === 'number') out[f.name] = el.value === '' ? null : +el.value;
          else out[f.name] = el.value.trim();
        }
        const why = fields.map(f => f.check?.(out[f.name], out)).find(Boolean);
        if (why) { err.textContent = why; return; }
        box.querySelector('.ed-primary').disabled = true;
        err.textContent = 'Working…';
        close(out);
      };
      setTimeout(() => formEl.querySelector('input, textarea')?.focus(), 0);
    });
  }

  // ------------------------------------------------------------ games, rooms, items
  async newGame() {
    const v = await this.form('New game', [
      { name: 'title', label: 'Title', placeholder: 'The Secret of Sandbox Island' },
      { name: 'key', label: 'Folder', hint: 'games/<folder>: lower case letters, digits, _', check: k => KEYRE.test(k) ? null : 'Folder: 2-31 lower case letters, digits or _, starting with a letter.' },
      { name: 'player', label: 'Main character', type: 'select', value: 'guybrush', options: [
        ['guybrush', 'Guybrush (from your CMI; plays in ScummVM too)'],
        ['own', 'Your own (a placeholder figure; nothing CMI-derived)'],
      ] },
      { name: 'hero', label: 'Their name', placeholder: 'Hero', hint: 'only for your own character; ✨ or Load image… gives them a face later' },
    ], 'Create game', 'A new game in its own folder with one room to start from. License to Pillage is not touched.');
    if (!v) return;
    const r = await api.newProject({ key: v.key, title: v.title || v.key, player: v.player, hero: v.hero });
    if (r.status !== 200) { this.ed.notice(`New game: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return; }
    this.go(v.key, 'start');
  }

  // any character becomes the player (game.js `player`); the web engine switches live, the ScummVM
  // build still shows Guybrush until own player costumes land there
  async setPlayer(id) {
    const e = this.ed.e;
    if (e.game.player === id || !e.game.actors?.[id]) return;
    const r = await this.ed.holdPoll(() => api.gamePatch([{ op: 'set', path: 'player', value: id }]));
    if (r.status !== 200) { this.ed.notice(r.data?.error || 'The main character was not changed.', 'warn'); return; }
    const a = e.actors.get(id), old = e.player;
    if (a && old) {
      Object.assign(a, { room: old.room, x: old.x, y: old.y, dir: old.dir });
      if (!this.ed.room?.def.actors?.[old.id]) old.room = null;      // gone unless placed here as an NPC
      a.play?.(a.baseRole || 'stand');
    }
    e.game.player = id;
    e.player = a;
    bumpSteps();
    this.ed.status(`${e.game.actors[id]?.name || id} is the main character now (game.js player). In ScummVM the player still shows as Guybrush.`);
    this.loadStandalone();
    this.ed.panel.refresh(['chars', 'list', 'inspector']);
  }

  async newRoom() {
    if (this.reference) { this.ed.notice('License to Pillage is the reference project: make new rooms in a game of your own (Game → New game…).', 'warn'); return; }
    const v = await this.form('New room', [
      { name: 'name', label: 'Name', placeholder: 'Beach' },
      { name: 'id', label: 'Id', hint: 'rooms/<id>.js', check: k => ID.test(k) ? (this.ed.e.rooms.has(k) ? 'A room with this id exists.' : null) : 'Id: lower case letters, digits or _, starting with a letter.' },
      { name: 'image', label: 'Background', type: 'file', accept: 'image/*', hint: '480 logical px high (art at 4x: 1920); the width follows the picture (640-1920). None: a placeholder.' },
      { name: 'width', label: 'Width without a picture', type: 'number', value: 640, min: 640, max: 1920, step: 8 },
    ], 'Create room');
    if (!v) return;
    const r = await api.newRoom({ id: v.id, name: v.name || v.id, image: v.image, width: v.image ? null : v.width });
    if (r.status !== 200) { this.ed.notice(`New room: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return; }
    this.go(getProject(), v.id);
  }

  async newItem() {
    if (this.reference) { this.ed.notice('License to Pillage is the reference project: make new items in a game of your own.', 'warn'); return; }
    const items = this.ed.e.game.items || {};
    const v = await this.form('New inventory item', [
      { name: 'name', label: 'Name', placeholder: 'rubber chicken' },
      { name: 'id', label: 'Id', check: k => ID.test(k) ? (items[k] ? 'An item with this id exists.' : null) : 'Id: lower case letters, digits or _, starting with a letter.' },
      { name: 'look', label: 'Look at', type: 'textarea', placeholder: "A rubber chicken with a pulley in the middle." },
      { name: 'icon', label: 'Icon', type: 'file', accept: 'image/*', hint: "Fitted into CMI's 80x56 inventory cell (art 320x224). None: a placeholder." },
    ], 'Create item');
    if (!v) return;
    const r = await api.newItem({ id: v.id, name: v.name || v.id, look: v.look || null, icon: v.icon });
    if (r.status !== 200) { this.ed.notice(`New item: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return; }
    await this.reloadItems();
    this.ed.status(`Item ${v.id} added to ${this.ed.e.base}/game.js.`);
  }

  // re-reads game.js for its items and characters (rooms and scripts stay as they are)
  async reloadItems() {
    const e = this.ed.e;
    const m = await import(new URL(e.path('game.js') + `?v=${Date.now()}`, location.href).href);
    const items = m.default.items || {};
    for (const it of Object.values(items)) if (it.icon) forget(e.path(it.icon));
    e.game.items = items;                               // as on disk (archived / deleted ones are gone)
    e.game.actors = m.default.actors || {};
    e.game.music = m.default.music || {};
    e.game.sfx = m.default.sfx || {};
    e.game.cards = m.default.cards || {};
    bumpSteps();
    await preload(Object.values(items).map(i => e.path(i.icon)));
    this.ed.panel.refresh(['items', 'chars', 'sound', 'doc', 'identity']);
  }

  async newCharacter() {
    if (this.reference) return;
    const r = await api.costumes();
    const list = r.data?.costumes || [];
    const v = await this.form('New character', [
      { name: 'name', label: 'Name', placeholder: 'lighthouse keeper' },
      { name: 'id', label: 'Id', check: k => ID.test(k) ? (this.ed.e.game.actors?.[k] ? 'A character with this id exists.' : null) : 'Id: lower case letters, digits or _, starting with a letter.' },
      { name: 'image', label: 'A picture of them', type: 'file', accept: 'image/*', hint: 'PNG with transparency, standing on its bottom edge: a still character that bobs when talking. Or pick a costume:' },
      { name: 'height', label: 'Height at full size (Guybrush ≈ 280)', type: 'number', value: 280, min: 60, max: 480, step: 10 },
      { name: 'source', label: 'Costume', type: 'select', value: list[0]?.source, options: list.map(c => [c.source, `${c.id} (${c.from})`]),
        hint: "Costumes from License to Pillage are copied into the game; CMI's own come from your CMI (cmi/actors)." },
      { name: 'color', label: 'Text colour', type: 'color', value: '#9fe0ff' },
    ], 'Create character');
    if (!v) return;
    const res = await api.newActor({ id: v.id, name: v.name || v.id, source: v.image ? null : v.source, image: v.image, height: v.height, color: v.color });
    if (res.status !== 200) { this.ed.notice(`New character: ${res.data?.error || 'HTTP ' + res.status}`, 'error'); return; }
    await this.reloadItems();
    this.ed.charsOpen = true;
    this.ed.panel.refresh(['chars']);
    this.ed.status(`Character ${v.id} added to game.js (costume ${res.data.costume}). "Place here" puts them in a room.`);
  }

  async ensureActor(id) {
    const e = this.ed.e;
    if (e.actors.has(id)) return e.actors.get(id);
    const def = e.game.actors[id];
    const costume = def.costume ? await Costume.load(e.path(def.costume)) : null;
    const a = new Actor(id, def, costume);
    if (def.anim) a.baseRole = def.anim;
    e.actors.set(id, a);
    return a;
  }

  // a character into this room: placement, an NPC hotspot from the sprite, and a first conversation
  async placeActor(id) {
    const ed = this.ed, e = ed.e, room = ed.room;
    const a = await this.ensureActor(id);
    const y = room.def.entries?.default?.[1] || 420, x = Math.round(Math.min(room.width - 60, ed.camX + W / 2 + 90));
    const ops = [
      { path: `actors.${id}`, after: { x, y, dir: 'W' } },
      { path: `npcs.${id}`, after: { name: e.game.actors[id].name || id, walkTo: [x - 70, y], face: 'E', mouth: { do: [{ talk: id }] } } },
    ];
    if (room.def.dialogues?.[id] == null && e.game.dialogues?.[id] == null) ops.push({ path: `dialogues.${id}`, after: newDialogue(id) });
    if (!ed.edit(`place ${id}`, ops)) return;
    e.placeActors(room);
    await new Promise(r => setTimeout(r, 120));
    const b = a.bounds(room);
    if (b && b.w > 0) ed.edit('NPC hotspot', [{ path: `npcs.${id}.hot`, after: [Math.round(b.x - a.x), Math.round(b.y - a.y), Math.round(b.w), Math.round(b.h)] }]);
    ed.setTool('select');
    ed.select({ kind: 'npc', id });
  }

  newConversation(id) {
    const ed = this.ed;
    ed.edit('new conversation', [
      { path: `dialogues.${id}`, after: newDialogue(id) },
      { path: `npcs.${id}.mouth`, after: { do: [{ talk: id }] } },
    ]);
  }

  // ------------------------------------------------------------ hotspots
  // writes edits to the room file at once (structural: inserting/removing objects), then reloads the room
  async structural(label, edits) {
    const ed = this.ed, doc = ed.doc;
    if (!doc || doc.offline) return false;
    return ed.holdPoll(async () => {
      const r = await api.patch(doc.id, { sha: doc.sha, edits });
      if (r.status !== 200) {
        const d = r.data || {};
        ed.notice(`${label}: ${d.error || (d.errors || []).map(x => x.error).join('; ') || (d.conflicts ? 'changed on disk' : 'HTTP ' + r.status)}`, 'error');
        return false;
      }
      await doc.load();
      await doc.hotSwap();
      doc.prune();               // pending edits into a removed object would block every later save
      doc.resetHistory();
      doc.persist();
      ed.status(`${label}: written to ${doc.file}.`);
      return true;
    });
  }

  async addHotspot() {
    const ed = this.ed, room = ed.room;
    if (!room) return;
    let n = 1;
    while (room.objects.has('hotspot' + n)) n++;
    const id = 'hotspot' + n;
    const cx = Math.round(ed.camX + W / 2);
    const value = { id, name: 'new hotspot', box: [cx - 40, 200, 80, 80] };
    if (await this.structural(`add ${id}`, [{ op: 'insert', path: 'objects', value }])) {
      ed.setTool('select');
      ed.select({ kind: 'object', id });
    }
  }

  async deleteHotspot(id) {
    if (!confirm(`Delete the hotspot "${id}"? It is removed from the room file at once (the file is in git, so it can be restored).`)) return;
    if (await this.structural(`delete ${id}`, [{ op: 'remove', path: `objects[id=${id}]` }])) this.ed.select(null);
  }

  // the arrival point in the target room for an exit from this room
  arrival(target) {
    const r = this.ed.e.rooms.get(target)?.def;
    const from = this.ed.room?.id;
    const p = r?.entries?.[from] || r?.entries?.default || r?.start || [320, 420, 'S'];
    return { room: target, x: p[0], y: p[1], dir: p[2] || 'S' };
  }

  // ------------------------------------------------------------ library: archive, delete, restore
  async loadLibrary() {
    const r = await api.library();
    this.library = r.status === 200 ? r.data.entries : [];
    this.ed.panel.refresh(['library']);
    return this.library;
  }

  // ------------------------------------------------------------ art style (style.json: every ✨ generation)
  async loadStyle() {
    const r = await api.style();
    this.style = r.status === 200 ? (r.data.style || {}) : {};
    this.ed.panel.refresh(['identity']);
    return this.style;
  }

  async saveStyle(patch) {
    const body = { ...(this.style || {}), ...patch };
    const r = await this.ed.holdPoll(() => api.setStyle(body));
    if (r.status !== 200) { this.ed.notice(r.data.error || 'The style was not saved.', 'warn'); this.ed.panel.refresh(['identity']); return; }
    this.style = r.data.style || {};
    this.ed.status(Object.keys(this.style).length ? 'Art style saved (style.json): every ✨ uses it now.' : 'Art style: back to the CMI look.');
    this.ed.panel.refresh(['identity']);
  }

  async addStyleRef() {
    const file = await pickFile('image/*');
    if (!file) return;
    const refs = this.style?.refs || [];
    if (refs.length >= 4) { this.ed.notice('Up to 4 style references.', 'warn'); return; }
    const base = (file.name || 'ref').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9_-]+/g, '_').slice(0, 24) || 'ref';
    const path = `library/style/${base}_${Date.now().toString(36)}.png`;
    const data = await readDataUrl(file);
    const r = await this.ed.holdPoll(() => api.upload({ path, data }));
    if (r.status !== 200) { this.ed.notice(r.data.error || 'The image was not uploaded.', 'warn'); return; }
    await this.saveStyle({ refs: [...refs, r.data.path] });
  }

  async removeStyleRef(i) {
    const refs = [...(this.style?.refs || [])];
    refs.splice(i, 1);
    await this.saveStyle({ refs });
  }

  // ------------------------------------------------------------ UI theme (theme.json: coin, cursors, chest…)
  async loadTheme() {
    const r = await api.theme();
    this.theme = r.status === 200 ? (r.data.theme || {}) : {};
    this.loadStandalone();
    this.ed.panel.refresh(['identity']);
    return this.theme;
  }

  // the badge: can this game ship with no CMI at all (theme complete + no cmi/ costume references)
  async loadStandalone() {
    const r = await api.standalone();
    this.standalone = r.status === 200 ? r.data : null;
    this.ed.panel.refresh(['identity']);
  }

  // mutate(copy) edits a copy of the theme; it is validated, saved and switched on
  async saveTheme(mutate) {
    const t = JSON.parse(JSON.stringify(this.theme || {}));
    mutate(t);
    for (const g of ['coin', 'arrows', 'colors', 'fonts']) if (t[g] && !Object.keys(t[g]).length) delete t[g];
    const r = await this.ed.holdPoll(() => api.setTheme(t));
    if (r.status !== 200) { this.ed.notice(r.data.error || 'The theme was not saved.', 'warn'); this.ed.panel.refresh(['identity']); return false; }
    this.theme = r.data.theme || {};
    await this.ed.e.reloadTheme();
    this.ed.status(Object.keys(this.theme).length ? 'Interface saved (theme.json).' : 'Interface: back to CMI.');
    this.loadStandalone();
    this.ed.panel.refresh(['identity']);
    return true;
  }

  // slot: 'coin.idle' | 'arrows.N' | 'chest' | 'cursor' | ... -> upload the picture, point the theme at it
  async themeLoadImage(slot) {
    const file = await pickFile('image/*');
    if (!file) return;
    const rel = 'ui/' + slot.replace('.', '_').toLowerCase() + '.png';
    if (!await this.uploadImage(rel, await readDataUrl(file))) return;
    await this.saveTheme(t => {
      const [g, sub] = slot.split('.');
      if (sub) (t[g] ||= {})[sub] = rel; else t[g] = rel;
    });
  }

  themeReset(slot) {
    return this.saveTheme(t => {
      const [g, sub] = slot.split('.');
      if (sub) delete (t[g] || {})[sub]; else delete t[slot];
    });
  }

  themeColor(k, v) {
    return this.saveTheme(t => {
      if (v) (t.colors ||= {})[k] = v; else delete (t.colors || {})[k];
    });
  }

  // one TTF/OTF -> three atlases at CMI's sizes (speech / small / big), theme.json pointing at them
  async themeLoadFont() {
    const file = await pickFile('.ttf,.otf,.ttc,font/ttf,font/otf');
    if (!file) return;
    const name = (file.name || 'font').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9_]+/g, '_').slice(0, 24);
    this.ed.status('Building the font atlases…');
    const r = await this.ed.holdPoll(async () => api.font({ name, data: await readDataUrl(file) }));
    if (r.status !== 200) { this.ed.notice(r.data.error || 'The font was not converted.', 'warn'); return; }
    this.theme = r.data.theme || {};
    await this.ed.e.reloadTheme();
    this.ed.status(`Font "${name}" is on (speech, small and big text; theme.json).`);
    this.loadStandalone();
    this.ed.panel.refresh(['identity']);
  }

  themeResetFonts() {
    return this.saveTheme(t => { delete t.fonts; });
  }

  // ------------------------------------------------------------ cards (game.cards: full-screen pictures)
  async addCard() {
    const e = this.ed.e;
    const v = await this.form('New card', [
      { name: 'id', label: 'Id', placeholder: 'title', check: k => ID.test(k) ? (e.game.cards?.[k] ? 'A card with this id exists.' : null) : 'Id: lower case letters, digits or _, starting with a letter.' },
      { name: 'image', label: 'Picture (4:3; empty: a placeholder with the name)', type: 'file', accept: 'image/*' },
    ], 'Create', 'A full-screen picture (the title, a chapter, THE END…), shown by a "Show a card" step — ✨ can paint it with the title lettering in it.');
    if (!v) return;
    const rel = `cards/${v.id}.jpg`;
    if (!await this.uploadImage(rel, v.image || this.cardPlaceholder(v.id))) return;
    const r = await this.ed.holdPoll(() => api.gamePatch([{ op: 'set', path: `cards.${v.id}`, value: rel }]));
    if (r.status !== 200) { this.ed.notice(r.data?.error || 'The card was not added to game.js.', 'warn'); return; }
    await this.cardChanged(v.id, rel);
    this.ed.status(`Card ${v.id}: a "Show a card" step can use it now.`);
  }

  // a dark placeholder with the name in the game's own big font (themed when the game has one)
  cardPlaceholder(id) {
    const cv = document.createElement('canvas');
    cv.width = 1280; cv.height = 960;
    const c = cv.getContext('2d');
    c.fillStyle = '#17100a';
    c.fillRect(0, 0, 1280, 960);
    c.save();
    c.scale(2, 2);
    const e = this.ed.e, text = id.replace(/_/g, ' ').toUpperCase();
    e.fontBig.drawCentered(c, e.fontBig.wrap(text, 560), 320, 214, [255, 211, 83]);
    c.restore();
    return cv.toDataURL('image/jpeg', 0.92);
  }

  async cardLoadImage(id) {
    const file = await pickFile('image/*');
    if (!file) return;
    const rel = this.ed.e.game.cards?.[id] || `cards/${id}.jpg`;
    if (!await this.uploadImage(rel, await readDataUrl(file))) return;
    await this.cardChanged(id, rel);
  }

  async removeCard(id) {
    const r = await this.ed.holdPoll(() => api.gamePatch([{ op: 'del', path: `cards.${id}` }]));
    if (r.status !== 200) { this.ed.notice(r.data?.error || 'The card was not removed.', 'warn'); return; }
    const e = this.ed.e;
    delete (e.game.cards || {})[id];
    bumpSteps();
    this.ed.status(`Card ${id} removed from game.js (its picture stays in cards/).`);
    this.ed.panel.refresh(['identity']);
  }

  // the picture behind a card changed (upload or ✨): fresh cache, fresh compiled steps
  async cardChanged(id, rel) {
    const e = this.ed.e;
    e.game.cards = { ...(e.game.cards || {}), [id]: rel };
    forget(e.path(rel));
    await preload([e.path(rel)]);
    bumpSteps();
    this.ed.panel.refresh(['identity']);
  }

  // after game.js or room files changed on disk: the open rooms and the game's items/characters again
  async reloadAll() {
    const ed = this.ed;
    for (const doc of ed.docs.values()) {
      const sha = doc.sha;
      if (await doc.load() && doc.sha !== sha) { await doc.hotSwap(); doc.prune(); doc.resetHistory(); doc.persist(); }
    }
    await this.reloadItems();
    const e = ed.e;
    for (const [id, a] of e.actors) if (id !== e.game.player && !e.game.actors?.[id]) a.room = null;
    for (const [id, a] of e.actors) if (a.room && a.room === ed.room?.id && !ed.room.def.actors?.[id] && id !== e.game.player) a.room = null;
    await this.loadLibrary();
    ed.panel.refresh();
  }

  async libraryOp(label, call, body) {
    return this.ed.holdPoll(async () => {
      const r = await call(body);
      if (r.status !== 200) { this.ed.notice(`${label}: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return null; }
      await this.reloadAll();
      return r.data;
    });
  }

  async archive(kind, id, keep = true) {
    const ed = this.ed;
    if (this.reference) { ed.notice('License to Pillage is the reference project: archive and delete things in a game of your own.', 'warn'); return; }
    const what = { object: 'hotspot', item: 'item', character: 'character' }[kind];
    if (!keep && !confirm(`Delete the ${what} "${id}"? It is taken out of the game at once (its pictures stay in the project; the files are in git).`)) return;
    if (kind === 'object' && ed.doc?.dirty().length) await ed.save();
    const r = await this.libraryOp(keep ? 'Archive' : 'Delete', api.archive, { kind, id, room: ed.room?.id, keep });
    if (!r) return;
    if (kind === 'item') { const e = ed.e; e.state.inv = e.state.inv.filter(x => x !== id); delete e.game.items[id]; }
    if (kind === 'character') delete ed.e.game.actors[id];
    if (ed.sel?.id === id) ed.select(null);
    ed.status(keep ? `"${id}" is in the library now (Library → put it back any time).` : `"${id}" deleted.`);
  }

  async restore(entry, opts = {}) {
    const ed = this.ed;
    if (ed.doc?.dirty().length) await ed.save();
    const at = entry.kind === 'object' ? [Math.round(ed.camX + W / 2 - 40), 200] : opts.at;
    const r = await this.libraryOp('Put back', api.restore, { id: entry.id, room: opts.room === null ? null : ed.room?.id, at, keepEntry: opts.keepEntry });
    if (!r) return;
    if (entry.kind === 'character') await this.ensureActor(r.id);
    if (r.kind === 'object') { ed.setTool('select'); ed.select({ kind: 'object', id: r.id }); }
    if (r.kind === 'character' && r.placed) { ed.e.placeActors(ed.room); ed.select({ kind: 'npc', id: r.id }); }
    if (r.kind === 'background') {
      if (opts.room === null) { this.go(getProject(), r.room); return; }
      const p = ed.e.path(ed.room.def.layers[0].img);
      forget(p);
      ed.e.gfx?.lo?.pal?.rooms.delete(ed.room.id);
      await preload([p]);
    }
    ed.status(`${entry.name}: back in the game.`);
  }

  async backgroundRoom(entry) {
    const v = await this.form('New room from this background', [
      { name: 'name', label: 'Name', value: entry.name },
      { name: 'id', label: 'Id', value: slug(entry.name), check: k => ID.test(k) ? (this.ed.e.rooms.has(k) ? 'A room with this id exists.' : null) : 'Id: lower case letters, digits or _, starting with a letter.' },
    ], 'Create room');
    if (v) await this.restore(entry, { room: null, at: { id: v.id, name: v.name } });
  }

  async removeEntry(entry) {
    if (!confirm(`Remove "${entry.name}" from the library? (Its picture goes to .trash.)`)) return;
    const r = await api.libRemove({ id: entry.id });
    if (r.status !== 200) { this.ed.notice(`Library: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return; }
    await this.loadLibrary();
  }

  // a character out of this room only (the game keeps them): unsaved edits like any other
  removeFromRoom(id) {
    const ed = this.ed, room = ed.room;
    const ops = [{ path: `actors.${id}`, after: undefined }, { path: `npcs.${id}`, after: undefined }];
    if (!ed.edit(`remove ${id} from the room`, ops)) return;
    const a = ed.e.actors.get(id);
    if (a && a.room === room.id) a.room = null;
    ed.select(null);
    ed.status(`${id} left this room (their conversation stays in the room file; Save to keep it).`);
  }

  // an item's fields in game.js (written at once)
  async itemField(id, field, value) {
    const ed = this.ed;
    const r = await api.gamePatch([value === undefined || value === '' ? { op: 'del', path: `items.${id}.${field}` } : { op: 'set', path: `items.${id}.${field}`, value }]);
    if (r.status !== 200) { ed.notice(`Item: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return; }
    const it = ed.e.game.items[id];
    if (it) { if (value === undefined || value === '') delete it[field]; else it[field] = value; }
    ed.status(`items.${id}.${field} saved to game.js.`);
    ed.panel.refresh(['items', 'inspector']);
  }

  async itemIcon(id) {
    const ed = this.ed, it = ed.e.game.items[id];
    const file = await pickFile('image/*');
    if (!file || !it) return;
    const rel = typeof it.icon === 'string' ? it.icon : `items/${id}.png`;
    if (!await this.uploadImage(rel, await readDataUrl(file))) return;
    if (it.icon !== rel) await this.itemField(id, 'icon', rel);
    ed.e.hotIcons?.delete(ed.e.path(rel));
    ed.panel.refresh(['items', 'inspector']);
  }

  // the exit back: in the target room, an exit hotspot at the arrival point that leads here (to this exit's walk-to
  // point), plus the arrival entries of both rooms; written at once to the target room's file
  async wayBack(o) {
    const ed = this.ed, e = ed.e, here = ed.room, ex = o.exit;
    const there = e.rooms.get(ex?.room);
    if (!there || there === here) return;
    const back = [...there.objects.values()].find(x => x.exit?.room === here.id);
    if (back) { ed.notice(`${ex.room} already has an exit back here (${back.id}).`, 'warn'); return; }
    const wt = (o.walkTo || here.walkToOf(o)).map(Math.round);
    const id = `to_${here.id}`.slice(0, 40);
    const name = typeof here.def.name === 'string' ? `to the ${here.def.name.toLowerCase()}` : `to ${here.id}`;
    const x = Math.round(ex.x), y = Math.round(ex.y);
    const value = { id, name, box: [x - 40, y - 110, 80, 100], walkTo: [x, y], face: ex.dir || 'S',
      exit: { room: here.id, x: wt[0], y: wt[1], dir: o.face || 'S' } };
    const r = await ed.holdPoll(() => api.patch(there.id, { edits: [
      { op: 'insert', path: 'objects', value },
      { op: 'set', path: `entries.${here.id}`, value: [x, y, ex.dir || 'S'] },
    ] }));
    if (r.status !== 200) { ed.notice(`Way back: ${r.data?.error || (r.data?.errors || []).map(x => x.error).join('; ') || 'HTTP ' + r.status}`, 'error'); return; }
    // the target room's definition again, as written (the editor opens it fresh when you go there)
    await ed.holdPoll(() => this.reloadRoom(there.id));
    ed.edit('arrival entry', [{ path: `entries.${there.id}`, after: [wt[0], wt[1], o.face || 'S'] }]);
    ed.status(`Exit "${id}" added in ${there.id} at its arrival point (move it there); ${here.id}'s arrival from ${there.id} set.`);
  }

  // a room's definition again, as on disk (its file was written by the server)
  async reloadRoom(id) {
    const e = this.ed.e, doc = this.ed.docs.get(id), room = e.rooms.get(id);
    if (doc?.base) {
      const sha = doc.sha;
      if (await doc.load() && doc.sha !== sha) { await doc.hotSwap(); doc.prune(); doc.resetHistory(); doc.persist(); }
      return;
    }
    if (!room) return;
    const url = new URL(e.path(`rooms/${id}.js`) + `?v=${Date.now()}`, location.href);
    const def = (await import(url.href)).default;
    const i = e.game.rooms.findIndex(rr => rr.id === id);
    if (i >= 0) e.game.rooms[i] = def;
    room.def = def;
    room.rebuild();
  }

  // an item's id everywhere (game.js, its icon, the scripts of every room): saved edits first, then the server
  async renameItem(old, to) {
    const ed = this.ed, e = ed.e;
    to = (to || '').trim();
    if (!to || to === old || this.reference) return;
    if (!ID.test(to)) { ed.notice('Id: lower case letters, digits or _, starting with a letter.', 'warn'); ed.panel.refresh(['inspector']); return; }
    if (e.game.items?.[to]) { ed.notice(`There is an item "${to}" already.`, 'warn'); ed.panel.refresh(['inspector']); return; }
    if ([...ed.docs.values()].some(d => d.dirty().length)) {
      if (!confirm('Renaming changes files on disk: save the unsaved edits first?')) { ed.panel.refresh(['inspector']); return; }
      const res = await ed.save();
      if (!Array.isArray(res) || res.some(x => !x.ok)) return;
    }
    const r = await api.renameItem({ id: old, to });
    if (r.status !== 200) { ed.notice(`Rename: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); ed.panel.refresh(['inspector']); return; }
    for (const f of r.data.files) if (f.startsWith('rooms/')) await this.reloadRoom(f.slice(6, -3));
    await this.reloadItems();
    e.state.inv = e.state.inv.map(x => x === old ? to : x);
    ed.select({ kind: 'item', id: to });
    ed.status(`Item "${old}" is now "${to}" (${r.data.files.join(', ')}).`);
    if (r.data.code.length) ed.notice(`Hand-written code still says "${old}": edit it in the source.`, 'warn', null, r.data.code.join('\n'));
  }

  // an object's states (pictures): add / replace an image, default state, show now, delete
  async stateAction(o, act, k) {
    const ed = this.ed, room = ed.room, e = ed.e, P = `objects[id=${o.id}]`;
    const states = JSON.parse(JSON.stringify(o.states || {}));
    if (act === 'default') return ed.edit('default state', [{ path: `${P}.state`, after: k }]);
    if (act === 'show') { e.api.setState(o.id, k); ed.hitmap.invalidate(); ed.panel.refresh(['inspector']); return; }
    if (act === 'del') {
      if (!confirm(`Remove the state "${k}"? (Its picture file stays in the project.)`)) return;
      delete states[k];
      const left = Object.keys(states);
      return ed.edit('remove state', [{ path: `${P}.states`, after: left.length ? states : undefined },
        { path: `${P}.state`, after: o.state === k ? left[0] : o.state }]);
    }
    let key = k;
    if (act === 'add') {
      const keys = Object.keys(states);
      const guess = !keys.length ? 'closed' : !keys.includes('open') ? 'open' : `state${keys.length + 1}`;
      const v = await this.form('New state', [
        { name: 'name', label: 'Name', value: guess, check: n => /^[A-Za-z][\w]*$/.test(n) ? (states[n] ? 'This state exists.' : null) : 'A name: letters, digits, _.' },
        { name: 'image', label: 'Picture', type: 'file', accept: 'image/*', hint: 'PNG with transparency, 4x art. None: the state shows nothing (e.g. a taken item).' },
      ], 'Add state');
      if (!v) return;
      key = v.name;
      const base = Object.values(states).find(st => st && typeof st.img === 'string');
      const [x, y] = base ? [base.x, base.y] : (o.box || [Math.round(ed.camX + W / 2) - 40, 200]);
      if (!v.image) states[key] = null;
      else {
        const rel = `rooms/${room.id}/${o.id}_${key}.png`;
        if (!await this.uploadImage(rel, v.image)) return;
        states[key] = { img: rel, x, y };
      }
      const ops = [{ path: `${P}.states`, after: states }];
      if (o.state == null) ops.push({ path: `${P}.state`, after: key });
      return ed.edit('add state', ops);
    }
    if (act === 'img') {
      const file = await pickFile('image/*');
      if (!file) return;
      const rel = states[key]?.img;
      if (typeof rel !== 'string') return;
      if (await this.uploadImage(rel, await readDataUrl(file))) { ed.hitmap.invalidate(); ed.panel.refresh(['inspector']); }
    }
  }

  // "Load image…" anywhere: a new picture for an object's current state (or its first), an item, a character
  // (one-picture costumes), the room's background
  async loadImage(kind, id) {
    const ed = this.ed, e = ed.e;
    if (kind === 'object') {
      const o = ed.room.objects.get(id);
      if (!o) return;
      const sts = o.states && typeof o.states === 'object' ? o.states : {};
      const k = o.state != null && sts[o.state]?.img ? o.state : Object.keys(sts).find(x => sts[x]?.img);
      return this.stateAction(o, k ? 'img' : 'add', k);
    }
    if (kind === 'item') return this.itemIcon(id);
    if (kind === 'background') return this.background();
    if (kind === 'character') {
      if (this.reference) return;
      const file = await pickFile('image/*');
      if (!file) return;
      const r = await api.actorImage({ id, image: await readDataUrl(file) });
      if (r.status !== 200) { ed.notice(`Character picture: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return; }
      await this.reloadCharacter(id);
      ed.panel.refresh();
      ed.status(`${id}: new picture (the old one is in .trash/editor_backups).`);
    }
  }

  // a picture character's poses: which way the picture faces (the other side is mirrored), its talking picture
  async actorPose(id, body, msg) {
    const ed = this.ed;
    const r = await api.actorPose({ id, ...body });
    if (r.status !== 200) { ed.notice(`Character: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return; }
    await this.reloadCharacter(id);
    ed.panel.refresh();
    if (msg) ed.status(msg);
  }

  async talkPicture(id) {
    const file = await pickFile('image/*');
    if (!file) return;
    await this.actorPose(id, { talk: await readDataUrl(file) }, `${id}: talking picture (talking switches between the two).`);
  }

  // a character's costume again (its picture and sizes changed on disk)
  async reloadCharacter(id) {
    const e = this.ed.e, def = e.game.actors[id], a = e.actors.get(id);
    if (!def?.costume || !a) return;
    const base = e.path(def.costume);
    for (const c of Object.values(a.costume?.cels || {})) forget(base + '/' + c.file);
    for (const f of ['cels/0000.png', 'cels/0001.png']) forget(base + '/' + f);     // a picture character's (new) pictures
    forget(base + '/actor.json');
    a.costume = await Costume.load(base);
    if (a.room) e.placeActors(e.rooms.get(a.room));
  }

  async uploadImage(rel, dataUrl) {
    const ed = this.ed;
    const r = await api.upload({ path: rel, data: dataUrl });
    if (r.status !== 200) { ed.notice(`Image: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return false; }
    forget(ed.e.path(rel));
    await preload([ed.e.path(rel)]);
    ed.status(`Image ${rel} saved${r.data.backup ? ' (the old one is in ' + r.data.backup + ')' : ''}.`);
    return true;
  }

  async background() {
    const ed = this.ed, room = ed.room;
    if (this.reference) { ed.notice("License to Pillage's backgrounds are not replaced from the editor.", 'warn'); return; }
    const file = await pickFile('image/*');
    if (!file) return;
    const r = await api.background({ room: room.id, image: await readDataUrl(file) });
    if (r.status !== 200) { ed.notice(`Background: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return; }
    const p = ed.e.path(room.def.layers[0].img);
    forget(p);
    ed.e.gfx?.lo?.pal?.rooms.delete(room.id);
    await preload([p]);
    ed.status(`Background replaced${r.data.backup ? ' (the old one is in ' + r.data.backup + ')' : ''}.`);
  }
  // ------------------------------------------------------------ sound: music, sound effects, a room's ambience
  // (files go to music/ and sfx/ as mp3, converted on the server; game.js gets the entry)
  async addSound(kind, name = null) {
    const ed = this.ed, e = ed.e;
    if (this.reference) return;
    const file = await pickFile('audio/*,.mp3,.ogg,.wav,.m4a,.flac');
    if (!file) return;
    const have = kind === 'music' ? e.game.music || {} : e.game.sfx || {};
    if (!name) {
      const v = await this.form(kind === 'music' ? 'New music' : 'New sound', [
        { name: 'name', label: 'Name', value: slug(file.name.replace(/\.\w+$/, '')) || kind,
          check: n => ID.test(n) ? (have[n] ? 'That name is taken.' : null) : 'A name: lower case letters, digits or _, starting with a letter.' },
      ], 'Add', `${esc(file.name)} (${Math.round(file.size / 1024)} KB)${/\.mp3$/i.test(file.name) ? '' : ': made mp3'}`);
      if (!v) return;
      name = v.name;
    }
    ed.status(`Adding ${file.name}…`);
    const r = await api.sound({ kind, name, data: await readDataUrl(file) });
    if (r.status !== 200) { ed.notice(`Sound: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return null; }
    forget(e.path(r.data.file));
    if (kind !== 'ambience') await this.reloadItems();
    // the replaced track playing now: again, from the new file
    if (kind === 'music' && e.audio.music?.path === e.path(r.data.file)) { e.audio.stopMusic(0.2); e.api.music(name); }
    ed.status(`${kind === 'music' ? 'Music' : 'Sound'} "${name}": ${r.data.file}${r.data.converted ? ' (converted to mp3)' : ''}.`);
    return r.data;
  }

  async removeSound(kind, name) {
    const ed = this.ed;
    if (this.reference || !confirm(`Remove the ${kind === 'music' ? 'music' : 'sound'} "${name}" from the game? (Its file goes to .trash/editor_backups.)`)) return;
    const r = await api.soundRemove({ kind, name });
    if (r.status !== 200) { ed.notice(`Sound: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return; }
    await this.reloadItems();
    ed.status(`Removed "${name}".`);
  }

  // the room's music (a name from the game's music) and ambience (a looping sound file): undoable room edits
  roomMusic(name) {
    const ed = this.ed, e = ed.e;
    if (ed.edit('room music', [{ path: 'music', after: name || undefined }])) {
      if (name) e.api.music(name); else e.api.stopMusic();
    }
  }

  async roomAmbience(clear) {
    const ed = this.ed, e = ed.e, room = ed.room;
    if (clear) { if (ed.edit('ambience', [{ path: 'ambience', after: undefined }])) e.audio.playAmbience(null); return; }
    const r = await this.addSound('ambience', room.id);
    if (!r) return;
    ed.edit('ambience', [{ path: 'ambience', after: r.file }]);
    e.audio.playAmbience(null);
    e.audio.playAmbience(e.path(r.file));
  }
}

export function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

function pickFile(accept) {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = () => resolve(inp.files[0] || null);
    inp.click();
  });
}
