// Actors: a costume with AKOS-style limb animation states, a position (feet) in the room,
// SCUMM-like walking (per-axis speed caps) and turning (45 degrees per game frame).

import { LimbState } from './costume.js';
import { deferred, dist } from './util.js';
import { updateGoogly, googlyParts } from './googly.js';

const DIRS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const TICK = 1 / 12;           // CMI game frame

export class Actor {
  constructor(id, def, costume) {
    this.id = id;
    this.def = def;
    this.name = def.name || id;
    this.costume = costume;
    this.color = def.color || '#ffffff';
    this.room = null;
    this.x = 0; this.y = 0;
    this.dir = def.dir || 'S';
    this.visible = true;
    this.scaleOverride = null;      // fixed scale (NPCs placed by hand), else room scale
    this.limbs = [];                // LimbState per limb index
    this.path = [];
    this.walkDone = null;
    this.walkFace = null;
    this.talking = false;
    this.baseRole = 'stand';        // what to return to after talking/special anims
    this.animDone = null;
    this.turn = null;               // {target, t, d}
    this.speed = def.speed || costume?.def?.walk || { speed_x: 156, speed_y: 48 };
    this.tint = null;
  }

  get eight() { return (this.costume?.def?.dirs || []).length >= 8; }

  // Plays a role ('stand', 'walk', 'talk', ...) or an anim name. Only the limbs the anim mentions
  // change (AKOS): 'talk' swaps the head limb and keeps the body standing.
  play(name, opts = {}) {
    if (!this.costume) return Promise.resolve();
    const dir = opts.dir || this.dir;
    const r = this.costume.resolve(name, dir);
    if (!r) return Promise.resolve();
    const anim = this.costume.anims[r.anim];
    if (!anim) return Promise.resolve();
    if (opts.clear) this.limbs = [];
    this.applyLimbs(anim, r.flip, name);
    this.curName = name;
    this.costume.preloadAnim?.(r.anim);
    if (this.animDone) { const d = this.animDone; this.animDone = null; d.resolve(false); }
    const holds = anim.limbs.some(l => (l.op || 'set') === 'set' && (l.frames || []).length > 1) &&
      anim.limbs.every(l => (l.op || 'set') !== 'set' || (l.loop_to ?? (anim.loop !== false ? 0 : 1e9)) >= (l.frames || []).length - 1);
    if (anim.loop === false || holds) {
      this.animDone = deferred();
      return this.animDone.promise;
    }
    return Promise.resolve();
  }

  applyLimbs(anim, flip, role, only = null) {
    for (const limbDef of anim.limbs) {
      if (only && !only.has(limbDef.limb)) continue;
      const op = limbDef.op || 'set';
      const cur = this.limbs[limbDef.limb];
      if (op === 'set') {
        const ls = new LimbState(anim, limbDef, flip);
        ls.role = role;
        this.limbs[limbDef.limb] = ls;
      } else if (op === 'stop') { if (cur) cur.hidden = true; }
      else if (op === 'resume') { if (cur) cur.hidden = false; }
      else if (op === 'clear') this.limbs[limbDef.limb] = null;
    }
  }

  // New facing: each limb re-applies the role that set it, for the new direction (keeps heads
  // matching bodies, as SCUMM re-applies the chore's family).
  setDir(d) {
    if (d === this.dir) return;
    this.dir = d;
    this.syncDir();
  }

  // Limbs whose role resolves to another anim for the current facing re-apply it; hidden limbs stay
  // hidden (walk hides the head: its cels have the head baked in).
  syncDir() {
    if (!this.costume) return;
    this.limbs.forEach((l, i) => {
      const r = l?.role && this.costume.resolve(l.role, this.dir);
      const anim = r && this.costume.anims[r.anim];
      if (!anim || (anim === l.anim && r.flip === l.flip)) return;
      this.applyLimbs(anim, r.flip, l.role, new Set([i]));
      if (this.limbs[i]) this.limbs[i].hidden = l.hidden;
    });
  }

  stand() {
    this.play(this.baseRole);
    this.syncDir();
  }

  // AKOS: the init anim sets up every limb (stand and walk only touch some of them)
  init() {
    this.limbs = [];
    if (this.costume?.roles.init) this.play('init');
    this.stand();
  }

  // Turn to a facing, 45 degrees per game frame (4-direction costumes snap).
  turnTo(target) {
    if (!target || target === this.dir) return Promise.resolve();
    if (!this.eight || !DIRS8.includes(target) || !DIRS8.includes(this.dir)) {
      this.setDir(target);
      if (!this.path.length && !this.talking) this.stand();
      return Promise.resolve();
    }
    if (this.turn) this.turn.d.resolve();
    this.turn = { target, t: 0, d: deferred() };
    return this.turn.d.promise;
  }

