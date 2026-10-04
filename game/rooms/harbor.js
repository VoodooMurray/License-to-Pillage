// Room 1: the harbor square of Port Papeleo, at sunset. 960x480 (scrolls).

const R = 'rooms/harbor/';
const GATE_LIFT = 172;      // the sea gate slides all the way up into its arch (its height, logical px)

async function harborMaster(g, opening = false) {
  if (g.has('license') && !g.flag('clue_isle')) return notYet(g);
  // the shutter opens, a pair of eyes and a voice
  g.setState('shutter', 'open');
  g.sfx('shutter');
  await g.wait(300);
  if (g.has('license')) return ending(g);
  if (g.once('hm_hello')) await g.say('harbormaster', "What? Who's knocking? Oh. It's you. The unlicensed one.");
  else await g.say('harbormaster', "Harbor Master speaking. Licenses only.");
  for (;;) {
    const c = await g.choose([
      { id: 'lower', text: "Can you raise the gate for me?" },
      !g.flag('hm_why') && { id: 'why', text: "Why does a pirate need a license?" },
      { id: 'what', text: "What do I need for a license?" },
      !g.flag('hm_anyone') && { id: 'anyone', text: "Has anybody ever gotten one?" },
      !g.flag('hm_sail') && { id: 'sail', text: "What if I just ram the gate?" },
      !g.flag('hm_window') && { id: 'window', text: "Nice window." },
      !g.flag('hm_blackwood') && { id: 'blackwood', text: "Ever heard of Captain Blackwood?" },
      { id: 'bye', text: "Never mind." },
    ]);
    if (c === 'lower') {
      await g.say('harbormaster', "Show me a license and I'll raise it faster than you can say 'excessive bureaucracy'.");
    } else if (c === 'why') {
      g.set('hm_why');
      await g.say('harbormaster', "The Governor says it makes piracy respectable. Also, the license fees pay for the gate.");
      await g.say("So I'm paying for my own prison?");
      await g.say('harbormaster', "Now you're thinking like a taxpayer.");
    } else if (c === 'what') {
      await g.say('harbormaster', "Ask at the Authority. They'll give you a list. Then another list. Then a list of lists.");
    } else if (c === 'anyone') {
      g.set('hm_anyone');
      await g.say('harbormaster', "Not since 1672. But I'm told they're very close.");
    } else if (c === 'sail') {
      g.set('hm_sail');
      await g.say('harbormaster', "In a rowboat? Be my guest. I'm running low on firewood.");
    } else if (c === 'blackwood') {
      g.set('hm_blackwood');
      await g.say('harbormaster', "Blackwood? Walked into the Licensing Authority in 1654. Never walked out.");
      await g.say("So he's still in there?");
      await g.say('harbormaster', "Either that, or he got filed.");
    } else if (c === 'window') {
      g.set('hm_window');
      await g.say('harbormaster', "It's a regulation window. Thank you for noticing.");
      await g.say('harbormaster', "Nobody ever notices the window.");
    } else break;
  }
  await g.say('harbormaster', "Mind the paperwork.");
  g.setState('shutter', 'closed');
  g.sfx('shutter');
}

async function ending(g) {
  await g.cutscene(async () => {
    await g.say("Behold! One Pirate License. Stamped APPROVED.");
    await g.say('harbormaster', "...");
    await g.say('harbormaster', "Let me see that.");
    await g.wait(700);
    await g.say('harbormaster', "Signed... portraited... APPROVED?!");
    await g.say('harbormaster', "Well, I'll be keelhauled. First one since 1672.");
    await g.say('harbormaster', "RAISING THE GATE!");
    g.setState('shutter', 'closed');
    g.sfx('gate_raise');
    g.engine.shake(1200);
    await g.moveObj('gate', 0, -GATE_LIFT, 2600);
    g.hide('gate');
    await g.wait(600);
    await g.say("Port Papeleo, it's been a pleasure. Well, it's been paperwork.");
    await g.say("Next stop: Isla Agria!");
    await g.walk(150, 336, 'W');
    await g.fadeOut(1.2);
    g.stopMusic();
    // meanwhile, in the office...
    g.set('ending');
    await g.goto('office', 330, 470, 'N', { fade: false });
    g.showActor('guybrush', false);
    await g.fadeIn(0.8);
    await g.wait(500);
    g.sfx('ding');
    g.setState('sign', 'eight', 'office');
    await g.say('agatha', "Now serving... number eight.");
    await g.wait(400);
    await g.say('mort', "EIGHT?! What happened to SEVEN?!");
    await g.wait(300);
    await g.say('agatha', "Next.");
    await g.fadeOut(1.5);
    g.music('ending');
    await g.showImage('art/the_end.jpg', { click: true, ms: 600000, keep: true });
  });
}

