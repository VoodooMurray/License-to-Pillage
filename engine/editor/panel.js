// The editor's side panel: document state (save / revert / last diff), notices (recovery, conflicts,
// changes on disk), the inspector of the selection, the hotspot list, problems and the key reference.
// Plain DOM, re-rendered from the editor state; one delegated click/change handler (data-act).

import { colorFor, rgba, DIRS, insidePoint } from './geom.js';
import { assetUrl } from '../assets.js';
import { ARRIVAL_COLORS } from './overlay.js';
import { writable, ghost } from './arrivals.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const chip = key => `<i class="ed-chip" style="background:${rgba(colorFor(key))}"></i>`;

export class Panel {
  constructor(ed, root) {
    this.ed = ed;
    this.root = root;
    root.innerHTML = `
      <div id="ed-notices"></div>
      <section id="ed-doc"></section>
      <section id="ed-inspector"></section>
      <section id="ed-list"></section>
      <section id="ed-arrivals"></section>
      <section id="ed-items"></section>
      <section id="ed-chars"></section>
      <section id="ed-sound"></section>
      <section id="ed-identity"></section>
      <section id="ed-library"></section>
      <section id="ed-problems"></section>
      <section id="ed-keys"></section>`;
    this.parts = Object.fromEntries(['notices', 'doc', 'inspector', 'list', 'arrivals', 'items', 'chars', 'sound', 'identity', 'library', 'problems', 'keys'].map(k => [k, root.querySelector('#ed-' + k)]));
    root.addEventListener('click', ev => this.click(ev));
    root.addEventListener('change', ev => this.change(ev));
    root.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.matches('input')) ev.target.blur(); });
    this.parts.keys.innerHTML = KEYS;
    this.lastDiff = '';
  }

  refresh(which = ['doc', 'inspector', 'list', 'arrivals', 'items', 'chars', 'sound', 'identity', 'library', 'problems']) {
    const focused = document.activeElement?.closest?.('#ed-side') ? document.activeElement.dataset.key : null;
    for (const w of which) this['render_' + w]?.();
    if (focused) this.root.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  // ------------------------------------------------------------ sections
  render_doc() {
    const ed = this.ed, doc = ed.doc;
    if (!doc) { this.parts.doc.innerHTML = '<h2>Loading…</h2>'; return; }
    const n = doc.dirty().length;
    const others = [...ed.docs.values()].filter(d => d !== doc && d.dirty().length);
    const state = doc.offline ? `<span class="ed-bad">read-only: ${esc(doc.error)}</span>`
      : n ? `<span class="ed-dirty">${n} unsaved change${n > 1 ? 's' : ''}</span>` : '<span class="ed-ok">saved</span>';
    this.parts.doc.innerHTML = `
      <h2>${esc(doc.file)}</h2>
      <div class="ed-row ed-dim">${doc.sha ? 'sha ' + doc.sha.slice(0, 8) : ''} · ${state}</div>
      ${others.length ? `<div class="ed-row"><span class="ed-dirty">Also unsaved: ${others.map(d => esc(d.file.split('/').pop())).join(', ')}</span> <span class="ed-dim">(Save writes them too)</span></div>` : ''}
      <div class="ed-row ed-buttons">
        <button data-act="save" class="ed-primary" ${(n || others.length) && !doc.offline ? '' : 'disabled'}>Save <kbd>⌘S</kbd></button>
        <button data-act="revert" ${n ? '' : 'disabled'}>Revert</button>
        <button data-act="undo" ${doc.history.done.length ? '' : 'disabled'} title="${esc(doc.history.done.at(-1)?.label || '')}">Undo</button>
        <button data-act="redo" ${doc.history.undone.length ? '' : 'disabled'} title="${esc(doc.history.undone.at(-1)?.label || '')}">Redo</button>
      </div>
      ${this.lastDiff ? `<details class="ed-diff"><summary>Last save</summary><pre>${esc(this.lastDiff)}</pre></details>` : ''}
      ${typeof ed.room?.def.layers?.[0]?.img === 'string' ? `<img class="ed-bgthumb" src="${esc(assetUrl(ed.e.path(ed.room.def.layers[0].img)))}" alt="" title="${esc(ed.room.def.layers[0].img)}">
        ${this.imgTools(ed.e.path(ed.room.def.layers[0].img), 'background', ed.room.id, { why: ed.project.reference ? "License to Pillage's art is not replaced from the editor" : '' })}` : ''}
      ${ed.room ? this.roomSoundHtml() : ''}`;
  }

  // the room's music (one of the game's) and ambience (a looping sound)
  roomSoundHtml() {
    const ed = this.ed, def = ed.room.def, music = Object.keys(ed.e.game.music || {});
    const ok = ed.doc?.editable('music').ok, amb = typeof def.ambience === 'string' ? def.ambience : null;
    return `<div class="ed-fields ed-roomsound"><label>Music<select data-kind="roommusic" data-key="room:music" ${ok ? '' : 'disabled'}>
        <option value="">— none —</option>${music.map(m => `<option ${m === def.music ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        ${def.music && !music.includes(def.music) ? `<option selected>${esc(def.music)}</option>` : ''}</select></label>
      <span class="ed-lbl">Ambience</span><span class="ed-dim" title="${esc(amb || '')}">${amb ? esc(amb.split('/').pop()) : 'none'}</span>
      <span class="ed-buttons">${amb ? `<button data-act="sound-play" data-file="${esc(amb)}" title="Listen">▶</button>` : ''}<button data-act="room-amb" ${ed.project.reference ? 'disabled title="License to Pillage\'s sounds are not replaced from the editor"' : 'title="A looping sound for this room (waves, gulls...)"'}>${amb ? 'Load…' : '+ Ambience…'}</button>${amb ? '<button data-act="room-amb-clear" title="No ambience">✕</button>' : ''}</span></div>`;
  }

  render_list() {
    const ed = this.ed, room = ed.room;
    if (!room) { this.parts.list.innerHTML = ''; return; }
    const sel = ed.sel;
    const rows = [];
    for (const a of ed.e.actorsIn(room.id)) {
      if (a === ed.e.player) continue;
      const n = room.def.npcs?.[a.id];
      const on = sel?.kind === 'npc' && sel.id === a.id;
      rows.push(`<li class="${on ? 'on' : ''}" data-act="pick" data-kind="npc" data-id="${esc(a.id)}">${chip('actor:' + a.id)}
        <b>${esc(n?.name || a.def.name || a.id)}</b><span class="ed-tag">NPC</span>${n?.hot ? '' : '<span class="ed-tag ed-warn">no hot</span>'}</li>`);
    }
    for (const o of room.objects.values()) {
      const on = sel?.kind === 'object' && sel.id === o.id;
      const st = room.objState(ed.e, o.id);
      const shape = o.hot ? `poly ${o.hot.length}` : o.box ? 'box' : '—';
      const name = typeof o.name === 'function' ? o.id : o.name || o.id;
      rows.push(`<li class="${on ? 'on' : ''}${st.hidden ? ' ed-hidden' : ''}" data-act="pick" data-kind="object" data-id="${esc(o.id)}">${chip('object:' + o.id)}
        <b>${esc(name)}</b><span class="ed-id">${esc(o.id)}</span><span class="ed-tag">${shape}</span>
        ${o.hotZ != null ? `<span class="ed-tag">z ${o.hotZ}</span>` : ''}${o.exit ? `<span class="ed-tag ed-exit">→ ${esc(o.exit.room)}</span>` : ''}</li>`);
    }
    this.parts.list.innerHTML = `<h3>Hotspots <span class="ed-dim">${rows.length}</span><span class="ed-buttons"><button data-act="ai-object" ${ed.project.reference ? 'disabled' : ''} title="Generate: drag an area in the room, describe the object, pick one of the ideas (ComfyUI)">✨ Object…</button><button data-act="addhot" title="A new hotspot in the middle of the view (written to the room file at once)">+ Add</button></span></h3><ul class="ed-list">${rows.join('')}</ul>`;
    this.parts.list.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
  }

  // the ways into this room (arrivals.js): where Guybrush appears, by exit, entry, script, start
  render_arrivals() {
    const ed = this.ed, room = ed.room;
    if (!room) { this.parts.arrivals.innerHTML = ''; return; }
    const list = ed.arrivalList(), sel = ed.sel;
    const rows = list.map(a => {
      const bad = room.walk && !room.walk.inside([a.x, a.y]);
      return `<li class="${sel?.kind === 'arrival' && sel.key === a.key ? 'on' : ''}" data-act="pickarr" data-key="${esc(a.key)}"><i class="ed-chip" style="background:${ARRIVAL_COLORS[a.kind]}"></i>
        <b>${esc(a.label)}</b><span class="ed-id">${esc(a.sub || '')}</span><span class="ed-tag${bad ? ' ed-warn' : ''}">${Math.round(a.x)}, ${Math.round(a.y)} ${esc(a.dir)}</span></li>`;
    });
    this.parts.arrivals.innerHTML = `<details ${ed.arrivalsOpen !== false ? 'open' : ''}><summary data-act="section" data-flag="arrivalsOpen" data-sec="arrivals" data-default="true"><h3>Arrivals <span class="ed-dim">${rows.length}</span></h3></summary>
      <ul class="ed-list">${rows.join('') || '<li class="ed-dim">No way in yet: an exit in another room that leads here adds one.</li>'}</ul></details>`;
    this.parts.arrivals.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
  }

  render_items() {
    const ed = this.ed, e = ed.e, items = e.game.items || {};
    const rows = Object.entries(items).map(([id, it]) => {
      const name = typeof it.name === 'function' ? id : it.name || id;
      const has = e.state.inv.includes(id);
      return `<li class="${ed.sel?.kind === 'item' && ed.sel.id === id ? 'on' : ''}" data-act="pickitem" data-id="${esc(id)}"><img src="${esc(assetUrl(e.path(it.icon)))}" alt=""><b>${esc(name)}</b><span class="ed-id">${esc(id)}</span>
        <span class="ed-buttons"><button data-act="give" data-id="${esc(id)}" ${has ? 'disabled' : ''} title="Put it in Guybrush's inventory now (for testing in Play mode)">${has ? 'carried' : 'Give'}</button></span></li>`;
    });
    this.parts.items.innerHTML = `<details ${ed.itemsOpen ? 'open' : ''}><summary data-act="section" data-flag="itemsOpen" data-sec="items"><h3>Items <span class="ed-dim">${rows.length}</span>
      <span class="ed-buttons"><button data-act="ai-item" ${ed.project.reference ? 'disabled' : ''} title="Generate an item: describe it, pick one of the ideas (ComfyUI)">✨</button><button data-act="newitem" ${ed.project.reference ? 'disabled title="License to Pillage is the reference project"' : ''}>+ New item</button></span></h3></summary>
      <ul class="ed-list ed-items">${rows.join('') || '<li class="ed-dim">No items yet.</li>'}</ul></details>`;
  }

  // a hotspot's texts: plain strings are editable here, scripts stay in the source
  textHtml(o) {
    const ed = this.ed, e = ed.e;
    const field = (k, label, area) => {
      const v = o[k], path = ed.path(k);
      if (v != null && typeof v !== 'string') return `<div class="ed-row ed-dim">${label}: ${typeof v === 'function' ? 'scripted' : 'a list / table'} (edit in the source)</div>`;
      const voiced = typeof v === 'string' && e.voiceMap?.[`${e.game.player}|${v}`];
      const ph = k === 'name' ? o.id : k === 'look' ? "I don't see anything special about it. (the game's default)" : "(the game's default)";
      const input = area ? `<textarea rows="2" data-key="${esc(path)}" data-path="${esc(path)}" data-kind="text" placeholder="${esc(ph)}">${esc(v || '')}</textarea>`
        : `<input type="text" data-key="${esc(path)}" data-path="${esc(path)}" data-kind="text" value="${esc(v || '')}" placeholder="${esc(ph)}">`;
      return `<label class="ed-text"><span>${label}${voiced ? ' <em class="ed-warn" title="This line has a recorded voice; a changed text needs a new recording">voiced</em>' : ''}</span>${input}</label>`;
    };
    const sc = ed.scripts, H = (k, label) => sc.handlerHtml(ed.path(k), label, o[k], k === 'look' ? "I don't see anything special about it. (the game's default)" : "(the game's default)");
    return `<div class="ed-group"><div class="ed-gh">Text and actions</div>${field('name', 'Name')}${H('look', 'Look at')}${H('hand', 'Use / pick up')}${H('mouth', 'Talk / eat')}</div>
      ${this.useHtml(ed.path('use'), o.use)}`;
  }

  // what happens when an item is used on it (use: { item: handler })
  useHtml(path, use) {
    const ed = this.ed, items = Object.keys(ed.e.game.items || {});
    if (use != null && (typeof use !== 'object' || use.$fn)) return '';
    const rows = Object.keys(use || {}).filter(k => k !== '*').map(k => ed.scripts.handlerHtml(`${path}.${k}`, `Use ${ed.e.itemName(k)} on it`, use[k], '...'));
    const free = items.filter(k => !use || !(k in use));
    return `<div class="ed-group"><div class="ed-gh">Items used on it</div>${rows.join('') || '<div class="ed-row ed-dim">None: the game\'s default answer.</div>'}
      ${free.length ? `<div class="ed-addstep"><select data-kind="use-add" data-path="${esc(path)}"><option value="">+ item…</option>${free.map(k => `<option value="${esc(k)}">${esc(ed.e.itemName(k))}</option>`).join('')}</select></div>` : ''}</div>`;
  }

  // an object's pictures: one per state (a door: closed / open), the default state, positions
  statesHtml(o, sp) {
    const ed = this.ed, room = ed.room, e = ed.e;
    const head = `<div class="ed-gh">Pictures <span class="ed-dim">(states)</span><span class="ed-buttons"><button data-act="state-add" title="A picture for a state of this hotspot (PNG with transparency, 4x art: 4 px per screen pixel)">+ State…</button></span></div>`;
    if (o.states != null && (typeof o.states !== 'object' || o.states.$fn || o.states.$opaque)) return `<div class="ed-group">${head}<div class="ed-row ed-dim">Defined in the source.</div></div>`;
    const keys = Object.keys(o.states || {});
    if (!keys.length) return `<div class="ed-group">${head}<div class="ed-row ed-dim">None: the background shows. Steps can switch states (Object state).</div></div>`;
    const now = room.objState(e, o.id).state;
    const rows = keys.map(k => {
      const st = o.states[k];
      const pic = st && typeof st.img === 'string' ? `<img src="${esc(assetUrl(e.path(st.img)))}" alt="">` : '<span class="ed-dim">(nothing)</span>';
      const xy = st && typeof st.img === 'string' ? `${this.num(`objects[id=${o.id}].states`, `st:${k}:x`, st.x, 'x', 0.25)}${this.num(`objects[id=${o.id}].states`, `st:${k}:y`, st.y, 'y', 0.25)}` : '';
      return `<div class="ed-state${k === now ? ' on' : ''}"><label title="the state at the start of the game"><input type="radio" name="st-${esc(o.id)}" data-act="state-default" data-k="${esc(k)}" ${o.state === k ? 'checked' : ''}> <b>${esc(k)}</b></label>${pic}
        <div class="ed-fields">${xy}</div><span class="ed-buttons"><button data-act="state-show" data-k="${esc(k)}" title="Show this state now (the game's state, not saved)">Show</button>${st && typeof st.img === 'string' ? `<a class="ed-btn" href="${esc(e.path(st.img))}" download="${esc(st.img.split('/').pop())}" title="Save image">⤓</a>` : ''}${st ? `<button data-act="state-img" data-k="${esc(k)}" title="Load image…">Image…</button>` : ''}<button data-act="state-del" data-k="${esc(k)}">✕</button></span></div>`;
    });
    return `<div class="ed-group">${head}${rows.join('')}${sp ? `<div class="ed-row ed-dim">Drawn at z ${Math.round(sp.z)} (actors further down the screen are drawn in front).</div>` : ''}</div>`;
  }

  // characters of the game: costume, placed in this room or not; ★ = the player
  render_chars() {
    const ed = this.ed, e = ed.e, room = ed.room;
    if (!room) return;
    const ref = ed.project.reference, pid = e.game.player;
    const acts = Object.entries(e.game.actors || {}).filter(([id]) => !id.startsWith('_'));
    const rows = acts.map(([id, d]) => {
      const me = id === pid, here = room.def.actors?.[id];
      const t = this.charThumb(id);
      return `<li class="${(ed.sel?.kind === 'npc' || ed.sel?.kind === 'character') && ed.sel.id === id ? 'on' : ''}" data-act="pickchar" data-id="${esc(id)}">${t ? `<img src="${esc(assetUrl(t))}" alt="">` : chip('actor:' + id)}<b>${esc(d.name || id)}</b><span class="ed-id">${esc(id)}</span>
        <span class="ed-buttons">${me ? '<span class="ed-tag" title="The player (game.js player)">★ player</span>'
          : `${ref ? '' : `<button data-act="char-player" data-id="${esc(id)}" ${d.costume ? '' : 'disabled title="No costume"'} title="They become the main character (the web engine switches live; ScummVM still shows Guybrush)">★</button>`}${here ? '<span class="ed-tag">in this room</span>' : `<button data-act="place" data-id="${esc(id)}" ${d.costume ? '' : 'disabled title="No costume"'}>Place here</button>`}`}</span></li>`;
    });
    this.parts.chars.innerHTML = `<details ${ed.charsOpen ? 'open' : ''}><summary data-act="section" data-flag="charsOpen" data-sec="chars"><h3>Characters <span class="ed-dim">${rows.length}</span>
      <span class="ed-buttons"><button data-act="ai-character" ${ed.project.reference ? 'disabled' : ''} title="Generate a character: describe them, pick one of the ideas (ComfyUI)">✨</button><button data-act="newchar" ${ed.project.reference ? 'disabled title="License to Pillage is the reference project"' : ''}>+ Character</button></span></h3></summary>
      <ul class="ed-list ed-items">${rows.join('') || '<li class="ed-dim">Nobody yet.</li>'}</ul></details>`;
  }

  // the game's music and sound effects: listen, replace, remove, add
  render_sound() {
    const ed = this.ed, e = ed.e, ref = ed.project.reference;
    const rooms = [...e.rooms.values()];
    const row = (kind, name, v) => {
      const file = typeof v === 'string' ? v : v?.file;
      const used = kind === 'music' ? rooms.filter(r => r.def.music === name).map(r => r.id) : [];
      const playing = this.playing === file;
      return `<li><span class="ed-buttons"><button data-act="sound-play" data-file="${esc(file || '')}" title="${playing ? 'Stop' : 'Listen'}">${playing ? '■' : '▶'}</button></span>
        <b title="${esc(file || '')}">${esc(name)}</b>${used.length ? `<span class="ed-tag" title="the rooms it plays in">${used.map(esc).join(', ')}</span>` : ''}
        <span class="ed-buttons">${file ? `<a class="ed-btn" href="${esc(e.path(file))}" download title="Save the file">⤓</a>` : ''}<button data-act="sound-load" data-kind="${kind}" data-name="${esc(name)}" ${ref ? 'disabled' : ''} title="Replace it with a file from your computer">Load…</button><button data-act="sound-del" data-kind="${kind}" data-name="${esc(name)}" ${ref ? 'disabled' : ''} title="Remove it from the game">✕</button></span></li>`;
    };
    const music = Object.entries(e.game.music || {}), sfx = Object.entries(e.game.sfx || {});
    this.parts.sound.innerHTML = `<details ${ed.soundOpen ? 'open' : ''}><summary data-act="section" data-flag="soundOpen" data-sec="sound"><h3>Sound <span class="ed-dim">${music.length} music · ${sfx.length} sounds</span></h3></summary>
      <div class="ed-gh">Music <span class="ed-buttons"><button data-act="sound-add" data-kind="music" ${ref ? 'disabled title="License to Pillage is the reference project"' : 'title="A music track (mp3, ogg, wav...): rooms play it (Music under the background) or a Play music step"'}>+ Music…</button></span></div>
      <ul class="ed-list ed-sound">${music.map(([k, v]) => row('music', k, v)).join('') || '<li class="ed-dim">No music yet.</li>'}</ul>
      <div class="ed-gh">Sounds <span class="ed-buttons"><button data-act="sound-add" data-kind="sfx" ${ref ? 'disabled title="License to Pillage is the reference project"' : 'title="A sound effect, played by a Sound step"'}>+ Sound…</button></span></div>
      <ul class="ed-list ed-sound">${sfx.map(([k, v]) => row('sfx', k, v)).join('') || '<li class="ed-dim">No sounds yet.</li>'}</ul></details>`;
  }

  // listen to a sound file in the panel (again: stop); not through the game's (muted while editing) mixer
  listen(file) {
    if (this.audioEl) { this.audioEl.pause(); this.audioEl = null; }
    const was = this.playing;
    this.playing = null;
    if (file && file !== was) {
      const el = this.audioEl = new Audio(assetUrl(this.ed.e.path(file)));
      this.playing = file;
      el.onended = () => { if (this.audioEl === el) { this.playing = null; this.refresh(['sound']); } };
      el.play().catch(() => { this.playing = null; this.refresh(['sound']); });
    }
    this.refresh(['sound']);
  }

  // the game's identity: the art style pack (style.json) every ✨ generation paints in, and the
  // interface theme (theme.json: verb coin, cursors, exit arrows, chest, colors) with CMI as the fallback
  render_identity() {
    const ed = this.ed, ref = ed.project.reference, st = ed.project.style || {};
    const refs = st.refs || [];
    const body = ref ? '<div class="ed-row ed-dim">License to Pillage keeps the CMI look.</div>'
      : `<div class="ed-gh">Art style <span class="ed-dim">every ✨ paints in it</span></div>
        <div class="ed-row"><textarea class="ed-style" data-kind="style-prompt" data-key="game:style" rows="3"
          placeholder="Empty: the CMI look. Or your own, e.g. 'in the style of a 1980s Saturday-morning cartoon: flat cel shading, bold outlines, muted colours'">${esc(st.prompt || '')}</textarea></div>
        <div class="ed-row ed-buttons ed-stylerefs">${refs.map((r, i) => `<span class="ed-styleref"><img src="${esc(assetUrl(ed.e.path(r)))}" alt="" title="${esc(r)}"><button data-act="style-ref-del" data-i="${i}" title="Remove this reference picture">✕</button></span>`).join('')}
          ${refs.length < 4 ? '<button data-act="style-ref-add" title="A picture in your style: generations copy its look (the first one leads; it also replaces Guybrush as the character reference)">+ Reference…</button>' : ''}</div>
        ${this.cardsHtml()}
        ${this.themeHtml()}`;
    const own = [st.prompt || refs.length ? 'own style' : '', Object.keys(ed.project.theme || {}).length ? 'own interface' : ''].filter(Boolean).join(' · ');
    this.parts.identity.innerHTML = `<details ${ed.identityOpen ? 'open' : ''}><summary data-act="section" data-flag="identityOpen" data-sec="identity"><h3>Game <span class="ed-dim">${own || 'CMI style'}</span></h3></summary>${body}</details>`;
  }

  standaloneHtml() {
    const r = this.ed.project.standalone;
    if (!r) return '';
    if (r.standalone) return `<div class="ed-row ed-standalone" title="No CMI anywhere: its own interface, fonts and characters. Export web gives a folder anyone may play.">✦ Standalone — shareable, nothing CMI-derived${r.unverified?.length ? ` <span class="ed-dim">(${r.unverified.length} file${r.unverified.length > 1 ? 's' : ''} the editor didn't make: check ${r.unverified.length > 1 ? 'they are' : 'it is'} yours)</span>` : ''}</div>`;
    const bits = [r.cmiReferences?.length ? `${r.cmiReferences.length} CMI reference${r.cmiReferences.length > 1 ? 's' : ''}` : '',
      r.themeMissing?.length ? `${r.themeMissing.length} interface piece${r.themeMissing.length > 1 ? 's' : ''} still CMI` : ''].filter(Boolean).join(' · ');
    return `<div class="ed-row ed-dim ed-standalone" title="${esc([...(r.cmiReferences || []), ...(r.themeMissing || [])].join('\n'))}">Plays with the player's own CMI (${bits}) — ✨ Make a set…, Load font… and an own main character make it standalone.</div>`;
  }

  // full-screen cards (game.cards): the title, chapters, THE END — shown by a "Show a card" step
  cardsHtml() {
    const ed = this.ed, cards = ed.e.game.cards || {};
    const rows = Object.entries(cards).map(([id, p]) => {
      const img = typeof p === 'string' ? p : p?.img || '';
      return `<li><img src="${esc(assetUrl(ed.e.path(img)))}" alt="" title="${esc(img)}"><b>${esc(id)}</b>
        <span class="ed-buttons"><button data-act="ai-card" data-id="${esc(id)}" title="Paint this card — the title lettering goes into the picture when you give one (ComfyUI)">✨</button><button data-act="card-load" data-id="${esc(id)}" title="A picture from your computer (4:3, best 2560x1920)">Load…</button><button data-act="card-del" data-id="${esc(id)}" title="Out of the game (the picture stays in cards/)">✕</button></span></li>`;
    });
    return `<div class="ed-gh">Cards <span class="ed-dim">shown by a “Show a card” step</span>
        <span class="ed-buttons"><button data-act="card-add" title="A full-screen picture: the title, a chapter, THE END…">+ Card…</button></span></div>
      <ul class="ed-list ed-cards">${rows.join('') || '<li class="ed-dim">None yet. + Card…, then a “Show a card” step in any script (the game’s start, an ending…).</li>'}</ul>`;
  }

  // one slot of the interface: the picture in use (theme or CMI), click = load your own, ✕ = back to CMI
  themeSlot(slot, title, cmiFile) {
    const ed = this.ed, t = ed.project.theme || {};
    const [g, sub] = slot.split('.');
    const own = sub ? t[g]?.[sub] : t[slot];
    const src = own ? assetUrl(ed.e.path(own)) : 'cmi/ui/' + cmiFile;
    return `<span class="ed-tslot${own ? ' ed-own' : ''}" data-act="theme-load" data-slot="${slot}" title="${esc(title)}${own ? ` — ${esc(own)}` : ' — CMI'}. Click: load your own picture.">
      <img src="${esc(src)}" alt="">${own ? `<button data-act="theme-reset" data-slot="${slot}" title="Back to the CMI picture">✕</button>` : ''}</span>`;
  }

  themeHtml() {
    const ed = this.ed, t = ed.project.theme || {};
    const coin = ['idle', 'hand', 'look', 'mouth'].map((v, i) => this.themeSlot('coin.' + v, `Verb coin, ${v} (464x472 px)`, ['coin_idle', 'coin_fist', 'coin_skull', 'coin_parrot'][i] + '.png')).join('');
    const cursors = [['cursor', 'Cursor (320x224 px)', 'cursor.png'], ['cursorHot', 'Cursor over something (320x224 px)', 'cursor_hot.png'], ['wait', 'Wait cursor (320x224 px)', 'cursor_wait.png']]
      .map(([s, ti, f]) => this.themeSlot(s, ti, f)).join('');
    const arrows = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map(d => this.themeSlot('arrows.' + d, `Exit arrow ${d} (320x224 px)`, `arrow_${d}.png`)).join('');
    const rest = [['chest', 'The inventory screen (2560x1888 px)', 'chest.png'], ['invPrev', 'Inventory page back (320x160 px)', 'inv_prev.png'], ['invNext', 'Inventory page forward (320x160 px)', 'inv_next.png'],
      ['dlgUp', 'Dialogue scroll up (128x160 px)', 'dlg_up.png'], ['dlgDown', 'Dialogue scroll down (128x128 px)', 'dlg_down.png']].map(([s, ti, f]) => this.themeSlot(s, ti, f)).join('');
    const colors = [['label', 'Name under the cursor'], ['choice', 'Dialogue choices'], ['choiceHover', 'Dialogue choice under the mouse'], ['highlight', 'Item highlight outline']]
      .map(([k, ti]) => {
        const own = t.colors?.[k];
        const cur = own || '#' + (ed.e.colors?.[k] || [255, 255, 255]).map(v => v.toString(16).padStart(2, '0')).join('');
        return `<label class="ed-tcolor" title="${esc(ti)}${own ? '' : ' (CMI)'}"><input type="color" data-kind="theme-color" data-k="${k}" value="${esc(cur)}">${k}${own ? `<button data-act="theme-color-reset" data-k="${k}" title="Back to the CMI colour">✕</button>` : ''}</label>`;
      }).join('');
    const font = t.fonts?.text ? t.fonts.text.split('/').pop().replace(/_text$/, '') : null;
    return `<div class="ed-gh">Interface <span class="ed-dim">CMI unless you replace a piece</span>
        <span class="ed-buttons"><button data-act="ai-theme" title="Generate the whole set as one matching look: the verb coin with its four states, cursors, an arrow for every direction, the chest (ComfyUI, 5 pictures per idea)">✨ Make a set…</button></span></div>
      <div class="ed-row ed-tslots">${coin}<i class="ed-tsep"></i>${cursors}</div>
      <div class="ed-row ed-tslots">${arrows}</div>
      <div class="ed-row ed-tslots">${rest}</div>
      <div class="ed-row ed-tcolors">${colors}</div>
      ${this.standaloneHtml()}
      <div class="ed-row ed-fields"><span class="ed-lbl">Font</span><span class="ed-dim">${esc(font || "CMI's")}</span>
        <span class="ed-buttons"><button data-act="theme-font" title="A .ttf/.otf file becomes the game's speech, label and card font (three atlases at CMI's sizes; the fonts in cmi/ stay untouched)">Load font…</button>${font ? '<button data-act="theme-font-reset" title="Back to CMI\'s fonts">✕</button>' : ''}</span></div>`;
  }

  exitHtml(o) {
    const ed = this.ed, rooms = [...ed.e.rooms.keys()];
    if (o.exit != null && (typeof o.exit !== 'object' || o.exit.$fn)) return '';
    const cur = o.exit?.room || '';
    return `<div class="ed-group"><div class="ed-gh">Exit <span class="ed-dim">${cur ? `arrives at ${o.exit.x}, ${o.exit.y} ${esc(o.exit.dir || '')}` : 'clicking it walks to another room'}</span></div>
      <div class="ed-fields"><label>To<select data-key="${esc(ed.path('exit'))}" data-path="${esc(ed.path('exit'))}" data-kind="exit">
        <option value="">— (not an exit)</option>${rooms.map(r => `<option ${r === cur ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label></div>
      ${cur && cur !== ed.room.id && ![...(ed.e.rooms.get(cur)?.objects.values() || [])].some(x => x.exit?.room === ed.room.id) ? `<div class="ed-row ed-buttons"><button data-act="wayback" title="An exit in ${esc(cur)} that leads back here, at the arrival point">Make the way back</button></div>` : ''}
      ${cur ? `<div class="ed-row ed-buttons"><button data-act="showarr" data-room="${esc(cur)}" data-key="${esc(`exit:${ed.room.id}:${o.id}`)}" title="Go to ${esc(cur)} and show where Guybrush arrives (drag him there)">Show the arrival in ${esc(cur)}</button></div>` : ''}
      ${cur ? `<div class="ed-fields"><span class="ed-lbl">arrive at</span>${this.num(ed.path('exit'), 'ex:x', o.exit.x, 'x')}${this.num(ed.path('exit'), 'ex:y', o.exit.y, 'y')}
        <label>Face<select data-key="${esc(ed.path('exit'))}#dir" data-path="${esc(ed.path('exit'))}" data-kind="exitdir">${DIRS.map(d => `<option ${d === o.exit.dir ? 'selected' : ''}>${d}</option>`).join('')}</select></label></div>` : ''}</div>`;
  }

  render_problems() {
    const all = this.ed.problems || [];
    const probs = all.filter(p => !p.ignored), ignored = all.filter(p => p.ignored);
    const icon = { error: '✖', warn: '▲', info: '●' };
    const row = (p, un) => `<li class="ed-${p.level}${un ? ' ed-dim' : ''}" data-act="problem" data-key="${esc(p.key)}"><span>${icon[p.level]}</span>${esc(p.msg)}
      <button class="ed-ign" data-act="${un ? 'problem-unign' : 'problem-ign'}" data-key="${esc(p.key)}" title="${un ? 'Check this again' : 'This is fine: stop reporting it (saved in the room file, lintIgnore)'}">${un ? '↩' : '✕'}</button></li>`;
    this.parts.problems.innerHTML = `<h3>Problems <span class="ed-dim">${probs.length || 'none'}</span></h3>
      <ul class="ed-problems">${probs.map(p => row(p, false)).join('')}</ul>
      ${ignored.length ? `<details class="ed-ignored"><summary class="ed-dim">${ignored.length} ignored</summary>
        <ul class="ed-problems">${ignored.map(p => row(p, true)).join('')}</ul></details>` : ''}`;
  }

  render_notices() {
    this.parts.notices.innerHTML = this.ed.notices.map((n, i) => `
      <div class="ed-notice ed-${n.level}">
        <div>${esc(n.msg)}</div>
        ${n.detail ? `<pre>${esc(n.detail)}</pre>` : ''}
        <div class="ed-buttons">${(n.actions || []).map((a, j) => `<button data-act="notice" data-i="${i}" data-j="${j}">${esc(a.label)}</button>`).join('')}
          <button data-act="dismiss" data-i="${i}">${n.actions?.length ? 'Later' : 'OK'}</button></div>
      </div>`).join('');
  }

  render_inspector() {
    const ed = this.ed, sel = ed.sel, room = ed.room, el = this.parts.inspector;
    if (!sel || !room) {
      el.innerHTML = `<h3>Inspector</h3><div class="ed-dim ed-row">${ed.tool === 'walk' ? 'Click the walk area or a hole.' : ed.tool === 'scale' ? 'Drag the points on the ruler. Double-click it to add one.' : 'Click a hotspot, or pick one from the list.'}</div>`;
      return;
    }
    if (sel.kind === 'object') el.innerHTML = this.objectHtml(room.objects.get(sel.id));
    else if (sel.kind === 'npc') el.innerHTML = this.npcHtml(sel.id);
    else if (sel.kind === 'item') el.innerHTML = this.itemHtml(sel.id);
    else if (sel.kind === 'character') el.innerHTML = this.characterHtml(sel.id);
    else if (sel.kind === 'walk') el.innerHTML = this.walkHtml();
    else if (sel.kind === 'scale') el.innerHTML = this.scaleHtml();
    else if (sel.kind === 'arrival') el.innerHTML = this.arrivalHtml(ed.arrival(sel.key));
  }

  num(path, i, v, label, step = 1) {
    const key = `${path}#${i}`;
    return `<label>${label}<input type="number" step="${step}" data-key="${esc(key)}" data-path="${esc(path)}" data-i="${i}" value="${v ?? ''}"></label>`;
  }

  lock(path) {
    const r = this.ed.doc?.editable(path);
    return r && !r.ok ? `<div class="ed-lock">🔒 ${esc(r.why)}</div>` : '';
  }

  code(prefix, def) {
    const doc = this.ed.doc;
    // a use map is scripted only if one of its entries is code (strings, line lists and data steps are edited here)
    const codeUse = u => u && typeof u === 'object' && Object.values(u).some(h => typeof h === 'function');
    const keys = Object.keys(def).filter(k => typeof def[k] === 'function' || (k === 'use' && codeUse(def.use)));
    const items = keys.map(k => {
      const line = doc?.line(`${prefix}.${k}`);
      const what = k === 'use' ? `use: ${Object.keys(def.use).join(', ')}` : k;
      return `<span class="ed-code">${esc(what)}${line ? ` <em>:${line}</em>` : ''}</span>`;
    });
    return items.length ? `<div class="ed-row ed-dim">Scripted (edit in the source): ${items.join(' ')}</div>` : '';
  }

  faceSel(path, cur) {
    return `<label>Face<select data-key="${esc(path)}" data-path="${esc(path)}" data-kind="face">
      <option value="">—</option>${DIRS.map(d => `<option ${d === cur ? 'selected' : ''}>${d}</option>`).join('')}</select></label>`;
  }

  objectHtml(o) {
    if (!o) return '<h3>Inspector</h3>';
    const ed = this.ed, p = k => ed.path(k), doc = ed.doc, room = ed.room;
    const name = typeof o.name === 'function' ? o.id : o.name || o.id;
    const sp = room.objSprite(ed.e, o);
    const line = doc?.line(`objects[id=${o.id}]`);
    let shape;
    if (o.box) shape = `<div class="ed-fields">${['x', 'y', 'w', 'h'].map((l, i) => this.num(p('box'), i, o.box[i], l)).join('')}</div>`;
    else if (o.hot) {
      const v = ed.vsel != null && o.hot[ed.vsel];
      shape = `<div class="ed-row ed-dim">${o.hot.length} points. Double-click an edge to add one; Backspace deletes the selected one.</div>
        ${v ? `<div class="ed-fields"><span class="ed-lbl">point ${ed.vsel + 1}</span>${this.num(p('hot'), 'v' + ed.vsel + '.0', v[0], 'x')}${this.num(p('hot'), 'v' + ed.vsel + '.1', v[1], 'y')}</div>` : ''}`;
    } else shape = '<div class="ed-row ed-dim">No hotspot shape.</div>';
    const wt = o.walkTo || room.walkToOf(o);
    const outside = room.walk && !room.walk.inside(wt);
    return `
      <h3>${chip('object:' + o.id)} ${esc(name)} <span class="ed-id">${esc(o.id)}</span>${line ? `<span class="ed-line">${esc(doc.file.split('/').pop())}:${line}</span>` : ''}</h3>
      ${sp?.img ? `<div class="ed-preview"><img src="${esc(sp.img.src)}" alt=""></div>` : ''}
      ${this.imgTools(sp?.img ? sp.img.getAttribute('src') : '', 'object', o.id, { why: ed.project.reference ? "License to Pillage's art is not replaced from the editor" : '' })}
      ${this.lock(p(o.hot ? 'hot' : 'box'))}
      <div class="ed-group"><div class="ed-gh">${o.hot ? 'Polygon' : 'Box'}
        <span class="ed-buttons">
          ${o.box || o.hot ? `<button data-act="shape" title="B">${o.hot ? '→ Box' : '→ Polygon'}</button>` : '<button data-act="addbox">Add box</button>'}
          ${sp ? '<button data-act="fit" title="F">Fit to sprite</button>' : ''}
        </span></div>${shape}</div>
      <div class="ed-group"><div class="ed-gh">Priority</div><div class="ed-fields">
        ${this.num(p('hotZ'), 'z', o.hotZ, 'hotZ')}<span class="ed-dim ed-note">${o.hotZ == null ? `Empty: z (${o.z ?? 0}). ` : ''}The higher one wins where hotspots overlap; on a tie the later one in the list.</span></div></div>
      <div class="ed-group"><div class="ed-gh">Walk to ${o.walkTo ? '' : '<span class="ed-dim">(default)</span>'}
        <span class="ed-buttons">${o.walkTo ? '<button data-act="clearwalk">Use default</button>' : ''}${outside && o.walkTo ? '<button data-act="walkinside">Snap inside</button>' : ''}</span></div>
        <div class="ed-fields">${this.num(p('walkTo'), 'w0', Math.round(wt[0]), 'x')}${this.num(p('walkTo'), 'w1', Math.round(wt[1]), 'y')}${this.faceSel(p('face'), o.face)}</div>
        ${outside ? '<div class="ed-row ed-warn">Outside the walk area.</div>' : ''}</div>
      ${this.textHtml(o)}
      ${this.exitHtml(o)}
      ${this.statesHtml(o, sp)}
      ${this.code(`objects[id=${o.id}]`, o)}
      <div class="ed-row ed-buttons"><button data-act="archive" data-kind="object" data-id="${esc(o.id)}" title="Out of the room, into the library (put it back later, in any room)">Archive</button>
        <button data-act="delhot" data-id="${esc(o.id)}" class="ed-danger">Delete hotspot</button></div>`;
  }

  npcHtml(id) {
    const ed = this.ed, room = ed.room, a = ed.e.actors.get(id), n = room.def.npcs?.[id] || {}, p = k => ed.path(k), doc = ed.doc;
    const line = doc?.line(`npcs.${id}`);
    const place = room.def.actors?.[id];
    const wt = ed.tools.npcWalkTo(a, n);
    return `
      <h3>${chip('actor:' + id)} ${esc(n.name || a?.def.name || id)} <span class="ed-id">${esc(id)}</span>${line ? `<span class="ed-line">${esc(doc.file.split('/').pop())}:${line}</span>` : ''}</h3>
      ${this.lock(p('hot'))}
      <div class="ed-group"><div class="ed-gh">Hot rect <span class="ed-dim">relative to the feet</span>
        <span class="ed-buttons">${n.hot ? '<button data-act="clearhot">Remove</button>' : '<button data-act="addbox">Add from sprite</button>'}</span></div>
        ${n.hot ? `<div class="ed-fields">${['x', 'y', 'w', 'h'].map((l, i) => this.num(p('hot'), i, n.hot[i], l)).join('')}</div>` : '<div class="ed-row ed-dim">None: the web engine uses the sprite bounds, the ScummVM build a default rect.</div>'}</div>
      <div class="ed-group"><div class="ed-gh">Walk to ${n.walkTo ? '' : '<span class="ed-dim">(default: beside the NPC)</span>'}
        <span class="ed-buttons">${n.walkTo ? '<button data-act="clearwalk">Use default</button>' : ''}</span></div>
        <div class="ed-fields">${this.num(p('walkTo'), 'w0', wt[0], 'x')}${this.num(p('walkTo'), 'w1', wt[1], 'y')}${this.faceSel(p('face'), n.face)}</div></div>
      ${place ? `<div class="ed-row ed-dim">Placed at ${place.x}, ${place.y}${place.scale != null ? `, scale ${place.scale}` : ''} (actors.${esc(id)})</div>` : ''}
      ${this.charPreview(id)}
      ${this.npcScripts(id, n)}
      ${this.code(`npcs.${id}`, n)}
      <div class="ed-row ed-buttons">${place ? `<button data-act="unplace" data-id="${esc(id)}" title="Take them out of this room (the game keeps them)">Remove from room</button>` : ''}
        <button data-act="archive" data-kind="character" data-id="${esc(id)}" title="Out of the game (and every room), into the library">Archive</button>
        <button data-act="delchar" data-id="${esc(id)}" class="ed-danger">Delete character</button></div>`;
  }

  // Save image (download) / Load image… (replace) under a picture
  imgTools(url, kind, id, { load = true, why = '' } = {}) {
    const name = url ? decodeURIComponent(url.split('/').pop().split('?')[0]) : '';
    return `<div class="ed-imgtools ed-buttons">${url ? `<a class="ed-btn" href="${esc(assetUrl(url))}" download="${esc(name)}" title="Download ${esc(name)}">Save image</a>` : ''}
      ${load ? `<button data-act="loadimg" data-kind="${esc(kind)}" data-id="${esc(id)}" ${why ? `disabled title="${esc(why)}"` : 'title="Replace it with a picture from your computer (the old one goes to .trash/editor_backups)"'}>Load image…</button>` : ''}
      ${load && url ? `<button data-act="ai-repaint" data-kind="${esc(kind)}" data-id="${esc(id)}" ${why ? 'disabled' : 'title="Repaint it: describe the change, pick one of the ideas (ComfyUI)"'}>✨ Repaint…</button><button data-act="ai-part" data-kind="${esc(kind)}" data-id="${esc(id)}" ${why ? 'disabled' : 'title="Repaint a part: drag over it, describe the change (ComfyUI)"'}>✨ Part…</button>` : ''}
      ${kind === 'background' && load ? `<button data-act="ai-bg" ${why ? 'disabled' : 'title="Generate a new background: describe it, pick one of the ideas (ComfyUI)"'}>✨ New…</button>` : ''}
      ${['item', 'object', 'character'].includes(kind) && load ? `<button data-act="ai-new" data-kind="${esc(kind)}" data-id="${esc(id)}" ${why ? 'disabled' : 'title="A new picture from a description (not from the old one, unlike Repaint); Use puts it in place of the old one (ComfyUI)"'}>✨ New…</button>` : ''}</div>`;
  }

  // the first picture of a character's stand anim
  charThumb(id) {
    const a = this.ed.e.actors.get(id), c = a?.costume;
    if (!c) return null;
    let role = c.roles?.stand;
    if (role && typeof role === 'object') role = role.S || role.W || role.E || Object.values(role)[0];
    if (role && typeof role === 'object') role = role.anim;
    const an = c.anims?.[role || 'stand'] || Object.values(c.anims || {})[0];
    const cel = an?.limbs?.[0]?.frames?.[0]?.cels?.[0]?.cel;
    const f = cel != null && c.cels[cel]?.file;
    return f ? c.base + '/' + f : null;
  }

  charPreview(id) {
    const t = this.charThumb(id), a = this.ed.e.actors.get(id), def = a?.costume?.def || {};
    const n = Object.keys(a?.costume?.cels || {}).length;
    const pic = !!def.picture || /^a picture/.test(def.source || '');
    const why = this.ed.project.reference ? "License to Pillage's art is not replaced from the editor"
      : n > 1 && !pic ? `An animated costume (${n} pictures): only characters made from pictures get a new picture here` : '';
    return (t ? `<div class="ed-preview"><img src="${esc(assetUrl(t))}" alt=""></div>` : '') + this.imgTools(t, 'character', id, { why })
      + (pic && !this.ed.project.reference ? this.posesHtml(id, a.costume) : '');
  }

  // a character made from pictures: the way the picture faces, a talking (mouth open) picture
  posesHtml(id, c) {
    const p = c.def.picture || {}, faces = p.faces || 'S', talk = p.talk && c.cels['1'];
    const opt = (v, l) => `<option value="${v}" ${v === faces ? 'selected' : ''}>${l}</option>`;
    return `<div class="ed-group"><div class="ed-gh">Poses <span class="ed-dim">made from pictures</span></div>
      <div class="ed-fields"><label title="Which way the picture looks; facing the other side it is mirrored">Picture faces<select data-kind="actor-faces" data-id="${esc(id)}">
        ${opt('E', 'right (mirrored for left)')}${opt('W', 'left (mirrored for right)')}${opt('S', 'front (never mirrored)')}</select></label></div>
      <div class="ed-state">${talk ? `<img src="${esc(assetUrl(c.base + '/' + c.cels['1'].file))}" alt="">` : ''}<b>Talking</b>
        <span class="ed-dim">${talk ? 'switches between the two pictures' : 'a small bob; a mouth-open picture makes it talk'}</span>
        <span class="ed-buttons"><button data-act="talk-load" data-id="${esc(id)}" title="A picture with the mouth open (PNG with transparency)">Load…</button><button data-act="talk-ai" data-id="${esc(id)}" title="Make it from the standing picture (ComfyUI)">✨ Make…</button>${talk ? `<button data-act="talk-del" data-id="${esc(id)}" title="Back to the bob">✕</button>` : ''}</span></div></div>`;
  }

  characterHtml(id) {
    const ed = this.ed, d = ed.e.game.actors?.[id];
    if (!d) return '<h3>Inspector</h3>';
    const rooms = [...ed.e.rooms.values()].filter(r => r.def.actors?.[id]).map(r => r.id);
    return `<h3>${chip('actor:' + id)} ${esc(d.name || id)} <span class="ed-id">${esc(id)}</span></h3>
      ${this.charPreview(id)}
      <div class="ed-row ed-dim">Costume ${esc(d.costume || '—')} · text colour <i class="ed-chip" style="background:${esc(d.color || '#fff')}"></i> · ${rooms.length ? 'in ' + rooms.map(esc).join(', ') : 'in no room'}</div>
      <div class="ed-row ed-buttons">${ed.room?.def.actors?.[id] ? '' : `<button data-act="place" data-id="${esc(id)}">Place here</button>`}
        <button data-act="archive" data-kind="character" data-id="${esc(id)}">Archive</button>
        <button data-act="delchar" data-id="${esc(id)}" class="ed-danger">Delete character</button></div>`;
  }

  itemHtml(id) {
    const ed = this.ed, e = ed.e, it = e.game.items?.[id];
    if (!it) return '<h3>Inspector</h3>';
    const field = (k, label, area) => {
      const v = it[k];
      if (v != null && typeof v !== 'string') return `<div class="ed-row ed-dim">${label}: ${typeof v === 'function' ? 'scripted' : 'a list / table'} (edit in game.js)</div>`;
      return `<label class="ed-text"><span>${label}</span>${area ? `<textarea rows="2" data-kind="itemfield" data-id="${esc(id)}" data-field="${k}">${esc(v || '')}</textarea>`
        : `<input type="text" data-kind="itemfield" data-id="${esc(id)}" data-field="${k}" value="${esc(v || '')}">`}</label>`;
    };
    return `<h3>${esc(typeof it.name === 'string' ? it.name : id)} <span class="ed-id">${esc(id)}</span><span class="ed-tag">item</span></h3>
      <div class="ed-preview ed-icon"><img src="${esc(assetUrl(e.path(it.icon)))}" alt=""></div>
      ${this.imgTools(e.path(it.icon), 'item', id, { why: ed.project.reference ? "License to Pillage's art is not replaced from the editor" : '' })}
      <div class="ed-row ed-dim">Changes here are written to game.js at once.</div>
      <label class="ed-text"><span>Id <em class="ed-dim">(scripts use it; renaming changes them all)</em></span><input type="text" data-kind="itemid" data-key="itemid:${esc(id)}" data-id="${esc(id)}" value="${esc(id)}" ${ed.project.reference ? 'disabled' : ''}></label>
      ${field('name', 'Name')}${field('look', 'Look at', true)}${field('mouth', 'Eat / talk', true)}
      <div class="ed-row ed-buttons"><button data-act="itemicon" data-id="${esc(id)}">Icon…</button>
        <button data-act="give" data-id="${esc(id)}" ${e.state.inv.includes(id) ? 'disabled' : ''}>Give</button>
        <button data-act="archive" data-kind="item" data-id="${esc(id)}" ${ed.project.reference ? 'disabled' : ''}>Archive</button>
        <button data-act="delitem" data-id="${esc(id)}" class="ed-danger" ${ed.project.reference ? 'disabled' : ''}>Delete item</button></div>`;
  }

  render_library() {
    const ed = this.ed, e = ed.e, lib = ed.project.library || [];
    if (ed.project.reference) { this.parts.library.innerHTML = ''; return; }
    const kinds = { object: 'Objects', item: 'Items', character: 'Characters', background: 'Backgrounds' };
    const use = en => ({ object: 'Put in this room', item: 'Add to the game', character: en.def ? 'Bring back' : null, background: 'Use here' }[en.kind]);
    const groups = Object.entries(kinds).map(([k, label]) => {
      const es = lib.filter(x => x.kind === k);
      if (!es.length) return '';
      return `<div class="ed-gh">${label} <span class="ed-dim">${es.length}</span></div><ul class="ed-list ed-items ed-lib">${es.map(en => `
        <li>${en.image ? `<img src="${esc(assetUrl(e.path(en.image)))}" alt="">` : '<span class="ed-noimg"></span>'}<b>${esc(en.name)}</b><span class="ed-tag">${esc(en.from)}</span>
          <span class="ed-buttons">${en.image ? `<a class="ed-btn" href="${esc(e.path(en.image))}" download="${esc(en.image.split('/').pop())}" title="Save image">⤓</a>` : ''}${use(en) ? `<button data-act="restore" data-id="${esc(en.id)}">${use(en)}</button>` : ''}${en.kind === 'background' ? `<button data-act="restore-room" data-id="${esc(en.id)}">New room</button>` : ''}<button data-act="libremove" data-id="${esc(en.id)}" title="Remove from the library">✕</button></span></li>`).join('')}</ul>`;
    }).join('');
    this.parts.library.innerHTML = `<details ${ed.libraryOpen ? 'open' : ''}><summary data-act="section" data-flag="libraryOpen" data-sec="library"><h3>Library <span class="ed-dim">${lib.length}</span></h3></summary>
      ${groups || '<div class="ed-row ed-dim">Archived objects, items and characters, and pictures kept for later, wait here.</div>'}</details>`;
  }

  npcScripts(id, n) {
    const ed = this.ed, sc = ed.scripts, p = k => `npcs.${id}.${k}`;
    if (!ed.room.def.npcs?.[id]) return '';
    const talk = n.mouth && typeof n.mouth === 'object' && Array.isArray(n.mouth.do) ? n.mouth.do.find(s => s.talk)?.talk : null;
    const tree = talk && (ed.room.def.dialogues?.[talk] ?? ed.e.game.dialogues?.[talk]);
    const own = talk && ed.room.def.dialogues?.[talk] != null;
    return `<div class="ed-group"><div class="ed-gh">Actions</div>${sc.handlerHtml(p('look'), 'Look at', n.look, "(the game's default)")}${sc.handlerHtml(p('hand'), 'Push', n.hand, "(the game's default)")}
        ${sc.handlerHtml(p('mouth'), 'Talk to', n.mouth, "(the game's default)")}</div>
      ${tree ? `<div class="ed-group"><div class="ed-gh">Conversation "${esc(talk)}"${own ? '' : ' <span class="ed-dim">(the game\'s)</span>'}</div>${own ? sc.dialogueHtml(`dialogues.${talk}`, tree) : '<div class="ed-row ed-dim">Defined in game.js.</div>'}</div>`
        : `<div class="ed-row ed-buttons"><button data-act="newdlg" data-id="${esc(id)}">+ Conversation</button></div>`}
      ${this.useHtml(p('use'), n.use)}`;
  }

  arrivalHtml(a) {
    if (!a) return '<h3>Inspector</h3><div class="ed-row ed-dim">That arrival point is gone.</div>';
    const ed = this.ed, room = ed.room, w = writable(ed, a);
    const bad = room.walk && !room.walk.inside([a.x, a.y]);
    const file = r => esc(`rooms/${r}.js`);
    const where = {
      exit: a.from === room.id ? `Using <b>${esc(a.sub)}</b> (an exit in this room) puts Guybrush here.`
        : `Using <b>${esc(a.sub)}</b> in <b>${esc(a.from)}</b> brings Guybrush here. It is written in that exit (${file(a.from)})${a.targets.length > 1 ? ` and in this room's entries.${esc(a.from)}` : ''}.`,
      entry: `This room's entries.${esc(a.from)}: no exit in ${esc(a.from)} leads here. New exits from ${esc(a.from)} would arrive here; <kbd>⌫</kbd> deletes it.`,
      start: 'Where Guybrush stands when this room is opened directly (the editor, <code>?room=</code>).',
      script: `A "Go to room" step of <b>${esc(a.sub)}</b> in ${file(a.from)}.`,
      opening: "Where the game begins: the <code>g.goto</code> in game.js's start (written to game.js at once, no undo).",
      code: `A <code>g.goto</code> in hand-written code (${esc(a.from === '*' ? 'game.js' : `rooms/${a.from}.js`)}${a.sub ? `: ${esc(a.sub)}` : ''}). Edit it in the source.`,
    }[a.kind];
    const ent = a.entry && (a.entry[0] !== a.x || a.entry[1] !== a.y || (a.entry[2] || 'S') !== a.dir)
      ? `<div class="ed-row ed-dim">entries.${esc(a.from)} here says ${a.entry.slice(0, 3).join(', ')}; moving the arrival sets both.</div>` : '';
    const num = (k, v) => `<label>${k}<input type="number" data-kind="arrival" data-key="${esc(a.key)}" data-field="${k}" value="${Math.round(v)}"></label>`;
    return `<h3><i class="ed-chip" style="background:${ARRIVAL_COLORS[a.kind]}"></i> Arrival · ${esc(a.label)}</h3>
      <div class="ed-row">${where}</div>
      ${w.ok ? '' : `<div class="ed-lock">🔒 ${esc(w.why)}</div>`}
      <div class="ed-group"><div class="ed-gh">Arrives at <span class="ed-dim">drag his feet in the room</span></div>
        <div class="ed-fields">${num('x', a.x)}${num('y', a.y)}<label>Face<select data-kind="arrival" data-key="${esc(a.key)}" data-field="dir">${DIRS.map(d => `<option ${d === a.dir ? 'selected' : ''}>${d}</option>`).join('')}</select></label></div>
        ${bad ? `<div class="ed-row ed-warn">Outside the walk area. <button data-act="arrinside" data-key="${esc(a.key)}">Snap inside</button></div>` : ''}${ent}
        <div class="ed-row ed-dim">Scale there ${room.scaleAt(a.y).toFixed(2)}: Guybrush is ${Math.round(ghost(ed, a.x, a.y, a.dir)?.box[3] || 0)} px tall.</div></div>
      <div class="ed-row ed-buttons"><button data-act="arrtry" data-key="${esc(a.key)}" title="Play: Guybrush comes in here, as in the game">▶ Try it</button>
        ${a.kind === 'exit' || a.kind === 'script' ? `<button data-act="arrsrc" data-key="${esc(a.key)}">${a.kind === 'exit' ? 'Go to the exit' : 'Go to the script'}${a.from === room.id ? '' : ` in ${esc(a.from)}`}</button>` : ''}</div>`;
  }

  walkHtml() {
    const ed = this.ed, sel = ed.sel, w = ed.room.def.walk || {};
    const pts = w[sel.poly]?.[sel.index] || [];
    const v = ed.vsel != null && pts[ed.vsel];
    const path = 'walk.' + sel.poly;
    return `
      <h3>${sel.poly === 'holes' ? `Hole ${sel.index + 1}` : `Walk area ${sel.index + 1}`} <span class="ed-dim">${pts.length} points</span></h3>
      ${this.lock(path)}
      <div class="ed-row ed-dim">${(w.polys || []).length} area${(w.polys || []).length === 1 ? '' : 's'}, ${(w.holes || []).length} hole${(w.holes || []).length === 1 ? '' : 's'}. Double-click an edge to add a point; right-click twice to test a path.</div>
      ${v ? `<div class="ed-fields"><span class="ed-lbl">point ${ed.vsel + 1}</span>${this.num(path, `p${sel.index}.${ed.vsel}.0`, v[0], 'x')}${this.num(path, `p${sel.index}.${ed.vsel}.1`, v[1], 'y')}</div>` : ''}
      <div class="ed-row ed-buttons"><button data-act="addhole">Add hole</button>
        ${sel.poly === 'holes' ? '<button data-act="delsel">Delete hole</button>' : ''}${v ? '<button data-act="delsel">Delete point</button>' : ''}</div>`;
  }

  scaleHtml() {
    const ed = this.ed, pts = ed.room.def.scale || [];
    return `
      <h3>Scale <span class="ed-dim">y → actor scale</span></h3>
      ${this.lock('scale')}
      ${pts.map(([y, s], i) => `<div class="ed-fields${ed.vsel === i ? ' on' : ''}">${this.num('scale', `s${i}.0`, y, 'y')}${this.num('scale', `s${i}.1`, s, 'scale', 0.01)}
        <button data-act="delscale" data-i="${i}" ${pts.length > 1 ? '' : 'disabled'}>×</button></div>`).join('')}
      <div class="ed-row ed-dim">The web engine interpolates all points; the ScummVM build uses the first and last, capped at 1.0 (dashed). Guybrush follows the mouse to show it.</div>`;
  }

  // ------------------------------------------------------------ events
  click(ev) {
    const b = ev.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const ed = this.ed, t = ed.tools, act = b.dataset.act;
    if (ed.scripts.click(b)) return;
    // collapsible sections: their state lives in the editor (the panel re-renders often), not in <details>
    if (act === 'section') {
      ev.preventDefault();
      const was = ed[b.dataset.flag] ?? (b.dataset.default === 'true');
      ed[b.dataset.flag] = !was;
      this.refresh([b.dataset.sec]);
      return;
    }
    if (act === 'save') ed.save();
    else if (act === 'revert') { ed.doc?.revert(); }
    else if (act === 'undo') ed.undo();
    else if (act === 'redo') ed.redo();
    else if (act === 'pick') { ed.select({ kind: b.dataset.kind, id: b.dataset.id }); ed.reveal(); }
    else if (act === 'sound-play') this.listen(b.dataset.file);
    else if (act === 'talk-load') ed.project.talkPicture(b.dataset.id);
    else if (act === 'talk-ai') ed.ai.talkPicture(b.dataset.id);
    else if (act === 'talk-del') ed.project.actorPose(b.dataset.id, { removeTalk: true }, 'Talking: back to the bob.');
    else if (act === 'sound-add') { ev.preventDefault(); ed.project.addSound(b.dataset.kind); }
    else if (act === 'sound-load') ed.project.addSound(b.dataset.kind, b.dataset.name);
    else if (act === 'style-ref-add') { ev.preventDefault(); ed.project.addStyleRef(); }
    else if (act === 'style-ref-del') ed.project.removeStyleRef(+b.dataset.i);
    else if (act === 'sound-del') ed.project.removeSound(b.dataset.kind, b.dataset.name);
    else if (act === 'room-amb') ed.project.roomAmbience(false);
    else if (act === 'room-amb-clear') ed.project.roomAmbience(true);
    else if (act === 'pickarr') { ed.setTool('select'); if (!ed.show.arrivals) ed.toggle('arrivals'); ed.select({ kind: 'arrival', key: b.dataset.key }); ed.reveal(); }
    else if (act === 'showarr') { if (!ed.show.arrivals) ed.toggle('arrivals'); ed.goSelect(b.dataset.room, { kind: 'arrival', key: b.dataset.key }); }
    else if (act === 'arrinside') { const a = ed.arrival(b.dataset.key); if (a && ed.room.walk) { const [x, y] = insidePoint(ed.room.walk, [a.x, a.y]); ed.moveArrival(a, x, y, a.dir); } }
    else if (act === 'arrtry') { const a = ed.arrival(b.dataset.key); if (a) { ed.setMode('play'); ed.e.goRoom(ed.room.id, { x: a.x, y: a.y, dir: a.dir }); } }
    else if (act === 'arrsrc') {
      const a = ed.arrival(b.dataset.key);
      if (a?.kind === 'exit') ed.goSelect(a.from, { kind: 'object', id: a.obj });
      else if (a?.kind === 'script') { const m = a.targets[0].path.match(/^objects\[id=([^\]]+)\]|^npcs\.([A-Za-z_$][\w$]*)/); ed.goSelect(a.from, m ? (m[1] ? { kind: 'object', id: m[1] } : { kind: 'npc', id: m[2] }) : null); }
    }
    else if (act === 'problem') { const p = ed.problems.find(x => x.key === b.dataset.key); if (p?.sel) { if (p.sel.kind === 'arrival' && !ed.show.arrivals) ed.toggle('arrivals'); if (p.sel.kind === 'walk') ed.setTool('walk'); else if (p.sel.kind === 'scale') ed.setTool('scale'); else ed.setTool('select'); ed.select(p.sel); ed.reveal(); } }
    else if (act === 'problem-ign' || act === 'problem-unign') {
      const cur = Array.isArray(ed.doc?.def.lintIgnore) ? ed.doc.def.lintIgnore : [];
      const next = act === 'problem-ign' ? [...new Set([...cur, b.dataset.key])] : cur.filter(k => k !== b.dataset.key);
      if (ed.edit(act === 'problem-ign' ? 'ignore a problem' : 'check a problem again', [{ path: 'lintIgnore', after: next.length ? next : undefined }])) ed.hitmapChanged();
    }
    else if (act === 'shape') t.toggleShape();
    else if (act === 'fit') t.fitSprite();
    else if (act === 'addbox') t.addBox();
    else if (act === 'clearwalk') ed.edit('default walk-to', [{ path: ed.path('walkTo'), after: undefined }]);
    else if (act === 'walkinside') t.snapWalkToInside();
    else if (act === 'clearhot') ed.edit('remove NPC hotspot', [{ path: ed.path('hot'), after: undefined }]);
    else if (act === 'addhole') t.addHole();
    else if (act === 'delsel') t.deleteSelected();
    else if (act === 'delscale') { ed.vsel = +b.dataset.i; t.deleteSelected(); }
    else if (act === 'notice') { const n = ed.notices[+b.dataset.i]; ed.notices.splice(+b.dataset.i, 1); this.render_notices(); n?.actions[+b.dataset.j]?.run(); }
    else if (act === 'dismiss') { ed.notices.splice(+b.dataset.i, 1); this.render_notices(); }
    else if (act === 'addhot') ed.project.addHotspot();
    else if (act === 'archive') ed.project.archive(b.dataset.kind, b.dataset.id);
    else if (act === 'loadimg') ed.project.loadImage(b.dataset.kind, b.dataset.id);
    else if (act === 'ai-object') ed.ai.newObject();
    else if (act === 'ai-item') { ev.preventDefault(); ed.ai.newItem(); }
    else if (act === 'ai-character') { ev.preventDefault(); ed.ai.newCharacter(); }
    else if (act === 'ai-bg') ed.ai.newBackground();
    else if (act === 'ai-theme') { ev.preventDefault(); ed.ai.newTheme(); }
    else if (act === 'theme-load') ed.project.themeLoadImage(b.dataset.slot);
    else if (act === 'theme-reset') ed.project.themeReset(b.dataset.slot);
    else if (act === 'theme-color-reset') ed.project.themeColor(b.dataset.k, null);
    else if (act === 'theme-font') ed.project.themeLoadFont();
    else if (act === 'theme-font-reset') ed.project.themeResetFonts();
    else if (act === 'char-player') ed.project.setPlayer(b.dataset.id);
    else if (act === 'card-add') { ev.preventDefault(); ed.project.addCard(); }
    else if (act === 'card-load') ed.project.cardLoadImage(b.dataset.id);
    else if (act === 'card-del') ed.project.removeCard(b.dataset.id);
    else if (act === 'ai-card') ed.ai.newCard(b.dataset.id);
    else if (act === 'ai-repaint') ed.ai.repaint(b.dataset.kind, b.dataset.id, false);
    else if (act === 'ai-part') ed.ai.repaint(b.dataset.kind, b.dataset.id, true);
    else if (act === 'ai-new') ed.ai.newFor(b.dataset.kind, b.dataset.id);
    else if (act === 'delchar') ed.project.archive('character', b.dataset.id, false);
    else if (act === 'delitem') ed.project.archive('item', b.dataset.id, false);
    else if (act === 'unplace') ed.project.removeFromRoom(b.dataset.id);
    else if (act === 'itemicon') ed.project.itemIcon(b.dataset.id);
    else if (act === 'pickitem') ed.select({ kind: 'item', id: b.dataset.id });
    else if (act === 'pickchar') ed.select({ kind: ed.room?.def.actors?.[b.dataset.id] && ed.e.actors.get(b.dataset.id)?.room === ed.room.id ? 'npc' : 'character', id: b.dataset.id });
    else if (act === 'restore') { const en = ed.project.library.find(x => x.id === b.dataset.id); if (en) ed.project.restore(en); }
    else if (act === 'restore-room') { const en = ed.project.library.find(x => x.id === b.dataset.id); if (en) ed.project.backgroundRoom(en); }
    else if (act === 'libremove') { const en = ed.project.library.find(x => x.id === b.dataset.id); if (en) ed.project.removeEntry(en); }
    else if (act === 'delhot') ed.project.deleteHotspot(b.dataset.id);
    else if (act.startsWith('state-')) { const o = ed.room?.objects.get(ed.sel?.id); if (o) ed.project.stateAction(o, act.slice(6), b.dataset.k); }
    else if (act === 'bg') ed.project.background();
    else if (act === 'wayback') { const o = ed.room?.objects.get(ed.sel?.id); if (o) ed.project.wayBack(o); }
    else if (act === 'newitem') { ev.preventDefault(); ed.project.newItem(); }
    else if (act === 'give') { ed.e.api.give(b.dataset.id); this.refresh(['items']); }
    else if (act === 'newchar') { ev.preventDefault(); ed.project.newCharacter(); }
    else if (act === 'place') ed.project.placeActor(b.dataset.id);
    else if (act === 'newdlg') ed.project.newConversation(b.dataset.id);
  }

  change(ev) {
    const inp = ev.target;
    const ed = this.ed, path = inp.dataset.path;
    if (ed.scripts.change(inp)) return;
    if (inp.dataset.kind === 'roommusic') { ed.project.roomMusic(inp.value); return; }
    if (inp.dataset.kind === 'style-prompt') { ed.project.saveStyle({ prompt: inp.value.trim() }); return; }
    if (inp.dataset.kind === 'theme-color') { ed.project.themeColor(inp.dataset.k, inp.value); return; }
    if (inp.dataset.kind === 'actor-faces') { ed.project.actorPose(inp.dataset.id, { faces: inp.value }, `${inp.dataset.id} faces ${inp.options[inp.selectedIndex].text}.`); return; }
    if (inp.dataset.kind === 'arrival') {
      const a = ed.arrival(inp.dataset.key), f = inp.dataset.field;
      if (!a) return;
      if (f === 'dir') ed.moveArrival(a, a.x, a.y, inp.value);
      else if (Number.isFinite(+inp.value) && inp.value.trim() !== '') ed.moveArrival(a, f === 'x' ? +inp.value : a.x, f === 'y' ? +inp.value : a.y, a.dir);
      return;
    }
    if (inp.dataset.kind === 'itemid') { ed.project.renameItem(inp.dataset.id, inp.value); return; }
    if (inp.dataset.kind === 'itemfield') { ed.project.itemField(inp.dataset.id, inp.dataset.field, inp.value.trim()); return; }
    if (inp.dataset.kind === 'use-add') { const k = inp.value; inp.value = ''; if (k) ed.edit('use ' + k, [{ path: `${path}.${k}`, after: { do: [{ say: '...' }] } }]); return; }
    if (!path) return;
    if (inp.dataset.kind === 'face') { ed.edit('face', [{ path, after: inp.value || undefined }]); return; }
    if (inp.dataset.kind === 'text') { ed.edit('edit ' + path.split('.').pop(), [{ path, after: inp.value.trim() || undefined }]); return; }
    if (inp.dataset.kind === 'exit') { ed.edit('exit', [{ path, after: inp.value ? ed.project.arrival(inp.value) : undefined }]); return; }
    if (inp.dataset.kind === 'exitdir') { ed.edit('arrival facing', [{ path, after: { ...ed.doc.get(path), dir: inp.value } }]); return; }
    const raw = inp.value.trim(), v = raw === '' ? null : +raw;
    if (raw !== '' && !Number.isFinite(v)) return;
    const i = inp.dataset.i, cur = ed.doc.get(path);
    let after;
    if (String(i).startsWith('ex:')) {
      after = { ...cur, [i.slice(3)]: v ?? 0 };
    } else if (String(i).startsWith('st:')) {
      const [, k, c] = i.split(':');
      after = JSON.parse(JSON.stringify(cur));
      after[k][c] = v ?? 0;
    } else if (i === 'z') after = v == null ? undefined : v;
    else if (i === 'w0' || i === 'w1') {
      const room = ed.room, sel = ed.sel;
      const base = cur || (sel.kind === 'npc' ? ed.tools.npcWalkTo(ed.e.actors.get(sel.id), room.def.npcs?.[sel.id]) : room.walkToOf(room.objects.get(sel.id)).map(Math.round));
      after = [...base]; after[i === 'w0' ? 0 : 1] = v ?? 0;
    } else if (/^v\d+\.\d$/.test(i)) {
      const [vi, c] = i.slice(1).split('.').map(Number);
      after = cur.map(p => [...p]); after[vi][c] = v ?? 0;
    } else if (/^p\d+\.\d+\.\d$/.test(i)) {
      const [pi, vi, c] = i.slice(1).split('.').map(Number);
      after = cur.map(poly => poly.map(p => [...p])); after[pi][vi][c] = v ?? 0;
    } else if (/^s\d+\.\d$/.test(i)) {
      const [si, c] = i.slice(1).split('.').map(Number);
      after = cur.map(p => [...p]); after[si][c] = v ?? 0;
      after.sort((a, b) => a[0] - b[0]);
    } else {
      after = [...cur]; after[+i] = v ?? 0;
    }
    ed.edit('edit ' + path.split('.').pop(), [{ path, after }]);
  }
}

const KEYS = `
  <details><summary>Keys</summary>
  <table class="ed-keys">
    <tr><td><kbd>Tab</kbd></td><td>Edit ⇄ Play (preview the edits in the game)</td></tr>
    <tr><td><kbd>V</kbd> <kbd>W</kbd> <kbd>S</kbd></td><td>Hotspots · Walk area · Scale</td></tr>
    <tr><td><kbd>H</kbd> <kbd>L</kbd> <kbd>G</kbd></td><td>Hit map · Labels · Probe (Guybrush follows the mouse)</td></tr>
    <tr><td><kbd>A</kbd></td><td>Arrival points (drag the feet; the exit in the other room moves along)</td></tr>
    <tr><td><kbd>P</kbd></td><td>Puzzle chart (what can be done in which order; click a step to edit it)</td></tr>
    <tr><td><kbd>⌘S</kbd> <kbd>⌘Z</kbd> <kbd>⇧⌘Z</kbd></td><td>Save · Undo · Redo</td></tr>
    <tr><td>click again</td><td>next hotspot under the same spot</td></tr>
    <tr><td>double-click</td><td>add a point on a polygon edge</td></tr>
    <tr><td><kbd>⌫</kbd></td><td>delete the selected point / hole</td></tr>
    <tr><td><kbd>←↑→↓</kbd></td><td>nudge 1 px (<kbd>⇧</kbd> 10 px)</td></tr>
    <tr><td><kbd>1</kbd>–<kbd>9</kbd></td><td>face (numpad layout: 8 N, 6 E, 2 S, 4 W; 5 none)</td></tr>
    <tr><td><kbd>B</kbd> <kbd>F</kbd></td><td>box ⇄ polygon · fit box to sprite</td></tr>
    <tr><td>drag <kbd>⇧</kbd> / <kbd>⌥</kbd></td><td>lock axis / no magnets</td></tr>
    <tr><td>right-click ×2</td><td>walk tool: test a path</td></tr>
    <tr><td>wheel · space-drag</td><td>pan; <kbd>⌘</kbd>-wheel / pinch zoom; <kbd>0</kbd> reset</td></tr>
    <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>previous / next hotspot</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>cancel drag / deselect</td></tr>
  </table></details>`;
