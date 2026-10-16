# License to Pillage
*A Tale of Red Tape and Plunder* — a fan-made chapter for **The Curse of Monkey Island**

Guybrush rows into Port Papeleo, where piracy has been regulated: a sea gate closes the harbor, and only a
stamped **Pirate License** opens it. Three new rooms, six new characters, sixteen items, puzzles, dialogue,
cutscenes, music and sound effects, and voiced characters (Guybrush speaks in subtitles in this release).

You play it two ways, from the same files:
- **Inside The Curse of Monkey Island, in ScummVM.** It is a real chapter of the game, with CMI's own verb coin,
  treasure chest, dialogue menus and saves.
- **In your web browser**, with a faithful CMI-style interface. A **level editor** for making your own scenes and
  games comes with it.

## You need
- **Your own copy of The Curse of Monkey Island** (Steam, GOG or the CD). Nothing of the original game comes with
  this download. Your game files are read on your computer, never changed, and what the chapter needs is made from
  them for you alone.
- **Python 3.8 or newer** ([python.org](https://www.python.org/downloads/); on Windows tick *"Add python.exe to
  PATH"*). It runs the little local server for the browser version. The installer (for ScummVM and the level editor)
  also fetches two Python packages (numpy, Pillow) into a private `.venv` folder here, so it needs the internet once.
- To play inside CMI: **ScummVM** 2.0 or newer. The one Steam ships with CMI works, as does any version from
  [scummvm.org](https://www.scummvm.org).
- Optional, for the level editor: [Node.js](https://nodejs.org) (needed to save edits), ffmpeg (needed to add new
  sounds), and a [ComfyUI](https://www.comfy.org) server (needed for the ✨ AI picture generation).

## Quickest: play in your browser, nothing to install
1. Unzip this folder anywhere.
2. Double-click **Play in Browser** (or run `python3 setup.py web`). Your browser opens the game.
3. The page asks for your game. Drop it onto the page: **both CD images** (`.iso` or `.bin`, from any CD ripping
   tool), or **the game's folder**. Steam: in your library, right-click The Curse of Monkey Island → Manage →
   Browse local files, and drag that folder onto the page.

Your browser reads the game right there (nothing is uploaded) and keeps the few pieces the chapter needs, about 9 MB,
so the game starts straight away next time. On a later visit it offers to save those pieces as one file
(License-to-Pillage-pieces.zip; any time later: F5 → Save your pieces as a file): drop that file instead of the CDs in
another browser or on another computer, and the game is ready in seconds. Reading takes about half a minute. This needs no Python packages. It is
made for current Chrome, Edge, Firefox and Safari, and tested in Chrome. It does not work in private windows,
which can't keep files.

For ScummVM and the level editor, install it as below. If both exist, the installed files are used.

## Install (for ScummVM and the level editor)
1. Unzip this folder anywhere.
2. Double-click **Install** (`Install.command` on a Mac, `Install.bat` on Windows, `./install.sh` on Linux).
   - Or, in a terminal: `python3 setup.py install`
   - Steam and GOG installs are found automatically. Otherwise, give the folder that holds `COMI.LA0`:
     `python3 setup.py install --cmi "/path/to/your/CMI"`
   - From the CDs: use the disc images directly. Put `.iso` / `.bin` files of both CDs into this folder before
     installing, or run `python3 setup.py install --cmi CD1.iso --cmi CD2.iso`. The game files are copied out of them
     once (about 1 GB).
   - Or, from a folder copied from both CDs: it must contain `COMI.LA0`, `COMI.LA1`, `COMI.LA2` and the whole
     `RESOURCE` folder.
3. That's it. It takes about a minute and about 0.5 GB of disk. It makes:
   - `cmi/`: the interface, fonts and Guybrush, taken from your game.
   - `scumm/game/`: the chapter built into a copy of CMI's index plus new data files. Your original files are only
     linked, never written.

On a Mac, the first double-click may say the file "can't be opened because it is from an unidentified developer".
Right-click it, choose **Open**, then **Open** again.

## Optional: Guybrush's voice
In this download Guybrush speaks in subtitles; the other characters are voiced. A separate voice pack voices his lines
too (an AI-generated voice). It comes in two sizes:
- **License-to-Pillage-Voice-Browser** (about 14 MB), for the browser: drop the zip onto the game page (or onto
  the page that asks for your game). The browser keeps it like the game's pieces.
- **License-to-Pillage-Voice-Complete** (about 49 MB), for the browser and ScummVM: drop it onto the page the same
  way, or, for an installed copy, put the zip into this folder and double-click **Install** again (or run
  `python3 setup.py voice-pack "<path to the zip>"`; `python3 setup.py voice-pack --remove` takes it out again).

## Optional: HD pack
A separate download, **License-to-Pillage-HD** (about 23 MB), makes Guybrush, the verb coin, the cursors and the fonts
sharper: your computer upscales the pieces made from your game with an AI upscaler (Real-ESRGAN), once.
- In the browser (Chrome or Edge, with a graphics card): drop the zip onto the game page, then drop your game once
  more. It takes a few minutes.
- For an installed copy: put the zip into this folder and run `python3 setup.py hd` (`--remove` undoes it).

## Play
| | double-click | or run |
|---|---|---|
| inside CMI (ScummVM) | **Play in ScummVM** | `python3 setup.py scummvm` |
| in your browser | **Play in Browser** | `python3 setup.py web` |
| level editor | **Level Editor** | `python3 setup.py editor` |

**Controls** (both versions):
- Click to walk.
- **Hold** the mouse button on anything to open the verb coin (hand / skull / parrot), then release on a verb.
- Right-click opens the treasure chest. Click an item to hold it, then click it on something else. Right-click
  puts it back.
- `.` skips a line, Esc skips a cutscene.

**ScummVM:**
- Save and load from CMI's own menu.
- The game opens in a window. Alt+Enter switches to fullscreen.

**Hero:** play as Guybrush, or as **Drybrush Cheapwood**, a cheap homemade paintbrush puppet with googly eyes
and his own voice (the stand-in hero when Guybrush isn't there yet).
- Browser: F5 → Hero (when both are there): swaps him in on the spot. It is remembered.
- ScummVM: double-click **Play in ScummVM as Drybrush** or **Play in ScummVM as Guybrush** (or
  `python3 setup.py scummvm --hero drybrush`). It is remembered; a change rebuilds the game once (about a minute).

**Languages:** the texts come in English, German, French, Spanish and Italian (the voices stay English).
- Browser: F5 → Language.
- ScummVM: `python3 setup.py rebuild --lang de` (or `fr`, `es`, `it`, `en`), or `install --lang de`. It is remembered.

**Browser:**
- F5 opens the menu (save, load, text speed, voices on/off, graphics, language, hero).
- Alt+0 cycles the graphics: HD → CMI's original low-res → VGA → EGA.
- Keep the little server window open while you play.

Using your own ScummVM setup instead? Add the folder `scumm/game` as a game in ScummVM's launcher. It shows up as
The Curse of Monkey Island; a note that the version is "unknown" is expected, because the chapter changed the game's
index.

## The level editor
`python3 setup.py editor` opens the editor. With it you can:
- edit License to Pillage's rooms: hotspots, walk areas, exits, characters, conversations, puzzles;
- start **your own game** (Game → New game);
- **Build** it for ScummVM and play it there, or **Export** it as a stand-alone web folder.

**In the browser, nothing installed:** open the page with `?edit` (for example on GitHub Pages, or after
`python3 setup.py web`). The same editor runs there: new games, rooms, items, characters, hotspots, texts, pictures
(load your own) and mp3 sounds. What you make is **kept in that browser**; *Game → Export this game* saves it as a zip,
*Import a game* brings it back (in any browser), and the zip's folder can go into `games/` of an installed copy.
Building for ScummVM and ✨ AI pictures need the installed editor.

Everything that comes from CMI can be swapped out for your own in the editor's **Game** section (side panel):
- **Interface theme**: the verb coin (its four states), cursors, the eight exit arrows, the chest screen,
  page/dialogue arrows and the interface colours. Load your own pictures, or let *✨ Make a set…* paint a matching set.
- **Load font…**: any TTF/OTF becomes the game's speech, label or card font.
- **Cards**: the title, chapter cards and THE END.
- **Art style**: a style phrase and reference pictures for ✨ generation.
- **Main character**: ★ next to any character makes them the player. New games can start with their own hero
  instead of Guybrush.
- **✦ Standalone**: this badge appears when nothing of CMI is left in a game. Such a game exports as a web folder you
  may share (`tools/export_web.py <key> --share`).

With no CMI interface extracted, the built-in original interface (nothing of CMI) is used. In ScummVM the interface
and Guybrush are always CMI's own; cards work in both.

**✨ AI pictures** in the editor need a [ComfyUI](https://www.comfy.org) server. Set its address with ⚙ in the
editor. The server needs:
- Flux.2 Klein, for painting and editing;
- a background-removal model (BiRefNet), for cut-outs;
- SAM 3, for picking objects out of a picture.

If your model files are named differently, edit `tools/comfy_models.json`.

**For Claude Code users:** `tools/mcp_editor.py` is an MCP server for the editor (see `.mcp.json` in the developer's
repo). Register it with `python3 tools/mcp_editor.py` while the editor runs, and your assistant can build scenes,
art and builds for you.

## Problems?
- `python3 setup.py status` shows what is installed where.
- The browser asks for your game again: it keeps the pieces per address. If the launcher had to pick another port
  than last time (`127.0.0.1:8765`), it asks once more. Clearing the site's data in your browser forgets them (and a
  voice pack added there).
- Run the installer again after moving or reinstalling CMI.
- `python3 setup.py uninstall` moves everything the installer made into `.trash/`. Your saves stay; `--all` moves
  them too.
- ScummVM says "a ScummVM is running": quit it before rebuilding.

