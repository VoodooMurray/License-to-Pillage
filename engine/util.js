// Small shared helpers.

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// Piecewise linear interpolation over [[x, y], ...] sorted by x.
export function piecewise(points, x) {
  if (!points || !points.length) return 1;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return lerp(y0, y1, (x - x0) / (x1 - x0 || 1));
    }
  }
  return points[points.length - 1][1];
}

export function pointInPoly(p, poly) {
  let inside = false;
  const [x, y] = p;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// A deferred promise that the game loop resolves.
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function parseColor(c) {
  if (Array.isArray(c)) return c;
  if (typeof c === 'string' && c[0] === '#') {
    const h = c.slice(1);
    const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return [255, 255, 255];
}

export const colorCss = c => { const [r, g, b] = parseColor(c); return `rgb(${r},${g},${b})`; };
