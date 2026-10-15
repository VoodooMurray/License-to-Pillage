// Room 2: the Caribbean Pirate Licensing Authority. Agatha Stampwell behind the counter, Old Mort
// (a skeleton, ticket #7) on the bench.

const R = 'rooms/office/';

async function talkAgatha(g) {
  if (g.has('ticket_7') && !g.flag('served')) return serve(g);
  if (g.once('agatha_hello')) {
    await g.say('agatha', "Next.");
    await g.say("Hi! I'm Guybrush Threepwood, mighty pirate!");
    await g.say('agatha', "Do you have a license to be a mighty pirate?");
    await g.say("Uh... no.");
    await g.say('agatha', "Then you're just a man in a puffy shirt. Next.");
  } else if (g.flag('served')) {
    await g.say('agatha', "Mr. Threepwood. Number seven. What now?");
  } else {
    await g.say('agatha', "Next.");
  }
  for (;;) {
    const c = await g.choose([
      !g.flag('served') && { id: 'apply', text: "I'd like to apply for a Pirate License." },
      g.flag('served') && { id: 'status', text: "How's my application doing?" },
      !g.flag('served') && { id: 'number', text: "What number are you serving?" },
      g.flag('ag_number') && !g.flag('served') && !g.flag('ag_skip') && { id: 'skip', text: "Can't you just skip to my number?" },
      !g.flag('ag_stamp') && { id: 'stamp', text: "What's with the stamp?" },
      g.flag('ag_stamp') && !g.flag('ag_archives') && !g.has('stamp') && !g.has('stamp_inked') && !g.flag('stamp_in') && { id: 'archives', text: "Why don't you look for the APPROVED stamp?" },
      !g.flag('ag_mort') && { id: 'mort', text: "What about the skeleton on the bench?" },
      !g.flag('ag_ink') && { id: 'ink', text: "Where would I get squid ink?" },
      !g.flag('ag_hair') && { id: 'hair', text: "Nice hairdo." },
      !g.flag('ag_dmv') && { id: 'dmv', text: "This place reminds me of the D.M.V." },
      { id: 'bye', text: "Goodbye." },
    ]);
    if (c === 'apply') {
      await g.say('agatha', "There are three requirements.");
      await g.say('agatha', "One: take a number, and wait until it is called.");
      await g.say('agatha', "Two: Form 27-B/6, Application for Piratical Licensure, completed in regulation squid ink.");
      await g.say('agatha', "Three: an official license portrait, painted by the Guild-certified portraitist in the square.");
      await g.say('agatha', "Then I stamp it. Approved, or denied.");
      await g.say("What are the odds?");
      await g.say('agatha', "Of 'denied'? Excellent.");
      g.set('ag_rules');
    } else if (c === 'status') {
      await status(g);
    } else if (c === 'number') {
      g.set('ag_number');
      await g.say('agatha', "Seven.");
      await g.say("And after seven?");
      await g.say('agatha', "Eight. I'm very good at counting.");
    } else if (c === 'skip') {
      g.set('ag_skip');
      await g.say('agatha', "Skip? SKIP? Young man, this is a queue, not a game of hopscotch.");
    } else if (c === 'stamp') {
      g.set('ag_stamp');
      await g.say('agatha', "It's regulation. I lost the hand in an unfortunate filing accident.");
      await g.say('agatha', "The stamp says DENIED.");
      await g.say("Only DENIED?");
      await g.say('agatha', "The APPROVED stamp was lost in the Archives in 1672. We've been denying ever since.");
      await g.say('agatha', "Efficiency has never been higher.");
    } else if (c === 'archives') {
      g.set('ag_archives');
      await g.say('agatha', "In the Archives? Nobody who goes into the Archives ever comes back out.");
      await g.say("What happens to them?");
      await g.say('agatha', "They get filed.");
    } else if (c === 'mort') {
      g.set('ag_mort');
      await g.say('agatha', "Mr. Mortimer. Number seven. He's been waiting since 1654.");
      await g.say("Why don't you serve him?");
      await g.say('agatha', "He has to come to the counter. Those are the rules.");
      await g.say("But he's dead!");
      await g.say('agatha', "Then he should have filled out Form 91: Notice of Death. In triplicate.");
    } else if (c === 'ink') {
      g.set('ag_ink');
      await g.say('agatha', "From a squid, I would imagine.");
      await g.say('agatha', "Squids ink when they are frightened. Much like applicants.");
    } else if (c === 'hair') {
      g.set('ag_hair');
      await g.say('agatha', "It's regulation height. Two feet, four inches.");
      await g.say("What's in it?");
      await g.say('agatha', "Forms.");
    } else if (c === 'dmv') {
      g.set('ag_dmv');
      await g.say('agatha', "The Department of Marine Vessels? Amateurs.");
      await g.say('agatha', "The D.M.V. takes a day of your life. We take the rest of it.");
      await g.say('mort', "Hear, hear!");
    } else {
      await g.say('agatha', "Next.");
      return;
    }
  }
}

