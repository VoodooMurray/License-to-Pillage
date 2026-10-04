// ComfyUI in the level editor (tools/ai_api.py, tools/ai_gen.py): ideas for a new object in an area of the room, an
// item, a character or a background, and repainting a picture, whole or a part of it. Each run makes several
// candidates; the window shows them as they arrive: Use one (written into the game at once, old pictures backed up),
// keep any for later (the library), or ask for more. The ComfyUI address is a setting (default 127.0.0.1:8188).

import { api, getProject } from './api.js';
import { forget, preload } from '../assets.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KEY = 'cmi-levels:comfy';
export const DEFAULT_COMFY = 'http://127.0.0.1:8188';

export class AI {
  constructor(ed) { this.ed = ed; }

  get url() { return localStorage.getItem(KEY) || DEFAULT_COMFY; }

  async settings() {
    const ed = this.ed, p = ed.project;
    const v = await p.form('ComfyUI', [
      { name: 'url', label: 'Address', value: this.url, placeholder: DEFAULT_COMFY, hint: 'Where your ComfyUI server runs. Default ' + DEFAULT_COMFY,
        check: u => /^https?:\/\/[A-Za-z0-9.\-]+(:\d{1,5})?\/?$/.test(u) ? null : 'http://host:port' },
    ], 'Save', 'Generation (objects, items, characters, backgrounds, repaint) uses Flux2 Klein, SAM 3 and BiRefNet on this ComfyUI.');
    if (!v) return;
    localStorage.setItem(KEY, v.url.replace(/\/$/, ''));
    const r = await api.ai('/status', { comfy: this.url });
    if (r.data?.ok) ed.notice(`ComfyUI at ${r.data.url}: ${r.data.gpu || 'connected'}, ${r.data.vram_free_mb} MB free.`);
    else ed.notice(`ComfyUI at ${this.url} does not answer: ${r.data?.error || 'HTTP ' + r.status}`, 'error');
  }

  guard() {
    if (!getProject()) { this.ed.notice('Generation works in games of your own (License to Pillage is the reference project).', 'warn'); return false; }
    return true;
  }

  // ------------------------------------------------------------ entry points
  async newObject() {
    if (!this.guard()) return;
    const ed = this.ed;
    ed.setTool('select');
    const area = await ed.pickArea('Drag the area where the new object should go (Esc cancels).');
    if (!area) return;
    const v = await this.ask('New object here', 'a wooden treasure chest');
    if (v) this.start({ kind: 'object', mode: 'new', prompt: v.prompt, count: v.count, room: ed.room.id, area }, `Object: ${v.prompt}`);
  }

  async newItem() {
    if (!this.guard()) return;
    const v = await this.ask('New inventory item', 'a brass compass');
    if (v) this.start({ kind: 'item', mode: 'new', prompt: v.prompt, count: v.count }, `Item: ${v.prompt}`);
  }

  async newCharacter() {
    if (!this.guard()) return;
    const v = await this.ask('New character', 'a fat pirate cook with an apron and a ladle',
      [{ name: 'height', label: 'Height at full size (Guybrush ≈ 280)', type: 'number', value: 280, min: 60, max: 480, step: 10 }]);
    if (v) this.start({ kind: 'character', mode: 'new', prompt: v.prompt, count: v.count }, `Character: ${v.prompt}`, { height: v.height });
  }

  async newBackground() {
    if (!this.guard()) return;
    const v = await this.ask('New background', 'a jungle clearing with a small wooden hut and a rope bridge',
      [{ name: 'style', label: "Use this room's picture as a guide (1: a variation of it, keeps its layout; 0: a new place)", type: 'number', value: 0, min: 0, max: 1 }]);
    if (v) this.start({ kind: 'background', mode: 'new', prompt: v.prompt, count: v.count, room: this.ed.room.id, style: !!v.style }, `Background: ${v.prompt}`);
  }

  // a full-screen card (game.cards.<id>): the title lettering painted into the picture when given
  async newCard(id) {
    if (!this.guard()) return;
    const e = this.ed.e;
    const dflt = id === 'title' ? (e.game.title || e.game.name || '') : id === 'the_end' ? 'THE END' : id.replace(/_/g, ' ').toUpperCase();
    const v = await this.ask(`Card: ${id}`, 'a moonlit pirate ship anchored in a cove, seen from the cliffs',
      [{ name: 'title', label: 'Title lettering in the picture (empty: none)', value: dflt }]);
    if (v) this.start({ kind: 'card', mode: 'new', prompt: v.prompt, count: v.count, card: id, title: v.title }, `Card ${id}: ${v.prompt}`);
  }