// Guybrush has the license but not yet the clue he came for: he doesn't show it yet
async function notYet(g) {
  await g.say("Not yet. I didn't come all this way to leave without a clue to Blackwood's treasure.");
}

// Daube's great-great-grandfather's license portrait of Captain Blackwood (1654): the map in his hand
async function blackwoodPortrait(g) {
  await g.cutscene(async () => {
    await g.say('painter', "Ah. Not mine. My great-great-grandfather's. Captain Blackwood, 1654.");
    await g.say('painter', "He never came back to collect it.");
    await g.say("Can I take a closer look?");
    await g.say('painter', "Look, but do not touch. It is older than my mustache.");
    await g.showImage('art/blackwood_portrait.jpg', { click: true, ms: 9000 });
    if (g.flag('mort_blackwood')) await g.say("Wait a minute... that's Mort! With skin!");
    else await g.say("So that's Captain Blackwood. Sour-looking fellow.");
    await g.say("He's holding a lime... and a map! An island with two peaks, a grove of trees, and a big red X!");
    await g.say('painter', "My ancestor painted only ze truth. Down to ze last lime.");
    await g.say('painter', "Ze lime was for ze scowl. A family secret.");
    g.set('clue_portrait');
    if (g.flag('saw_crates')) await foundIsle(g);
    else await g.say("Two peaks and lime trees. Now where have I seen limes around here?");
  });
}

// the portrait's map + the lime crates' stencil: Blackwood's treasure is on Isla Agria
async function foundIsle(g) {
  g.set('clue_isle');
  await g.say("Two peaks, lime trees... It's the island on Blackwood's map! Isla Agria!");
  await g.say("That's my next stop. Now I just have to get out of this harbor.");
}