async function serve(g) {
  await g.cutscene(async () => {
    await g.say("Ahem. I believe I'm next.");
    await g.say('agatha', "Number seven. After all these years.");
    await g.wait(500);
    await g.say('agatha', "Now serving... number seven.");
    await g.say('mort', "Eh? What? Did somebody call my number?");
    await g.say('agatha', "No.");
    await g.say('mort', "Ah. Good. Wouldn't want to lose my place.");
    g.take('ticket_7');
    g.set('served');
    await g.say('agatha', "Very well, Mr. Threepwood. Form 27-B/6 and your license portrait, please.");
  });
}

async function status(g) {
  if (!g.flag('form_in') && !g.flag('portrait_in')) return g.say('agatha', "I still need your completed Form 27-B/6 and your license portrait.");
  if (!g.flag('form_in')) return g.say('agatha', "I still need your completed Form 27-B/6.");
  if (!g.flag('portrait_in')) return g.say('agatha', "I still need your license portrait.");
  if (!g.flag('stamp_in')) {
    await g.say('agatha', "Everything is in order. I've never seen that before. It's very unsettling.");
    return g.say('agatha', "But I only have DENIED. Find the APPROVED stamp, and I'll approve you.");
  }
}

// Paperwork handed to Agatha (only once served).
async function hand(g, item) {
  if (!g.flag('served')) {
    if (item === 'ticket_big') {
      await g.say('agatha', "Nine million, nine hundred and ninety-nine thousand, nine hundred and ninety-nine?");
      await g.say('agatha', "Please wait until your number is called.");
      await g.say("And when will that be?");
      return g.say('agatha', "Next century. Possibly the one after.");
    }
    if (item === 'ticket_7') return serve(g);
    if (item === 'chicken') return bribe(g);
    return g.say('agatha', "Take a number, please.");
  }
  if (item === 'form') {
    await g.say('agatha', "It's blank.");
    await g.say("I was hoping you wouldn't notice.");
    return g.say('agatha', "I notice everything. Fill it in. In squid ink.");
  }
  if (item === 'form_done') {
    await g.cutscene(async () => {
      await g.gesture('give');
      g.take('form_done');
      g.set('form_in');
      await g.say('agatha', "Name: Guybrush Threepwood. Occupation: pirate.");
      await g.say('agatha', "Limbs: yes. Previous acts of piracy: 'several'.");
      await g.say('agatha', "Hmm. It seems to be in order.");
    });
    return complete(g);
  }
  if (item === 'portrait') {
    await g.cutscene(async () => {
      await g.gesture('give');
      g.take('portrait');
      g.set('portrait_in');
      await g.say('agatha', "Eye patch. Parrot. Scowl.");
      await g.wait(400);
      await g.say('agatha', "It's you, all right. Acceptable.");
    });
    return complete(g);
  }
  if (item === 'stamp') {
    await g.say('agatha', "The APPROVED stamp! Good heavens. Where did you find it?");
    await g.say("Under L. For 'Lost'.");
    await g.say('agatha', "Of course. Unfortunately it's bone dry. A dry stamp is no stamp at all.");
    return g.say('agatha', "It takes regulation squid ink. Like everything else.");
  }
  if (item === 'stamp_inked') {
    await g.cutscene(async () => {
      await g.gesture('give');
      g.take('stamp_inked');
      g.set('stamp_in');
      await g.say('agatha', "The APPROVED stamp! Freshly inked! I'll keep it right here.");
    });
    return complete(g);
  }
  if (item === 'ticket_big') return g.say('agatha', "You've already been served. Don't be greedy.");
  if (item === 'chicken') return bribe(g);
  if (item === 'license') return g.say('agatha', "It's already approved. Don't push your luck.");
  return g.say('agatha', "That isn't regulation paperwork.");
}