  // one consistent interface set: the verb coin's four states (one strip generation), cursor + hot +
  // hourglass, one arrow turned into every direction, the chest screen (theme.json; 5 generations per idea)
  async newTheme() {
    if (!this.guard()) return;
    const v = await this.ask('A whole interface set', 'carved dark wood with brass fittings, nautical', [], '', 2);
    if (v) this.start({ kind: 'theme', mode: 'new', prompt: v.prompt, count: v.count }, `Interface: ${v.prompt}`);
  }

  // ✨ New… under a picture: a fresh picture of an existing item / hotspot / character from a description alone (not
  // made from the old picture, unlike Repaint); Use puts it in place of the old one. A hotspot's is painted into the
  // room where its picture (else its box) is.
  async newFor(kind, id) {
    if (!this.guard()) return;
    const ed = this.ed, e = ed.e, room = ed.room;
    let name = id, extra = {};
    if (kind === 'item') name = e.itemName(id);
    else if (kind === 'character') name = e.game.actors?.[id]?.name || id;
    else if (kind === 'object') {
      const o = room.objects.get(id);
      if (!o) return;
      name = typeof o.name === 'string' ? o.name : id;
      const sp = room.objSprite(e, o);
      let area = sp?.img ? [sp.x, sp.y, sp.w, sp.h] : o.box || null;
      if (!area) { area = await ed.pickArea(`Drag the area for the new picture of ${name} (Esc cancels).`); if (!area) return; }
      extra = { room: room.id, area: area.map(Math.round) };
    }
    const v = await this.ask(`New picture: ${name}`, 'a brass spyglass', [], /^(a|an|the|some)\s/i.test(name) ? name : `a ${name}`);
    if (v) this.start({ kind, mode: 'new', prompt: v.prompt, count: v.count, ...extra, replace: { kind, id, room: room?.id } }, `New picture of ${name}: ${v.prompt}`);
  }

  // repaint a picture (whole: region null) or a part of it (region: picked in the room or on the preview)
  async repaint(kind, id, part) {
    if (!this.guard()) return;
    const ed = this.ed, room = ed.room;
    const target = { kind, id, room: room.id };
    let region = null;
    if (kind === 'object') {
      const o = room.objects.get(id), st = o?.states?.[o.state] || Object.values(o?.states || {}).find(s => s?.img);
      if (!st?.img) { ed.notice('This hotspot has no picture yet (Pictures → + State, or ✨ Object… in the hotspot list).', 'warn'); return; }
      target.state = o.state;
      if (part) {
        const a = await ed.pickArea('Drag over the part of the picture to repaint (Esc cancels).');
        if (!a) return;
        region = [(a[0] - st.x) * 4, (a[1] - st.y) * 4, a[2] * 4, a[3] * 4];
      }
    } else if (kind === 'background') {
      if (part) {
        const a = await ed.pickArea('Drag over the part of the background to repaint (Esc cancels).');
        if (!a) return;
        region = a.map(v => v * 4);
      }
    } else if (part) {
      region = await this.pickOnPreview();
      if (!region) return;
    }
    const v = await this.ask(part ? 'Repaint a part' : 'Repaint', part ? 'a small campfire with a cooking pot' : 'make it look older and rusty');
    if (v) this.start({ kind, mode: part ? 'inpaint' : 'repaint', prompt: v.prompt, count: v.count, target, region }, `${part ? 'Repaint a part' : 'Repaint'}: ${v.prompt}`);
  }

  // a talking picture for a character made from a picture: its standing picture with the mouth open
  async talkPicture(id) {
    if (!this.guard()) return;
    const v = await this.ask('Talking picture', 'the same character with the mouth open', [],
      'the same character, same pose and clothes, with the mouth open as if talking');
    if (v) this.start({ kind: 'character', mode: 'repaint', prompt: v.prompt, count: v.count, target: { kind: 'character', id, room: this.ed.room?.id, pose: 'talk' } }, `Talking picture: ${v.prompt}`);
  }

