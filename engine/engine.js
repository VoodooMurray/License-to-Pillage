// The CMI-style adventure engine: main loop, rendering, CMI interface (verb coin, chest inventory,
// dialogue choices, labels, speech), scripting API, cutscenes, save/load.
//
// Logical screen: 640x480 (CMI coordinates); art is 4x (2560x1920). Everything is drawn in logical
// units through a canvas transform, so any window size works.

import { Font } from './font.js';
import { Costume } from './costume.js';
import { Actor } from './actor.js';
import { Room } from './room.js';
import { Audio } from './audio.js';
import { LowRes } from './lowres.js';
import { Ega, Vga } from './ega.js';
import { isSteps, compileSteps } from './steps.js';
import { Lang, LANGS } from './i18n.js';
import { image, imageNow, preload, json, forget } from './assets.js';
import { clamp, deferred, pick, parseColor, colorCss } from './util.js';

export const W = 640, H = 480;
const ORIGINAL = 'engine/theme/original/';    // the built-in interface set (tools/theme/build_original.py)
const HOLD_MS = 180;            // hold time before the verb coin opens
// Verb coin = CMI's actor 50: image top-left at the press point + (-60, -91), the press point clamped to
// x 60..580, y 100..410 (in the chest: the icon + (38, -30)); zones [x, y, w, h] from the press point
// (CMI scripts 63, 64, 62), only within 60 px of it
const COIN_W = 116, COIN_H = 118, COIN_DX = -60, COIN_DY = -91;
const COIN_ZONES = [['hand', -59, -74, 38, 60], ['look', -18, -84, 31, 72], ['mouth', 16, -68, 40, 57]];
const LABEL_Y = 424, LABEL_Y_INV = 400;   // label cell top in the room / over the chest (centered at x=320)
// the interface colors (label under the cursor, dialogue choices, the item highlight outline);
// a project's theme.json `colors` overrides single entries
const UI_COLORS = { label: [255, 211, 83], choice: [255, 239, 127], choiceHover: [255, 59, 15], highlight: [255, 50, 0] };
const CHOICE_LH = 24, CHOICE_X = 6;
const INV = { x0: 100, y0: 180, dx: 90, dy: 65, cols: 5, rows: 3, iw: 80, ih: 56 };
const INV_ARROWS = { '-1': [155, 120], '1': [400, 120] };     // page arrows (80x40), CMI script 47
const inChest = (x, y) => x > 45 && x < 607 && y > 100 && y < 446;   // CMI script 57
const HOT_X = [34, 25], HOT_ICON = [39, 24];    // cursor hot spots: the X; arrows, item icons, hourglass