async function complete(g) {
  if (!(g.flag('form_in') && g.flag('portrait_in'))) {
    return g.say('agatha', g.flag('form_in') ? "Now I just need your license portrait." : "Now I just need your completed Form 27-B/6.");
  }
  if (!g.flag('stamp_in')) {
    if (g.once('ag_order')) {
      await g.say('agatha', "Everything is in order. I've never seen that before. It's very unsettling.");
      await g.say('agatha', "Unfortunately, I can only stamp it DENIED.");
      if (g.has('stamp_inked')) {
        await g.say("Funny you should say that...");
      } else if (g.has('stamp')) {
        await g.say("Funny you should say that. Although mine's a little dry.");
        await g.say('agatha', "Then it's no use to me. It takes regulation squid ink. Like everything else.");
      } else {
        await g.say("What about the APPROVED stamp?");
        await g.say('agatha', "Lost in the Archives in 1672. Find it, and I'll stamp you. But nobody ever finds anything in the Archives.");
      }
    }
    return;
  }
  await g.cutscene(async () => {
    await g.say('agatha', "Form: complete. Portrait: acceptable. Number seven: served.");
    await g.say('agatha', "That leaves only the stamp.");
    g.anim('agatha', 'screw', { wait: false });
    await g.say('agatha', "Hmm. It fits.");
    await g.anim('agatha', 'stamp');
    g.sfx('stamp');
    g.engine.shake(500);
    await g.wait(700);
    await g.say('agatha', "APPROVED.");
    await g.wait(900);
    await g.say('agatha', "How odd. I feel almost cheerful.");
    await g.say('agatha', "It will pass.");
    await g.say('agatha', "Your Pirate License, Mr. Threepwood.");
    g.give('license');
    g.set('licensed');
    await g.say("Thanks! You won't regret this!");
    await g.say('agatha', "I already do. Next!");
  });
}

async function bribe(g) {
  await g.say('agatha', "A rubber chicken. Is that supposed to be a bribe?");
  await g.say("Would it work?");
  await g.say('agatha', "No.");
}

// The grandfather clock is a door to somebody else's adventure.
async function dottClock(g) {
  if (!g.once('dott_clock')) return g.say("I'm not opening that again. That tentacle looked like it wanted to take over the world.");
  await g.cutscene(async () => {
    await g.say("Odd, there's a slight draft coming out of the clock.");
    await g.gesture('use');
    g.sfx('door');
    // over there the soundtrack cuts out: a beat of silence, his voice in the other game, then he is back and the
    // office music returns (an audible cue that he went somewhere and came back)
    g.stopMusic();
    await g.showImage('art/dott_lab.jpg', { click: false, ms: 1200, keep: true });
    await g.say("Hello?");
    await g.wait(600);
    g.hideImage();
    g.music('office');
    await g.say("A secret laboratory, three portable toilets and a purple tentacle.");
    await g.say("I think I just opened the wrong adventure.");
    await g.say('agatha', "We don't talk about the clock.");
  });
}

