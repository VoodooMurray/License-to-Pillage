// Paths into room definitions, shared by the level editor (browser) and tools/js/roomsrc.mjs (node).
// No DOM here.
//
//   objects[id=door].box    npcs.agatha.hot    walk.polys[0]    occluders[1].z    use["*"]
//
// Segments: a key (identifier, or ["any text"]), [id=x] = the array element whose id is x, [n] = index n.

const TOKEN = /([A-Za-z_$][\w$]*)|\[id=([^\]]*)\]|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]|(\.)/y;

export function parsePath(p) {
  const segs = [];
  TOKEN.lastIndex = 0;
  let expectKey = true;
  while (TOKEN.lastIndex < p.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(p);
    if (!m) throw new Error(`bad path ${p} at ${at}`);
    if (m[5]) { expectKey = true; continue; }
    if (m[1] != null) {
      if (!expectKey) throw new Error(`bad path ${p} at ${at}`);
      segs.push({ key: m[1] });
    } else if (m[2] != null) segs.push({ id: m[2] });
    else if (m[3] != null) segs.push({ index: +m[3] });
    else segs.push({ key: JSON.parse(m[4]) });
    expectKey = false;
  }
  return segs;
}

export function formatPath(segs) {
  let s = '';
  for (const g of segs) {
    if (g.id != null) s += `[id=${g.id}]`;
    else if (g.index != null) s += `[${g.index}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(g.key)) s += (s ? '.' : '') + g.key;
    else s += `[${JSON.stringify(g.key)}]`;
  }
  return s;
}

export const joinPath = (base, seg) => formatPath([...parsePath(base), ...(typeof seg === 'string' ? parsePath(seg) : [seg])]);

const segs = p => typeof p === 'string' ? parsePath(p) : p;

// index of the element a segment selects in an array (-1 if none)
export function elementIndex(arr, g) {
  if (!Array.isArray(arr)) return -1;
  if (g.index != null) return g.index < arr.length ? g.index : -1;
  return arr.findIndex(el => el && typeof el === 'object' && !Array.isArray(el) && el.id === g.id);
}

export function getPath(root, p) {
  let v = root;
  for (const g of segs(p)) {
    if (v == null || typeof v !== 'object') return undefined;
    if (g.key != null) { if (Array.isArray(v) || !Object.hasOwn(v, g.key)) return undefined; v = v[g.key]; }
    else { const i = elementIndex(v, g); if (i < 0) return undefined; v = v[i]; }
  }
  return v;
}

// Sets (value undefined: deletes) a value, creating missing objects on the way. Returns false when
// the path runs into a missing array element or a non-object.
export function setPath(root, p, value) {
  const s = segs(p);
  let v = root;
  for (let i = 0; i < s.length; i++) {
    const g = s[i], last = i === s.length - 1;
    if (v == null || typeof v !== 'object') return false;
    if (g.key != null) {
      if (Array.isArray(v)) return false;
      if (last) {
        if (value === undefined) delete v[g.key]; else v[g.key] = value;
        return true;
      }
      if (v[g.key] == null) { if (value === undefined) return true; v[g.key] = {}; }
      v = v[g.key];
    } else {
      const k = elementIndex(v, g);
      if (k < 0) return false;
      if (last) {
        if (value === undefined) v.splice(k, 1); else v[k] = value;
        return true;
      }
      v = v[k];
    }
  }
  return false;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
  return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

// plain data copy (functions are kept by reference)
export function clone(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone);
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = clone(x);
  return o;
}

// numbers as the source formatter writes them: integers, else 2 decimals
export function roundValue(v) {
  if (typeof v === 'number') {
    const r = Number.isInteger(v) ? v : Math.round(v * 100) / 100;
    return Object.is(r, -0) ? 0 : r;
  }
  if (Array.isArray(v)) return v.map(roundValue);
  if (v && typeof v === 'object' && !v.$fn && !v.$opaque) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = roundValue(x);
    return o;
  }
  return v;
}

// true if a model value holds code (a function or a non-static expression) somewhere
export function hasCode(v) {
  if (typeof v === 'function') return true;
  if (v == null || typeof v !== 'object') return false;
  if (v.$fn != null || v.$opaque != null) return true;
  return (Array.isArray(v) ? v : Object.values(v)).some(hasCode);
}
