// One room in the editor: its model on disk (tools/js/roomsrc.mjs dump, through tools/serve.py), the
// edits not saved yet (applied live to the room definition, so the engine previews them at once),
// undo/redo, save with per-path conflict detection, hot swap when the file changes on disk, and
// crash recovery (unsaved edits are kept in localStorage until saved or discarded).

import { api, getProject } from './api.js';
import { History } from './history.js';
import { parsePath, formatPath, getPath, setPath, deepEqual, clone, hasCode } from './paths.js';
import { Room } from '../room.js';

const MISSING = { $missing: true };
export const KEY = id => `cmi-levels:editor:${getProject() ? getProject() + ':' : ''}${id}`;

export class RoomDoc {
  constructor(ed, id) {
    this.ed = ed;
    this.id = id;
    this.base = null;            // model on disk
    this.loc = {};               // path -> source line
    this.sha = null;
    this.file = `${ed.e.base}/rooms/${id}.js`;
    this.pending = new Map();    // path -> value (undefined: delete) since the last save
    this.history = new History((op, v) => (op.doc || this).set(op.path, v));
    this.offline = false;
    this.error = null;
    this.external = false;       // changed on disk while we had unsaved edits
  }

  get room() { return this.ed.e.rooms.get(this.id); }
  get def() { return this.room.def; }

  async load() {
    const r = await api.room(this.id);
    if (r.status !== 200) { this.offline = true; this.error = r.data?.error || `HTTP ${r.status}`; return false; }
    Object.assign(this, { offline: false, error: null, base: r.data.value, loc: r.data.loc, sha: r.data.sha, file: r.data.file });
    return true;
  }

  get(path) { return getPath(this.def, path); }
  disk(path) { return this.base ? getPath(this.base, path) : undefined; }
  line(path) { return this.loc[path]; }

  // sets a live value (undefined deletes it) and records it as unsaved
  set(path, value) {
    setPath(this.def, path, value === undefined ? undefined : clone(value));
    this.pending.set(path, clone(value));
    this.persist();
    this.ed.changed(this, path);
  }

  // an undoable change: ops [{path, after, doc?}] (doc: another room's file), the befores are read from the live
  // definitions
  change(label, ops, key) {
    const full = ops.map(op => {
      const doc = op.doc && op.doc !== this ? op.doc : undefined;
      return { doc, path: op.path, before: clone((doc || this).get(op.path)), after: clone(op.after) };
    }).filter(op => !deepEqual(op.before, op.after));
    if (!full.length) return false;
    for (const op of full) (op.doc || this).set(op.path, op.after);
    this.history.push({ label, key, ops: full });
    return true;
  }

  // the end of a drag: the live values already changed; befores were taken at its start
  commitDrag(label, befores) {
    const ops = [...befores].map(([path, before]) => ({ path, before, after: clone(this.get(path)) }))
      .filter(op => !deepEqual(op.before, op.after));
    if (!ops.length) return false;
    for (const op of ops) this.set(op.path, op.after);
    this.history.push({ label, ops });
    return true;
  }

  // the end of a drag over several rooms' files: befores [{doc, path, before}]
  commitAcross(label, befores) {
    const ops = befores.map(b => ({ doc: b.doc !== this ? b.doc : undefined, path: b.path, before: b.before, after: clone(b.doc.get(b.path)) }))
      .filter(op => !deepEqual(op.before, op.after));
    if (!ops.length) return false;
    for (const op of ops) (op.doc || this).set(op.path, op.after);
    this.history.push({ label, ops });
    return true;
  }

  // Can this path be written back into the source? (a literal on disk, or a missing key of one)
  editable(path) {
    if (!this.base) return { ok: false, why: this.error || 'not loaded' };
    const segs = parsePath(path);
    for (let i = segs.length; i >= 1; i--) {
      const pre = formatPath(segs.slice(0, i));
      const v = getPath(this.base, pre);
      if (v === undefined) continue;
      if (i === segs.length && hasCode(v)) return { ok: false, why: `scripted in ${this.file}:${this.loc[pre] ?? '?'}` };
      if (!(pre in this.loc)) return { ok: false, why: `${pre} is not a literal in ${this.file}` };
      if (i < segs.length && (v === null || typeof v !== 'object' || Array.isArray(v) || v.$fn || v.$opaque)) return { ok: false, why: `${pre} is not an object` };
      return { ok: true };
    }
    return { ok: true };
  }

  dirty() { return [...this.pending].filter(([p, v]) => !deepEqual(v, this.disk(p))); }

  edits() {
    return this.dirty().map(([path, value]) => {
      const d = this.disk(path);
      const expect = d === undefined ? MISSING : d;
      return value === undefined ? { op: 'del', path, expect } : { op: 'set', path, value, expect };
    });
  }