  update(dt, room, skipping) {
    // turning
    if (this.turn) {
      this.turn.t += dt;
      while (this.turn && (this.turn.t >= TICK || skipping)) {
        this.turn.t -= TICK;
        const i = DIRS8.indexOf(this.dir), j = DIRS8.indexOf(this.turn.target);
        const diff = ((j - i) % 8 + 8) % 8;
        const next = DIRS8[(i + (diff <= 4 ? 1 : 7)) % 8];
        this.setDir(next);
        if (next === this.turn.target) { const d = this.turn.d; this.turn = null; d.resolve(); }
      }
    }
    // walking: SCUMM caps each axis separately (speed_x, speed_y per second at scale 1)
    if (this.path.length) {
      const s = Math.max(0.3, this.scale(room));
      const sx = (this.speed.speed_x ?? 156) * s, sy = (this.speed.speed_y ?? 48) * s;
      let remaining = dt;
      while (remaining > 0 && this.path.length) {
        const [tx, ty] = this.path[0];
        const dx = tx - this.x, dy = ty - this.y;
        if (skipping || Math.hypot(dx, dy) < 0.3) { this.x = tx; this.y = ty; this.path.shift(); continue; }
        const need = Math.max(Math.abs(dx) / sx, Math.abs(dy) / sy);
        const newDir = this.dirFor(dx, dy);
        if (newDir !== this.dir) { this.dir = newDir; this.play('walk'); }
        if (remaining >= need) { this.x = tx; this.y = ty; this.path.shift(); remaining -= need; }
        else { const f = remaining / need; this.x += dx * f; this.y += dy * f; remaining = 0; }
      }
      if (!this.path.length) {
        this.stand();
        // head limb: talking again if a line is still up, else the closed-mouth head
        if (this.talking) this.play('talk');
        else if (this.costume?.roles.talk_stop) this.play('talk_stop');
        const face = this.walkFace;
        this.walkFace = null;
        const w = this.walkDone; this.walkDone = null;
        if (face && face !== this.dir) this.turnTo(face).then(() => w && w.resolve(true));
        else if (w) w.resolve(true);
      }
    }
    // limb animation
    let allDone = true;
    const fps = this.costume?.def?.fps || 12;
    for (const limb of this.limbs) {
      if (!limb) continue;
      limb.step(dt, limb.anim.fps || fps);
      if (!limb.done) allDone = false;
    }
    updateGoogly(this, dt, room, this.look);       // live googly eyes (costume frames with "eyes")
    if (this.animDone && (allDone || skipping)) {
      const a = this.animDone; this.animDone = null; a.resolve(true);
    }
  }

  dirFor(dx, dy) {
    if (!this.eight) {
      if (Math.abs(dx) >= Math.abs(dy) * 0.7) return dx >= 0 ? 'E' : 'W';
      return dy >= 0 ? 'S' : 'N';
    }
    // 8 directions from the true screen angle of the movement, like SCUMM v7+ (getAngleFromPos)
    const a = Math.atan2(dy, dx) * 180 / Math.PI;   // 0 = E, 90 = S
    const names = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
    return names[((Math.round(a / 45) % 8) + 8) % 8];
  }

  walkTo(room, x, y, face) {
    if (this.walkDone) { this.walkDone.resolve(false); this.walkDone = null; }
    if (this.turn) { const d = this.turn.d; this.turn = null; d.resolve(); }
    const target = room.walk ? room.walk.closest([x, y]) : [x, y];
    this.path = room.walk ? room.walk.path([this.x, this.y], target) : [target];
    this.walkFace = face || null;
    if (!this.path.length || (this.path.length === 1 && dist(this.path[0], [this.x, this.y]) < 1)) {
      this.path = [];
      this.walkFace = null;
      return face ? this.turnTo(face).then(() => true) : Promise.resolve(true);
    }
    this.dir = this.dirFor(this.path[0][0] - this.x, this.path[0][1] - this.y);
    this.play('walk');
    this.walkDone = deferred();
    return this.walkDone.promise;
  }

  stopWalking() {
    this.path = [];
    if (this.walkDone) { this.walkDone.resolve(false); this.walkDone = null; }
    this.stand();
  }

  scale(room) {
    if (this.scaleOverride != null) return this.scaleOverride;
    return room ? room.scaleAt(this.y) : 1;
  }

  // Draw list: [{img, x, y, w, h, flip}] in room logical coordinates.
  parts(room) {
    const out = [];
    if (!this.visible || !this.costume) return out;
    const s = this.scale(room);
    for (const limb of this.limbs) {
      if (!limb || limb.hidden) continue;
      const fr = limb.frame;
      if (!fr || !fr.cels) continue;
      for (const c of fr.cels) {
        const info = this.costume.cels[c.cel];
        if (!info) continue;
        const img = this.costume.celImage(c.cel);
        const w = info.w * s, h = info.h * s;
        const x = limb.flip ? this.x - (c.x + info.w) * s : this.x + c.x * s;
        out.push({ img, x, y: this.y + c.y * s, w, h, flip: limb.flip });
      }
    }
    if (this.googly) out.push(...googlyParts(this));
    return out;
  }

  bounds(room) {
    const p = this.parts(room);
    if (!p.length) {
      const s = this.scale(room);
      const hb = this.def.box || [-30, -200, 60, 200];
      return { x: this.x + hb[0] * s, y: this.y + hb[1] * s, w: hb[2] * s, h: hb[3] * s };
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x + q.w); y1 = Math.max(y1, q.y + q.h); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Head position for speech text (logical, room coordinates).
  talkAnchor(room) {
    if (this.def.talkAt) return [this.x + this.def.talkAt[0], this.y + this.def.talkAt[1]];
    const b = this.bounds(room);
    return [this.x, b.y - 6];
  }
}
