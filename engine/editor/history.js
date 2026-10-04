// Undo/redo for one room: commands {label, key, t, ops: [{path, before, after, doc?}]} (undefined = absent; doc: an
// op on another room's file, e.g. moving an arrival point moves the exit in the room it comes from).
// A drag is one command; repeated nudges of the same selection merge within 500 ms.

import { clone } from './paths.js';

export class History {
  constructor(apply) {
    this.apply = apply;          // (op, value) -> void
    this.done = [];
    this.undone = [];
  }

  clear() {
    this.done = [];
    this.undone = [];
  }

  push(cmd) {
    cmd.t = performance.now();
    const last = this.done[this.done.length - 1];
    if (cmd.key && last && last.key === cmd.key && cmd.t - last.t < 500) {
      // merge: keep the oldest before of each path, the newest after
      for (const op of cmd.ops) {
        const o = last.ops.find(x => x.path === op.path && x.doc === op.doc);
        if (o) o.after = clone(op.after); else last.ops.push(op);
      }
      last.t = cmd.t;
    } else this.done.push(cmd);
    this.undone = [];
  }

  undo() {
    const c = this.done.pop();
    if (!c) return null;
    for (const op of [...c.ops].reverse()) this.apply(op, clone(op.before));
    this.undone.push(c);
    return c;
  }

  redo() {
    const c = this.undone.pop();
    if (!c) return null;
    for (const op of c.ops) this.apply(op, clone(op.after));
    this.done.push(c);
    return c;
  }
}
