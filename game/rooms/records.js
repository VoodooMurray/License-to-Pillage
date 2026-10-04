// Room 3: the Archives behind the office. Filbert the filing parrot, the filing cabinet (drawer L:
// the APPROVED stamp), the feather duster, the Lost and Found (and its rubber chicken), the empty ink bottle.

const R = 'rooms/records/';

// The Lost and Found holds the chapter's one red herring: a rubber chicken without a pulley.
async function searchLostFound(g) {
  if (!g.flag('chicken_found')) {
    await g.gesture('pickup_low');
    g.set('chicken_found');
    g.give('chicken');
    await g.say("A rubber chicken!");
    await g.say("...Without a pulley in the middle. What good is a rubber chicken without a pulley?");
    await g.say("I'll take it anyway. Old habits.");
    return;
  }
  if (!g.hidden('eyepatch')) {
    await g.walk(404, 420, 'S');
    return takePatch(g);
  }
  await g.say("Nothing else I need. Unless I want three left gloves.");
}

async function takePatch(g) {
  await g.gesture('pickup_low');
  g.hide('eyepatch');
  g.give('eyepatch');
  await g.say("Finders keepers.");
}

// Easter egg: Guybrush burns his fingers on the desk candle with the Curse's own "Youch!" and "Pappapisshu!"
// (CMI's voice clips, tools/voice_fixed.json), and on the third try it goes out and he keeps it.
async function grabCandle(g) {
  if (g.flag('candle_taken')) return g.say("One candle is plenty. The others are still on duty.");
  await g.gesture('use');
  const n = g.inc('candle_grab');
  if (n === 1) return g.say("Youch!");
  if (n === 2) return g.say("Pappapisshu!");
  g.setState('candle', 'gone');
  g.set('candle_taken');
  g.give('candle');
  await g.say("Hey, it went out that time! Now I have a candle. And no fingerprints.");
}

async function drawers(g) {
  await g.say("Let's see. A drawer for every letter of the alphabet. And a few letters I've never heard of.");
  for (;;) {
    const c = await g.choose([
      { id: 'A', text: "Open drawer A." , say: false },
      { id: 'D', text: "Open drawer D.", say: false },
      { id: 'L', text: "Open drawer L.", say: false },
      { id: 'S', text: "Open drawer S.", say: false },
      { id: 'Z', text: "Open drawer Z.", say: false },
      { id: 'no', text: "Never mind.", say: false },
    ]);
    if (c === 'no') return;
    g.sfx('drawer');
    if (c === 'A') {
      await g.say("A, for 'Approved'.");
      await g.say("It's empty. There's a cobweb in it. The cobweb has also been denied.");
    } else if (c === 'D') {
      await g.say("D, for 'Denied'. It's so full it's bulging.");
      await g.say("I'd better close it before it explodes.");
    } else if (c === 'L') {
      if (!g.flag('stamp_found')) {
        await g.cutscene(async () => {
          await g.say("L, for 'Lost'.");
          await g.say("A lost cause... a lost weekend... a lost sock...");
          await g.say("...and the APPROVED stamp!");
          g.set('stamp_found');
          g.give('stamp');
          await g.say("Lost since 1672, and filed exactly where it belongs. Bureaucracy works in mysterious ways.");
        });
        return;
      }
      await g.say("L, for 'Lost'. A lost cause and a lost weekend. I'll leave them where they are.");
    } else if (c === 'S') {
      await g.say("S, for 'Stamps'.");
      await g.say("It's empty, except for a little note: 'See L.'");
    } else if (c === 'Z') {
      await g.say("Z, for 'Snooze'. There's a tiny pillow in here. Someone's been napping on the job.");
    }
  }
}

