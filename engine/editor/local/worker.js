// The level editor without tools/serve.py (a static host such as GitHub Pages): the editor's own server code
// (tools/serve.py + projects.py, library.py, scene.py) runs here in Pyodide, on a virtual copy of this folder:
//   - every file of the release (MANIFEST.json) is there, fetched only when Python reads it;
//   - files the editor writes are kept in this browser (Cache Storage 'ltp-editor-1', index .editor/index.json) and
//     served by sw.js under their usual paths, so the engine plays them like files on a server;
//   - tools/js/roomsrc.mjs / gamesrc.mjs (Node on a desktop) run in this worker: their Node imports swapped for
//     acorn's ES module and a SHA-1 (sha1.js).
// Not here (they need the desktop editor, python3 setup.py editor): the ScummVM build and play, the web export, ✨ AI
// pictures, converting sounds to mp3, the git diff.
//
// Messages: {id, op: 'call', method, path, body} -> {id, status, data, changed}; {op: 'export', key} -> {files};
// {op: 'import', key, files: [{path, data}]} -> {status, data, changed}.
import { loadPyodide } from '../../byog/pyodide/pyodide.mjs';

const ROOT = new URL('../../../', import.meta.url).href;
const CACHE = 'ltp-editor-1';
const INDEX = ROOT + '.editor/index.json';
const SITE = '/site';
const KEEP = rel => !/^\.(trash|history)\//.test(rel) && !/(^|\/)\.[^/]*\.tmp$/.test(rel);
const TYPES = { js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', webp: 'image/webp', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', ttf: 'font/ttf',
  otf: 'font/otf', txt: 'text/plain', md: 'text/plain' };
const urlOf = rel => new URL(rel.split('/').map(encodeURIComponent).join('/'), ROOT).href;

let py, FS, handle, ready, index = { files: {} };
const shipped = new Set();

function getSync(url) {
  const x = new XMLHttpRequest();
  x.open('GET', url, false);
  x.responseType = 'arraybuffer';
  x.send(null);
  if (x.status < 200 || x.status >= 300) throw new Error(`${url}: ${x.status}`);
  return new Uint8Array(x.response);
}

// a file of the release, its size known (MANIFEST.json): nothing is fetched until it is read
function lazy(rel, size) {
  const p = `${SITE}/${rel}`, dir = p.slice(0, p.lastIndexOf('/'));
  FS.mkdirTree(dir);
  const node = FS.createLazyFile(dir, p.slice(dir.length + 1), urlOf(rel), true, true);
  const c = node.contents;
  Object.assign(c, { _length: size, _chunkSize: Math.max(size, 1), lengthKnown: true });
  c.setDataGetter(() => (c.chunks[0] ??= getSync(urlOf(rel))));
}

const isLazy = node => node.contents && !(node.contents instanceof Uint8Array) && 'lengthKnown' in node.contents;

// before Python writes a file: a lazy one becomes a real one (keep: its bytes stay, for 'a' / 'r+')
function unlazy(path, keep) {
  let node;
  try { node = FS.lookupPath(path).node; } catch (err) { return; }
  if (!isLazy(node)) return;
  const data = keep ? FS.readFile(path) : new Uint8Array(0);
  FS.unlink(path);
  FS.writeFile(path, data);
}

const exists = p => { try { return FS.isFile(FS.stat(p).mode); } catch (err) { return false; } };
const mkdirs = p => FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));

// ------------------------------------------------------------------ Node's tools/js scripts, in this worker
async function shim(rel) {
  let text = await (await fetch(ROOT + rel, { cache: 'no-store' })).text();
  text = text.replace(/^import [^\n]* from 'node:[^']+';\n/gm, '')
    .replace(/^const require = createRequire\(import\.meta\.url\);\n/m, '')
    .replace(/require\('acorn'\)/g, '__acorn')
    .replace(/'\.\.\/\.\.\/engine\/editor\/paths\.js'/, `'${ROOT}engine/editor/paths.js'`);
  const head = `import * as __acorn from '${ROOT}tools/js/node_modules/acorn/dist/acorn.mjs';\n`
    + `import { createHash } from '${new URL('./sha1.js', import.meta.url).href}';\n`
    + 'const process = { argv: [] };\n';
  return import(URL.createObjectURL(new Blob([head + text], { type: 'text/javascript' })));
}