export default {
  id: 'harbor',
  size: [960, 480],
  layers: [{ img: R + 'bg.jpg' }],
  // the harbor water moves: a generated loop, drawn right
  // over the background (gate, boat, actors on top); SCUMM: object sets cycled by a room script
  anims: [{ id: 'water', dir: R + 'water/' }],
  music: 'harbor',
  ambience: 'sfx/amb_harbor.mp3',
  tint: '#ffe2c4',
  scale: [[286, 0.34], [480, 1.0]],
  walk: {
    polys: [[
      [16, 300], [60, 290], [228, 286], [300, 298], [345, 306], [470, 300], [600, 292], [690, 318], [700, 345],
      [820, 362], [960, 392], [960, 480], [0, 480], [0, 392], [130, 386], [236, 376], [262, 346], [240, 324], [16, 324],
    ]],
    holes: [[[346, 296], [400, 286], [470, 292], [478, 312], [412, 324], [350, 318]]],
  },
  entries: { default: [520, 330, 'S'], office: [512, 300, 'S'], start: [150, 332, 'E'] },
  start: [512, 330, 'S'],
  voices: { harbormaster: [56, 118] },

  actors: {
    painter: { x: 914, y: 392, dir: 'W' },
    squid: { x: 437, y: 312, dir: 'S', scale: 1 },
  },

  occluders: [
    { img: R + 'fg_fountain.png', x: 340.2, y: 157.8, z: 312 },
    // the arch around the sea gate's opening, so the raised gate disappears into it (web only: SCUMM hides the gate)
    { img: R + 'fg_arch.png', x: 81, y: 59.75, z: 201, scumm: false },
  ],

  objects: [
    {
      id: 'gate', name: 'sea gate', box: [86, 64, 100, 150],
      states: { down: { img: R + 'gate.png', x: 81, y: 59.75, z: 200, clip: [81, 59.75, 111.25, 172] } }, state: 'down',
      look: "A massive iron portcullis, lowered right into the water between the towers. Now THAT'S a closed-door policy.",
      hand: "It weighs more than the whole island. And lifting it probably requires a permit.",
      mouth: "I'm not licking government property. It's illegal AND it's rusty.",
      verbs: { hand: 'lift', mouth: 'lick' },
      use: {
        chicken: "If this chicken had a pulley in the middle, I could zip-line right over the gate. It doesn't.",
      },
    },
    {
      id: 'shutter', name: 'watchtower window', box: [32, 118, 40, 54], hotZ: 1,
      states: { closed: null, open: { img: R + 'shutter_open.png', x: 30, y: 118, z: 300 } }, state: 'closed',
      walkTo: [96, 300], face: 'W',
      verbs: { hand: 'knock on', mouth: 'talk to' },
      look: "A shuttered window in the watchtower. The Harbor Master lurks in there, guarding his gate.",
      hand: async g => { g.gesture('use'); g.sfx('knock'); await g.wait(600); return harborMaster(g); },
      mouth: g => harborMaster(g),
      use: {
        license: g => {
          if (!g.flag('clue_isle')) return notYet(g);
          g.setState('shutter', 'open'); g.sfx('shutter');
          return ending(g);
        },
        '*': async (g, item) => {
          g.setState('shutter', 'open'); g.sfx('shutter');
          await g.say('harbormaster', "Whatever that is, I don't want it. I want a LICENSE.");
          g.setState('shutter', 'closed'); g.sfx('shutter');
        },
      },
    },
    {
      id: 'towers', name: 'watchtowers', hot: [[0, 30], [70, 30], [70, 250], [0, 270]],
      look: "Two squat stone watchtowers guard the harbor mouth. They're the only things on this island that work overtime.",
      hand: "They're solid stone. And solidly unhelpful.",
    },
    {
      id: 'tower2', name: 'watchtowers', hot: [[190, 50], [330, 50], [334, 250], [186, 256]],
      look: "Two squat stone watchtowers guard the harbor mouth. They're the only things on this island that work overtime.",
      hand: "They're solid stone. And solidly unhelpful.",
    },
    {
      id: 'rowboat', name: 'rowboat', box: [62, 318, 120, 46], hotZ: 1, walkTo: [150, 318], face: 'S',
      verbs: { hand: 'get in', mouth: 'taste' },
      look: "My trusty rowboat. It's got a slow leak and a fast oar.",
      hand: async g => {
        if (g.has('license')) return g.say("First I'd better show my license to the Harbor Master. Otherwise that gate stays down.");
        await g.say("No point. That gate would stop a man-o'-war, never mind a rowboat with a slow leak.");
      },
      mouth: "It tastes like barnacles and regret.",
    },
    {
      id: 'sea', name: 'sea', hot: [[70, 150], [200, 150], [200, 262], [70, 262]],
      look: "The sun's going down. So are my chances of leaving on time.",
      hand: "I'm not swimming. The sharks here are licensed.",
      mouth: "Salt water. I'd rather have grog.",
      verbs: { hand: 'swim in', mouth: 'drink' },
    },
    {
      id: 'pier', name: 'pier', hot: [[0, 272], [230, 262], [300, 300], [230, 345], [0, 350]],
      look: "A rickety wooden pier. Half the planks are missing. The other half are thinking about it.",
    },
    {
      id: 'door', name: 'Licensing Authority', box: [484, 118, 56, 118], walkTo: [512, 298], face: 'N',
      exit: { room: 'office', x: 330, y: 468, dir: 'N' },
      verbs: { hand: 'open', mouth: 'kiss' },
      look: "The door of the Caribbean Pirate Licensing Authority. Carved over it: 'WE WILL GET TO YOU.'",
      mouth: "I'm not kissing a government building. That's how they get you.",
    },
    {
      id: 'building', name: 'Licensing Authority', hot: [[352, 20], [470, 0], [790, 0], [790, 230], [620, 255], [440, 230], [352, 220]],
      hotZ: -1,
      look: "The Caribbean Pirate Licensing Authority. The building leans a little to the left. Even the architecture is tired of waiting.",
      hand: "I should use the door. That's what doors are for.",
    },
    {
      id: 'sign', name: 'sign', box: [452, 52, 86, 44], face: 'N', walkTo: [496, 300],
      look: "It says: CARIBBEAN PIRATE LICENSING AUTHORITY. Established 1650. Approving since... hmm. That part's been painted over.",
      hand: "It's too high. Also, stealing government property requires Form 88-Q.",
    },
    {
      id: 'board', name: 'notice board', box: [558, 186, 76, 70], hotZ: 1, walkTo: [590, 296], face: 'N',
      look: async g => {
        await g.say("It's the official notice board.");
        await g.say("'NOTICE: Piracy without a license is strictly forbidden. Violators will be fined, keelhauled, and then fined for the keelhauling.'");
        await g.say("'LOST: one eye, brown, answers to Lefty. If found, please contact the Lost and Found. We'll be looking out for it.'");
        if (!g.hidden('menu')) await g.say("And a menu from the Salty Squid Tavern.");
      },
      hand: "I'd better not take down official notices. The menu, on the other hand, is fair game.",
    },
    {
      id: 'menu', name: 'menu', box: [598, 204, 22, 27], hotZ: 2, walkTo: [590, 296], face: 'N',
      states: { on: { img: R + 'menu.png', x: 598, y: 204, z: 260 } }, state: 'on',
      verbs: { hand: 'take', mouth: 'read aloud' },
      look: "It's a menu from the Salty Squid Tavern. TONIGHT'S SPECIAL: FRIED CALAMARI, served with a wedge of lime.",
      hand: async g => {
        await g.gesture('pickup_high');
        g.hide('menu');
        g.give('menu');
        g.sfx('paper');
        await g.say("I'll borrow this. I'm not hungry, but I am a pirate.");
      },
      mouth: async g => { await g.say("'Tonight's special: FRIED CALAMARI!'"); await g.say("I hope the squid didn't hear that."); },
    },
    {
      id: 'fountain', name: g => g.state('fountain') === 'inky' ? 'inky fountain' : 'squid fountain',
      hot: [[346, 272], [384, 262], [388, 150], [424, 150], [430, 262], [476, 276], [470, 310], [410, 322], [350, 312]],
      walkTo: [400, 338], face: 'N',
      states: { clear: null, inky: { img: R + 'ink.png', x: 340, y: 262, z: 313 } }, state: 'clear',
      verbs: { hand: 'use', mouth: 'drink from' },
      look: async g => {
        if (g.state('fountain') === 'inky') return g.say("The basin's full of squid ink now. It's like a giant inkwell. A giant, fishy inkwell.");
        await g.say("A fountain dedicated to the Great Squid of Papeleo, patron saint of paperwork.");
        await g.say("There's a real squid hiding in the basin.");
      },
      hand: "I'm not taking a bath in a public fountain. Not before dark, anyway.",
      mouth: async g => {
        if (g.state('fountain') === 'inky') return g.say("Drink squid ink? I'm a pirate, not a fountain pen.");
        await g.say("The water's full of squid. I'll pass.");
      },
      use: {
        bottle: g => fillBottle(g),
        menu: g => scareSquid(g),
        ink: "It's inky enough already.",
        lime: "Squid with a wedge of lime? That's just cruel.",
      },
    },
    {
      id: 'stall', name: 'lime stall', hot: [[680, 140], [890, 140], [900, 250], [800, 340], [700, 330]],
      walkTo: [730, 352], face: 'N',
      verbs: { hand: 'take a lime from', mouth: 'taste' },
      look: async g => {
        await g.say("A fruit stall. The sign says: 'SCURVY-B-GONE LIMES. Honor system. One piece of eight.'");
        if (g.flag('clue_isle')) return g.say("Limes from Isla Agria. Blackwood's island.");
        g.set('saw_crates');
        await g.say("The crates are stamped 'ISLA AGRIA', with a little picture of an island. An island with two peaks.");
        if (g.flag('clue_portrait')) await foundIsle(g);
      },
      hand: async g => {
        if (g.has('lime')) return g.say("I already have a lime. I'm not greedy. Just dishonest.");
        if (g.once('lime_honor')) {
          await g.say("Honor system, huh?");
          await g.wait(600);
          await g.say("I'm a pirate. My honor is flexible.");
        } else await g.say("Another one for the road. The honor system is really working out for me.");
        await g.gesture('use');
        g.give('lime');
      },
      mouth: "I'd rather take one to go.",
    },
    {
      id: 'easel', name: 'easel', box: [826, 228, 54, 128], walkTo: [760, 380], face: 'E',
      look: async g => {
        if (g.flag('portrait_done')) return g.say("An empty canvas, waiting for its next fearsome pirate.");
        await g.say("A blank canvas on an easel, waiting for a fearsome pirate face. Or mine.");
      },
      hand: "I'd better not touch his canvas. He looks like he bites.",
    },
    {
      id: 'portraits', name: 'sample portraits', box: [870, 264, 90, 84], walkTo: [840, 390], face: 'E',
      look: async g => {
        if (g.flag('clue_portrait')) {
          await g.say("Captain Blackwood's old license portrait. Let's have another look at that map.");
          await g.showImage('art/blackwood_portrait.jpg', { click: true, ms: 9000 });
          return g.say("Two peaks, lime trees and a big red X.");
        }
        await g.say("Sample portraits of pirates. Every single one has an eye patch, a parrot and a terrible scowl.");
        await g.say("There's a pattern here.");
        if (g.once('portraits_parrot')) await g.say("Wait, that one's just a parrot wearing an eye patch.");
        await g.say("One of them is much older than the rest. And much darker.");
      },
      hand: "They're not for sale. They're 'for inspiration'.",
    },
    {
      id: 'palm', name: 'palm tree', hot: [[800, 0], [960, 0], [960, 170], [880, 230], [820, 120]],
      look: "A palm tree. The only thing on this island that doesn't need a permit to grow.",
      hand: "I'm not climbing it. I left my climbing permit at home.",
    },
    {
      id: 'plaza', name: 'office steps', box: [436, 226, 150, 48], walkTo: [512, 298], face: 'N',
      look: "Steps up to the Licensing Authority. They're worn smooth by the shuffling feet of applicants.",
      exit: { room: 'office', x: 330, y: 468, dir: 'N' },
    },
  ],

  npcs: {
    painter: {
      name: 'painter', hot: [-44, -196, 72, 196],
      walkTo: [838, 404], face: 'E',
      look: "A tall, skinny artist with a mustache you could hang laundry on.",
      hand: "I'd better not. He's holding a very pointy paintbrush.",
      mouth: g => talkPainter(g),
      use: {
        eyepatch: g => pose(g, 'eyepatch'),
        parrot: g => pose(g, 'parrot'),
        lime: async g => { await g.say('painter', "A lime? Non, monsieur. I do not paint still lifes. Not since the Incident."); },
        chicken: async g => { await g.say('painter', "A rubber chicken? Monsieur, this is a portrait studio, not a circus."); },
        form: async g => { await g.say('painter', "Paperwork! Pah! I am an artist! Take that to Madame Stampwell."); },
        form_done: async g => { await g.say('painter', "Paperwork! Pah! I am an artist! Take that to Madame Stampwell."); },
        portrait: async g => { await g.say('painter', "You wish me to sign it again? It is already my finest work."); },
        menu: async g => { await g.say('painter', "Fried calamari! Ah, the Salty Squid! Their lime wedges are magnifique."); },
        '*': async g => { await g.say('painter', "Non, merci. I have everything I need. Except talent in my clients."); },
      },
    },
    squid: {
      name: 'squid',
      hot: [-24, -48, 50, 40],
      walkTo: [436, 336], face: 'N',
      look: "A small, nervous squid. It keeps looking at me like I'm a waiter.",
      hand: "It slips right out of my hands. Squids are very slippery. Also very rude.",
      mouth: async g => {
        await g.say("Hello there, little squid!");
        await g.anim('squid', 'look');
        await g.say("It's giving me the silent treatment. Squids are terrible conversationalists.");
      },
      verbs: { hand: 'pick up' },
      use: {
        menu: g => scareSquid(g),
        // once it has inked, the squid's hotspot covers the inky basin: fill the bottle there too
        bottle: async g => {
          if (g.state('fountain') === 'inky') return fillBottle(g);
          await g.say("It won't ink on command. I'd have to give it a really good reason.");
        },
        lime: "I'm not squeezing lime on a live squid. I'm not a monster.",
        chicken: "The squid is not impressed by my rubber chicken. Nobody ever is.",
      },
    },
  },

  // the painter works on his canvas; the squid peeks around
  idle(g) {
    if (Math.random() < 0.6) g.fidget('painter', 'paint', 2.5);
    else if (g.state('fountain') !== 'inky') g.fidget('squid', 'look');
  },

  async enter(g, from) {
    if (from === 'office' && g.once('harbor_back')) {
      // first time back outside: nothing special
    }
  },

  opening,
};

