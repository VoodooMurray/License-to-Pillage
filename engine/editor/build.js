// ScummVM from the editor (EDITOR_PLAN.md 10f D): a Build button that streams tools/scumm/build.py's
// output into a console, shows build.json's warnings, and offers Play in ScummVM and a standalone web
// export (tools/export_web.py) when it is done. One build at a time; the server refuses while a ScummVM runs.

import { api, getProject } from './api.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Build {
  constructor(ed) {
    this.ed = ed;
    this.box = null;
    this.running = false;
  }

  async open() {
    const ed = this.ed;
    if (this.running) return;
    this.close();
    if ([...ed.docs.values()].some(d => d.dirty().length)
        && confirm('There are unsaved edits; the build reads the files on disk. Save them first?')) await ed.save();
    const key = getProject();
    const box = this.box = document.createElement('div');
    box.className = 'ed-modal';
    box.innerHTML = `<div class="ed-dialog ed-buildwin">
      <h2>ScummVM build — ${esc(key || 'License to Pillage')}</h2>
      <pre class="ed-console"></pre>
      <div class="ed-warnlist"></div>
      <div class="ed-buttons">
        <button data-b="play" disabled title="Play it in your HD ScummVM build (windowed)">▶ Play in ScummVM</button>
        <button data-b="export" title="A standalone web folder in dist/ (no editor; cmi/ is NOT included)">Export web</button>
        <span class="ed-spacer"></span><button data-b="close">Close</button></div></div>`;
    document.getElementById('ed').append(box);
    box.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Escape' && !this.running) this.close(); });
    box.addEventListener('click', ev => this.click(ev, key));
    await this.run(key);
  }

  log(text) {
    const con = this.box?.querySelector('.ed-console');
    if (!con) return;
    con.textContent += text + '\n';
    con.scrollTop = con.scrollHeight;
  }

  async run(key) {
    this.running = true;
    this.log(`$ python3 tools/scumm/build.py${key ? ' --game ' + key : ''}`);
    try {
      const r = await api.buildStream({ game: key }, line => this.log(line));
      if (!this.box) return;
      if (r.error) { this.log('✖ ' + r.error); return; }
      this.log(r.done === 0 ? `✔ built -> ${r.out}` : `✖ failed (exit ${r.done}) — the last lines above say why`);
      const wl = this.box.querySelector('.ed-warnlist');
      if (r.warnings?.length) {
        wl.innerHTML = `<div class="ed-gh">Warnings <span class="ed-dim">${r.warnings.length}</span></div>`
          + r.warnings.map(w => `<div class="ed-row ed-warn">▲ ${esc(w)}</div>`).join('');
      }
      if (r.done === 0) this.box.querySelector('[data-b=play]').disabled = false;
    } finally { this.running = false; }
  }

  async click(ev, key) {
    const b = ev.target.closest('[data-b]');
    if (!b || b.disabled) return;
    const ed = this.ed;
    if (b.dataset.b === 'close') { if (!this.running) this.close(); return; }
    b.disabled = true;
    if (b.dataset.b === 'play') {
      const r = await api.scummPlay({ game: key });
      if (r.status !== 200) { ed.notice(`Play in ScummVM: ${r.data?.error || 'HTTP ' + r.status}`, 'error'); b.disabled = false; }
      else this.log('▶ ScummVM is starting (windowed)…');
      return;
    }
    if (b.dataset.b === 'export') {
      this.log('exporting a standalone web folder…');
      const r = await api.exportWeb({ game: key });
      b.disabled = false;
      if (r.status !== 200) { this.log('✖ export: ' + (r.data?.error || 'HTTP ' + r.status)); return; }
      const d = r.data;
      this.log(`✔ ${d.out} (${d.files} files, ${d.mb} MB).`);
      for (const c of d.cmiDerived || []) this.log(`▲ CMI-derived, not for sharing: ${c}`);
      if (d.standalone) this.log('✦ Standalone — nothing of CMI anywhere: share the folder as it is.');
      else if (d.shareable) {
        this.log('✔ nothing CMI-derived inside, but it plays with the player\'s own cmi/:');
        for (const c of d.cmiReferences || []) this.log(`   · ${c}`);
        if (d.themeMissing?.length) this.log(`   · ${d.themeMissing.length} interface pieces still CMI (Game → ✨ Make a set…, Load font…)`);
      }
    }
  }

  close() {
    this.box?.remove();
    this.box = null;
  }
}
