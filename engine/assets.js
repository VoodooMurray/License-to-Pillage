// Asset loading with a cache. Paths are relative to the project root (index.html).

const images = new Map();
const jsons = new Map();
const audio = new Map();
const versions = new Map();     // path -> a version for files replaced while running (the level editor)
// a replaced file must not come from the browser's in-memory image cache (it reuses images by URL)
const url = path => versions.has(path) ? `${path}${path.includes('?') ? '&' : '?'}v=${versions.get(path)}` : path;

export function image(path) {
  if (!path) return Promise.resolve(null);
  if (!images.has(path)) {
    images.set(path, new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed: ' + path));
      img.src = url(path);
    }));
  }
  return images.get(path);
}

// Returns an already loaded image or null (for draw calls).
const ready = new Map();
export function imageNow(path) {
  if (!path) return null;
  if (ready.has(path)) return ready.get(path);
  image(path).then(img => ready.set(path, img)).catch(e => { console.warn(e.message); ready.set(path, null); });
  ready.set(path, undefined);
  return null;
}

export async function preload(paths) {
  await Promise.all(paths.filter(Boolean).map(p => image(p).then(img => ready.set(p, img)).catch(e => console.warn(e.message))));
}

export function json(path) {
  if (!jsons.has(path)) {
    jsons.set(path, fetch(url(path)).then(r => {
      if (!r.ok) throw new Error('json failed: ' + path);
      return r.json();
    }));
  }
  return jsons.get(path);
}

export async function audioBuffer(ctx, path) {
  if (!audio.has(path)) {
    audio.set(path, fetch(url(path)).then(r => {
      if (!r.ok) throw new Error('audio failed: ' + path);
      return r.arrayBuffer();
    }).then(b => ctx.decodeAudioData(b)));
  }
  return audio.get(path);
}

// Drops a cached image / JSON / sound file so the next use loads it again (the level editor after replacing a file).
export function forget(path) {
  images.delete(path);
  ready.delete(path);
  jsons.delete(path);
  audio.delete(path);
  versions.set(path, Date.now());
}

// the URL an image path is loaded from now (for <img> previews in the editor's panel)
export const assetUrl = url;