export class Engine {
  constructor(canvas, game, base) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.base = base;                 // game folder, e.g. 'games/license'
    this.audio = new Audio();
    this.time = 0;
    this.actors = new Map();
    this.rooms = new Map();
    this.room = null;
    this.camX = 0;
    this.mouse = { x: 320, y: 240, down: false, downAt: 0, downX: 0, downY: 0, inside: false };
    this.coin = null;                 // {x, y, target, hover}
    this.held = null;                 // item id held as cursor
    this.invOpen = false;
    this.invPage = 0;
    this.choices = null;              // {options, hover, scroll, d}
    this.texts = [];                  // speech [{actor, lines, color, x, y}]
    this.busy = 0;                    // >0: a script owns the player
    this.cutsceneDepth = 0;
    this.skipping = false;
    this.timers = [];
    this.tweens = [];
    this.shakeUntil = 0;
    this.lineSkip = null;             // resolves the current speech line
    this.pending = null;              // sentence waiting for the walk
    this.fade = { a: 0, target: 0, speed: 0, done: null };
    this.overlay = null;              // full-screen image {img, alpha}
    this.menu = null;
    this.state = this.freshState();
    this.textSpeed = 1;               // multiplier for speech duration
    this.debug = new URLSearchParams(location.search).has('debug');
    this.web = true;    // game scripts can test g.engine.web: the SCUMM build reads engine internals as false
    this.api = makeApi(this);
    this.roomToken = 0;
    this.started = false;
    this.editor = null;               // the level editor (engine/editor/, only with ?edit)
    this.viewport = null;             // editor: {x, y, w, h (CSS px), zoom, panX, panY}, else the whole window
    this.lowres = false;              // Alt+0: CMI's original low-res graphics (engine/lowres.js)
    this.vga = false;                 // Alt+0 third state: 320x240 in the room's 256 colours (MI2 look)
    this.ega = false;                 // Alt+0 fourth state: 320x240 in 16 EGA colours (engine/ega.js)
    this.gfx = {};                    // interface images + fonts per graphics mode: {hd, lo}
  }

  freshState() {
    return { room: null, flags: {}, inv: [], rooms: {}, actors: {}, seen: {} };
  }

  // ---------------------------------------------------------------- setup
  async init() {
    this.useGfx(await this.loadGfx(false));
    const params = new URLSearchParams(location.search);
    const saved = params.has('test') ? null : localStorage.getItem('cmi-levels:graphics');
    const mode = params.has('ega') ? 'ega' : params.has('vga') ? 'vga' : params.has('lowres') ? 'original'
      : ['ega', 'vga', 'original'].includes(saved) ? saved : 'hd';
    if (mode !== 'hd') await this.setGraphics(mode, { quiet: true });
    try { this.voiceMap = await json(this.path('voice.json')); } catch (err) { this.voiceMap = {}; }
    this.voiceOn = localStorage.getItem('cmi-levels:voice') !== 'off';
    // music on/off (F5); ?nomusic mutes it for this visit without changing the setting (tests)
    this.audio.musicOn = !params.has('nomusic') && localStorage.getItem('cmi-levels:music') !== 'off';
    // text language: ?lang=de, else the last choice (F5 menu)
    this.lang = new Lang();
    await this.lang.load(params.get('lang') || (params.has('test') ? 'en' : localStorage.getItem('cmi-levels:lang')) || 'en', p => this.path(p));
    // actors
    for (const [id, def] of Object.entries(this.game.actors || {})) {
      const costume = await this.loadCostume(id, def);
      // a stand-in main character brings his own name: "aliases" in his actor.json rename the shown text
      // (the built-in hero: Guybrush Threepwood -> Drybrush Cheapwood) and "voice": false (or "mumble": engine/audio.js synthesizes one) keeps the old voice out
      if (id === this.game.player) this.heroSetup(costume);
      const a = new Actor(id, def, costume);
      if (def.anim) a.baseRole = def.anim;
      this.actors.set(id, a);
    }
    for (const def of this.game.rooms) this.rooms.set(def.id, new Room(def, this.game));
    // item icons
    await preload(Object.values(this.game.items || {}).map(i => this.path(i.icon)));
    this.player = this.actors.get(this.game.player);
    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.last = performance.now();
    requestAnimationFrame(t => this.frame(t));
  }

  // The interface images and fonts: CMI's HD pack (cmi/) or, for Alt+0, CMI's original 1x graphics (cmi/lo/,
  // nearest-upscaled 4x so all sizes stay the same; tools/extract_cmi.py). A project's theme.json replaces
  // single pieces (verb coin, cursors, exit arrows, chest, page/dialogue arrows, colors, fonts) with its own
  // files; whatever it doesn't name stays CMI.
  async loadGfx(lo) {
    const key = lo ? 'lo' : 'hd';
    if (this.gfx[key]) return this.gfx[key];
    // the stock set: CMI's own (cmi/, made from the player's copy by tools/byog/extract.py), or without it the
    // built-in original one (engine/theme/original/, nothing of CMI: tools/theme/build_original.py)
    const stock = (await this.hasCmi()) ? 'cmi/' : ORIGINAL;
    const base = lo ? stock + 'lo/' : stock;
    const ui = n => base + 'ui/' + n;
    const set = { lo, ui: {
      // CMI coin anims 6-9: idle, hand (the fist), skull, parrot
      coin: { idle: ui('coin_idle.png'), hand: ui('coin_fist.png'), look: ui('coin_skull.png'), mouth: ui('coin_parrot.png') },
      chest: ui('chest.png'), cursor: ui('cursor.png'), cursorHot: ui('cursor_hot.png'), wait: ui('cursor_wait.png'),
      invNext: ui('inv_next.png'), invPrev: ui('inv_prev.png'), dlgUp: ui('dlg_up.png'), dlgDown: ui('dlg_down.png'),
      arrows: Object.fromEntries(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map(d => [d, ui(`arrow_${d}.png`)])),
    } };
    const theme = await this.loadTheme();
    if (theme) {
      const tp = p => typeof p === 'string' && p ? this.path(p) : null;
      for (const k of ['chest', 'cursor', 'cursorHot', 'wait', 'invNext', 'invPrev', 'dlgUp', 'dlgDown']) if (tp(theme[k])) set.ui[k] = tp(theme[k]);
      for (const v of Object.keys(set.ui.coin)) if (tp(theme.coin?.[v])) set.ui.coin[v] = tp(theme.coin[v]);
      for (const d of Object.keys(set.ui.arrows)) if (tp(theme.arrows?.[d])) set.ui.arrows[d] = tp(theme.arrows[d]);
      set.themedCoin = Object.keys(set.ui.coin).some(v => tp(theme.coin?.[v]));
    }
    set.colors = Object.fromEntries(Object.entries(UI_COLORS).map(([k, dflt]) => {
      const v = theme?.colors?.[k];
      return [k, (v != null && parseColor(v)) || dflt];
    }));
    await preload(Object.values(set.ui).flatMap(v => typeof v === 'string' ? [v] : Object.values(v)));
    // ScummVM draws the coin a bit brighter than its HD cels (fitted on reference/cmi_ui captures)
    set.coinImg = Object.fromEntries(Object.entries(set.ui.coin).map(([k, v]) => [k, lo || set.themedCoin ? imageNow(v) : filtered(imageNow(v), 'brightness(1.025)')]));
    // the sparkles that run over the coin (CMI coin anim, limb 1; they fit CMI's disc only)
    if (set.themedCoin) set.glint = null;
    else try { const g = await json(ui('coin_glint.json')); g.img = await image(ui(g.img)); g.ticks = g.frames.reduce((s, f) => s + f.hold, 0); set.glint = g; } catch (err) { set.glint = null; }
    const fnt = async (n, slot) => (theme?.fonts?.[slot] ? Font.load(this.path(theme.fonts[slot])).catch(() => Font.load(base + 'fonts/font' + n)) : Font.load(base + 'fonts/font' + n));
    [set.font, set.fontSmall, set.fontBig] = await Promise.all([fnt(1, 'text'), fnt(3, 'small'), fnt(4, 'big')]);
    if (lo) {
      const pal = await json(base + 'palette.json');
      set.pal = new LowRes(pal);
      this.lowresFixedPalette = pal.art[0] > 0;     // CMI's palette keeps fixed colours below the art range
    }
    return (this.gfx[key] = set);
  }

  // games/<key>/theme.json, if the project has one (null otherwise, cached)
  async loadTheme() {
    if (this.themeData === undefined) {
      try { this.themeData = await json(this.path('theme.json')); } catch (err) { this.themeData = null; }
      if (typeof this.themeData !== 'object') this.themeData = null;
    }
    return this.themeData;
  }

  // the editor edited theme.json: drop the caches and load everything again in the current mode
  async reloadTheme() {
    const collect = (o, out = []) => { for (const v of Object.values(o || {})) { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') collect(v, out); } return out; };
    for (const p of ['theme.json', ...collect(this.themeData)]) {
      forget(this.path(p));
      if (!/\.[a-z0-9]+$/i.test(p)) { forget(this.path(p) + '.json'); forget(this.path(p) + '.png'); }   // a font base path
    }
    this.themeData = undefined;
    this.gfx = {};
    this.hotIcons = null;
    await this.setGraphics(this.gfxMode, { quiet: true });
  }

  // whether the player's CMI interface was extracted (cmi/), checked once
  async hasCmi() {
    if (this.cmiOk === undefined) {
      if (new URLSearchParams(location.search).has('nocmi')) return (this.cmiOk = false);     // ?nocmi: the built-in interface, as for a player without CMI
      try { await json('cmi/fonts/font1.json'); this.cmiOk = true; } catch (err) { this.cmiOk = false; }
    }
    return this.cmiOk;
  }

  // the player's costume brings its own text, voice and pictures: "aliases" in a stand-in's actor.json rename the
  // shown text, "voice": false / "mumble" keeps the old voice out, "lines" are his recordings (lines without one:
  // the mumble) and "images" his own versions of the pictures that show Guybrush
  heroSetup(costume) {
    const d = costume?.def?.aliases ? costume.def : null;
    this.aliases = d ? Object.entries(d.aliases).sort((x, y) => y[0].length - x[0].length) : null;
    this.playerMute = !!d && (d.voice === false || d.voice === 'mumble');
    this.playerMumble = !!d && d.voice === 'mumble';
    this.playerLines = d ? Object.fromEntries(Object.entries(d.lines || {}).map(([k, v]) => [k, `${costume.path}/${v}`])) : null;
    this.imageSwap = d ? Object.fromEntries(Object.entries(d.images || {}).map(([k, v]) => [k, ORIGINAL + v])) : null;
  }

  // A costume, or null (the actor stays invisible) when it can't be loaded; the main character falls back to CMI's
  // Guybrush (cmi/actors/guybrush) when the game's own costume is missing (e.g. a mod release before installing), then to
  // the built-in stand-in hero (engine/theme/original/actors/hero, mod/artgen/drybrush.py)
  async loadCostume(id, def, hero = null) {
    // the stand-in even when Guybrush is there: ?standin, or the F5 menu's "Hero" choice (remembered)
    const standin = id === this.game.player && (hero ? hero === 'standin' : new URLSearchParams(location.search).has('standin')
      || localStorage.getItem('cmi-levels:hero') === 'standin');
    const paths = def.costume && !standin ? [def.costume] : [];
    if (standin) paths.push(ORIGINAL + 'actors/hero');
    if (id === this.game.player && !paths.includes('cmi/actors/guybrush')) paths.push('cmi/actors/guybrush');
    if (id === this.game.player) paths.push(ORIGINAL + 'actors/hero');      // the built-in stand-in (nothing of CMI)
    for (const p of paths) {
      try {
        const c = await Costume.load(this.path(p)); c.path = p;
        // both heroes there? (then F5 offers the switch)
        if (id === this.game.player) this.standinHero = p === ORIGINAL + 'actors/hero';
        if (id === this.game.player) this.bothHeroes = p !== ORIGINAL + 'actors/hero' || await this.guybrushThere(def);
        return c;
      } catch (err) { console.warn(`costume ${p}: ${err.message}`); }
    }
    return null;
  }

  async guybrushThere(def) {
    for (const p of [def.costume, 'cmi/actors/guybrush'].filter(Boolean)) {
      try { await json(this.path(p) + '/actor.json'); return true; } catch (err) { /* not there */ }
    }
    return false;
  }

  useGfx(set) {
    for (const k of ['ui', 'coinImg', 'glint', 'font', 'fontSmall', 'fontBig', 'colors']) this[k] = set[k];
    this.lowres = set.lo;
  }

  // Alt+0 (as in the HD ScummVM build) cycles the graphics: HD -> CMI's original low-res -> VGA
  // (320x240 in the room's 256 colours, the MI1-VGA/MI2 look) -> EGA (320x240 in 16 colours, the MI1/MI2
  // EGA look; both engine/ega.js) -> HD; remembered for the next start
  get gfxMode() { return this.ega ? 'ega' : this.vga ? 'vga' : this.lowres ? 'original' : 'hd'; }

  get nextGfxMode() { return { hd: 'original', original: 'vga', vga: 'ega', ega: 'hd' }[this.gfxMode]; }

  setLowres(on, opts) { return this.setGraphics(on ? 'original' : 'hd', opts); }

  async setGraphics(mode, { quiet = false } = {}) {
    try {
      this.useGfx(await this.loadGfx(mode !== 'hd'));
    } catch (err) {
      console.warn(err);
      this.toast = { text: 'Original graphics need tools/extract_cmi.py lo', until: this.time + 3 };
      return;
    }
    this.ega = mode === 'ega';
    this.vga = mode === 'vga';
    if (this.ega && !this.egaFilter) this.egaFilter = new Ega();
    if (this.vga && !this.vgaFilter) this.vgaFilter = new Vga();
    localStorage.setItem('cmi-levels:graphics', mode);
    const name = { hd: 'HD', original: 'original', vga: 'VGA (320, 256 colours)', ega: 'EGA (320, 16 colours)' }[mode];
    if (!quiet) this.toast = { text: this.t('Showing {0} graphics.', this.t(name)), until: this.time + 1.5 };
  }

  // the shown text in the current language (engine/i18n.js)
  t(s, ...args) {
    const r = this.lang ? this.lang.t(s, ...args) : s;
    if (!this.aliases || typeof r !== 'string') return r;
    return this.aliases.reduce((x, [from, to]) => x.split(from).join(to), r);
  }

  async setLang(code) {
    await this.lang.load(code, p => this.path(p));
    this.wrapCache = null;
    localStorage.setItem('cmi-levels:lang', this.lang.code);
  }

  // a speech entry's lines in the current language (say() wraps the English text for tests and scripts)
  shownLines(t) {
    if (this.lang.code === 'en' && !this.aliases) return t.lines;
    if (t.text == null) return t.lines.map(l => this.t(l));
    const key = t.text + '\u0000' + t.width;
    this.wrapCache ??= new Map();
    if (!this.wrapCache.has(key)) this.wrapCache.set(key, this.font.wrap(this.t(t.text), t.width));
    return this.wrapCache.get(key);
  }

  path(p) {
    if (!p) return p;
    if (this.imageSwap?.[p]) return this.imageSwap[p];
    if (p.startsWith('cmi/') || p.startsWith('engine/') || p.startsWith('/') || p.startsWith('http')) return p;
    return this.base + '/' + p;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const cw = window.innerWidth, ch = window.innerHeight;
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    this.canvas.style.width = cw + 'px';
    this.canvas.style.height = ch + 'px';
    // the screen fits the viewport (the level editor leaves room for its panel and may zoom and pan)
    const v = this.viewport || { x: 0, y: 0, w: cw, h: ch };
    const vw = v.w * dpr, vh = v.h * dpr;
    this.k = Math.min(vw / W, vh / H) * (v.zoom || 1);
    this.ox = v.x * dpr + (vw - W * this.k) / 2 - (v.panX || 0) * this.k;
    this.oy = v.y * dpr + (vh - H * this.k) / 2 - (v.panY || 0) * this.k;
    this.dpr = dpr;
  }

  // ---------------------------------------------------------------- main loop
  frame(t) {
    const dt = Math.min(0.1, (t - this.last) / 1000) * (this.timeScale || 1);
    this.last = t;
    try {
      this.update(this.menu ? 0 : dt);
      this.render();
    } catch (e) { console.error(e); }
    requestAnimationFrame(tt => this.frame(tt));
  }

  update(dt) {
    this.time += dt;
    const room = this.room;
    if (room && this.player) this.player.look = this.mouse.inside ? [this.mouse.x + this.camX, this.mouse.y] : null;
    if (room) for (const a of this.actorsIn(room.id)) a.update(dt, room, this.skipping);
    // timers
    if (this.timers.length) {
      const due = this.timers.filter(tm => this.skipping || this.time >= tm.t);
      if (due.length) {
        this.timers = this.timers.filter(tm => !due.includes(tm));
        for (const tm of due) tm.d.resolve();
      }
    }
    // tweens (object moves etc.)
    if (this.tweens.length) {
      for (const tw of [...this.tweens]) {
        const k = this.skipping ? 1 : Math.min(1, (this.time - tw.t0) / tw.dur);
        tw.apply(k);
        if (k >= 1) { this.tweens = this.tweens.filter(x => x !== tw); tw.d.resolve(); }
      }
    }
    // fade
    const f = this.fade;
    if (f.a !== f.target) {
      const step = this.skipping ? 1 : f.speed * dt;
      f.a = f.target > f.a ? Math.min(f.target, f.a + step) : Math.max(f.target, f.a - step);
      if (f.a === f.target && f.done) { const d = f.done; f.done = null; d.resolve(); }
    }
    // camera follows the player in wide rooms (the level editor pans it itself)
    if (room && this.editor?.active) this.camX = clamp(this.editor.camX, 0, Math.max(0, room.width - W));
    else if (room && room.width > W) {
      const target = clamp((this.cameraFollow?.x ?? this.player.x) - W / 2, 0, room.width - W);
      const d = target - this.camX;
      if (Math.abs(d) > 1) this.camX += Math.sign(d) * Math.min(Math.abs(d), Math.max(60, Math.abs(d) * 3) * dt);
      else this.camX = target;
    } else this.camX = 0;
    // verb coin opens after a hold
    const m = this.mouse;
    if (m.down && !this.coin && !this.editor?.active && this.interactive() && !this.choices && performance.now() - m.downAt > HOLD_MS) {
      const target = this.invOpen ? this.invItemAt(m.downX, m.downY) : this.hotspotAt(m.downX, m.downY);
      if (target && !this.held) {
        const [ax, ay] = this.invOpen ? this.invSlot(target.id).map((v, i) => v + [38, -30][i]) : [m.downX, m.downY];
        const px = clamp(Math.round(ax), 60, 580), py = clamp(Math.round(ay), 100, 410);
        // x, y = the coin's center
        this.coin = { px, py, x: px + COIN_DX + COIN_W / 2, y: py + COIN_DY + COIN_H / 2, target, hover: null, t0: this.time };
      }
    }
    if (this.coin) {
      const v = this.coinZone(m.x, m.y);
      if (v !== this.coin.hover) { this.coin.hover = v; this.coin.t0 = this.time; }   // new coin anim: sparkles restart
    }
    this.chestWatch();
    if (!this.editor?.active) this.idleLife();
  }

  // CMI script 50: with an item in hand, leaving the chest area (once the cursor was inside) closes it
  chestWatch() {
    const m = this.mouse;
    if (!this.invOpen) this.invArmed = false;
    else if (inChest(m.x, m.y)) this.invArmed = true;
    else if (this.invArmed && this.held && !this.coin) this.invOpen = false;
  }

  // Ambient life while the player is free: Guybrush blinks, rooms run small NPC idle bits.
  idleLife() {
    const free = this.interactive() && !this.choices && !this.pending && !this.invOpen && this.room;
    if (!free) { this.nextIdle = Math.max(this.nextIdle || 0, this.time + 4); return; }
    const p = this.player;
    if (this.nextBlink == null) this.nextBlink = this.time + 3;
    if (this.nextIdle == null) this.nextIdle = this.time + 6;
    if (p.costume?.roles.blink && !p.path.length && !p.talking && !p.turn && this.time > this.nextBlink) {
      {
        p.play('blink');
        this.timers.push({ t: this.time + 0.45, d: { resolve: () => {
          if (!this.busy && !p.path.length && !p.talking && p.costume.roles.talk_stop) p.play('talk_stop');
        } } });
      }
      this.nextBlink = this.time + 2.5 + Math.random() * 4.5;
    }
    if (this.room.def.idle && this.time > this.nextIdle) {
      try { this.room.def.idle(this.api); } catch (err) { console.warn(err); }
      this.nextIdle = this.time + 9 + Math.random() * 8;
    }
  }

  interactive() {
    return this.started && !this.busy && !this.cutsceneDepth && !this.menu && !this.overlay?.block;
  }

  actorsIn(roomId) {
    const out = [];
    for (const a of this.actors.values()) if (a.room === roomId) out.push(a);
    return out;
  }

  // ---------------------------------------------------------------- rendering
  render() {
    const main = this.ctx, lo = this.lowres;
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.fillStyle = '#000';
    main.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // the render target: the window at its resolution, or for the original graphics a 640x480 frame
    const c = lo ? this.gfx.lo.pal.ctx : main;
    [this.rk, this.rox, this.roy] = lo ? [1, 0, 0] : [this.k, this.ox, this.oy];
    c.setTransform(this.rk, 0, 0, this.rk, this.rox, this.roy);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.save();
    c.beginPath(); c.rect(0, 0, W, H); c.clip();
    if (lo) { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
    if (this.room && !this.invOpen) this.drawRoom(c);
    // the original interface: CMI's 1x images, never smoothed (item icons and cards turn it on for themselves)
    if (lo) c.imageSmoothingEnabled = false;
    if (this.invOpen) this.drawInventory(c);
    if (this.coin) this.drawCoin(c);
    // EGA/VGA: text, labels, menus and the cursor are drawn after the filter, full resolution, so they
    // stay readable (the one difference: speech stays sharp over a fade)
    const sharp = (this.ega || this.vga) && lo;
    if (!sharp && !this.invOpen && !this.overlay) this.drawTexts(c);
    if (this.fade.a > 0) { c.fillStyle = `rgba(0,0,0,${this.fade.a})`; c.fillRect(0, 0, W, H); }
    if (this.overlay) { this.drawOverlay(c); if (!sharp) this.drawTexts(c); }
    if (!sharp && this.invOpen) this.drawTexts(c);
    if (!sharp && this.choices) this.drawChoices(c);
    if (!sharp) {
      this.drawLabel(c);
      if (this.menu) this.drawMenu(c);
      if (this.toast) this.drawToast(c);
    }
    if (!lo) {
      if (this.debug) this.drawDebug(c);
      if (this.editor) this.editor.draw(c);
    }
    if (!sharp) this.drawCursor(c);
    c.restore();
    if (!lo) return;
    // the 640x480 frame, scaled up without smoothing (EGA/VGA: reduced to 320x240 first);
    // the sharp text layer, the debug overlay and the editor go on top
    main.setTransform(this.k, 0, 0, this.k, this.ox, this.oy);
    main.imageSmoothingEnabled = false;
    const frame = this.ega ? this.egaFilter.apply(this.gfx.lo.pal.canvas)
      : this.vga ? this.vgaFilter.apply(this.gfx.lo.pal.canvas, this.room && this.gfx.lo.pal.rooms.get(this.room.id))
        : this.gfx.lo.pal.canvas;
    main.drawImage(frame, 0, 0, W, H);
    if (sharp) {
      main.save();
      main.beginPath(); main.rect(0, 0, W, H); main.clip();
      [this.rk, this.rox, this.roy] = [this.k, this.ox, this.oy];
      if (!this.invOpen && !this.overlay) this.drawTexts(main);
      if (this.overlay) this.drawTexts(main);
      if (this.invOpen) this.drawTexts(main);
      if (this.choices) this.drawChoices(main);
      this.drawLabel(main);
      if (this.menu) this.drawMenu(main);
      if (this.toast) this.drawToast(main);
      this.drawCursor(main);
      main.restore();
    }
    main.imageSmoothingEnabled = true;
    [this.rk, this.rox, this.roy] = [this.k, this.ox, this.oy];
    if (this.debug || this.editor) {
      main.save();
      main.beginPath(); main.rect(0, 0, W, H); main.clip();
      if (this.debug) this.drawDebug(main);
      if (this.editor) this.editor.draw(main);
      main.restore();
    }
  }

  drawToast(c) {
    const t = this.toast;
    if (this.time > t.until) { this.toast = null; return; }
    const w = this.fontSmall.width(t.text);
    this.fontSmall.draw(c, t.text, Math.round(320 - w / 2), 8, [255, 255, 255], Math.min(1, (t.until - this.time) * 3));
  }

  shake(ms) { if (!this.skipping) this.shakeUntil = this.time + ms / 1000; }

  drawRoom(c) {
    const room = this.room;
    c.save();
    const camX = Math.round(this.camX * this.rk) / this.rk;
    c.translate(-camX, 0);
    if (this.time < this.shakeUntil) c.translate((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4);
    // original graphics: the room's dithered 256-colour background instead of the first layer
    const lo = this.lowres && c === this.gfx.lo.pal.ctx ? this.gfx.lo.pal.room(this, room) : null;
    (room.def.layers || []).forEach((l, i) => {
      const img = lo && i === 0 ? lo.bg : imageNow(this.path(l.img));
      if (img) c.drawImage(img, l.x || 0, l.y || 0, l.w || room.width, l.h || room.height);
    });
    room.drawAnims(c, this.time, this);
    const list = [];
    for (const o of room.objects.values()) {
      const sp = room.objSprite(this, o);
      if (sp) list.push({ z: sp.layer === 'bg' ? -1e9 : sp.layer === 'fg' ? 1e9 : sp.z, draw: () => this.drawSprite(c, sp) });
    }
    for (const oc of room.def.occluders || []) {
      if (oc.when && !oc.when(this.api)) continue;
      const img = imageNow(this.path(oc.img));
      if (img) list.push({ z: oc.z, draw: () => c.drawImage(img, oc.x, oc.y, oc.w ?? img.naturalWidth / 4, oc.h ?? img.naturalHeight / 4) });
    }
    for (const a of this.actorsIn(room.id)) {
      if (!a.visible) continue;
      list.push({ z: a.y + (a.def.zBias || 0), draw: () => this.drawActor(c, a) });
    }
    list.sort((p, q) => p.z - q.z);
    for (const it of list) it.draw();
    if (room.def.draw) room.def.draw(c, this.api);
    c.restore();
    if (lo) this.gfx.lo.pal.quantize(lo, camX);
  }

  drawSprite(c, sp) {
    if (!sp.img) return;
    if (sp.clip) { c.save(); c.beginPath(); c.rect(...sp.clip); c.clip(); }
    c.drawImage(sp.img, sp.x, sp.y, sp.w, sp.h);
    if (sp.clip) c.restore();
  }

  drawActor(c, a) {
    const parts = a.parts(this.room);
    if (!parts.length) return;
    // def.tint false: never tinted (region-sprite costumes cut from the painted room)
    const tint = a.tint || (a.def.tint === false ? null : a.def.tint || this.room.def.tint);
    if (!tint) {
      for (const p of parts) this.drawPart(c, p);
      return;
    }
    // tinted: draw into an offscreen buffer aligned to whole device pixels (copied back 1:1, with a
    // 1 px transparent margin), multiply by the tint color
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of parts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h); }
    const m = c.getTransform(), k = m.a;
    const dx = Math.floor(k * x0 + m.e) - 1, dy = Math.floor(k * y0 + m.f) - 1;
    const bw = Math.ceil(k * x1 + m.e) + 1 - dx, bh = Math.ceil(k * y1 + m.f) + 1 - dy;
    const A = this.buf(0, bw, bh), B = this.buf(1, bw, bh);
    const ax = A.getContext('2d'), bx = B.getContext('2d');
    // clear the whole buffers: nothing of an earlier (bigger) actor may be left next to this one
    ax.setTransform(1, 0, 0, 1, 0, 0); ax.clearRect(0, 0, A.width, A.height);
    ax.imageSmoothingQuality = 'high';
    ax.setTransform(k, 0, 0, k, m.e - dx, m.f - dy);
    for (const p of parts) this.drawPart(ax, p);
    ax.setTransform(1, 0, 0, 1, 0, 0);
    bx.setTransform(1, 0, 0, 1, 0, 0); bx.globalCompositeOperation = 'source-over';
    bx.clearRect(0, 0, B.width, B.height);
    bx.fillStyle = colorCss(tint); bx.fillRect(0, 0, bw, bh);
    bx.globalCompositeOperation = 'destination-in'; bx.drawImage(A, 0, 0);
    bx.globalCompositeOperation = 'source-over';
    ax.globalCompositeOperation = 'multiply'; ax.drawImage(B, 0, 0); ax.globalCompositeOperation = 'source-over';
    c.save(); c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(A, 0, 0, bw, bh, dx, dy, bw, bh);
    c.restore();
  }

  drawPart(c, p) {
    if (!p.img) return;
    if (p.flip) {
      c.save(); c.translate(p.x + p.w, p.y); c.scale(-1, 1); c.drawImage(p.img, 0, 0, p.w, p.h); c.restore();
    } else c.drawImage(p.img, p.x, p.y, p.w, p.h);
  }

  buf(i, w, h) {
    this.bufs ||= [];
    let b = this.bufs[i];
    if (!b) { b = this.bufs[i] = document.createElement('canvas'); }
    if (b.width < w || b.height < h) { b.width = Math.max(b.width, w); b.height = Math.max(b.height, h); }
    return b;
  }

  drawTexts(c) {
    for (const t of this.texts) {
      const lines = this.shownLines(t);
      const lh = this.font.lineHeight;
      let x, y;
      if (t.at) { [x, y] = t.at; }
      else {
        const a = this.actors.get(t.actor);
        const onStage = a && this.room && a.room === this.room.id && a.visible;
        const at = !onStage && this.room && (this.room.def.voices?.[t.actor] || a?.def.at);
        const [ax, ay] = onStage ? a.talkAnchor(this.room) : at ? at : [320, 60];
        x = ax - this.camX; y = ay - lines.length * lh - 2;
      }
      y = clamp(y, 4, H - 40 - lines.length * lh);
      const wmax = Math.max(...lines.map(l => this.font.width(l)));
      x = clamp(x, wmax / 2 + 6, W - wmax / 2 - 6);
      this.font.drawCentered(c, lines, x, y, t.color);
    }
  }

  drawLabel(c) {
    const text = this.labelText();
    if (!text) return;
    const w = this.font.width(text);
    this.font.draw(c, text, Math.round(320 - w / 2), this.invOpen ? LABEL_Y_INV : LABEL_Y, this.colors.label);
  }

  labelText() {
    if (this.editor?.active) return '';
    if (!this.started || this.cutsceneDepth || this.choices || this.menu) return '';
    if (this.busy && !this.coin) return '';
    const m = this.mouse;
    if (!m.inside) return '';
    if (this.coin) {
      const t = this.coin.target;
      const v = this.coin.hover;
      if (!v) return this.lang.label(this.t(this.nameOf(t)));
      return this.lang.label(this.t(this.verbLabel(t, v)) + ' ' + this.t(this.nameOf(t)));
    }
    const t = this.invOpen ? this.invItemAt(m.x, m.y) : this.hotspotAt(m.x, m.y);
    if (this.held) {
      const itemName = this.t(this.itemName(this.held));
      if (!t || (t.kind === 'item' && t.id === this.held)) return this.lang.label(itemName);
      return this.lang.label(this.t(t.kind === 'actor' ? 'give {0} to {1}' : 'use {0} with {1}', itemName, this.t(this.nameOf(t))));
    }
    return t ? this.lang.label(this.t(this.nameOf(t))) : '';
  }

  nameOf(t) {
    if (!t) return '';
    if (t.kind === 'item') return this.itemName(t.id);
    const d = t.def;
    return typeof d.name === 'function' ? d.name(this.api) : (d.name || t.id);
  }

  itemName(id) {
    const it = this.game.items[id];
    return it ? (typeof it.name === 'function' ? it.name(this.api) : it.name) : id;
  }

  verbLabel(t, v) {
    const d = t.kind === 'item' ? this.game.items[t.id] : t.def;
    const custom = d && d.verbs && d.verbs[v];
    if (custom) return custom;
    if (v === 'look') return 'look at';
    if (v === 'hand') return t.kind === 'actor' ? 'push' : (t.kind === 'item' ? 'use' : 'use');
    return t.kind === 'actor' ? 'talk to' : 'eat';
  }

  drawCoin(c) {
    const co = this.coin;
    const key = co.hover || 'idle';
    const img = this.coinImg[key] || imageNow(this.ui.coin[key]);
    const [x, y] = this.snap(co.px + COIN_DX, co.py + COIN_DY);
    if (img) c.drawImage(img, x, y, COIN_W, COIN_H);
    const g = this.glint;
    if (!g) return;
    let t = Math.floor((this.time - co.t0) * g.fps) % g.ticks, f = g.frames[0];
    for (f of g.frames) { if (t < f.hold) break; t -= f.hold; }
    if (f.r) c.drawImage(g.img, ...f.r, ...this.snap(co.px + f.x, co.py + f.y), f.w, f.h);
  }

  coinZone(x, y, co = this.coin) {
    if (!co) return null;
    const dx = x - co.px, dy = y - co.py;
    if (Math.abs(dx) >= 60 || Math.abs(dy) >= 60) return null;
    const z = COIN_ZONES.find(([, zx, zy, zw, zh]) => dx >= zx && dx <= zx + zw && dy >= zy && dy <= zy + zh);
    return z ? z[0] : null;
  }

  // logical -> logical position on a whole pixel of the render target (crisp 1:1 blits at 4x; whole logical
  // pixels for the original graphics)
  snap(x, y) {
    const k = this.rk ?? this.k, ox = this.rox ?? this.ox, oy = this.roy ?? this.oy;
    return [(Math.round(ox + x * k) - ox) / k, (Math.round(oy + y * k) - oy) / k];
  }

  // CMI's highlighted icon (state 2): the icon with a 2 px red-orange outline (cached per image)
  hotIcon(src) {
    this.hotIcons ||= new Map();
    if (!this.hotIcons.has(src)) {
      const img = imageNow(src);
      if (!img) return null;
      const r = img.naturalWidth / INV.iw * 2, cv = document.createElement('canvas');
      cv.width = img.naturalWidth + 2 * r; cv.height = img.naturalHeight + 2 * r;
      const x = cv.getContext('2d');
      for (let a = 0; a < 24; a++) {     // dilate: 16 copies on a circle of radius r, 8 at r/2
        const q = a < 16 ? r : r / 2, t = a < 16 ? a * Math.PI / 8 : (a - 16) * Math.PI / 4;
        x.drawImage(img, r + q * Math.cos(t), r + q * Math.sin(t));
      }
      x.globalCompositeOperation = 'source-in'; x.fillStyle = colorCss(this.colors.highlight); x.fillRect(0, 0, cv.width, cv.height);
      x.globalCompositeOperation = 'source-over'; x.drawImage(img, r, r);
      this.hotIcons.set(src, cv);
    }
    return this.hotIcons.get(src);
  }

  // draws an 80x56 icon (or its highlight) with its top-left at x, y
  drawIcon(c, src, x, y, hot) {
    const img = hot ? this.hotIcon(src) : imageNow(src);
    if (!img) return false;
    const m = hot ? 2 : 0;
    const [sx, sy] = this.snap(x - m, y - m);
    const sm = c.imageSmoothingEnabled;
    c.imageSmoothingEnabled = true;       // our icons are HD art, also on the original graphics
    c.drawImage(img, sx, sy, INV.iw + 2 * m, INV.ih + 2 * m);
    c.imageSmoothingEnabled = sm;
    return true;
  }

  drawCursor(c) {
    const m = this.mouse;
    if (!m.inside || !this.started || this.editor?.active) return;
    if (this.cutsceneDepth && !this.choices) return;
    // cursor images are 80x56 logical, placed by their CMI hot spot
    const at = (src, [hx, hy]) => { const img = imageNow(src); if (img) c.drawImage(img, ...this.snap(m.x - hx, m.y - hy), 80, 56); return !!img; };
    if (this.roomChange) { at(this.ui.wait, HOT_ICON); return; }        // CMI's hourglass while rooms change
    const live = this.interactive() && !this.coin;
    const h = live ? (this.invOpen ? this.invItemAt(m.x, m.y) : this.hotspotAt(m.x, m.y)) : null;
    // a held item is the cursor, highlighted (red outline) over something to use it with
    if (this.held && !this.coin && this.drawIcon(c, this.path(this.game.items[this.held]?.icon), m.x - HOT_ICON[0], m.y - HOT_ICON[1],
      !!h && !(h.kind === 'item' && h.id === this.held))) return;
    // CMI shows a directional arrow over exits
    if (h && h.def.exit && !this.held && at(this.ui.arrows[this.exitArrow(h.def)], HOT_ICON)) return;
    let hot = !!h || (live && this.invOpen && !!this.invArrowAt(m.x, m.y));
    if (this.choices) hot = this.choices.hover >= 0;
    at(hot ? this.ui.cursorHot : this.ui.cursor, HOT_X);
  }

  exitArrow(d) {
    if (d.exit.arrow) return d.exit.arrow;
    const [cx, cy] = this.room.centerOf(d);
    const sx = cx - this.camX;
    if (cy > 420) return 'S';
    if (sx < 90) return 'W';
    if (sx > W - 90) return 'E';
    return 'N';
  }

  drawOverlay(c) {
    const o = this.overlay;
    const img = o.img ? imageNow(o.img) : null;
    if (o.t0 == null) o.t0 = this.time;
    const fadeIn = this.skipping ? 1 : Math.min(1, (this.time - o.t0) / (o.fadeIn ?? 0.6));
    c.globalAlpha = (o.alpha ?? 1) * fadeIn;
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    if (img) {
      const s = Math.min(W / (img.naturalWidth / 4), H / (img.naturalHeight / 4));
      const w = img.naturalWidth / 4 * s, h = img.naturalHeight / 4 * s;
      const sm = c.imageSmoothingEnabled;
      c.imageSmoothingEnabled = true;
      c.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      c.imageSmoothingEnabled = sm;
    }
    if (o.text) this.fontBig.drawCentered(c, o.text.map ? o.text.map(l => this.t(l)) : this.t(o.text), 320, o.textY ?? 200, o.color || [255, 255, 255]);
    c.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- inventory
  drawInventory(c) {
    // as in CMI: the room is not dimmed, icons are never highlighted in the chest (the cursor is)
    const chest = imageNow(this.ui.chest);
    if (this.room) this.drawRoom(c);
    if (chest) c.drawImage(chest, 0, 0, 640, 472);
    const inv = this.state.inv, per = INV.cols * INV.rows;
    this.invPage = clamp(this.invPage, 0, Math.max(0, Math.ceil(inv.length / per) - 1));
    for (const id of inv.slice(this.invPage * per, this.invPage * per + per)) {
      if (id !== this.held) this.drawIcon(c, this.path(this.game.items[id]?.icon), ...this.invSlot(id));
    }
    for (const d of [-1, 1]) {
      const img = imageNow(d < 0 ? this.ui.invPrev : this.ui.invNext);
      if (img && this.invCanPage(d)) c.drawImage(img, ...INV_ARROWS[d], 80, 40);
    }
  }

  // top-left of an item's icon on the current chest page
  invSlot(id) {
    const i = this.state.inv.indexOf(id) - this.invPage * INV.cols * INV.rows;
    return [INV.x0 + (i % INV.cols) * INV.dx, INV.y0 + Math.floor(i / INV.cols) * INV.dy];
  }

  invCanPage(d) {
    return d < 0 ? this.invPage > 0 : (this.invPage + 1) * INV.cols * INV.rows < this.state.inv.length;
  }

  invItemAt(x, y) {
    if (!this.invOpen) return null;
    const per = INV.cols * INV.rows;
    const cx = Math.floor((x - INV.x0) / INV.dx), cy = Math.floor((y - INV.y0) / INV.dy);
    if (cx < 0 || cy < 0 || cx >= INV.cols || cy >= INV.rows) return null;
    if (x - INV.x0 - cx * INV.dx > INV.iw || y - INV.y0 - cy * INV.dy > INV.ih) return null;
    const id = this.state.inv[this.invPage * per + cy * INV.cols + cx];
    return id ? { kind: 'item', id, def: this.game.items[id] } : null;
  }

  invArrowAt(x, y) {
    for (const d of [-1, 1]) {
      const [ax, ay] = INV_ARROWS[d];
      if (this.invCanPage(d) && x >= ax && x < ax + 80 && y >= ay && y < ay + 40) return d;
    }
    return 0;
  }

  // ---------------------------------------------------------------- dialogue choices
  drawChoices(c) {
    const ch = this.choices;
    const n = Math.min(ch.options.length, 6);
    const top = H - 29 - (n - 1) * CHOICE_LH;
    ch.layout = [];
    for (let i = 0; i < n; i++) {
      const opt = ch.options[ch.scroll + i];
      const y = top + i * CHOICE_LH;
      ch.layout.push({ idx: ch.scroll + i, y });
      this.font.draw(c, this.t(opt.text), CHOICE_X + (ch.options.length > 6 ? 24 : 0), y, ch.hover === ch.scroll + i ? this.colors.choiceHover : this.colors.choice);
    }
    if (ch.options.length > 6) {
      const up = imageNow(this.ui.dlgUp), dn = imageNow(this.ui.dlgDown);
      if (ch.scroll > 0 && up) c.drawImage(up, 2, top, 24, 30);
      if (ch.scroll + 6 < ch.options.length && dn) c.drawImage(dn, 2, H - 32, 24, 24);
    }
  }

  choiceAt(x, y) {
    const ch = this.choices;
    if (!ch || !ch.layout) return -1;
    for (const l of ch.layout) if (y >= l.y + 3 && y < l.y + CHOICE_LH + 3 && x < W - 10) return l.idx;
    return -1;
  }

  // ---------------------------------------------------------------- hit testing
  hotspotAt(x, y) {
    if (!this.room) return null;
    const rx = x + this.camX, ry = y;
    // actors (not the player), front-most first
    const actors = this.actorsIn(this.room.id).filter(a => a !== this.player && a.visible && !a.def.noHotspot && !(a.def.when && !a.def.when(this.api)))
      .sort((p, q) => q.y - p.y);
    for (const a of actors) {
      let hit;
      const ad = this.actorDef(a);
      if (ad.hot) {
        const hb = ad.hot; // [x, y, w, h] relative to feet, logical
        hit = rx >= a.x + hb[0] && ry >= a.y + hb[1] && rx < a.x + hb[0] + hb[2] && ry < a.y + hb[1] + hb[3];
      } else {
        const b = a.bounds(this.room);
        hit = rx >= b.x && ry >= b.y && rx < b.x + b.w && ry < b.y + b.h;
      }
      if (hit) return { kind: 'actor', id: a.id, def: this.actorDef(a), actor: a };
    }
    const o = this.room.objectAt(this, rx, ry);
    return o ? { kind: 'object', id: o.id, def: o } : null;
  }

  actorDef(a) {
    // the room may extend an actor with handlers (npcs: {agatha: {look, mouth, use}})
    const extra = this.room?.def.npcs?.[a.id] || {};
    return { ...a.def, ...extra, name: extra.name || a.def.name || a.id };
  }

  // ---------------------------------------------------------------- input
  // window (CSS px) -> logical screen coordinates
  toLogical(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const px = (clientX - r.left) * this.dpr, py = (clientY - r.top) * this.dpr;
    return [(px - this.ox) / this.k, (py - this.oy) / this.k];
  }

  bindInput() {
    const cv = this.canvas;
    const pos = e => this.toLogical(e.clientX, e.clientY);
    cv.addEventListener('mousemove', e => {
      const [x, y] = pos(e);
      this.mouse.x = x; this.mouse.y = y;
      this.mouse.inside = x >= 0 && y >= 0 && x < W && y < H;
      if (this.choices) this.choices.hover = this.choiceAt(x, y);
      this.chestWatch();
    });
    cv.addEventListener('mouseleave', () => { this.mouse.inside = false; });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('mousedown', e => {
      this.audio.unlock();
      const [x, y] = pos(e);
      this.mouse.x = x; this.mouse.y = y;
      if (e.button === 2) { this.rightClick(); return; }
      if (e.button !== 0) return;
      this.mouse.down = true; this.mouse.downAt = performance.now(); this.mouse.downX = x; this.mouse.downY = y;
    });
    window.addEventListener('mouseup', e => {
      if (e.button !== 0 || !this.mouse.down) return;
      this.mouse.down = false;
      const [x, y] = pos(e);
      this.mouse.x = x; this.mouse.y = y;
      this.leftRelease(x, y);
    });
    window.addEventListener('keydown', e => this.key(e));
  }

  key(e) {
    this.audio.unlock();
    // typing in a page field (the level editor's panels): not a game key
    const field = e.target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    if (field) { if (this.onKey) this.onKey(e); return; }
    if (e.altKey && e.code === 'Digit0') { e.preventDefault(); this.setGraphics(this.nextGfxMode); return; }
    if (this.onKey && this.onKey(e)) return;
    if (e.key === '.' ) { this.skipLine(); return; }
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
      if (this.overlay && this.overlay.click && !this.started) {    // title screen
        const d = this.overlay.click; this.overlay.click = null; d.resolve(); return;
      }
      if (e.key !== 'Escape') { this.skipLine(); return; }
      if (this.menu) { this.menu = null; return; }
      if (this.cutsceneDepth) { this.skipping = true; this.skipLine(); return; }
      if (this.coin) { this.coin = null; return; }
      if (this.invOpen) { this.invOpen = false; return; }
      if (this.overlay && this.overlay.click) { const d = this.overlay.click; this.overlay.click = null; d.resolve(); return; }
      this.skipLine();
      return;
    }
    if (e.key === 'F5' || e.key === 'F1') { e.preventDefault(); if (this.interactive() || this.menu) this.toggleMenu(); return; }
    if (e.key === 'i' && this.interactive() && !this.choices) { this.toggleInventory(); return; }
  }

  skipLine() {
    if (this.lineSkip) { const s = this.lineSkip; this.lineSkip = null; s(); }
  }

  rightClick() {
    if (this.menu || this.choices) return;
    if (!this.interactive()) { this.skipLine(); return; }
    if (this.coin) { this.coin = null; return; }
    if (this.held) { this.held = null; this.invOpen = true; return; }
    this.toggleInventory();
  }

  toggleInventory() {
    this.invOpen = !this.invOpen;
    if (this.invOpen) this.api.sfx?.('ui_chest');
  }

  leftRelease(x, y) {
    if (this.menu) { this.menuClick(x, y); return; }
    if (this.overlay && this.overlay.click) { const d = this.overlay.click; this.overlay.click = null; d.resolve(); return; }
    if (this.choices) {
      const ch = this.choices;
      // arrows
      if (ch.options.length > 6 && x < 28) {
        if (y > H - 34 && ch.scroll + 6 < ch.options.length) { ch.scroll++; return; }
        const n = Math.min(ch.options.length, 6);
        if (y < H - 29 - (n - 1) * CHOICE_LH + 32 && ch.scroll > 0) { ch.scroll--; return; }
      }
      const i = this.choiceAt(x, y);
      if (i >= 0) { this.choices = null; ch.d.resolve(ch.options[i]); }
      return;
    }
    if (!this.interactive()) { this.skipLine(); this.coin = null; return; }
    if (this.coin) {
      const co = this.coin;
      const v = this.coinZone(x, y);
      const dx = Math.abs(x - co.px), dy = Math.abs(y - co.py);
      this.coin = null;
      if (v) {
        if (co.target.kind === 'item') this.run(() => this.itemVerb(co.target.id, v));
        else this.sentence(v, co.target);
      } else if (co.target.kind !== 'item' && Math.max(dx, dy) + Math.min(dx, dy) / 2 <= 18) this.sentence('walk', co.target);
      return;    // (CMI script 36: released near the press point without a verb = walk to it)
    }
    if (this.invOpen) {
      const arrow = this.invArrowAt(x, y);
      if (arrow) { this.invPage += arrow; return; }
      const it = this.invItemAt(x, y);
      if (!inChest(x, y)) this.invOpen = false;      // outside the chest: close it (a held item stays in hand)
      else if (this.held) {
        if (it && it.id !== this.held) { const a = this.held; this.held = null; this.run(() => this.combine(a, it.id)); }
        else this.held = null;                       // back into the chest
      } else if (it) this.held = it.id;
      return;
    }
    const t = this.hotspotAt(x, y);
    const now = performance.now();
    const dbl = this.lastClick && now - this.lastClick.t < 450 && Math.hypot(x - this.lastClick.x, y - this.lastClick.y) < 12;
    this.lastClick = { t: now, x, y };
    if (this.held) {
      if (t) { const item = this.held; this.held = null; this.sentence('use', t, item); }
      else this.walkPlayer(x + this.camX, y);
      return;
    }
    if (t && t.def.exit) {
      if (dbl) { this.quickExit(t); return; }
      this.sentence('exit', t);
      return;
    }
    this.walkPlayer(x + this.camX, y);
  }

  // double-click on an exit: skip the walk and leave at once
  quickExit(t) {
    const d = t.def;
    if (d.exit.when && !d.exit.when(this.api)) { this.sentence('exit', t); return; }
    this.pending = null;
    const p = this.player;
    const wt = this.room.walkToOf(d);
    p.stopWalking();
    p.x = wt[0]; p.y = wt[1];
    this.run(() => this.dispatch('exit', t));
  }

  walkPlayer(x, y) {
    this.pending = null;
    if (!this.room?.walk) return;
    this.player.walkTo(this.room, x, y);
  }

  // Walk to the target, then run the verb's handler. A later click cancels it.
  async sentence(verb, t, item) {
    const token = {};
    this.pending = token;
    const room = this.room;
    let ok = true;
    const d = t.def;
    const noWalk = verb === 'look' && !d.lookWalk;
    if (t.kind === 'actor') {
      const a = t.actor;
      if (!noWalk) {
        const wt = d.walkTo || [a.x + (this.player.x < a.x ? -60 : 60) * room.scaleAt(a.y), a.y];
        ok = await this.player.walkTo(room, wt[0], wt[1], d.face || (this.player.x < a.x ? 'E' : 'W'));
      } else this.faceTowards(a.x);
    } else if (!noWalk) {
      const wt = room.walkToOf(d);
      ok = await this.player.walkTo(room, wt[0], wt[1], d.face);
    } else {
      this.faceTowards(room.centerOf(d)[0]);
    }
    if (this.pending !== token || !ok || this.room !== room) return;
    this.pending = null;
    await this.run(() => this.dispatch(verb, t, item));
  }

  faceTowards(x) {
    const p = this.player;
    if (p.path.length) return;
    const d = x < p.x - 10 ? 'W' : x > p.x + 10 ? 'E' : null;
    if (d && d !== p.dir) p.turnTo(d);
  }

  async run(fn) {
    this.busy++;
    try { await fn(); } catch (e) { console.error(e); } finally { this.busy--; }
  }

  async dispatch(verb, t, item) {
    const d = t.def;
    const g = this.api;
    if (verb === 'walk') return;
    if (verb === 'exit') {
      if (d.exit.when && !d.exit.when(g)) return this.call(d.hand, g);
      if (d.onExit) await d.onExit(g);
      return this.goRoom(d.exit.room, d.exit);
    }
    if (verb === 'use') {
      const itemDef = this.game.items[item];
      const h = (d.use && (d.use[item] ?? d.use['*'])) ?? (itemDef?.useOn && itemDef.useOn[t.id]);
      if (h !== undefined) return this.call(h, g, item, t.id);
      if (t.kind === 'actor') return this.call(this.game.defaults.give, g, item, t.id);
      return this.call(this.game.defaults.use, g, item, t.id);
    }
    if (verb === 'hand' && d.exit && d.hand === undefined) return this.dispatch('exit', t);
    const h = d[verb];
    if (h !== undefined) return this.call(h, g, t.id);
    const defs = this.game.defaults;
    if (verb === 'look') return this.call(defs.look, g, t.id);
    if (verb === 'hand') return this.call(t.kind === 'actor' ? defs.push : defs.hand, g, t.id);
    return this.call(t.kind === 'actor' ? defs.talk : defs.mouth, g, t.id);
  }

  async itemVerb(id, verb) {
    const it = this.game.items[id];
    const g = this.api;
    this.invOpen = false;
    const h = it?.[verb];
    if (h !== undefined) return this.call(h, g, id);
    const defs = this.game.defaults;
    return this.call(verb === 'look' ? defs.lookItem : verb === 'hand' ? defs.handItem : defs.mouthItem, g, id);
  }

  async combine(a, b) {
    const g = this.api;
    const A = this.game.items[a], B = this.game.items[b];
    this.invOpen = false;
    const h = A?.combine?.[b] ?? B?.combine?.[a];
    if (h !== undefined) return this.call(h, g, a, b);
    return this.call(this.game.defaults.combine, g, a, b);
  }

  // Handler: function | string (player says it) | array of strings (random) | { do: [steps] } (engine/steps.js) | null
  async call(h, g, ...args) {
    if (h == null) return;
    if (typeof h === 'function') return h(g, ...args);
    if (isSteps(h)) return compileSteps(h, { dialogues: this.dialogues(), cards: this.game.cards })(g);
    if (Array.isArray(h)) return g.say(pick(h));
    if (typeof h === 'string') return g.say(h);
  }

  // dialogue trees for talk steps: the current room's, then the game's (cached until either object changes)
  dialogues() {
    const r = this.room?.def.dialogues, gd = this.game.dialogues;
    if (!r) return gd || {};
    if (!gd) return r;
    if (this.dlgCache?.r !== r || this.dlgCache?.gd !== gd) this.dlgCache = { r, gd, all: { ...gd, ...r } };
    return this.dlgCache.all;
  }

  // ---------------------------------------------------------------- rooms
  async goRoom(id, opts = {}) {
    const room = this.rooms.get(id);
    if (!room) throw new Error('no room ' + id);
    const from = this.room;
    this.roomToken++;
    this.pending = null;
    this.coin = null;
    this.roomChange = true;     // hourglass cursor (CMI script 12) until the new room has faded in
    let entered;
    try {
      if (from && opts.fade !== false) await this.fadeTo(1, 0.25);
      if (from && from.def.exit && opts.scripts !== false) await from.def.exit(this.api, id);
      this.texts = [];
      await room.preload(this);
      this.room = room;
      this.state.room = id;
      const p = this.player;
      p.room = id;
      if (opts.x != null) { p.x = opts.x; p.y = opts.y; }
      p.path = [];
      if (opts.dir) p.setDir(opts.dir);
      if (!p.limbs.length) p.init(); else p.stand();
      this.camX = clamp(p.x - W / 2, 0, Math.max(0, room.width - W));
      this.placeActors(room);
      if (room.def.music) this.api.music(room.def.music);
      this.audio.playAmbience(room.def.ambience ? this.path(room.def.ambience) : null);
      entered = room.def.enter && opts.scripts !== false ? room.def.enter(this.api, from?.id) : null;
      if (opts.fade !== false) await this.fadeTo(0, 0.35);
    } finally { this.roomChange = false; }
    if (entered) await entered;
  }

  // the room's actors (room.def.actors), unless the story moved them elsewhere
  placeActors(room) {
    const id = room.id;
    for (const [aid, place] of Object.entries(room.def.actors || {})) {
      const a = this.actors.get(aid);
      if (!a) continue;
      const saved = this.state.actors[aid];
      if (saved && saved.room && saved.room !== id) continue;   // moved elsewhere by the story
      if (place.when && !place.when(this.api)) { if (a.room === id) a.room = null; continue; }
      a.room = id;
      a.x = saved?.x ?? place.x; a.y = saved?.y ?? place.y;
      a.dir = place.dir || a.dir;
      a.scaleOverride = place.scale ?? a.def.scale ?? null;
      a.baseRole = place.anim || a.def.anim || 'stand';
      a.init();
    }
  }

  fadeTo(target, secs) {
    const f = this.fade;
    if (f.done) f.done.resolve();
    f.target = target; f.speed = 1 / Math.max(0.01, secs);
    if (f.a === target) return Promise.resolve();
    f.done = deferred();
    return f.done.promise;
  }

  // ---------------------------------------------------------------- menu (F5)
  toggleMenu() {
    this.menu = this.menu ? null : { items: [], hover: -1 };
    this.refreshMenu();
  }

  refreshMenu() {
    if (!this.menu) return;
    const t = (s, ...a) => this.t(s, ...a);
    const sp = this.textSpeed < 0.9 ? 'fast' : this.textSpeed > 1.2 ? 'slow' : 'normal';
    this.menu.items = [t('Resume'), t('Save game'), t('Load game'), t('Text speed: {0}', t(sp)),
      t('Voices: {0}', t(this.voiceOn ? 'on' : 'off')),
      t('Music: {0}', t(this.audio.musicOn ? 'on' : 'off')),
      t('Graphics: {0} (Alt+0)', t({ hd: 'HD', original: 'original', vga: 'VGA', ega: 'EGA' }[this.gfxMode])),
      t('Language: {0}', LANGS[this.lang.code]), t('Restart'),
      ...(this.bothHeroes ? [t('Hero: {0}', this.standinHero ? 'Drybrush' : 'Guybrush')] : []),
      // entries added by the page (engine.menuExtras: [{label(t), click(engine)}], e.g. engine/byog/)
      ...(this.menuExtras || []).map(x => x.label(t))];
  }

  drawMenu(c) {
    c.fillStyle = 'rgba(0,0,0,0.72)'; c.fillRect(0, 0, W, H);
    // game.title is the title-screen function in most games; the name is then the page's title
    const title = this.t(typeof this.game.title === 'string' ? this.game.title : this.game.name || document.title || '');
    const tw = this.fontBig.width(title);
    this.fontBig.draw(c, title, 320 - tw / 2, 70, [255, 211, 83]);
    const m = this.menu;
    m.hover = -1;
    const step = m.items.length > 9 ? 28 : m.items.length > 8 ? 31 : 36;
    m.items.forEach((it, i) => {
      const y = 150 + i * step, w = this.font.width(it);
      const hov = this.mouse.y >= y && this.mouse.y < y + 32 && Math.abs(this.mouse.x - 320) < w / 2 + 20;
      if (hov) m.hover = i;
      this.font.draw(c, it, 320 - w / 2, y, hov ? this.colors.choiceHover : this.colors.choice);
    });
    if (m.msg) { const w = this.fontSmall.width(m.msg); this.fontSmall.draw(c, m.msg, 320 - w / 2, m.items.length > 8 ? 446 : 420, [255, 255, 255]); }
  }

  menuClick() {
    const m = this.menu;
    if (!m || m.hover < 0) return;
    const i = m.hover;
    if (i === 0) this.menu = null;
    else if (i === 1) { this.save('slot1'); m.msg = this.t('Game saved.'); }
    else if (i === 2) { if (this.load('slot1')) this.menu = null; else m.msg = this.t('No saved game.'); }
    else if (i === 3) { this.textSpeed = this.textSpeed > 1.2 ? 0.7 : this.textSpeed < 0.9 ? 1 : 1.5; this.refreshMenu(); }
    else if (i === 4) { this.voiceOn = !this.voiceOn; localStorage.setItem('cmi-levels:voice', this.voiceOn ? 'on' : 'off'); this.refreshMenu(); }
    else if (i === 5) { this.audio.setMusicOn(!this.audio.musicOn); localStorage.setItem('cmi-levels:music', this.audio.musicOn ? 'on' : 'off'); this.refreshMenu(); }
    else if (i === 6) this.setGraphics(this.nextGfxMode, { quiet: true }).then(() => this.refreshMenu());
    else if (i === 7) this.setLang(this.lang.next()).then(() => { if (m.msg) m.msg = null; this.refreshMenu(); });
    else if (i === 8) { localStorage.removeItem(this.saveKey('auto')); location.reload(); }
    else if (i === 9 && this.bothHeroes) this.switchHero();
    else this.menuExtras?.[i - (this.bothHeroes ? 10 : 9)]?.click(this);
  }

  // the other hero, swapped in place (costume, names, voice, pictures); remembered
  async switchHero() {
    const want = this.standinHero ? 'guybrush' : 'standin';
    const id = this.game.player, a = this.player;
    const costume = await this.loadCostume(id, this.game.actors[id], want);
    if (!costume) return;
    localStorage.setItem('cmi-levels:hero', want);
    this.heroSetup(costume);
    a.costume = costume;
    a.speed = this.game.actors[id].speed || costume.def?.walk || a.speed;
    a.googly = null;
    a.play(a.path.length ? 'walk' : a.talking ? 'talk' : 'stand', { clear: true });
    await preload(Object.values(this.game.items || {}).map(i => this.path(i.icon)));
    this.refreshMenu();
  }

  saveKey(slot) { return `cmi-levels:${this.game.id}:${slot}`; }

  snapshot() {
    const actors = {};
    for (const a of this.actors.values()) actors[a.id] = { room: a.room, x: a.x, y: a.y, dir: a.dir };
    return JSON.stringify({ ...this.state, actors, v: 1 });
  }

  save(slot) {
    if (!this.interactive() && !this.menu) return false;
    localStorage.setItem(this.saveKey(slot), this.snapshot());
    return true;
  }

  load(slot) {
    const s = localStorage.getItem(this.saveKey(slot));
    if (!s) return false;
    const st = JSON.parse(s);
    this.state = { ...this.freshState(), ...st };
    for (const [id, a] of Object.entries(st.actors || {})) {
      const ac = this.actors.get(id);
      if (ac) { ac.room = a.room; ac.x = a.x; ac.y = a.y; if (a.dir) ac.setDir(a.dir); }
    }
    this.texts = []; this.choices = null; this.held = null; this.invOpen = false;
    const p = this.state.actors[this.game.player];
    this.goRoom(st.room, { x: p?.x, y: p?.y, dir: p?.dir });
    return true;
  }

  // ---------------------------------------------------------------- debug overlay
  drawDebug(c) {
    const room = this.room;
    if (!room) return;
    c.save();
    c.translate(-this.camX, 0);
    c.lineWidth = 1;
    if (room.walk) {
      c.strokeStyle = 'rgba(0,255,0,0.8)';
      for (const p of room.walk.polys) { c.beginPath(); p.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); c.stroke(); }
      c.strokeStyle = 'rgba(255,0,0,0.8)';
      for (const p of room.walk.holes) { c.beginPath(); p.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); c.stroke(); }
    }
    c.strokeStyle = 'rgba(0,200,255,0.9)';
    for (const o of room.objects.values()) {
      if (o.box) c.strokeRect(...o.box);
      if (o.hot) { c.beginPath(); o.hot.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); c.stroke(); }
      const wt = room.walkToOf(o);
      c.fillStyle = 'yellow'; c.fillRect(wt[0] - 1.5, wt[1] - 1.5, 3, 3);
    }
    for (const a of this.actorsIn(room.id)) {
      const b = a.bounds(room);
      c.strokeStyle = 'magenta'; c.strokeRect(b.x, b.y, b.w, b.h);
      c.fillStyle = 'magenta'; c.fillRect(a.x - 2, a.y - 2, 4, 4);
    }
    c.restore();
    const m = this.mouse;
    this.fontSmall.draw(c, `${Math.round(m.x + this.camX)},${Math.round(m.y)} s=${room.scaleAt(m.y).toFixed(2)}`, 4, 4, [0, 255, 0]);
  }
}

