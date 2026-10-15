# License to Pillage: notes for Claude Code

This folder is **License to Pillage**, a fan-made chapter for *The Curse of Monkey Island* (CMI): three rooms,
puzzles, dialogue, music and voices. It plays in the browser and, as a real chapter of CMI, inside ScummVM. It uses
pieces of the player's own copy of CMI (Guybrush, the verb coin, the fonts), which are made on this computer from
their game files; this folder holds none of them until then. `README.md` is the player's guide.

## Getting it running
Python 3.8 or newer is the only requirement for the browser version (on Windows: "Add python.exe to PATH").

| goal | run |
|---|---|
| play in the browser, nothing installed | `python3 setup.py web`, then drop the player's game on the page that opens |
| install (ScummVM version + level editor) | `python3 setup.py install` |
| play inside CMI (ScummVM) | `python3 setup.py scummvm` |
| level editor | `python3 setup.py editor` |
| what is installed | `python3 setup.py status` |
| undo the install | `python3 setup.py uninstall` (moves everything it made into `.trash/`) |

- **Browser:** `setup.py web` starts a small local server (port 8765, or the next free one) and opens the page.
  Without an install the page asks for the game: both CD images (`.iso`/`.bin`) or the game folder. Steam: in the
  library, right-click the game → Manage → Browse local files, and drag that folder onto the page. The browser reads
  it there (about 30 s) and keeps the pieces for next time; on a later visit it offers them as one file
  (`License-to-Pillage-pieces.zip`; also F5 → "Save your pieces as a file", or open the page with `?pieces`) that can
  be dropped instead of the CDs. Private windows cannot keep them.
- **Install:** finds Steam and GOG installs by itself. Otherwise `--cmi "<folder with COMI.LA0>"`, or the CD images:
  `--cmi CD1.iso --cmi CD2.iso` (images next to this folder are found too). It creates a private `.venv` with numpy
  and Pillow if the system Python lacks them (needs the internet once), builds the ScummVM version and finds ScummVM
  (2.0 or newer; `--scummvm "<path>"` for another one).
- **Optional packs** (separate downloads):
  - `License-to-Pillage-Voice-Browser-*.zip` (browser) / `License-to-Pillage-Voice-Complete-*.zip` (browser + ScummVM):
    Guybrush's voice. Browser: drop the zip onto the game. Installed copy: `python3 setup.py voice-pack "<zip>"`.
  - `License-to-Pillage-HD-*.zip`: sharper Guybrush, coin and fonts through an AI upscaler. Browser (Chrome or Edge
    with a graphics card): drop the zip onto the game, then the game once more. Installed copy:
    `python3 setup.py hd "<zip>"` (a few minutes; `--remove` undoes it).
- **Languages:** English, German, French, Spanish, Italian (texts; voices stay English). Browser: F5 → Language.
  ScummVM: `python3 setup.py rebuild --lang de` (or `fr`, `es`, `it`, `en`).

## Where things are
| path | what |
|---|---|
| `game/` | the chapter: `game.js` (items, characters, music, start), `rooms/<room>.js` (hotspots, walk areas, dialogue, puzzles), `scripts/`, pictures, music, sounds, voices, `lang/<code>.json` |
| `engine/` | the browser engine (plain ES modules, no build step); `engine/editor/` the level editor; `engine/byog/` reads the player's game in the browser |
| `tools/` | `serve.py` (local server + editor API), `byog/` (reads CMI's files), `scumm/` (builds the ScummVM version), `mcp_editor.py` (an MCP server for the editor), `export_web.py` |
| `games/<key>/` | games made in the level editor (`?game=<key>` plays one; Game → New game makes one) |
| `scumm/` | the ScummVM version: `scumm/game/` after the install, `scumm/saves/` |
| `cmi/`, `.byog/`, `scumm/game/` | made from the player's game by the installer |

## Working in this folder
- Never change or delete the player's CMI installation or CD images: everything here only reads them.
- Move files into `.trash/` instead of deleting them.
- After editing `game/`: reload the browser page; the ScummVM version needs `python3 setup.py rebuild`. Quit ScummVM
  first (the build replaces the files it reads).
- Saving in the level editor needs Node.js (https://nodejs.org); adding new sounds needs ffmpeg. The editor's ✨ AI
  pictures need a ComfyUI server (address under ⚙ in the editor; model names in `tools/comfy_models.json`).
- MCP: while the editor runs, `python3 tools/mcp_editor.py` exposes it to an assistant (list/get/patch rooms,
  generate art, build for ScummVM, export for the web).
- The web version is plain files: any static web server can serve this folder. Without `tools/serve.py` (e.g. GitHub
  Pages) the level editor (`?edit`) runs its Python in the browser (`engine/editor/local/`): games are kept in that
  browser and move as zips (Game → Export / Import); ScummVM builds and ✨ AI pictures need `python3 setup.py editor`.

## Troubleshooting
- macOS says a `.command` file "can't be opened": right-click it → Open → Open.
- The browser asks for the game again: it keeps the pieces per address, so a different port means asking once
  more (or drop the saved pieces file). Clearing the site's data forgets them.
- "A ScummVM is running": quit the ScummVM that plays this copy before rebuilding.
- The HD pack in the browser says it cannot run: it needs WebGPU and Chrome or Edge.
- `python3 setup.py status` lists what is installed and which tools (node, ffmpeg) were found.