async function fillBottle(g) {
  if (g.state('fountain') !== 'inky') return g.say("It's just water. I need squid INK, not squid water.");
  await g.cutscene(async () => {
    await g.gesture('pickup_low');
    g.sfx('splash');
    g.swap('bottle', 'ink');
    await g.say("Regulation squid ink. Freshly squeezed.");
  });
}

async function scareSquid(g) {
  if (g.state('fountain') === 'inky') return g.say("It's already scared out of its wits. And out of its ink.");
  await g.cutscene(async () => {
    await g.say("Pssst! Hey, squid! Look what's on the menu tonight!");
    await g.anim('squid', 'look');
    await g.say("'FRIED CALAMARI, served with a wedge of lime!'");
    g.sfx('squirt');
    g.anim('squid', 'ink', { wait: false });
    await g.wait(500);
    g.setState('fountain', 'inky');
    await g.wait(900);
    g.setBase('squid', 'hide');
    await g.say("Sorry, little guy. It's nothing personal. It's paperwork.");
  });
}

async function talkPainter(g) {
  if (g.flag('pose_scowl')) return scowlTime(g);
  if (g.once('painter_hello')) {
    await g.say('painter', "Bonjour! Jacques-Louis Daube, Guild-certified license portraitist, at your service.");
    await g.say('painter', "You need a portrait, non?");
    await g.say("How did you know?");
    await g.say('painter', "Everyone on this island needs a portrait. Nobody on this island has a license. It is a very good business.");
  } else if (g.flag('portrait_done')) {
    await g.say('painter', "Ah, my favorite client! Still scowling magnificently?");
  } else {
    await g.say('painter', "Bonjour again, monsieur!");
  }
  for (;;) {
    const c = await g.choose([
      !g.flag('portrait_done') && { id: 'paint', text: "Please paint my license portrait." },
      g.flag('painter_marks') && !g.flag('portrait_done') && { id: 'marks', text: "What were the three marks again?" },
      g.flag('painter_marks') && !g.flag('painter_where') && !g.flag('portrait_done') && { id: 'where', text: "Where am I supposed to find all that?" },
      !g.flag('painter_who') && { id: 'who', text: "Who are the pirates in your sample portraits?" },
      g.flag('painter_who') && !g.flag('clue_portrait') && { id: 'old', text: "What about that old, dark one?" },
      !g.flag('painter_mustache') && { id: 'mustache', text: "Nice mustache." },
      { id: 'bye', text: "I'll be back." },
    ]);
    if (c === 'paint') {
      if (g.has('eyepatch') && g.has('parrot')) return pose(g, 'both');
      await g.say('painter', "Hmm.");
      await g.say('painter', "Non. Non, non, non.");
      await g.say('painter', "Monsieur, you look like a tax collector with a hangover.");
      await g.say("I'll have you know I'm a mighty pirate!");
      await g.say('painter', "Then where is your eye patch? Your parrot? Your fearsome scowl?");
      await g.say('painter', "The Guild has rules: a license portrait must show the three marks of the pirate.");
      await g.say("Can't you just paint them in?");
      await g.say('painter', "I am an ARTIST, monsieur, not a liar. I paint only ze truth.");
      await g.say('painter', "...For liars I charge extra. And you cannot afford it.");
      g.set('painter_marks');
    } else if (c === 'marks') {
      await g.say('painter', "One: the eye patch, the mark of a pirate who has seen too much.");
      await g.say('painter', "Two: the parrot, a pirate's loyal friend and accountant.");
      await g.say('painter', "Three: the scowl, the face of a man who has just been denied a license.");
    } else if (c === 'where') {
      g.set('painter_where');
      await g.say('painter', "Monsieur, I am a painter, not a treasure map.");
    } else if (c === 'who') {
      g.set('painter_who');
      await g.say('painter', "My masterpieces! Every one of them fearsome, one-eyed and parroted.");
      await g.say('painter', "Every one of them denied a license, of course. But beautifully painted!");
    } else if (c === 'old') {
      await blackwoodPortrait(g);
    } else if (c === 'mustache') {
      g.set('painter_mustache');
      await g.say('painter', "Merci. It is registered with the Authority as a lethal weapon.");
    } else {
      await g.say('painter', "Adieu! And do not come back without a parrot!");
      return;
    }
  }
}