  // one save at a time (⌘S during a save waits for it, then saves whatever is still pending)
  async save(opts = {}) {
    while (this.saving) await this.saving.catch(() => {});
    const p = this._save(opts);
    this.saving = p;
    try { return await p; } finally { if (this.saving === p) this.saving = null; }
  }

  async _save({ force = false } = {}) {
    const edits = this.edits();
    if (!edits.length) { this.prune(); this.persist(); return { ok: true, nothing: true }; }
    const r = await api.patch(this.id, { sha: this.sha, edits, force });
    if (r.status === 409) return { ok: false, conflicts: r.data.conflicts };
    if (r.status !== 200) {
      const d = r.data || {};
      const why = d.error || (d.errors || []).map(x => `${x.path}: ${x.error}`).join('; ') || d.verify?.error || `HTTP ${r.status}`;
      return { ok: false, error: why };
    }
    const changedOnDisk = r.data.baseSha !== this.sha;
    Object.assign(this, { base: r.data.model, loc: r.data.loc, sha: r.data.sha, external: false });
    // drop only what was sent and hasn't changed since: edits made during the save stay pending
    for (const e of edits) {
      const sent = e.op === 'del' ? undefined : e.value;
      if (this.pending.has(e.path) && deepEqual(this.pending.get(e.path), sent)) this.pending.delete(e.path);
    }
    this.persist();
    if (changedOnDisk) { await this.hotSwap(); this.resetHistory(); }
    return { ok: true, diff: r.data.diff, postcheck: r.data.postcheck, wrote: r.data.wrote, n: edits.length };
  }

  // pending entries that are no-ops now, or whose place in the file is gone (a removed object): out
  prune() {
    for (const [p, v] of [...this.pending]) {
      if (deepEqual(v, this.disk(p)) || !this.editable(p).ok) this.pending.delete(p);
    }
  }

  // after a structural change or an external reload the befores in the history are stale: undo would
  // write old values over the new file, so the room's undo history starts fresh
  resetHistory() {
    if (this.history.done.length || this.history.undone.length) {
      this.history.clear();
      this.ed.status(`${this.file}: the file was rewritten, the undo history of this room starts fresh.`);
    }
  }

  // unsaved edits back to the disk values (undoable)
  revert() {
    return this.change('revert unsaved edits', this.dirty().map(([path]) => ({ path, after: clone(this.disk(path)) })));
  }

  // Re-imports the room module (a fresh definition, as on disk) and re-applies the unsaved edits.
  async hotSwap() {
    const e = this.ed.e;
    const url = new URL(e.path(`rooms/${this.id}.js`) + `?v=${this.sha}-${Date.now()}`, location.href);
    const def = (await import(url.href)).default;
    const i = e.game.rooms.findIndex(r => r.id === this.id);
    if (i >= 0) e.game.rooms[i] = def;
    for (const [p, v] of this.pending) setPath(def, p, clone(v));
    const room = new Room(def, e.game);
    e.rooms.set(this.id, room);
    await room.preload(e);
    if (e.room?.id === this.id) { e.room = room; e.placeActors(room); }
    this.ed.changed(this, null);
  }

  // the file changed on disk (another tool or agent): reload if we have nothing unsaved
  async poll() {
    if (this.offline || this.saving || this.ed.pollHold || !this.sha) return;
    const r = await api.sha(this.id);
    if (r.status !== 200 || r.data.sha === this.sha || this.saving || this.ed.pollHold) return;
    if (!this.dirty().length) {
      const old = { base: this.base, loc: this.loc, sha: this.sha };
      try {
        if (await this.load()) { await this.hotSwap(); this.resetHistory(); this.ed.notice(`${this.file} changed on disk: reloaded.`); }
      } catch (err) {
        // a half-written file (an agent mid-save): keep the old definition and try again on the next poll
        Object.assign(this, old);
        if (this.badSha !== r.data.sha) { this.badSha = r.data.sha; this.ed.notice(`${this.file} changed on disk but didn't load (${err.message}); retrying.`, 'warn'); }
      }
    } else if (!this.external) {
      this.external = true;
      this.ed.notice(`${this.file} changed on disk. Your unsaved edits are checked for conflicts when you save.`, 'warn');
    }
  }

  persist() {
    const d = this.dirty();
    if (d.length) localStorage.setItem(KEY(this.id), JSON.stringify({ sha: this.sha, t: Date.now(), edits: d }));
    else localStorage.removeItem(KEY(this.id));
  }

  recovered() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY(this.id)) || 'null');
      return s?.edits?.length ? s : null;
    } catch (err) { return null; }
  }

  restore(saved) {
    return this.change('restore unsaved edits', saved.edits.map(([path, after]) => ({ path, after })));
  }
}
