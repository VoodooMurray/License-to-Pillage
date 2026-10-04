// LICENSE TO PILLAGE — a new Monkey Island chapter. Game definition for the cmi-levels engine.
// Rooms: rooms/harbor.js, rooms/office.js, rooms/records.js. Design: docs/DESIGN_spoilers.md

import harbor from './rooms/harbor.js';
import office from './rooms/office.js';
import records from './rooms/records.js';
import { fillForm } from './scripts/form.js';

const game = {
  id: 'license',
  title: 'License to Pillage',
  name: 'License to Pillage',     // (title is also the title-screen function below, which wins)
  player: 'guybrush',
  rooms: [harbor, office, records],

  actors: {
    guybrush: { name: 'Guybrush', costume: 'actors/guybrush', color: '#ffffff' },
    agatha: { name: 'clerk', costume: 'actors/agatha', color: '#e4a3ff', anim: 'stand', zBias: -100 },
    mort: { name: 'skeleton', costume: 'actors/mort', color: '#a8e8ff', anim: 'stand' },
    painter: { name: 'painter', costume: 'actors/painter', color: '#ffb040', anim: 'stand' },
    filbert: { name: 'Filbert', costume: 'actors/filbert', color: '#8cff5a', anim: 'stand', tint: false },
    squid: { name: 'squid', costume: 'actors/squid', color: '#ff9ccf', anim: 'stand', tint: false, zBias: 6 },
    harbormaster: { name: 'Harbor Master', color: '#ff6a3a' },
    _narrator: { name: '', color: '#ffffff' },
  },

  items: {
    ticket_big: {
      name: 'ticket number 9,999,999', icon: 'items/ticket_big.png',
      look: "My number: nine million and then some. My grandchildren will be so proud when it's called.",
      mouth: "I'm not eating my place in line.",
    },
    ticket_7: {
      name: 'ticket number 7', icon: 'items/ticket_7.png',
      look: "Ticket number seven. It's covered in little notches. Gnawed, I think. By a skeleton.",
      mouth: "I know where it's been. That's the problem.",
    },
    feather: {
      name: 'feather', icon: 'items/feather.png',
      look: "A long, soft feather from the feather duster. Very tickly.",
      hand: async g => { await g.say("Hee hee! Stop it, Guybrush!"); await g.say("...I really need to get off this island."); },
      mouth: "It tickles my nose. Ah... ah... no. False alarm.",
      combine: {
        ink: async g => {
          g.take('feather'); g.give('quill');
          g.sfx('dip');
          await g.say("I dip the feather in the squid ink and... voila! One quill.");
          await g.say("My old schoolteacher would be so proud. She always said I'd end up with a criminal record.");
        },
        form: "The feather needs some ink before I can write with it.",
      },
    },
    form: {
      name: 'Form 27-B/6', icon: 'items/form.png',
      look: "Form 27-B/6: Application for Piratical Licensure. It has more boxes than a shipping company.",
      mouth: "It tastes like bureaucracy. Dry, with a hint of despair.",
      combine: {
        quill: g => fillForm(g),
        ink: "I need something to write with, not something to pour on it.",
      },
    },
    form_done: {
      name: 'completed Form 27-B/6', icon: 'items/form_done.png',
      look: "My completed application. My handwriting is terrible, but my piracy is magnificent.",
      mouth: "Not after all that work.",
    },
    bottle: {
      name: 'empty ink bottle', icon: 'items/bottle.png',
      look: "An empty ink bottle. The second saddest kind of bottle, after an empty grog bottle.",
      mouth: "It's empty. I checked. Twice.",
    },
    ink: {
      name: 'bottle of squid ink', icon: 'items/ink.png',
      look: "A bottle of regulation squid ink. Freshly squeezed.",
      mouth: "No way! It's regulation ink. I'd be drinking evidence.",
      combine: {
        feather: g => game.items.feather.combine.ink(g),
        stamp: g => game.items.stamp.combine.ink(g),
        form: "I need something to write with, not something to pour on it.",
        lime: "Lime juice and squid ink. That's either invisible ink or a very bad cocktail.",
        menu: "I could ink over 'calamari'... but the squid has already seen it. The damage is done.",
      },
    },
    quill: {
      name: 'inked quill', icon: 'items/quill.png',
      look: "A makeshift quill, dripping with squid ink. I'm practically a notary.",
      mouth: "I'd end up with a blue tongue. Well, a black tongue. Squid ink.",
      combine: { form: g => fillForm(g), ink: "It's inky enough already." },
    },
    menu: {
      name: 'calamari menu', icon: 'items/menu.png',
      look: "The Salty Squid Tavern. TONIGHT'S SPECIAL: FRIED CALAMARI, served with a wedge of lime. Not a good night to be a squid.",
      mouth: "I'm hungry, but I'm not eating the menu.",
    },
    eyepatch: {
      name: 'eye patch', icon: 'items/eyepatch.png',
      look: "An eye patch from the Lost and Found. I hope the previous owner found a replacement. Or at least his way home.",
      hand: "I'll save it for the portrait. When I wear it, I walk into things.",
      mouth: "I don't know where it's been. Well, I know one place it's been.",
    },
    parrot: {
      name: 'Filbert', icon: 'items/parrot.png',
      look: "Filbert, the filing parrot. He has a tiny clerk's visor and an enormous opinion of himself.",
      mouth: async g => { await g.say("Say something, Filbert."); await g.say('filbert', "SQUAWK! Form 27-B/6! Form 27-B/6!"); },
      hand: async g => { await g.say("Who's a pretty bird?"); await g.say('filbert', "SQUAWK! Flattery must be submitted in writing!"); },
    },
    lime: {
      name: 'lime', icon: 'items/lime.png',
      verbs: { mouth: 'eat' },
      look: "A Scurvy-B-Gone lime. Just looking at it makes my face pucker.",
      mouth: async g => {
        g.take('lime');
        g.sfx('crunch');
        await g.say("YEEOWCH! That's SOUR!");
        await g.say("My face is stuck like this! No, wait. It's back.");
        await g.say("Well, that was a waste of a perfectly good scowl.");
      },
    },
    portrait: {
      name: 'license portrait', icon: 'items/portrait.png',
      look: async g => {
        await g.showImage('art/portrait_reveal.jpg', { click: true, ms: 9000 });
        await g.say("My license portrait: eye patch, parrot, and the most fearsome scowl in the Caribbean. I look terrible. It's perfect.");
      },
      mouth: "Monsieur Daube would have me keelhauled.",
    },
    stamp: {
      name: 'APPROVED stamp', icon: 'items/stamp.png',
      look: "The long-lost APPROVED stamp! Its ink pad dried up sometime around 1672.",
      mouth: "It tastes like 1672.",
      combine: {
        ink: async g => {
          g.take('stamp'); g.give('stamp_inked');
          g.sfx('dip');
          await g.say("I dab the stamp in the squid ink.");
          await g.say("APPROVED has never looked so good.");
        },
      },
    },
    stamp_inked: {
      name: 'inked APPROVED stamp', icon: 'items/stamp_inked.png',
      look: "The APPROVED stamp, dripping with fresh squid ink. It's the most powerful object in the Caribbean.",
      mouth: "I'd end up with APPROVED on my tongue. Actually, that sounds kind of nice.",
    },
    candle: {
      name: 'candle', icon: 'items/candle.png',
      look: "A candle stub from the Archives. It's been on duty since 1672. It's earned a rest.",
      mouth: "It's a candle, not a breadstick.",
      combine: { chicken: "A rubber chicken with a candle on top. The saddest birthday cake in the Caribbean." },
    },
    chicken: {
      name: 'rubber chicken', icon: 'items/chicken.png',
      look: "A rubber chicken with no pulley in the middle. It's completely useless. I love it.",
      hand: async g => { g.sfx('squeak'); await g.wait(500); await g.say("Nope. Still no pulley."); },
      mouth: "It tastes like rubber. And a little like chicken.",
      combine: { menu: "Rubber chicken isn't on the menu. Lucky chicken." },
    },
    license: {
      name: 'Pirate License', icon: 'items/license.png',
      look: "My Pirate License! Stamped, signed and portraited. I am officially, legally, bureaucratically a pirate.",
      mouth: "I'm not eating the only approved document in the Caribbean.",
    },
  },

  // CMI-style fallbacks
  defaults: {
    look: ["I don't see anything special about it.", "It looks exactly like it looks.", "Hmm. Nope, nothing."],
    hand: ["I can't pick that up.", "I don't think that would do anything.", "That's not going to work.", "I'd rather not."],
    mouth: ["I'm not putting that in my mouth.", "I'd rather not.", "I'm hungry, but not THAT hungry."],
    push: ["I'd better not push my luck.", "I don't think that would be appreciated."],
    talk: ["I don't think it'll answer.", "It's not much of a conversationalist."],
    give: ["I don't think they want that.", "I think I'll hang on to that."],
    use: ["That doesn't work.", "I can't use those together.", "Nope. That didn't do anything."],
    combine: ["I can't combine those.", "Those don't go together.", "That doesn't work."],
    lookItem: ["It's in my inventory. Where it belongs."],
    handItem: ["I can't use that by itself.", "I need to use it with something."],
    mouthItem: ["I don't want to eat that.", "That's not food. Probably."],
  },

  music: {
    title: { file: 'music/title.mp3' },
    harbor: { file: 'music/harbor.mp3' },
    office: { file: 'music/office.mp3' },
    records: { file: 'music/records.mp3' },
    ending: { file: 'music/ending.mp3' },
  },
  sfx: {
    gate_slam: 'sfx/gate_slam.mp3', gate_raise: 'sfx/gate_raise.mp3', shutter: 'sfx/shutter.mp3', knock: 'sfx/knock.mp3', ding: 'sfx/ding.mp3',
    stamp: 'sfx/stamp.mp3', splash: 'sfx/splash.mp3', squirt: 'sfx/squirt.mp3', ticket: 'sfx/ticket.mp3',
    paper: 'sfx/paper.mp3', door: 'sfx/door.mp3', drawer: 'sfx/drawer.mp3', squawk: 'sfx/squawk.mp3',
    rattle: 'sfx/rattle.mp3', squeak: 'sfx/squeak.mp3', laugh: 'sfx/laugh.mp3', crunch: 'sfx/crunch.mp3', dip: 'sfx/dip.mp3', ui_chest: 'sfx/chest.mp3',
  },
  voice: {},  // text -> voice file (tools/voice.py)

  async title(g, begin) {
    const e = g.engine;
    e.started = false;
    await g.showImage('art/title.jpg', { click: true, ms: 3600000, keep: true });
    e.audio.unlock();
    begin();
  },

  async start(g) {
    const e = g.engine;
    e.started = true;
    g.music('title');
    if (!e.overlay) await g.showImage('art/title.jpg', { click: false, ms: 10, keep: true });
    // ScummVM: the title card waits for the player like CMI's own start menu (the web's title screen is
    // game.title(), before this)
    if (!e.web) await g.choose([{ id: 'start', text: "License to Pillage", say: false }]);
    await g.cutscene(async () => {
      await g.wait(1500);
      await g.showImage('art/chapter.jpg', { click: true, ms: 5500 });
      await harbor.opening(g);
    });
  },
};

export default game;