let R, G;
// node <script> <args> (stdin) as Python's subprocess.run would see it: {code, stdout, stderr}
function nodeRun(script, argsJson, stdin) {
  const args = JSON.parse(argsJson), read = p => FS.readFile(p, { encoding: 'utf8' });
  const out = (o, code = 0) => JSON.stringify({ code, stdout: JSON.stringify(o) + '\n', stderr: '' });
  const write = (file, text) => { unlazy(file, false); FS.writeFile(file, text); };
  try {
    if (script === 'roomsrc.mjs') {
      const [cmd, file, ...rest] = args;
      if (cmd === 'dump') return out(R.dump(read(file)));
      if (cmd === 'patch') {
        const input = JSON.parse(stdin || '[]');
        const edits = Array.isArray(input) ? input : input.edits || [];
        const r = R.patch(read(file), edits, { force: !!input.force || rest.includes('--force') });
        if (rest.includes('--write')) {
          const ok = r.verify.ok && !r.conflicts.length && !r.errors.length;
          if (ok && r.changed) write(file, r.text);
          const { text: _, ...more } = r;
          return out(more, ok ? 0 : 1);
        }
        return out(r);
      }
    }
    if (script === 'gamesrc.mjs') {
      const [cmd, file, arg] = args;
      if (cmd === 'rooms') return out({ rooms: G.rooms(read(file)) });
      if (cmd === 'add-room') {
        const r = G.addRoom(read(file), arg);
        if (args.includes('--write')) write(file, r.text);
        return out(r);
      }
    }
    return JSON.stringify({ code: 2, stdout: '', stderr: `${script} ${args[0]}: not in the browser editor` });
  } catch (err) {
    return out({ error: err.message }, 1);
  }
}

// ------------------------------------------------------------------ Python: serve.py's handler without sockets
const ADAPTER = `
import builtins, io, json, os, shutil, subprocess, sys
sys.path.insert(0, '${SITE}/tools')
os.chdir('${SITE}')
import ltp_local

TOUCHED = set()
BROWSER = 'not in the browser editor (it needs the desktop editor: python3 setup.py editor)'

class _Done:
    def __init__(self, code, out='', err=''):
        self.returncode, self.stdout, self.stderr = code, out, err

def _run(cmd, *a, input=None, **kw):
    cmd = [os.fspath(c) for c in cmd]
    if cmd[0] == 'node':
        r = json.loads(ltp_local.node(os.path.basename(cmd[1]), json.dumps(cmd[2:]), input or ''))
        return _Done(r['code'], r['stdout'], r['stderr'])
    if cmd[0] == sys.executable and cmd[1:2] == ['-c']:    # serve.postcheck (the SCUMM loader): a desktop check
        return _Done(0, '1\\n')
    if cmd[0] == 'ffmpeg':
        return _Done(1, '', 'the browser editor takes mp3 files only')
    return _Done(1, '', BROWSER)

def _popen(*a, **kw):
    raise OSError(BROWSER)

subprocess.run, subprocess.Popen = _run, _popen

def _abs(p):
    return os.path.abspath(os.fsdecode(p))

def _files(p):
    p = _abs(p)
    if os.path.isdir(p):
        return [os.path.join(dp, f) for dp, _, fns in os.walk(p) for f in fns]
    return [p]

_open = builtins.open
def _topen(file, mode='r', *a, **kw):
    if isinstance(file, (str, bytes, os.PathLike)) and any(c in mode for c in 'wax+'):
        p = _abs(file)
        ltp_local.unlazy(p, 'w' not in mode)
        TOUCHED.add(p)
    return _open(file, mode, *a, **kw)
builtins.open = io.open = _topen

def _moving(fn):
    def wrapped(src, dst, *a, **kw):
        before = _files(src)
        r = fn(src, dst, *a, **kw)
        TOUCHED.update(before)
        TOUCHED.update(_files(dst))
        return r
    return wrapped
os.rename, os.replace = _moving(os.rename), _moving(os.replace)

def _gone(fn):
    def wrapped(p, *a, **kw):
        before = _files(p)
        r = fn(p, *a, **kw)
        TOUCHED.update(before)
        return r
    return wrapped
os.remove, os.unlink, shutil.rmtree = _gone(os.remove), _gone(os.unlink), _gone(shutil.rmtree)

import types
class _NoNet(types.ModuleType):     # ✨ AI pictures talk to ComfyUI through requests: the desktop editor only
    def __getattr__(self, name):
        if name.startswith('__'):
            raise AttributeError(name)
        raise OSError(BROWSER)
sys.modules.setdefault('requests', _NoNet('requests'))

import serve

class _Req(serve.Handler):
    def __init__(self, method, path, body):
        self.command, self.path, self.request_version, self.requestline = method, path, 'HTTP/1.1', method + ' ' + path
        self.headers = {'X-Editor': '1', 'Host': 'localhost:%d' % self.port, 'Content-Length': str(len(body))}
        self.rfile, self.wfile, self.status = io.BytesIO(body), io.BytesIO(), 200

    def send_response(self, code, message=None):
        self.status = code

    def send_header(self, k, v):
        pass

    def end_headers(self):
        pass

def handle(method, path, body):
    TOUCHED.clear()
    h = _Req(method, path, (body or '').encode())
    (h.do_POST if method == 'POST' else h.do_GET)()
    return json.dumps({'status': h.status, 'body': h.wfile.getvalue().decode('utf-8', 'replace'),
                       'touched': sorted(TOUCHED)})
`;

