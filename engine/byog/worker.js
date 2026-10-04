// Reads the player's own copy of The Curse of Monkey Island in the browser: a Web Worker that runs the installer's
// Python (tools/byog/browser.py) in Pyodide (Python + numpy + Pillow in WebAssembly, ./pyodide/). The dropped files
// are mounted read-only and read in place (nothing is copied or uploaded); a CD image's game files are byte ranges of
// the image. Posts back the files it made: {path, data} or {path, link} (the same file under a second name).
import { loadPyodide } from './pyodide/pyodide.mjs';

const ROOT = new URL('../../', import.meta.url).href;      // the site (index.html's folder)
const PY = ['tools/byog/__init__.py', 'tools/byog/gamedir.py', 'tools/byog/decoders.py', 'tools/byog/upscale.py',
  'tools/byog/extract.py', 'tools/byog/ltp_extras.py', 'tools/byog/fence.py', 'tools/byog/iso9660.py',
  'tools/byog/browser.py', 'tools/byog/hdmodel.py', 'tools/akos_extract.py', 'tools/scumm/scummres.py'];
// tools/bun_extract.py (GPL-3.0-or-later, a port of ScummVM's decoder) is not part of the program above: it runs as
// its own program in a separate Python (decodeClips), given the voice bundles, handing back WAV files
const SECTOR = 2048;

const say = (msg, pct) => postMessage({ type: 'progress', msg, pct });
let mounts = null;      // the WORKERFS mounts of the dropped files (for decodeClips' own Python)
const out0 = [];

// tools/bun_extract.py as its own program: a second Python with only it, the voice bundles mounted, its command line
async function decodeClips(tags, voxdisks) {
  const py2 = await loadPyodide({ indexURL: new URL('./pyodide/', import.meta.url).href, stdout: () => {}, stderr: () => {} });
  const r = await fetch(ROOT + 'tools/bun_extract.py', { cache: 'no-store' });
  py2.FS.writeFile('/bun_extract.py', new Uint8Array(await r.arrayBuffer()));
  py2.FS.mkdir('/in');
  py2.FS.mount(py2.FS.filesystems.WORKERFS, { blobs: mounts.in }, '/in');
  if (mounts.cd) { py2.FS.mkdir('/cd'); py2.FS.mount(py2.FS.filesystems.WORKERFS, { blobs: mounts.cd }, '/cd'); }
  py2.FS.mkdir('/clips');
  for (const bun of voxdisks) {
    py2.globals.set('argv', ['bun_extract.py', bun, '--extract', ...tags, '--out', '/clips']);
    try { py2.runPython('import sys, runpy\nsys.argv = list(argv)\ntry:\n    runpy.run_path("/bun_extract.py", run_name="__main__")\nexcept SystemExit:\n    pass'); } catch (err) { /* a bundle without them */ }
  }
  return py2.FS.readdir('/clips').filter(n => n.endsWith('.wav')).map(n => ({ path: 'cmi/voice/' + n, data: py2.FS.readFile('/clips/' + n).buffer }));
}

// a file inside a raw CD dump (2352/2448-byte sectors): its 2048-byte user data, read in place. WORKERFS only needs
// `size` and `slice()` returning a Blob; the Blob is made of the sectors' data parts that the read touches.
class RawFile {
  constructor(img, raw, off, lba, size) { Object.assign(this, { img, raw, off, lba, size }); }
  slice(a = 0, b = this.size) {
    a = Math.max(0, a); b = Math.min(this.size, b);
    const parts = [];
    for (let p = a; p < b;) {
      const s = Math.floor(p / SECTOR), o = p % SECTOR, n = Math.min(SECTOR - o, b - p);
      const at = (this.lba + s) * this.raw + this.off + o;
      parts.push(this.img.slice(at, at + n));
      p += n;
    }
    return new Blob(parts);
  }
}

