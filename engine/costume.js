// Costumes: AKOS-like limb animations. A costume JSON (see tools/akos_extract.py, tools/npc.py):
// { scale, cels: {id: {file, w, h}}, anims: {name: {fps, loop, limbs: [{limb, frames: [{cels: [{cel, x, y}], hold}]}]}},
//   roles: {stand: {E: 'anim'|{anim, flip}, ...}, walk: {...}, talk: {...}, ...}, walk: {speed_x, speed_y} }
// x, y of a cel = its top-left relative to the actor's feet, in logical px at scale 1.

import { json, imageNow, preload } from './assets.js';

export class Costume {
  static async load(base) {
    const def = await json(base + '/actor.json');
    const c = new Costume(base, def);
    await c.preloadRoles();
    return c;
  }

  constructor(base, def) {
    this.base = base;
    this.def = def;
    this.scale = def.scale || 4;
    this.anims = def.anims || {};
    this.roles = def.roles || {};
    this.cels = def.cels || {};
  }

  celImage(id) {
    const c = this.cels[id];
    return c ? imageNow(this.base + '/' + c.file) : null;
  }

  celsOf(animName) {
    const a = this.anims[animName];
    const out = new Set();
    if (!a) return out;
    for (const limb of a.limbs) for (const fr of (limb.frames || [])) for (const c of (fr.cels || [])) out.add(c.cel);
    return out;
  }

  // Loads the cels of one anim in the background (first use of rare anims).
  preloadAnim(name) {
    this.loaded ||= new Set();
    if (this.loaded.has(name)) return;
    this.loaded.add(name);
    const files = [];
    for (const id of this.celsOf(name)) if (this.cels[id]) files.push(this.base + '/' + this.cels[id].file);
    preload(files);
  }

  // Preloads the core roles (the rest loads on first use).
  async preloadRoles(extra = []) {
    const core = this.def.preload || ['init', 'walk', 'stand', 'talk', 'talk_stop'];
    const names = new Set(extra);
    for (const [key, role] of Object.entries(this.roles)) {
      if (!core.includes(key)) continue;
      if (typeof role === 'string') names.add(role);
      else if (role && typeof role === 'object') {
        for (const v of Object.values(role)) names.add(typeof v === 'string' ? v : v && v.anim);
      }
    }
    const files = [];
    for (const n of names) for (const id of this.celsOf(n)) if (this.cels[id]) files.push(this.base + '/' + this.cels[id].file);
    await preload(files);
  }

  // Resolves a role (e.g. 'walk') or anim name for a direction -> {anim, flip} or null.
  resolve(name, dir) {
    const r = this.roles[name];
    let v = null;
    if (r !== undefined) {
      if (typeof r === 'string') v = r;
      else v = r[dir] ?? r.E ?? r.S ?? Object.values(r)[0];
    } else if (this.anims[name]) v = name;
    else if (this.anims[name + '_' + dir]) v = name + '_' + dir;
    if (!v) return null;
    if (typeof v === 'string') return { anim: v, flip: false };
    return { anim: v.anim, flip: !!v.flip };
  }
}

// Per-limb animation state for one actor (AKOS semantics: after the last frame continue at
// loop_to; loop_to == last index = hold the last frame, the limb is then "done").
export class LimbState {
  constructor(anim, limbDef, flip) {
    this.anim = anim;            // anim def
    this.family = anim.family;
    this.frames = limbDef.frames || [];
    const last = Math.max(0, this.frames.length - 1);
    this.loopTo = limbDef.loop_to ?? (anim.loop !== false && limbDef.loop !== false ? 0 : last);
    this.flip = flip;
    this.hidden = false;
    this.i = 0;
    this.t = 0;
    this.done = this.frames.length <= 1 || (this.loopTo >= last && this.frames.length <= 1);
  }

  step(dt, fps) {
    if (this.frames.length <= 1) { this.done = true; return; }
    this.t += dt;
    const frameDur = 1 / fps;
    for (let guard = 0; guard < 64; guard++) {
      const hold = (this.frames[this.i].hold || 1) * frameDur;
      if (this.t < hold) break;
      this.t -= hold;
      if (this.i + 1 < this.frames.length) this.i++;
      else if (this.loopTo < this.frames.length - 1) this.i = this.loopTo;
      else { this.done = true; this.t = 0; break; }
    }
  }

  get frame() { return this.frames[this.i]; }
}