// A copy of an image drawn through a canvas filter (a plain copy where ctx.filter is unsupported).
function filtered(img, filter) {
  if (!img) return null;
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const x = cv.getContext('2d');
  x.filter = filter;
  x.drawImage(img, 0, 0);
  return cv;
}

// ------------------------------------------------------------------ scripting API
function makeApi(e) {
  const g = {
    get engine() { return e; },
    get room() { return e.room?.id; },
    get player() { return e.player; },
    get skipping() { return e.skipping; },
    actor: id => e.actors.get(id),

    flag: k => e.state.flags[k],
    set(k, v = true) { e.state.flags[k] = v; },
    inc(k) { e.state.flags[k] = (e.state.flags[k] || 0) + 1; return e.state.flags[k]; },
    once(k) { if (e.state.flags['once:' + k]) return false; e.state.flags['once:' + k] = true; return true; },

    has: id => e.state.inv.includes(id),
    give(id) { if (!e.state.inv.includes(id)) e.state.inv.push(id); },
    take(id) { e.state.inv = e.state.inv.filter(x => x !== id); if (e.held === id) e.held = null; },
    swap(a, b) { const i = e.state.inv.indexOf(a); if (i >= 0) e.state.inv[i] = b; else g.give(b); if (e.held === a) e.held = null; },

    state(obj, room) { return e.rooms.get(room || e.room.id).objState(e, obj).state; },
    setState(obj, st, room) { const r = e.rooms.get(room || e.room.id); (r.st(e).objects[obj] ||= {}).state = st; },
    hide(obj, room) { const r = e.rooms.get(room || e.room.id); (r.st(e).objects[obj] ||= {}).hidden = true; },
    show(obj, room) { const r = e.rooms.get(room || e.room.id); (r.st(e).objects[obj] ||= {}).hidden = false; },
    hidden(obj, room) { return e.rooms.get(room || e.room.id).objState(e, obj).hidden; },

    wait(ms) {
      if (e.skipping) return Promise.resolve();
      const d = deferred();
      e.timers.push({ t: e.time + ms / 1000, d });
      return d.promise;
    },

    // Speech. g.say('text') = player; g.say('agatha', 'text'); opts: {wait: false, ms}
    async say(who, text, opts = {}) {
      if (text === undefined || typeof text === 'object') { opts = text || {}; text = who; who = e.game.player; }
      if (Array.isArray(text)) text = pick(text);
      const a = e.actors.get(who);
      if (e.skipping) return;
      const def = e.game.actors[who] || {};
      const lines = e.font.wrap(text, opts.width || def.textWidth || 380);
      const entry = { actor: who, lines, text, width: opts.width || def.textWidth || 380, color: opts.color || def.color || '#fff', at: opts.at };
      e.texts = e.texts.filter(t => t.actor !== who);
      e.texts.push(entry);
      const anim = a && a.room === e.room?.id && a.costume && !opts.noAnim && !a.noTalk;
      if (anim) { a.talking = true; if (!a.path.length) a.play('talk'); }
      const voice = e.voiceOn && (e.playerMute && who === e.game.player ? e.playerLines?.[text]
        : e.voiceMap?.[`${who}|${text}`] || e.game.voice?.[text]);
      // the line can be skipped from the moment it shows, even while its voice is still loading
      const d = deferred();
      let t = null, skipped = false;
      const skip = () => { skipped = true; if (t) e.timers = e.timers.filter(x => x !== t); d.resolve(); };
      e.lineSkip = skip;
      const vdur = voice ? await e.audio.voice(e.path(voice))
        : e.voiceOn && e.playerMumble && who === e.game.player ? e.audio.mumble(e.t(text)) : 0;
      if (!skipped) {
        // voiced lines end with the voice (as in CMI); text-only lines are timed by their length
        const ms = opts.ms ?? (vdur > 0 ? vdur * 1000 + 350 : (900 + e.t(text).length * 55) * e.textSpeed);
        t = { t: e.time + ms / 1000, d };
        e.timers.push(t);
      }
      await d.promise;
      if (e.lineSkip === skip) e.lineSkip = null;
      e.audio.stopVoice();
      e.texts = e.texts.filter(x => x !== entry);
      if (a && anim) {
        a.talking = false;
        if (!a.path.length) { if (a.costume?.roles.talk_stop) a.play('talk_stop'); else a.stand(); }
      }
    },

    // Narration / captions at a fixed position (e.g. title cards)
    async caption(text, opts = {}) {
      return g.say('_narrator', text, { at: opts.at || [320, 40], color: opts.color || '#ffffff', ...opts });
    },

    walk(x, y, face, who) {
      const a = e.actors.get(who || e.game.player);
      return a.walkTo(e.room, x, y, face);
    },
    walkTo(objId) {
      const o = e.room.objects.get(objId);
      const wt = e.room.walkToOf(o);
      return e.player.walkTo(e.room, wt[0], wt[1], o.face);
    },
    face(dir, who) { const a = e.actors.get(who || e.game.player); return a.turnTo(dir); },
    place(who, x, y, dir) { const a = e.actors.get(who); a.x = x; a.y = y; if (dir) a.setDir(dir); a.stand(); },
    preloadAnim(who, role) { const a = e.actors.get(who); const r = a?.costume?.resolve(role, a.dir); if (r) a.costume.preloadAnim(r.anim); },
    anim(who, name, opts = {}) {
      const a = e.actors.get(who);
      const p = a.play(name, { ...opts });
      if (opts.base) a.baseRole = opts.base;
      return opts.wait === false ? Promise.resolve() : p;
    },
    setBase(who, role) { const a = e.actors.get(who); a.baseRole = role; a.stand(); },
    // a body gesture from the costume's roles (pickup_low, pickup_high, use, give, shrug...):
    // turns first when the gesture is only drawn for another view, then returns to standing
    async gesture(role, who) {
      const a = e.actors.get(who || e.game.player);
      if (!a?.costume || e.skipping) return;
      const r = a.costume.resolve(role, a.dir);
      const anim = r && a.costume.anims[r.anim];
      if (!anim) return;
      const same = (a.costume.def.same_pose || []).some(p => p.includes(a.dir) && p.includes(anim.dir));
      if (anim.dir && anim.dir !== a.dir && !same) await a.turnTo(anim.dir);
      a.costume.preloadAnim(r.anim);
      await a.play(role);
      a.stand();
    },
    showActor(who, on = true) { e.actors.get(who).visible = on; },
    moveObj(id, dx, dy, ms = 0, room) {
      const r = e.rooms.get(room || e.room.id);
      const st = (r.st(e).objects[id] ||= {});
      const x0 = st.dx || 0, y0 = st.dy || 0;
      if (!ms || e.skipping) { st.dx = x0 + dx; st.dy = y0 + dy; return Promise.resolve(); }
      const d = deferred();
      e.tweens.push({ t0: e.time, dur: ms / 1000, apply: k => { st.dx = x0 + dx * k; st.dy = y0 + dy * k; }, d });
      return d.promise;
    },
    moveActor(who, room, x, y, dir) {
      const a = e.actors.get(who);
      a.room = room; if (x != null) { a.x = x; a.y = y; } if (dir) a.setDir(dir);
      e.state.actors[who] = { room, x: a.x, y: a.y };
      a.stand();
    },

    async choose(options) {
      const opts = options.filter(Boolean).map(o => typeof o === 'string' ? { text: o, id: o } : o);
      if (!opts.length) return null;
      const d = deferred();
      e.choices = { options: opts, hover: -1, scroll: 0, d };
      const sel = await d.promise;
      if (sel.say !== false) await g.say(sel.text);
      return sel.id ?? sel.text;
    },

    async cutscene(fn) {
      e.cutsceneDepth++;
      e.coin = null;
      try { await fn(); } finally {
        e.cutsceneDepth--;
        if (!e.cutsceneDepth) e.skipping = false;
      }
    },

    goto(room, x, y, dir, opts = {}) { return e.goRoom(room, { x, y, dir, ...opts }); },
    fadeOut(secs = 0.5) { return e.fadeTo(1, secs); },
    fadeIn(secs = 0.5) { return e.fadeTo(0, secs); },

    async showImage(img, opts = {}) {
      await image(e.path(img));
      const click = opts.click !== false ? deferred() : null;
      e.overlay = { img: e.path(img), alpha: 1, block: true, click, text: opts.text, textY: opts.textY, color: opts.color };
      if (click) await Promise.race([click.promise, g.wait(opts.ms || 60000)]);
      else await g.wait(opts.ms || 2000);
      if (!opts.keep) e.overlay = null;
    },
    hideImage() { e.overlay = null; },

    music(name) {
      const m = e.game.music?.[name];
      if (m) e.audio.playMusic(e.path(m.file || m), m);
    },
    stopMusic() { e.audio.stopMusic(); },
    sfx(name, volume = 1) {
      if (e.skipping) return;
      const s = e.game.sfx?.[name];
      if (s) e.audio.sfx(e.path(s.file || s), (s.volume || 1) * volume);
    },
    // plays an anim on an NPC, then back to its base pose unless something else took over
    fidget(who, anim, secs) {
      const a = e.actors.get(who);
      if (!a || a.room !== e.room?.id || !a.visible || a.talking) return;
      const p = a.play(anim);
      const back = () => { if (a.curName === anim && !a.talking) a.stand(); };
      if (secs) e.timers.push({ t: e.time + secs, d: { resolve: back } });
      else p.then(ok => { if (ok !== false) back(); });
    },
    random: arr => pick(arr),
  };
  return g;
}