async function talkFilbert(g) {
  if (g.has('parrot')) {
    return g.say("Filbert's on my shoulder. He's... not a great listener.");
  }
  await g.say('filbert', g.once('filbert_hello') ? "SQUAWK! Form 12-C! Form 27-B/6!" : "SQUAWK! Next!");
  for (;;) {
    const c = await g.choose([
      !g.flag('fil_name') && { id: 'name', text: "Hello, Polly!" },
      { id: 'stamp', text: "Where is the APPROVED stamp?" },
      !g.flag('fil_cracker') && { id: 'cracker', text: "Polly want a cracker?" },
      !g.flag('fil_portrait') && !g.flag('portrait_done') && { id: 'portrait', text: "Want to be in a portrait?" },
      !g.flag('fil_shanty') && { id: 'shanty', text: "Do you know any sea shanties?" },
      { id: 'bye', text: "Bye, bird." },
    ]);
    if (c === 'name') {
      g.set('fil_name');
      await g.say('filbert', "SQUAWK! Filbert! Filed under F!");
    } else if (c === 'stamp') {
      await g.say('filbert', "SQUAWK! Lost! Lost since 1672!");
    } else if (c === 'cracker') {
      g.set('fil_cracker');
      await g.say('filbert', "SQUAWK! Cracker? Form 12-C! Six weeks!");
    } else if (c === 'portrait') {
      g.set('fil_portrait');
      await g.say('filbert', "SQUAWK! No form, no field trip!");
    } else if (c === 'shanty') {
      g.set('fil_shanty');
      // sung to 'What Shall We Do with a Drunken Sailor' (the voice file is a sung take)
      await g.say('filbert', "Way hey, and stamp it DENIED! Way hey, and stamp it DENIED! Way hey, and stamp it DENIED! Early in the morning!", { width: 300 });
      await g.say("That's not how that song goes.");
      await g.say('filbert', "SQUAWK! Revised edition!");
    } else {
      await g.say('filbert', "SQUAWK! Next!");
      return;
    }
  }
}

async function openCage(g) {
  if (g.has('parrot')) return g.say("The cage is empty. Filbert's with me.");
  if (g.flag('portrait_done')) {
    await g.say('filbert', "SQUAWK! Overtime is over! Do not disturb! SQUAWK!");
    return;
  }
  if (!(g.has('form') || g.has('form_done'))) {
    await g.say("Come on out, birdie.");
    await g.say('filbert', "SQUAWK! No form, no service! SQUAWK!");
    return;
  }
  await g.cutscene(async () => {
    await g.gesture('use');
    g.sfx('squawk');
    await g.say('filbert', "SQUAWK! Form 27-B/6! Applicant escort! Let's go!");
    g.showActor('filbert', false);
    g.give('parrot');
    await g.say("He hopped right onto my shoulder. He's lighter than he sounds.");
  });
}