async function boot() {
  py = await loadPyodide({ indexURL: new URL('../../byog/pyodide/', import.meta.url).href, stdout: () => {}, stderr: s => console.warn(s) });
  await py.loadPackage(['numpy', 'pillow'], { messageCallback: () => {} });
  FS = py.FS;
  const man = await fetch(ROOT + 'MANIFEST.json', { cache: 'no-store' });
  if (!man.ok) throw new Error('this copy has no MANIFEST.json (the browser editor needs a release folder)');
  for (const f of (await man.json()).files) { lazy(f.path, f.bytes); shipped.add(f.path); }
  // what this browser kept from earlier visits
  const cache = await caches.open(CACHE);
  index = (await (await cache.match(INDEX))?.json()) || { files: {} };
  for (const [rel, on] of Object.entries(index.files)) {
    const p = `${SITE}/${rel}`;
    try { FS.unlink(p); } catch (err) { /* not there */ }
    if (!on) continue;
    const r = await cache.match(urlOf(rel));
    if (!r) { delete index.files[rel]; continue; }
    mkdirs(p);
    FS.writeFile(p, new Uint8Array(await r.arrayBuffer()));
  }
  [R, G] = await Promise.all([shim('tools/js/roomsrc.mjs'), shim('tools/js/gamesrc.mjs')]);
  py.registerJsModule('ltp_local', { node: nodeRun, unlazy });
  await py.runPythonAsync(ADAPTER);
  handle = py.globals.get('handle');
}

// keeps what a request wrote (files under the folder, minus backups / history / temp files) in this browser
async function persist(touched) {
  const cache = await caches.open(CACHE), changed = [];
  for (const p of touched) {
    if (!p.startsWith(SITE + '/')) continue;
    const rel = p.slice(SITE.length + 1);
    if (!KEEP(rel)) continue;
    if (exists(p)) {
      const type = TYPES[rel.split('.').pop().toLowerCase()] || 'application/octet-stream';
      await cache.put(urlOf(rel), new Response(FS.readFile(p), { headers: { 'Content-Type': type } }));
      index.files[rel] = 1;
    } else if (shipped.has(rel)) {
      await cache.delete(urlOf(rel));
      index.files[rel] = 0;
    } else {
      await cache.delete(urlOf(rel));
      delete index.files[rel];
    }
    changed.push(rel);
  }
  if (changed.length) await cache.put(INDEX, new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } }));
  return changed;
}

function walk(dir, out = []) {
  for (const n of FS.readdir(dir)) {
    if (n === '.' || n === '..') continue;
    const p = `${dir}/${n}`;
    if (FS.isDir(FS.stat(p).mode)) walk(p, out); else out.push(p);
  }
  return out;
}

async function call({ method, path, body }) {
  const r = JSON.parse(handle(method, path, body));
  const changed = await persist(r.touched);
  let data;
  try { data = JSON.parse(r.body); } catch (err) { data = { error: r.body.slice(0, 300) || `HTTP ${r.status}` }; }
  return { status: r.status, data, changed };
}

// a project's files for "Export": games/<key>/... (License to Pillage: only what was changed in this browser)
function exportFiles(key) {
  const base = key ? `${SITE}/games/${key}` : `${SITE}/game`;
  const files = key ? walk(base) : Object.keys(index.files).filter(r => index.files[r] && r.startsWith('game/')).map(r => `${SITE}/${r}`);
  return files.filter(p => !p.split('/').some(s => s.startsWith('.')))
    .map(p => ({ path: p.slice(base.length + 1), data: FS.readFile(p) }));
}

async function importFiles({ key, files }) {
  const dir = `${SITE}/games/${key}`;
  if (exists(`${dir}/game.js`)) return { status: 409, data: { error: `there is already a game "${key}"` }, changed: [] };
  const paths = [];
  for (const f of files) {
    const p = `${dir}/${f.path}`;
    mkdirs(p);
    FS.writeFile(p, new Uint8Array(f.data));
    paths.push(p);
  }
  const changed = await persist(paths);
  return { status: 200, data: { key }, changed };
}

onmessage = async e => {
  const m = e.data;
  try {
    await (ready ??= boot());
    let r;
    if (m.op === 'call') r = await call(m);
    else if (m.op === 'export') {
      const files = exportFiles(m.key);
      r = { files };
      return postMessage({ id: m.id, ...r }, files.map(f => f.data.buffer));
    } else if (m.op === 'import') r = await importFiles(m);
    else if (m.op === 'forget') {
      await caches.delete(CACHE);
      index = { files: {} };
      r = { status: 200, data: { ok: true }, changed: ['*'] };
    } else r = { status: 400, data: { error: 'unknown op' } };
    postMessage({ id: m.id, ...r });
  } catch (err) {
    console.error(err);
    postMessage({ id: m.id, status: 500, data: { error: `${err.name || 'Error'}: ${err.message}` }, changed: [] });
  }
};