  // a rectangle dragged on the inspector's picture -> picture px
  pickOnPreview() {
    const img = document.querySelector('#ed-inspector .ed-preview img');
    if (!img) return Promise.resolve(null);
    this.ed.status('Drag over the part of the picture to repaint (Esc cancels).');
    return new Promise(resolve => {
      const box = img.parentElement;
      const sel = document.createElement('div');
      sel.className = 'ed-psel';
      box.style.position = 'relative';
      box.append(sel);
      img.style.cursor = 'crosshair';
      let p0 = null;
      const done = r => { img.onpointerdown = img.onpointermove = img.onpointerup = null; window.removeEventListener('keydown', key, true); sel.remove(); img.style.cursor = ''; resolve(r); };
      const key = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); done(null); } };
      window.addEventListener('keydown', key, true);
      const at = ev => { const r = img.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top, r]; };
      img.ondragstart = () => false;
      img.onpointerdown = ev => { ev.preventDefault(); img.setPointerCapture(ev.pointerId); p0 = at(ev); };
      img.onpointermove = ev => {
        if (!p0) return;
        const [x, y] = at(ev), r = p0[2], br = box.getBoundingClientRect();
        Object.assign(sel.style, { left: r.left - br.left + Math.min(p0[0], x) + 'px', top: r.top - br.top + Math.min(p0[1], y) + 'px', width: Math.abs(x - p0[0]) + 'px', height: Math.abs(y - p0[1]) + 'px' });
      };
      img.onpointerup = ev => {
        if (!p0) return;
        const [x, y, r] = at(ev), k = img.naturalWidth / r.width;
        const rect = [Math.min(p0[0], x) * k, Math.min(p0[1], y) * k, Math.abs(x - p0[0]) * k, Math.abs(y - p0[1]) * k].map(Math.round);
        done(rect[2] >= 8 && rect[3] >= 8 ? rect : null);
      };
    });
  }

  ask(title, placeholder, extra = [], value = '', count = 6) {
    return this.ed.project.form(title, [
      { name: 'prompt', label: 'Describe it', type: 'textarea', placeholder, value },
      { name: 'count', label: 'How many ideas', type: 'number', value: count, min: 1, max: 10 },
      ...extra,
    ], 'Generate', `On ComfyUI at ${esc(this.url)} (⚙ to change). Each idea takes a few seconds.`).then(v => v && (v.prompt ? v : null));
  }

  // ------------------------------------------------------------ a run and its window
  async start(spec, title, useOpts = {}) {
    const ed = this.ed;
    const r = await api.ai('/generate', { comfy: this.url, ...spec });
    if (r.status !== 200) { ed.notice(`Generate: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return; }
    this.window(r.data.job, spec, title, useOpts);
  }

  window(job, spec, title, useOpts) {
    const ed = this.ed;
    const box = document.createElement('div');
    box.className = 'ed-modal';
    box.innerHTML = `<div class="ed-dialog ed-gen"><h2>${esc(title)}</h2><div class="ed-row ed-dim ed-genstate">Starting…</div>
      <div class="ed-cands"></div>
      <div class="ed-buttons"><button data-g="more">More ideas</button><button data-g="stop">Stop</button><button data-g="close" class="ed-primary">Close</button></div></div>`;
    document.getElementById('ed').append(box);
    box.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Escape') close(); });
    const state = box.querySelector('.ed-genstate'), grid = box.querySelector('.ed-cands');
    let alive = true, shown = 0, cur = job;
    const close = () => { alive = false; box.remove(); };
    const poll = async () => {
      if (!alive) return;
      const r = await api.aiJob(cur);
      if (r.status !== 200) { state.textContent = r.data?.error || 'lost the job'; return; }
      const d = r.data;
      for (const cd of d.candidates.slice(shown)) grid.append(this.card(cd, spec, cur, useOpts, close));
      shown = d.candidates.length;
      const each = d.done ? Math.round(d.seconds / d.done) : null;
      state.textContent = d.status === 'error' ? `Failed: ${d.error}` : d.status === 'running' || d.status === 'queued'
        ? `${d.done} of ${d.total} ideas${each ? ` (about ${each} s each)` : ''}…${d.errors.length ? ' · ' + d.errors.length + ' failed' : ''}`
        : `${d.done} idea${d.done === 1 ? '' : 's'}${d.status === 'cancelled' ? ' (stopped)' : ''}. Use one, keep any for later, or ask for more.`;
      if (d.status === 'running' || d.status === 'queued') setTimeout(poll, 1000);
    };
    box.addEventListener('click', async ev => {
      const b = ev.target.closest('[data-g]');
      if (!b) return;
      if (b.dataset.g === 'close') close();
      else if (b.dataset.g === 'stop') api.ai(`/job/${cur}/cancel`, {});
      else if (b.dataset.g === 'more') {
        const r = await api.ai('/generate', { comfy: this.url, ...spec });
        if (r.status === 200) { cur = r.data.job; shown = 0; poll(); }
      }
    });
    poll();
  }

  card(cd, spec, job, useOpts, close) {
    const ed = this.ed, el = document.createElement('div');
    el.className = 'ed-cand';
    const bg = spec.kind === 'background' && spec.mode === 'new';
    el.innerHTML = `<img src="${esc(cd.preview)}?t=${Date.now()}" alt="">
      <div class="ed-buttons">${bg ? '<button data-u="here">Use here</button><button data-u="room">New room</button>' : '<button data-u="use">Use</button>'}${spec.kind === 'theme' ? '' : '<button data-u="keep">Keep for later</button>'}</div>`;
    el.addEventListener('click', async ev => {
      const b = ev.target.closest('[data-u]');
      if (!b || b.disabled) return;
      b.disabled = true;
      if (b.dataset.u === 'keep') {
        const r = await api.ai(`/job/${job}/keep`, { i: cd.i });
        if (r.status === 200) { b.textContent = 'Kept ✓'; ed.project.loadLibrary(); } else { b.disabled = false; ed.notice(`Keep: ${r.data?.error}`, 'error'); }
        return;
      }
      let body = { i: cd.i, comfy: this.url, ...useOpts };
      if (b.dataset.u === 'room') {
        const v = await ed.project.form('New room from this background', [
          { name: 'name', label: 'Name', value: '' },
          { name: 'id', label: 'Id', check: k => /^[a-z][a-z0-9_]{0,40}$/.test(k) ? (ed.e.rooms.has(k) ? 'A room with this id exists.' : null) : 'Id: lower case letters, digits or _.' },
        ], 'Create room');
        if (!v) { b.disabled = false; return; }
        body.newRoom = { id: v.id, name: v.name || v.id };
      } else if (b.dataset.u === 'here') body.room = ed.room.id;
      const r = await ed.holdPoll(() => api.ai(`/job/${job}/use`, body));
      if (r.status !== 200) { b.disabled = false; ed.notice(`Use: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); return; }
      if (r.data.pending) { b.textContent = 'Making it full size…'; this.finishBackground(job, body, close); return; }
      close();
      await this.applied(r.data, spec);
    });
    return el;
  }

  // a background is made full size (4x) on ComfyUI after it is picked: wait for it
  async finishBackground(job, body, close) {
    const ed = this.ed;
    ed.status('Making the background full size (about a minute)…');
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      const r = await api.aiJob(job);
      const u = r.data?.use;
      if (u?.status === 'error') { ed.notice(`Background: ${u.result?.error}`, 'error'); return; }
      if (u?.status === 'done') break;
    }
    close();
    if (body.newRoom) { ed.project.go(getProject(), body.newRoom.id); return; }
    await this.refreshBackground();
    ed.status('New background in place (the old one is in .trash/editor_backups).');
  }

  async refreshBackground() {
    const ed = this.ed, p = ed.e.path(ed.room.def.layers[0].img);
    forget(p);
    ed.e.gfx?.lo?.pal?.rooms.delete(ed.room.id);
    await preload([p]);
    ed.panel.refresh(['doc']);
  }

  // after Use: bring the editor up to date
  applied(res, spec) { return this.ed.holdPoll(() => this._applied(res, spec)); }

  async _applied(res, spec) {
    const ed = this.ed, pj = ed.project;
    if (res.replaced || spec.mode !== 'new') {
      if (res.kind === 'background') await this.refreshBackground();
      else if (res.kind === 'object' && res.room) {
        // ✨ New… of a hotspot: its state's picture and position changed in the room file
        const p = ed.e.path(res.path);
        forget(p);
        await preload([p]);
        const doc = ed.docs.get(res.room);
        if (doc && await doc.load()) { await doc.hotSwap(); doc.prune(); doc.resetHistory(); doc.persist(); }
        ed.hitmap.invalidate();
      }
      else if (res.kind === 'character') await pj.reloadCharacter((spec.target || spec.replace).id);
      else { const p = ed.e.path(res.path); forget(p); ed.e.hotIcons?.delete(p); await preload([p]); ed.hitmap.invalidate(); }
      ed.panel.refresh();
      ed.status(`${spec.replace ? 'New picture' : 'Repainted'} (the old one is in .trash/editor_backups).`);
      return;
    }
    if (res.kind === 'theme') {
      ed.project.theme = res.theme || {};
      await ed.e.reloadTheme();
      ed.identityOpen = true;
      ed.status('The new interface is on (theme.json; the replaced pieces are in .trash/editor_backups).');
      ed.panel.refresh(['identity']);
      return;
    }
    if (res.kind === 'card') {
      await ed.project.cardChanged(res.card, res.path);
      ed.identityOpen = true;
      ed.status(`Card ${res.card} is in (the old picture is in .trash/editor_backups).`);
      ed.panel.refresh(['identity']);
      return;
    }
    if (res.kind === 'object') {
      const doc = ed.doc;
      if (await doc.load()) { await doc.hotSwap(); doc.prune(); doc.resetHistory(); doc.persist(); }
      ed.setTool('select');
      ed.select({ kind: 'object', id: res.id });
      ed.status(`New object "${res.id}" (its picture: rooms/${res.room}/${res.id}.png). Give it texts and actions in the inspector.`);
    } else if (res.kind === 'item') {
      await pj.reloadItems();
      ed.itemsOpen = true;
      ed.select({ kind: 'item', id: res.item });
    } else if (res.kind === 'character') {
      await pj.reloadItems();
      await pj.ensureActor(res.actor);
      ed.charsOpen = true;
      ed.select({ kind: 'character', id: res.actor });
      ed.status(`New character "${res.actor}": Place here puts them in the room.`);
    }
    ed.panel.refresh();
  }
}
