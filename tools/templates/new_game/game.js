// {{TITLE}}: a game in the style of The Curse of Monkey Island, made with the cmi-levels level editor.
// Rooms: rooms/*.js (one module per room). Guybrush and the interface come from your own CMI (cmi/).

import start from './rooms/start.js';

const game = {
  id: '{{ID}}',
  title: '{{TITLE}}',
  name: '{{TITLE}}',
  player: 'guybrush',
  rooms: [start],

  actors: {
    guybrush: { name: 'Guybrush', costume: 'cmi/actors/guybrush', color: '#ffffff' },
    _narrator: { name: '', color: '#ffffff' },
  },

  items: {
  },

  // what Guybrush says when nothing else is scripted (CMI-style fallbacks)
  defaults: {
    look: ["I don't see anything special about it.", "It looks exactly like it looks."],
    hand: ["I can't pick that up.", "I don't think that would do anything."],
    mouth: ["I'm not putting that in my mouth.", "I'd rather not."],
    push: ["I'd better not push my luck."],
    talk: ["I don't think it'll answer."],
    give: ["I don't think they want that."],
    use: ["That doesn't work.", "I can't use those together."],
    combine: ["I can't combine those.", "Those don't go together."],
    lookItem: ["It's in my inventory. Where it belongs."],
    handItem: ["I can't use that by itself."],
    mouthItem: ["I don't want to eat that."],
  },

  music: {},
  sfx: {},
  voice: {},

  // the opening, as a cutscene (the click that started the game must not walk Guybrush away)
  async start(g) {
    await g.cutscene(async () => {
      await g.goto('start', 320, 430, 'S');
      await g.say("Well. Here I am. Somewhere new.");
    });
  },
};

export default game;