async function talkMort(g) {
  if (g.once('mort_hello')) {
    await g.say('mort', "Shhh! They might call my number!");
  } else if (g.flag('swapped')) {
    await g.say('mort', "Still number seven. I can feel it in my bones. Which is all I've got.");
  } else {
    await g.say('mort', "Shhh! Any minute now.");
  }
  for (;;) {
    const c = await g.choose([
      !g.flag('mort_who') && { id: 'who', text: "Who are you?" },
      g.flag('mort_who') && !g.flag('mort_long') && { id: 'long', text: "How long have you been waiting?" },
      g.flag('mort_blackwood') && !g.flag('mort_treasure') && { id: 'treasure', text: "Where did you bury your treasure?" },
      g.flag('mort_blackwood') && g.flag('clue_isle') && !g.flag('mort_isle') && { id: 'isle', text: "Your treasure is on Isla Agria, isn't it?" },
      !g.flag('mort_counter') && { id: 'counter', text: "Why don't you just go up to the counter?" },
      !g.flag('swapped') && { id: 'ticket', text: "Can I have your ticket?" },
      !g.flag('mort_dead') && { id: 'dead', text: "Aren't you, um... dead?" },
      !g.flag('mort_eyes') && { id: 'eyes', text: "What happened to your eyes?" },
      !g.flag('mort_worst') && { id: 'worst', text: "What's the worst part about being a skeleton?" },
      !g.flag('mort_need') && { id: 'need', text: "Do you need anything?" },
      { id: 'bye', text: "Goodbye." },
    ]);
    if (c === 'who') {
      g.set('mort_who');
      await g.say('mort', "Mortimer Blackwood, captain of the good ship Patience. I came in to renew my license.");
      await g.say("When was that?");
      await g.say('mort', "1654. I was thirty-two. I had hair. And skin.");
      await g.say("Wait. Captain Mortimer Blackwood? THE Captain Blackwood? I've been following your trail!");
      await g.say('mort', "Trail? I've been sitting right here.");
      g.set('mort_blackwood');
    } else if (c === 'treasure') {
      g.set('mort_treasure');
      await g.say('mort', "Ah, the treasure. I remember it like it was yesterday.");
      await g.say('mort', "...Which it wasn't. It was 1654. I don't remember a thing.");
      await g.say("Nothing at all?");
      await g.say('mort', "Only that I had my license portrait done that morning. Out in the square. Sour business. Very sour.");
    } else if (c === 'isle') {
      g.set('mort_isle');
      await g.say('mort', "Isla Agria! The lime groves! It's all coming back to me!");
      await g.say('mort', "Go on, lad. Dig it up. I can't leave. I'd lose my place in line.");
    } else if (c === 'long') {
      g.set('mort_long');
      await g.say('mort', "What year is it now?");
      await g.say("It's... later than 1654.");
      await g.say('mort', "Then too long.");
    } else if (c === 'counter') {
      g.set('mort_counter');
      await g.say('mort', "And lose my place in line? Are you mad?");
      await g.say("There's nobody else in line!");
      await g.say('mort', "That's what they WANT you to think.");
    } else if (c === 'ticket') {
      await g.say('mort', "Over my dead body.");
      await g.say("That's... not much of an obstacle.");
      await g.say('mort', "It's the principle of the thing!");
    } else if (c === 'dead') {
      g.set('mort_dead');
      await g.say('mort', "I prefer 'patiently deceased'.");
    } else if (c === 'eyes') {
      g.set('mort_eyes');
      await g.say('mort', "Fell out in 1702. Can't read a thing anymore. Not even my own ticket.");
      await g.say('mort', "But I know it's seven. I can feel the notches.");
    } else if (c === 'worst') {
      g.set('mort_worst');
      await g.say('mort', "The drafts. Every little breeze goes straight through my ribs.");
      await g.say('mort', "And I'm terribly ticklish. Always have been.");
    } else if (c === 'need') {
      g.set('mort_need');
      await g.say('mort', "A cushion. After all these years on this bench, my coccyx is the only bone I can still feel.");
    } else {
      await g.say('mort', "Shhh! They might call my number!");
      return;
    }
  }
}

