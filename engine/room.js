// Room runtime: background layers, objects (hotspots with optional sprite states), occluders,
// walk area, actor scale, lighting tint. Room definitions live in the game (games/*/rooms/*.js).
//
// Object def: { id, name, box: [x, y, w, h] | hot: [[x, y], ...], walkTo: [x, y], face: 'N',
//   verbs: {hand: 'pick up', mouth: 'talk to', look: 'look at'}, state: 'a',
//   states: { a: {img, x, y, z, clip: [x, y, w, h]}, b: null }, z, layer: 'bg'|'fg', hidden: bool, exit: {room, x, y, dir},
//   (clip: the sprite, also when moved by g.moveObj, is only drawn inside that room rect)
//   look / hand / mouth: handler (fn(g) | string | [strings]), use: {itemId: handler, '*': handler} }
// Room anims: [{ id, dir }] -> dir/anim.json {frames, fps, scale, atlas: [{rect: [x, y, w, h], ax, ay}]} + dir/fNN.webp
//   (looping animated patches of the background, e.g. water; drawn right over the layers)

import { piecewise, pointInPoly } from './util.js';
import { WalkArea } from './walk.js';
import { imageNow, preload, json } from './assets.js';

export class Room {
  constructor(def, game) {
    this.def = def;
    this.id = def.id;
    this.game = game;
    this.rebuild();
  }

  // size, walk area and object list from the definition (again after the level editor changed it)
  rebuild() {
    const def = this.def;
    this.width = def.size ? def.size[0] : 640;
    this.height = def.size ? def.size[1] : 480;
    this.walk = def.walk ? new WalkArea(def.walk) : null;
    this.objects = new Map();
    for (const o of def.objects || []) this.objects.set(o.id, o);
  }

  // runtime state lives in engine.state.rooms[id] so saves capture it
  st(engine) {
    const s = engine.state.rooms[this.id] ||= { objects: {} };
    return s;
  }

  objState(engine, id) {
    const o = this.objects.get(id);
    const s = this.st(engine).objects[id] ||= {};
    return {
      state: s.state ?? o?.state ?? null,
      // edition: 'extended' = only in that edition (the game flag of the same name, set by the title choice)
      hidden: (o?.edition && !engine.state.flags?.[o.edition]) || (s.hidden ?? !!o?.hidden),
      dx: s.dx || 0, dy: s.dy || 0,
    };
  }

  scaleAt(y) {
    return this.def.scale ? piecewise(this.def.scale, y) : 1;
  }

  tintAt(y) {
    const t = this.def.tint;
    if (!t) return null;
    return t;
  }

  assetPaths(engine) {
    const out = [];
    for (const l of this.def.layers || []) out.push(engine.path(l.img));
    for (const o of this.objects.values()) {
      for (const s of Object.values(o.states || {})) if (s && s.img) out.push(engine.path(s.img));
    }
    for (const oc of this.def.occluders || []) out.push(engine.path(oc.img));
    for (const p of this.def.preload || []) out.push(engine.path(p));
    return out;
  }

  async preload(engine) {
    this.loadAnims(engine);
    await preload(this.assetPaths(engine));
  }

  // Frames decode in the background (the room does not wait for them); a loop runs once all its frames are
  // decoded, until then the painted background shows (it is the loop's resting look).
  loadAnims(engine) {
    if (this.anims) return;
    this.anims = [];
    for (const d of this.def.anims || []) {
      const dir = engine.path(d.dir);
      json(dir + 'anim.json').then(m => {
        const an = { ...m, fps: d.fps || m.fps, imgs: [], ready: 0 };
        this.anims.push(an);
        for (let i = 0; i < m.frames; i++) {
          const img = new Image();
          img.src = dir + `f${String(i).padStart(2, '0')}.webp`;
          img.decode().then(() => { an.imgs[i] = img; an.ready++; }).catch(() => console.warn('anim frame failed: ' + img.src));
        }
      }).catch(e => console.warn(e.message));
    }
  }

  drawAnims(c, time) {
    for (const an of this.anims || []) {
      if (an.ready < an.frames) continue;
      const img = an.imgs[Math.floor(time * an.fps) % an.frames];
      const s = an.scale;
      for (const { rect: [x, y, w, h], ax, ay } of an.atlas) c.drawImage(img, ax, ay, w * s, h * s, x, y, w, h);
    }
  }

  // Sprite of an object in its current state (or null).
  objSprite(engine, o) {
    const { state, hidden, dx, dy } = this.objState(engine, o.id);
    if (hidden || !o.states || state == null) return null;
    const s = o.states[state];
    if (!s || !s.img) return null;
    const img = imageNow(engine.path(s.img));
    const w = s.w ?? (img ? img.naturalWidth / (s.scale || 4) : 0);
    const h = s.h ?? (img ? img.naturalHeight / (s.scale || 4) : 0);
    return { img, x: s.x + dx, y: s.y + dy, w, h, z: s.z ?? o.z ?? (s.y + h), layer: s.layer || o.layer, clip: s.clip };
  }

  // Hotspot test for objects only (actors are tested by the engine). Topmost (highest z) first.
  objectAt(engine, x, y) {
    let best = null, bz = -Infinity;
    for (const o of this.objects.values()) {
      if (o.noHotspot) continue;
      const { hidden } = this.objState(engine, o.id);
      if (hidden) continue;
      if (o.when && !o.when(engine.api)) continue;
      let hit = false;
      if (o.hot) hit = pointInPoly([x, y], o.hot);
      else if (o.box) hit = x >= o.box[0] && y >= o.box[1] && x < o.box[0] + o.box[2] && y < o.box[1] + o.box[3];
      else {
        const sp = this.objSprite(engine, o);
        if (sp) hit = x >= sp.x && y >= sp.y && x < sp.x + sp.w && y < sp.y + sp.h;
      }
      if (hit) {
        const z = o.hotZ ?? o.z ?? 0;
        if (z >= bz) { bz = z; best = o; }
      }
    }
    return best;
  }

  // Default walk-to point: bottom center of the hotspot, snapped to the walk area.
  walkToOf(o) {
    if (o.walkTo) return o.walkTo;
    let cx, by;
    if (o.box) { cx = o.box[0] + o.box[2] / 2; by = o.box[1] + o.box[3]; }
    else if (o.hot) { cx = o.hot.reduce((a, p) => a + p[0], 0) / o.hot.length; by = Math.max(...o.hot.map(p => p[1])); }
    else { cx = 320; by = 400; }
    return this.walk ? this.walk.closest([cx, by + 4]) : [cx, by];
  }

  centerOf(o) {
    if (o.box) return [o.box[0] + o.box[2] / 2, o.box[1] + o.box[3] / 2];
    if (o.hot) return [o.hot.reduce((a, p) => a + p[0], 0) / o.hot.length, o.hot.reduce((a, p) => a + p[1], 0) / o.hot.length];
    return [320, 240];
  }
}
