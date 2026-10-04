// Filling in Form 27-B/6 (quill + form): a little multiple-choice sequence. Any answers work.

const QUESTIONS = [
  { q: 'NAME:', a: [
    ["Guybrush Threepwood.", null],
    ["Guybrush Threepwood, Mighty Pirate.", "The 'Mighty Pirate' part is legally binding, right?"],
    ["Captain Guybrush 'The Terror' Threepwood.", "Too much? Nah."],
  ] },
  { q: 'OCCUPATION:', a: [
    ["Pirate.", null],
    ["Mighty pirate.", null],
    ["Pirate (license pending).", "Honesty is the best policy. Second best, after piracy."],
  ] },
  { q: 'NUMBER OF LIMBS (WOODEN LIMBS COUNT AS HALF):', a: [
    ["Four, all original.", null],
    ["Three and two halves.", "That's four. I think. Math was never my strong suit."],
    ["Does a rubber chicken count?", "Better cross that out."],
  ] },
  { q: 'PREVIOUS ACTS OF PIRACY:', a: [
    ["Defeated the ghost pirate LeChuck. Several times.", "They'll never believe that."],
    ["Stole a lime. On the honor system.", null],
    ["Filled out this form with a stolen feather.", "It's a confession AND an application. Efficient!"],
  ] },
  { q: 'REASON FOR APPLYING:', a: [
    ["To leave this island.", null],
    ["To pillage legally.", null],
    ["To find a lost treasure.", "They'll probably want a cut. Too late now."],
    ["Peer pressure.", null],
  ] },
];

export async function fillForm(g) {
  await g.cutscene(async () => {
    await g.say("All right, Form 27-B/6. Let's do this.");
  });
  for (const { q, a } of QUESTIONS) {
    g.engine.texts.push({ actor: '_form', lines: [q], color: '#ffd353', at: [320, 24] });
    const pick = await g.choose(a.map(([text], i) => ({ id: i, text })));
    g.engine.texts = g.engine.texts.filter(t => t.actor !== '_form');
    g.sfx('paper');
    const comment = a[pick][1];
    if (comment) await g.say(comment);
  }
  await g.cutscene(async () => {
    g.take('form');
    g.give('form_done');
    await g.say("And... signed. With a flourish.");
    await g.say("That's the most official thing I've ever done.");
  });
}
