# Project templates (level editor)

`new_game/` is copied to `games/<id>/` by the editor's "New game" (tools/serve.py `POST /api/projects`), with
`{{ID}}` and `{{TITLE}}` filled in. `room.js` is the scaffold of every new room (`POST /api/project/rooms`:
`{{ROOM}}`, `{{NAME}}`, `{{W}}`, `{{H}}`, `{{X}}`, `{{Y}}`, `{{WALKY}}`, `{{WALKX1}}`). Guybrush and the interface come from
`cmi/` (the user's own CMI data, `tools/extract_cmi.py`), never from the project.