async function tickle(g) {
  if (g.flag('swapped')) return g.say('mort', "Not again! My ribs are still rattling!");
  if (!g.has('ticket_big')) {
    await g.say("If I grab his ticket, he'll notice an empty hand. Even without eyes.");
    return g.say("I'd need something to slip into it.");
  }
  await g.cutscene(async () => {
    g.preloadAnim('guybrush', 'fence_tickle');
    // fencing distance: from 160 the lunge would push the feather through Mort (tip at x~38); from 200 it ends at his ribs
    await g.walk(200, 440, 'W');
    g.gesture('fence_tickle');     // ~1.1 s: en garde, lunge, three flicks, recover, back to standing
    await g.say("Coochie coochie coo!", { noAnim: true });   // his head is drawn into the fencing frames
    await g.say('mort', "Hee! Hee hee! Stop it! Stop it! HAHAHAHA!");
    await g.say('mort', "Not the ribs! Anything but the RIBS! HAHAHA!");
    // he clutches his ribs (the laugh has empty hands) and the ticket flutters to the floor
    g.sfx('laugh');
    g.setBase('mort', 'laugh');
    g.sfx('rattle');
    await g.wait(300);
    g.setState('floor_ticket', 'floor');
    g.sfx('paper');
    await g.wait(700);
    await g.walk(160, 440, 'W');   // his reach from here ends at the ticket
    // the ticket leaves the floor when his hand is down (end of the kneel), not after he's up again
    g.gesture('pickup_low');
    await g.wait(330);
    g.setState('floor_ticket', 'off');
    g.give('ticket_7');
    await g.wait(600);
    // a step closer to hand it over (the walk also ends the pickup chore in SCUMM, which holds its last frame)
    await g.walk(150, 436, 'W');
    await g.say("Whoops! You dropped your ticket. Here you go.");
    await g.gesture('give');
    g.take('ticket_big');
    g.set('swapped');
    g.setBase('mort', 'stand');
    await g.say('mort', "Thank ye, lad. Wouldn't want to lose THAT. I've got a good feeling about today.");
    await g.say("Lucky number seven.");
  });
}