// Giving the eye patch or the parrot to the painter. Both are needed at once.
async function pose(g, what) {
  if (g.flag('portrait_done')) return g.say('painter', "I have already painted you, monsieur. Once was enough for both of us.");
  if (!(g.has('eyepatch') && g.has('parrot'))) {
    if (what === 'eyepatch') {
      await g.say('painter', "An eye patch! Very good!");
      return g.say('painter', "But a pirate with no parrot is just a man with a sore eye. Come back when you have both.");
    }
    await g.say('painter', "A parrot! Magnifique!");
    await g.say('filbert', "SQUAWK! Form 27-B/6!");
    await g.say('painter', "...Does he always do that?");
    return g.say('painter', "But where is your eye patch? Come back with the eye patch.");
  }
  await g.cutscene(async () => {
    await g.say('painter', "An eye patch AND a parrot! At last, a real pirate!");
    await g.say('painter', "Put on the patch. Perch the parrot on your shoulder. Stand there. Non, there!");
    await g.walk(760, 404, 'E');
    posing(g, 'pose');
    g.sfx('squawk');
    await g.say('filbert', "SQUAWK! Portrait! Form 61-P!", { at: [g.actor('guybrush').x - g.engine.camX, 250] });
    await g.say('painter', "Now... the most important part.");
    await g.say('painter', "The SCOWL!");
  });
  g.set('pose_scowl');
  return scowlTime(g);
}