export default {
  id: 'records',
  size: [640, 480],
  layers: [{ img: R + 'bg.jpg' }],
  music: 'records',
  tint: '#e8d2b4',
  scale: [[360, 0.83], [480, 1.18]],
  walk: {
    polys: [[[44, 392], [112, 374], [248, 364], [332, 360], [446, 392], [524, 398], [604, 404], [640, 406], [640, 480], [0, 480], [0, 424]]],
    holes: [[[454, 384], [516, 384], [516, 398], [454, 398]]],
  },
  entries: { default: [84, 420, 'E'], office: [84, 420, 'E'] },
  start: [120, 430, 'E'],

  actors: {
    filbert: { x: 483, y: 272, dir: 'S', scale: 1, when: g => !g.has('parrot') },
  },

  objects: [
    {
      id: 'door', name: 'door', box: [0, 80, 62, 300], walkTo: [70, 420], face: 'W',
      exit: { room: 'office', x: 240, y: 292, dir: 'S' },
      verbs: { hand: 'open' },
      look: "The door back to the office. I made it into the Archives AND I can leave. That must be a first.",
      onExit: g => g.sfx('door'),
    },
    {
      id: 'cabinet', name: 'filing cabinet', box: [344, 130, 78, 202], walkTo: [384, 378], face: 'N',
      verbs: { hand: 'open' },
      look: "A filing cabinet with a drawer for every letter of the alphabet. Very organized. Suspiciously organized.",
      hand: async g => { await g.gesture('use'); return drawers(g); },
    },
    {
      id: 'duster', name: 'feather duster', box: [402, 122, 44, 134], hotZ: 1, walkTo: [424, 388], face: 'N',
      verbs: { hand: 'pluck a feather from' },
      look: "A feather duster, soft and very tickly. It hasn't touched a speck of dust in years.",
      hand: async g => {
        if (g.has('feather') || g.has('quill')) return g.say("One feather is plenty.");
        await g.gesture('pickup_high');
        g.give('feather');
        await g.say("I'll just take one feather. I'm a pirate, not a monster.");
      },
      mouth: "Achoo! It's dustier than the things it's supposed to dust.",
    },
    {
      id: 'bottle', name: 'ink bottle', box: [149, 249, 20, 32], walkTo: [160, 386], face: 'N',
      states: { on: { img: R + 'bottle.png', x: 144, y: 245, z: 285 } }, state: 'on',
      verbs: { hand: 'pick up' },
      look: "An empty ink bottle. Even the ink ran out of patience in here.",
      hand: async g => {
        await g.gesture('use');
        g.hide('bottle');
        g.give('bottle');
        await g.say("An empty ink bottle. Every pirate needs one. Well, every bureaucratic pirate.");
      },
    },
    {
      id: 'desk', name: 'desk', hot: [[104, 236], [236, 236], [236, 372], [104, 372]], hotZ: -1, walkTo: [170, 390], face: 'N',
      look: "A writing desk, buried in unfinished paperwork. The candles have been burning since 1672.",
      hand: "It's full of half-written denials. I don't want to disturb anyone's work.",
    },
    {
      id: 'lostfound', name: 'Lost and Found', box: [510, 372, 124, 96], walkTo: [496, 436], face: 'E',
      verbs: { hand: 'search' },
      look: async g => {
        await g.say("The Lost and Found. An old boot, a broken spyglass, three left gloves...");
        await g.say("...and a wooden leg with a note: 'Gone for a walk.'");
        if (!g.flag('chicken_found')) await g.say("Is that a rubber chicken in there?");
        if (!g.hidden('eyepatch')) await g.say("And there's an eye patch lying next to it.");
      },
      hand: g => searchLostFound(g),
    },
    {
      id: 'eyepatch', name: 'eye patch', box: [367, 428, 77, 30], walkTo: [404, 420], face: 'S',
      states: { on: { img: R + 'eyepatch.png', x: 366, y: 428, z: 430 } }, state: 'on',
      verbs: { hand: 'pick up' },
      look: "An eye patch, lost and found. Mostly lost.",
      hand: g => takePatch(g),
    },
    {
      id: 'papers', name: 'mountain of paperwork', hot: [[200, 210], [300, 190], [346, 250], [344, 356], [214, 360]], hotZ: -1,
      look: "A mountain of DENIED applications. There's a little flag on top. It's also been denied.",
      hand: "If I pull one out, the whole mountain comes down. That's how avalanches start. And audits.",
    },
    {
      id: 'shelves', name: 'shelves', hot: [[240, 40], [520, 20], [640, 0], [640, 380], [600, 390], [520, 300], [430, 120], [350, 110], [240, 160]], hotZ: -5,
      look: "Every application ever denied, from 1650 to the present. Mostly the present.",
      hand: "I'd need a map. And a snack. And a will.",
    },
    {
      id: 'ladder', name: 'ladder', hot: [[504, 20], [610, 20], [614, 400], [560, 400], [504, 200]], hotZ: -2,
      look: "A rolling library ladder. It rolls, but it never gets anywhere. Very bureaucratic.",
      hand: "Up there it's just more paperwork. With a view.",
    },
    {
      id: 'window', name: 'stained-glass window', box: [112, 36, 90, 116],
      look: "A stained-glass window showing Saint Papeleo, blessing a stack of forms.",
    },
    {
      id: 'candle', name: 'candles', box: [128, 196, 24, 40], walkTo: [174, 388], face: 'NW',
      states: { lit: null, gone: { img: R + 'candle_gone.png', x: 129, y: 188, z: 223 } }, state: 'lit',
      look: async g => g.flag('candle_taken')
        ? g.say("One candle fewer. Nobody will notice. Nobody in here notices anything.")
        : g.say("Candles, melted down to stubs. Someone's been doing a lot of overtime."),
      hand: g => grabCandle(g),
    },
    {
      id: 'cage', name: 'birdcage', box: [444, 140, 78, 132], walkTo: [470, 400], face: 'N', hotZ: -1,
      verbs: { hand: 'open' },
      look: async g => g.has('parrot') ? g.say("An empty birdcage. Filbert's out on business.") : g.say("An ornate birdcage. There's a green parrot inside wearing a tiny clerk's visor."),
      hand: g => openCage(g),
    },
  ],

  npcs: {
    filbert: {
      name: 'Filbert',
      hot: [-30, -110, 64, 110],
      walkTo: [470, 400], face: 'N',
      look: "A green parrot wearing a tiny clerk's visor. The name plate on the cage says 'FILBERT. Filing Parrot, Grade 3.'",
      verbs: { hand: 'open cage of' },
      hand: g => openCage(g),
      mouth: g => talkFilbert(g),
      use: {
        form: g => openCage(g),
        form_done: g => openCage(g),
        lime: async g => { await g.say('filbert', "SQUAWK! Citrus! Form 9-L!"); },
        '*': async g => { await g.say('filbert', "SQUAWK! Not a form! Not interested! SQUAWK!"); },
      },
    },
  },

  // Filbert mutters form numbers to himself
  idle(g) {
    if (g.has('parrot') || Math.random() < 0.4) return;
    g.fidget('filbert', 'talk', 0.9);
    g.sfx('squawk', 0.3);
  },

  async enter(g, from) {
    g.showActor('filbert', true);
    if (g.once('records_first')) {
      await g.cutscene(async () => {
        await g.walk(150, 430, 'E');
        await g.say("The Archives. It smells like old paper and older regrets.");
      });
    }
  },
};