// A browser error inside a file read or write (a dropped file that changed or vanished after the drop, no permission,
// out of memory) must not cross Python as a JS exception: CPython has its GIL released during the call, Pyodide would
// be left fatally broken and every later step fails with "NoGilError". Retry a read once, then hand Python an ordinary
// I/O error (EIO) and keep the reason for the message.
let ioProblem = null;
let failRead = null;        // tests only (window.__byogTest = {failRead: 'COMI.LA2'}): reads of that file fail
const PIECE = 8 << 20;      // big reads (the 69 and 83 MB data files) in 8 MB pieces: no huge temporary buffers
function guardIo(FS) {
  const wrap = (ops, what, retry) => {
    if (!ops || !ops[what] || ops[what].guarded) return;
    const orig = ops[what];
    const once = function (stream, ...args) {
      for (let attempt = 0; ; attempt++) {
        try {
          if (failRead && what === 'read' && String(stream?.path).endsWith(failRead)) throw new DOMException('test', 'NotReadableError');
          return orig.call(this, stream, ...args);
        } catch (e) {
          if (e && e.name === 'ErrnoError') throw e;
          if (retry && attempt === 0) continue;
          ioProblem = { file: stream?.path || stream?.node?.name || '?', what, error: `${e?.name || 'Error'}: ${e?.message || e}` };
          throw new FS.ErrnoError(29);
        }
      }
    };
    ops[what] = what !== 'read' ? once : function (stream, buffer, offset, length, position) {
      let done = 0;
      while (done < length) {
        const n = Math.min(PIECE, length - done);
        const got = once.call(this, stream, buffer, offset + done, n, position + done);
        done += got;
        if (got < n) break;
      }
      return done;
    };
    ops[what].guarded = true;
  };
  wrap(FS.filesystems.WORKERFS.stream_ops, 'read', true);
  wrap(FS.filesystems.MEMFS.ops_table?.file?.stream, 'write', false);
}

function* walk(FS, dir) {
  for (const n of FS.readdir(dir)) {
    if (n === '.' || n === '..') continue;
    const p = `${dir}/${n}`;
    const st = FS.lstat(p);
    if (FS.isDir(st.mode)) yield* walk(FS, p); else yield [p, st];
  }
}