// Guybrush's posing figure (eye patch + Filbert on his shoulder); null = back to normal
function posing(g, role) {
  const a = g.actor('guybrush');
  if (role) {
    a.noTalk = true;
    g.setBase('guybrush', role);
  } else {
    a.noTalk = false;
    a.baseRole = 'stand';
    a.init();
  }
}

async function scowlTime(g) {
  if (!g.actor('guybrush').noTalk) posing(g, 'pose');
  for (;;) {
    const c = await g.choose([
      { id: 'grr', text: "Grrrrr!" },
      { id: 'taxes', text: "(Think of taxes.)", say: false },
      g.has('lime') && { id: 'lime', text: "(Eat the lime.)", say: false },
      { id: 'quit', text: "I can't do it." },
    ]);
    if (c === 'grr') {
      await g.say('painter', "Non! That is not a scowl, that is indigestion!");
    } else if (c === 'taxes') {
      await g.say("(Taxes... tariffs... license fees...)");
      await g.say('painter', "Closer. But now you look like a man thinking about taxes.");
      await g.say('painter', "Something SOUR, monsieur! Think SOUR!");
    } else if (c === 'lime') {
      return paintPortrait(g);
    } else {
      await g.say('painter', "Then come back when you can. And bring something sour!");
      g.set('pose_scowl', false);
      posing(g, null);
      return;
    }
  }
}

