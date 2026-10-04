// The editor's calls to tools/serve.py (every /api request carries X-Editor: 1).

const HEADERS = { 'X-Editor': '1' };

async function call(method, path, body) {
  let r;
  try {
    r = await fetch('/api' + path, {
      method, cache: 'no-store',
      headers: body ? { ...HEADERS, 'Content-Type': 'application/json' } : HEADERS,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return { status: 0, data: { error: 'no editor server (run tools/serve.sh)' } };
  }
  let data = null;
  try { data = await r.json(); } catch (err) { data = { error: `HTTP ${r.status}: not an editor server (run tools/serve.sh)` }; }
  return { status: r.status, data };
}

// the project being edited: null = License to Pillage (game/), else games/<key>/ (tools/projects.py)
let project = null;
export function setProject(key) { project = key || null; }
export function getProject() { return project; }
const q = path => project ? `${path}${path.includes('?') ? '&' : '?'}game=${encodeURIComponent(project)}` : path;

export const api = {
  rooms: () => call('GET', q('/rooms')),
  room: id => call('GET', q(`/room/${id}`)),
  sha: id => call('GET', q(`/room/${id}/sha`)),
  diff: id => call('GET', q(`/room/${id}/diff`)),
  patch: (id, body) => call('POST', q(`/room/${id}/patch`), body),
  // projects (games/<key>/): list, new game, new room, new item, image uploads, the project's images
  projects: () => call('GET', '/projects'),
  newProject: body => call('POST', '/projects', body),
  newRoom: body => call('POST', q('/project/room'), body),
  newItem: body => call('POST', q('/project/item'), body),
  upload: body => call('POST', q('/project/upload'), body),
  background: body => call('POST', q('/project/background'), body),
  actorImage: body => call('POST', q('/project/actor-image'), body),
  actorPose: body => call('POST', q('/project/actor-pose'), body),
  renameItem: body => call('POST', q('/project/item-rename'), body),
  files: () => call('GET', q('/project/files')),
  costumes: () => call('GET', q('/project/costumes')),
  newActor: body => call('POST', q('/project/actor'), body),
  library: () => call('GET', q('/library')),
  gamePatch: edits => call('POST', q('/game/patch'), { edits }),
  opening: () => call('GET', q('/game/opening')),
  sound: body => call('POST', q('/project/sound'), body),
  soundRemove: body => call('POST', q('/project/sound/remove'), body),
  style: () => call('GET', q('/project/style')),
  setStyle: body => call('POST', q('/project/style'), body),
  theme: () => call('GET', q('/project/theme')),
  standalone: () => call('GET', q('/project/standalone')),
  setTheme: body => call('POST', q('/project/theme'), body),
  font: body => call('POST', q('/project/font'), body),
  setOpening: body => call('POST', q('/game/opening'), body),
  ai: (path, body) => call('POST', q('/ai' + path), body),
  aiJob: id => call('GET', `/ai/job/${id}`),
  archive: body => call('POST', q('/library/archive'), body),
  restore: body => call('POST', q('/library/restore'), body),
  libRemove: body => call('POST', q('/library/remove'), body),
  libAdd: body => call('POST', q('/library/add'), body),
  scummPlay: body => call('POST', '/scumm/play', body),
  exportWeb: body => call('POST', '/export/web', body),

  // POST /api/build streams JSON lines: {line} per build.py output line, then {done, warnings, out}
  buildStream: async (body, onLine) => {
    let resp;
    try {
      resp = await fetch('/api/build', { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (err) {
      return { error: 'no editor server (run tools/serve.sh)' };
    }
    if (!resp.ok) {
      try { return await resp.json(); } catch (err) { return { error: 'HTTP ' + resp.status }; }
    }
    const rd = resp.body.getReader(), dec = new TextDecoder();
    let buf = '', last = null;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const o = JSON.parse(line);
        if (o.line != null) onLine(o.line); else last = o;
      }
    }
    return last || { error: 'the build stream ended early' };
  },
};
