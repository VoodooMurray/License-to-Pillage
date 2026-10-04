// {{NAME}} (room `{{ROOM}}`, made with the level editor). Geometry: edit it in the editor (?edit&game=...).

const R = 'rooms/{{ROOM}}/';

export default {
  id: '{{ROOM}}',
  name: '{{NAME}}',
  size: [{{W}}, {{H}}],
  layers: [{ img: R + 'bg.jpg' }],
  scale: [[{{WALKY}}, 0.45], [480, 0.85]],
  walk: { polys: [[[20, {{WALKY}}], [{{WALKX1}}, {{WALKY}}], [{{W}}, 480], [0, 480]]] },
  entries: { default: [{{X}}, {{Y}}, 'S'] },
  start: [{{X}}, {{Y}}, 'S'],
  objects: [],
};