async function paintPortrait(g) {
  await g.cutscene(async () => {
    g.take('lime');
    g.sfx('crunch');
    await g.say("Mmmph!");
    posing(g, 'pose_sour');
    await g.say("Sour! SOUR! SO SOUR!");
    await g.say('painter', "YES! THAT FACE! Such fury! Such bile!");
    await g.say('painter', "Do not move! Not a muscle!");
    g.setBase('painter', 'paint');
    await g.wait(3000);
    g.setBase('painter', 'stand');
    g.anim('painter', 'bravo', { wait: false });
    await g.say('painter', "Et voila!");
    posing(g, null);
    await g.showImage('art/portrait_reveal.jpg', { click: true, ms: 9000 });
    await g.say('painter', "My greatest work. I shall call it: 'Man Who Has Just Eaten a Lime'.");
    await g.say("It's... fearsome.");
    await g.say('filbert', "SQUAWK! Overtime! Back to the archives!");
    g.take('parrot');
    g.set('filbert_back');
    await g.say('painter', "I shall keep the eye patch, for future clients. Here is your portrait. Take it to Madame Stampwell.");
    g.take('eyepatch');
    g.give('portrait');
    g.set('portrait_done');
    g.set('pose_scowl', false);
  });
}

async function opening(g) {
  const e = g.engine;
  await g.goto('harbor', 150, 332, 'E', { fade: false });
  g.hide('gate');
  e.fade.a = 1;
  await g.cutscene(async () => {
    g.music('harbor');
    await g.fadeIn(2.0);
    await g.wait(600);
    await g.walk(330, 380, 'E');
    await g.say("Port Papeleo! The last place anybody saw Captain Mortimer Blackwood and his legendary treasure.");
    await g.say("That was in 1654. The trail's gone a little cold.");
    await g.wait(300);
    g.show('gate');
    g.sfx('gate_slam');
    await g.moveObj('gate', 0, -GATE_LIFT, 0);
    g.moveObj('gate', 0, GATE_LIFT, 600);
    await g.wait(550);
    g.sfx('splash');
    e.shake(900);
    await g.wait(900);
    g.face('W');
    await g.say("Hey! What's the big idea?");
    g.setState('shutter', 'open');
    g.sfx('shutter');
    await g.say('harbormaster', "Welcome to Port Papeleo! Pleasure or piracy?");
    await g.say("Piracy! I'm Guybrush Threepwood, mighty pirate!");
    await g.say('harbormaster', "License, please.");
    await g.say("...License?");
    await g.say('harbormaster', "Pirate License. Issued by the Caribbean Pirate Licensing Authority. Stamped, signed and portraited.");
    await g.say("Since when does piracy need a license?");
    await g.say('harbormaster', "Since 1650. We only got the gate on Tuesday.");
    await g.say('harbormaster', "Sorry. No license, no leaving.");
    await g.say("And where would a mighty pirate get one of these licenses?");
    await g.say('harbormaster', "Big pink building. Take a number. Mind the skeleton.");
    g.setState('shutter', 'closed');
    g.sfx('shutter');
    await g.wait(500);
    await g.say("Skeleton?");
    await g.wait(300);
    g.face('S');
    await g.say("Oh well. How hard can it be?");
  });
}