onmessage = async e => {
  // files: [{path, file}] as dropped; inputs: {path: ArrayBuffer} = the chapter's files its extras read (game/...);
  // hd: the HD pack's {mjs, loader, wasm, model} Blobs (hdpack.js), or nothing
  const { files, inputs, hd } = e.data;
  failRead = e.data.test?.failRead || null;
  try {
    say('Starting Python in your browser…', 2);
    const py = await loadPyodide({ indexURL: new URL('./pyodide/', import.meta.url).href, stdout: () => {}, stderr: () => {} });
    say('Loading numpy and Pillow…', 8);
    await py.loadPackage(['numpy', 'pillow'], { messageCallback: () => {} });
    const FS = py.FS;
    guardIo(FS);
    for (const f of PY) {
      const r = await fetch(ROOT + f, { cache: 'no-store' });
      if (!r.ok) throw new Error(`${f}: ${r.status}`);
      FS.mkdirTree('/app/' + f.split('/').slice(0, -1).join('/'));
      FS.writeFile('/app/' + f, new Uint8Array(await r.arrayBuffer()));
    }
    const given = new Set();
    for (const [p, buf] of Object.entries(inputs || {})) {
      FS.mkdirTree('/out/' + p.split('/').slice(0, -1).join('/'));
      FS.writeFile('/out/' + p, new Uint8Array(buf));
      given.add('/out/' + p);
    }
    FS.mkdir('/in');
    mounts = { in: files.map(f => ({ name: f.path, data: f.file })) };
    FS.mount(FS.filesystems.WORKERFS, { blobs: mounts.in }, '/in');
    py.globals.set('report', (m, pct) => say(m, pct));
    say('Looking at your files…', 12);
    // results cross as JSON text: no Python objects are left for the browser's garbage collector to clean up later
    const plan = JSON.parse(py.runPython(`import sys, json\nsys.path.insert(0, '/app/tools/byog')\nimport browser\nplan = browser.find('/in')\njson.dumps(plan)`));
    if (plan.kind === 'images') {
      const blobs = [];
      for (const [img, t] of Object.entries(plan.tables)) {
        const src = files.find(f => '/in/' + f.path === img)?.file;
        if (!src) throw new Error(`${img}: not found`);
        for (const [name, [lba, size]] of Object.entries(t.files)) {
          blobs.push({ name, data: t.raw ? new RawFile(src, t.raw[0], t.raw[1], lba, size) : src.slice(lba * SECTOR, lba * SECTOR + size) });
        }
      }
      FS.mkdir('/cd');
      mounts.cd = blobs;
      FS.mount(FS.filesystems.WORKERFS, { blobs }, '/cd');
    }
    py.globals.set('extras', inputs && Object.keys(inputs).length ? 'game' : null);
    // the HD pack: Real-ESRGAN on the graphics card (onnxruntime-web, WebGPU); Python waits for each picture
    let hdWhy = null;
    if (hd) {
      try {
        say('Starting the HD upscaler on your graphics card…', 13);
        const ort = await import(URL.createObjectURL(new Blob([hd.mjs], { type: 'text/javascript' })));
        ort.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([hd.loader], { type: 'text/javascript' })) };
        ort.env.wasm.wasmBinary = await hd.wasm.arrayBuffer();
        ort.env.wasm.numThreads = 1;
        ort.env.logLevel = 'error';
        const session = await ort.InferenceSession.create(new Uint8Array(await hd.model.arrayBuffer()), { executionProviders: ['webgpu'] });
        py.globals.set('hd_run', async (x, h, w) => (await session.run({ input: new ort.Tensor('float32', x, [1, 3, h, w]) })).output.data);
      } catch (err) {
        hdWhy = 'the HD upscaler did not start (' + String(err && err.message || err).slice(0, 160) + ')';
      }
    }
    py.globals.set('hd_on', !!hd && !hdWhy);
    // (runPythonAsync: inside it Python may wait for JavaScript promises, the GPU's results)
    const result = JSON.parse(await py.runPythonAsync(`
import json, upscale, hdmodel, numpy as np
hd_used = False
if hd_on:
    from pyodide.ffi import run_sync, to_js, can_run_sync
    if can_run_sync():
        def _gpu(x):
            n, c, h, w = x.shape
            out = run_sync(hd_run(to_js(memoryview(np.ascontiguousarray(x).reshape(-1))), h, w))
            return np.frombuffer(out.to_bytes(), dtype=np.float32).reshape(1, 3, h * 4, w * 4)
        upscale.MODEL = lambda rgb: hdmodel.tiled(_gpu, rgb)
        hd_used = True
try:
    r = browser.run(plan, '/out', extras, report)
finally:
    upscale.MODEL = None
r['hd'] = hd_used
json.dumps(r)
`));
    if (hd && !result.hd) result.hdWhy = hdWhy || 'this browser cannot wait for the graphics card from Python';
    if (result.clips) {
      say("CMI's voice clips…", 95);
      for (const c of await decodeClips(result.clips, result.voxdisks, files, plan)) out0.push(c);
      delete result.clips; delete result.voxdisks;
    }
    say('Keeping the files in your browser…', 96);
    const out = out0;
    for (const [p, st] of walk(FS, '/out')) {
      if (given.has(p)) continue;
      const path = p.slice('/out/'.length);
      if (FS.isLink(st.mode)) out.push({ path, link: FS.readlink(p).replace(/^\/out\//, '') });
      else out.push({ path, data: FS.readFile(p).buffer });
    }
    postMessage({ type: 'done', files: out, result }, out.filter(f => f.data).map(f => f.data));
  } catch (err) {
    // the Python side's PlayerError is a message for the player; a file the browser could not read says which;
    // anything else: a short line + the details
    const text = String(err && err.message || err);
    const player = err && err.type === 'PlayerError' && text.match(/PlayerError: ([\s\S]*?)\s*$/);
    if (player) postMessage({ type: 'error', msg: player[1], details: '' });
    else if (ioProblem) {
      const name = ioProblem.file.split('/').pop();
      postMessage({ type: 'error', details: `${ioProblem.file}: ${ioProblem.error}\n\n${text}`,
        msg: /RangeError|memory|allocation/i.test(ioProblem.error)
          ? `The browser ran out of memory while reading ${name}. Close other tabs and drop the game again.`
          : ioProblem.what === 'read'
            ? `Your browser could not read ${name} (${ioProblem.error.split(':')[0]}). That happens when a file changes or ` +
              'moves after it was dropped, or when the browser may not read it. Drop the game again.'
            : `The browser ran out of room while making the pieces (${ioProblem.error.split(':')[0]}). Close other tabs and try again.` });
    } else postMessage({ type: 'error', msg: 'Something went wrong while reading your game.', details: text });
  }
};