export default {
  id: 'office',
  size: [640, 480],
  layers: [{ img: R + 'bg.jpg' }],
  // flickering flames + a breathing glow (tools/candle_anim.py)
  anims: [{ id: 'candles', dir: R + 'candles/' }],
  music: 'office',
  scale: [[280, 0.41], [480, 1.05]],
  walk: {
    polys: [[[206, 280], [340, 276], [368, 318], [498, 480], [0, 480], [0, 456], [118, 430], [148, 350], [190, 334]]],
  },
  entries: { default: [330, 468, 'N'], harbor: [330, 468, 'N'], records: [240, 290, 'S'] },
  start: [330, 440, 'N'],

  actors: {
    agatha: { x: 505, y: 372, dir: 'W', scale: 0.92 },
    mort: { x: 70, y: 414, dir: 'E', scale: 1.0 },
  },

  occluders: [
    { img: R + 'fg_counter.png', x: 361.5, y: 233, z: 300 },
  ],

  objects: [
    {
      id: 'exit', name: 'town square', box: [140, 456, 360, 24], walkTo: [330, 474], face: 'S',
      exit: { room: 'harbor', x: 512, y: 300, dir: 'S' },
      look: "The way out. The only thing in here that moves quickly.",
      verbs: { hand: 'go to' },
    },
    {
      id: 'archives', name: 'Archives door', box: [216, 150, 46, 124], walkTo: [240, 286], face: 'N',
      exit: { room: 'records', x: 84, y: 420, dir: 'E' },
      verbs: { hand: 'open' },
      look: "A door marked 'ARCHIVES. STAFF ONLY.'",
      onExit: async g => {
        if (g.once('archives_first')) {
          await g.say('agatha', "It isn't locked.");
          await g.say("Aren't you going to stop me?");
          await g.say('agatha', "Nobody ever comes back out of the Archives. It's self-regulating.");
        }
        g.sfx('door');
      },
    },
    {
      id: 'sign', name: 'NOW SERVING sign', hot: [[428, 62], [452, 34], [490, 10], [498, 14], [498, 104], [440, 124]],
      states: { seven: { img: R + 'sign7.png', x: 424, y: 36, z: 120 }, eight: { img: R + 'sign8.png', x: 424, y: 36, z: 120 } },
      state: 'seven', walkTo: [340, 320], face: 'E',
      look: async g => {
        if (g.state('sign') === 'eight') return g.say("NOW SERVING: 8. Progress!");
        await g.say("NOW SERVING: 7.");
        await g.say("Judging by the cobwebs, it's been seven for a while.");
      },
      hand: "It's out of reach. Like everything else in this building.",
    },
    {
      id: 'dispenser', name: 'ticket dispenser', box: [124, 228, 58, 110], hotZ: 1, walkTo: [196, 348], face: 'W',
      verbs: { hand: 'take a ticket from' },
      look: "A take-a-number machine. The numbers go up. The service doesn't.",
      hand: async g => {
        if (g.flag('swapped')) return g.say("I've got number seven now. I'm not going back to the end of the line. Not for the rest of my life. Or Mort's.");
        if (g.has('ticket_big')) return g.say("I already have a number. A very, very big number.");
        await g.gesture('use');
        g.sfx('ticket');
        g.give('ticket_big');
        await g.say("Number nine million, nine hundred and ninety-nine thousand, nine hundred and ninety-nine.");
        await g.say("I'd better get comfortable.");
      },
      mouth: "It's not a candy dispenser. I checked.",
    },
    {
      id: 'forms', name: 'form rack', box: [0, 150, 92, 112], walkTo: [156, 356], face: 'W',
      verbs: { hand: 'take a form from' },
      look: "Forms. Hundreds of them. There's even a form for requesting forms.",
      hand: async g => {
        if (g.has('form') || g.has('form_done') || g.flag('form_in')) return g.say("I've already got my form. Any more and I'd need a form for my forms.");
        await g.gesture('pickup_high');
        g.sfx('paper');
        g.give('form');
        await g.say("Form 27-B/6: Application for Piratical Licensure.");
        await g.say("Only one copy? I was promised triplicate.");
      },
    },
    {
      id: 'pen', name: 'pen', box: [505, 287, 73, 28], walkTo: [414, 382], face: 'E',
      verbs: { hand: 'pick up' },
      look: async g => {
        await g.say("A pen. Wait a minute... it's carved into the counter!");
        await g.say("An anti-theft pen. Nobody can steal it. Nobody can use it, either.");
      },
      hand: "It's carved right into the wood. Very secure. Completely useless.",
      use: {
        form: "I can't fill in a form with a woodcarving.",
        ink: "I could ink it and make a lovely print of a pen. That won't fill in my form, though.",
      },
    },
    {
      id: 'bell', name: 'bell', box: [408, 206, 50, 46], walkTo: [384, 344], face: 'E',
      verbs: { hand: 'ring' },
      look: "A little brass bell. 'Ring for service.'",
      hand: async g => {
        // after her threat he thinks better of it: no reach, no ring, just the line
        if (g.flag('bell') >= 2) return g.say("Better not. She looks like she files things permanently.");
        await g.gesture('use');
        g.sfx('ding');
        const n = g.inc('bell');
        if (n === 1) { await g.say('agatha', "I am right here."); await g.say("Just checking."); }
        else await g.say('agatha', "Ring that again and I'll file you under 'Deceased'.");
      },
      mouth: "It's not that kind of bell.",
    },
    {
      id: 'counter', name: 'counter', hot: [[362, 236], [640, 330], [640, 480], [500, 480], [362, 318]],
      hotZ: -1, walkTo: [420, 390], face: 'E',
      look: "A service counter behind thick glass. Thick enough to stop a cannonball. Or a complaint.",
      hand: "I'm not climbing over. There's probably a form for that. Form 1: Climbing Over the Counter.",
    },
    {
      id: 'papers', name: 'mountains of paperwork', box: [540, 110, 100, 170], hotZ: -2,
      look: "Mountains of paperwork. Somewhere in there is an approved application. Probably.",
    },
    {
      id: 'clock', name: 'grandfather clock', box: [282, 158, 36, 118], hotZ: 1, walkTo: [300, 292], face: 'N',
      verbs: { hand: 'open', mouth: 'wind' },
      look: async g => {
        await g.say("A grandfather clock, stopped at five to five. Around here, even the clock is waiting.");
        await g.say("A little brass plate says: 'Edison Clock Company.' Never heard of them.");
      },
      hand: g => dottClock(g),
      mouth: "I'd better not wind it. Time might actually start moving in here, and then where would we be?",
    },
    {
      id: 'window', name: 'window', box: [300, 96, 90, 120],
      look: "Through the window I can see the harbor. And my boat. And the sea gate. Mostly the gate.",
      hand: "It's painted shut. Probably regulation.",
    },
    {
      id: 'palm', name: 'potted palm', box: [160, 156, 52, 150], walkTo: [210, 330], face: 'W',
      look: "A potted palm. The only thing in here that's growing.",
      mouth: "I'm not eating the office plant. That's how it starts.",
    },
    {
      // Mort's ticket on the floor, only during the tickle cutscene
      id: 'floor_ticket', name: 'ticket', noHotspot: true,
      states: { off: null, floor: { img: R + 'ticket_floor.png', x: 84, y: 418, z: 426 } }, state: 'off',
    },
    {
      id: 'portraits', name: 'portraits', hot: [[0, 0], [200, 0], [210, 90], [300, 90], [296, 140], [200, 150], [152, 150], [152, 224], [104, 224], [104, 150], [100, 150], [40, 140], [0, 150]],
      hotZ: -3,
      look: "The plaque says 'Our Valued Applicants, 1650 to Present'. None of them looks approved.",
      hand: "They're nailed to the wall. Much like their applications.",
    },
    {
      id: 'bench', name: 'bench', hot: [[0, 262], [134, 280], [140, 420], [0, 440]],
      hotZ: -1, walkTo: [150, 440], face: 'W',
      look: "A waiting bench, polished smooth by centuries of waiting.",
      hand: "I'd sit down, but I'm afraid I'd never get up again.",
    },
  ],

  npcs: {
    agatha: {
      name: 'clerk',
      hot: [-23, -218, 64, 126],
      walkTo: [412, 378], face: 'E',
      look: async g => {
        await g.say("The clerk. Her name tag says 'Agatha Stampwell'.");
        await g.say("She's got a towering beehive, spectacles on a chain and a rubber stamp for a left hand.");
      },
      hand: "I'm not going to push her. She looks like she'd push back. With a stamp.",
      mouth: g => talkAgatha(g),
      use: { '*': (g, item) => hand(g, item) },
    },
    mort: {
      name: 'skeleton',
      hot: [-40, -166, 98, 166],
      // fencing distance for the feather tickle (from 160 he walked past it and backed up to 200 first)
      walkTo: [200, 440], face: 'W',
      look: async g => {
        await g.say("A skeleton in a tattered captain's coat.");
        if (!g.flag('swapped')) await g.say("He's clutching a ticket in his bony fingers. A death grip. Literally.");
        else await g.say("He's clutching my old ticket. He looks very hopeful. As hopeful as a skull can look.");
      },
      verbs: { hand: 'take ticket from' },
      hand: async g => {
        if (g.flag('swapped')) return g.say("He's got my nine-million-something now. He can keep it.");
        await g.say('mort', "Hands off! I'm warning you, I'm VERY ticklish.");
        await g.say('mort', "Nothing but ribs, you see.");
      },
      mouth: g => talkMort(g),
      use: {
        feather: g => tickle(g),
        quill: g => tickle(g),
        ticket_big: async g => {
          await g.say("He's not going to trade seven for nine million-something. Not willingly, anyway.");
        },
        lime: async g => { await g.say('mort', "I don't have a tongue, lad. I'd just get lime all over my jaw."); },
        chicken: async g => { await g.say('mort', "A chicken? I haven't eaten since 1654. I'm not starting with rubber."); },
        '*': async g => { await g.say('mort', "I don't want that. I want my number called."); },
      },
    },
  },

  // Agatha stamps something DENIED now and then
  idle(g) {
    if (g.flag('ending')) return;
    if (Math.random() < 0.7) { g.fidget('agatha', 'stamp'); g.wait(420).then(() => g.sfx('stamp', 0.35)); }
  },

  async enter(g, from) {
    if (g.flag('ending')) return;
    if (g.once('office_first')) {
      await g.cutscene(async () => {
        await g.walk(330, 430, 'N');
        await g.say("Wow. It's like a cathedral dedicated to waiting.");
        g.setBase('mort', 'laugh');      // laughing while he talks (noAnim: no talk anim over the laugh)
        await g.say('mort', "Hee hee! Hee! Shut the door, lad! The draft tickles my ribs!", { noAnim: true });
        g.setBase('mort', 'stand');
        await g.face('W');
        await g.say("Sorry!");
      });
    }
  },
};
