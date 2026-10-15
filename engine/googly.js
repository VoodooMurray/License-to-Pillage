// Googly eyes, live: a costume frame may list its eyes ("eyes": [[x, y, R, r], ...]: centre relative to the actor's
// feet, eye and pupil radius, logical px at scale 1). Each pupil is a disc loose in its eye: gravity, bounces off the
// rim and every jolt of the body (a new frame moves the eye at once) throw it around; standing still, a spring pulls
// it towards the mouse instead. Used by the stand-in hero (mod/artgen/drybrush.py).

const G = 2600;            // px/s^2 at scale 1 (puppet scale: livelier than the real 25 cm brush)
const BOUNCE = 0.82, SLIDE = 0.985;
const LOOK_K = 260, LOOK_DAMP = 7;       // standing: spring towards the cursor (underdamped: it wobbles in place)
const SUB = 1 / 480;

let pupilImg = null;
function pupil() {
  if (pupilImg) return pupilImg;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#121214'; x.beginPath(); x.arc(32, 32, 31, 0, Math.PI * 2); x.fill();
  x.fillStyle = 'rgba(150,150,160,0.55)'; x.beginPath(); x.arc(21, 21, 8, 0, Math.PI * 2); x.fill();
  return (pupilImg = c);
}

// the frame's eyes in room coordinates: [{x, y, R, r}]
function eyesOf(a, room) {
  const s = a.scale(room), out = [];
  for (const limb of a.limbs) {
    const e = limb && !limb.hidden && limb.frame && limb.frame.eyes;
    if (!e) continue;
    for (const [x, y, R, r] of e) out.push({ x: a.x + (limb.flip ? -x : x) * s, y: a.y + y * s, R: R * s, r: r * s });
  }
  return out;
}

export function updateGoogly(a, dt, room, look) {
  const eyes = eyesOf(a, room);
  if (!eyes.length) { a.googly = null; return; }
  // pupil state relative to its eye: o (offset), v (velocity)
  const g = a.googly && a.googly.length === eyes.length ? a.googly
    : eyes.map(e => ({ ox: 0, oy: e.R - e.r, vx: 0, vy: 0, ex: e.x, ey: e.y }));
  const walking = a.path.length > 0, s = a.scale(room);
  const n = Math.max(1, Math.ceil(dt / SUB)), h = dt / n;
  eyes.forEach((e, i) => {
    const p = g[i], travel = Math.max(0.2, e.R - e.r);
    // walking: v is the pupil's speed in the room and the eye moves under it (a new frame: a jolt the rim knocks it
    // with); standing: v is relative to the eye, so the hand's tremor doesn't jolt it
    const evx = walking ? (e.x - p.ex) / Math.max(dt, 1e-3) : 0, evy = walking ? (e.y - p.ey) / Math.max(dt, 1e-3) : 0;
    for (let k = 0; k < n; k++) {
      let ax, ay;
      if (walking) { ax = 0; ay = G * s; }
      else if (look) {                  // standing: a spring towards the cursor (relative to the eye: the tremor doesn't jolt it)
        const dx = look[0] - e.x, dy = look[1] - e.y, d = Math.hypot(dx, dy) || 1, f = travel * Math.min(1, d / 40) / d;
        ax = LOOK_K * (dx * f - p.ox) - LOOK_DAMP * p.vx; ay = LOOK_K * (dy * f - p.oy) - LOOK_DAMP * p.vy;
      } else { ax = -LOOK_DAMP * p.vx; ay = G * s * 0.3 - LOOK_DAMP * p.vy; }
      p.vx += ax * h; p.vy += ay * h;
      p.ox += (p.vx - evx) * h; p.oy += (p.vy - evy) * h;
      const d = Math.hypot(p.ox, p.oy);
      if (d > travel) {                 // on the rim: back in, bounce what moves outwards (relative to the eye)
        const nx = p.ox / d, ny = p.oy / d;
        let rx = p.vx - evx, ry = p.vy - evy;
        const vn = rx * nx + ry * ny;
        p.ox = nx * travel; p.oy = ny * travel;
        if (vn > 0) { rx = (rx - vn * nx) * SLIDE - BOUNCE * vn * nx; ry = (ry - vn * ny) * SLIDE - BOUNCE * vn * ny; }
        p.vx = rx + evx; p.vy = ry + evy;
      }
    }
    if (!walking && p.walked) { p.vx -= p.evx || 0; p.vy -= p.evy || 0; }      // stopped: room speed -> relative
    p.walked = walking; p.evx = evx; p.evy = evy;
    p.ex = e.x; p.ey = e.y; p.px = e.x + p.ox; p.py = e.y + p.oy; p.r = e.r;
  });
  a.googly = g;
}

export function googlyParts(a) {
  if (!a.googly) return [];
  return a.googly.map(p => ({ img: pupil(), x: p.px - p.r, y: p.py - p.r, w: p.r * 2, h: p.r * 2 }));
}
