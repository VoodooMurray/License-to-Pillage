// window.__test: drives the game through the same code paths as the mouse, for automated
// walkthroughs (tests/walkthrough.py with Playwright) and debugging from the console.
// Actions start a sentence and return when the player can act again, or when dialogue choices
// appear (then call choose()).

export function installTestApi(e) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t = {
    autoClick: false,
    log: [],
    // resolves true when the player can act again, or 'choices' when a dialogue menu is up
    async idle(timeoutMs = 120000) {
      const t0 = performance.now();
      for (;;) {
        if (t.autoClick && e.overlay && e.overlay.click) { const d = e.overlay.click; e.overlay.click = null; d.resolve(); }
        const walking = e.player && e.player.path.length > 0;
        if (e.choices) return 'choices';
        if (e.started && e.interactive() && !walking && !e.pending && e.room && !e.overlay) return true;
        if (performance.now() - t0 > timeoutMs) throw new Error('not idle: ' + JSON.stringify(t.status()));
        await sleep(40);
      }
    },
    status() {
      return {
        room: e.room?.id, busy: e.busy, cutscene: e.cutsceneDepth, choices: e.choices?.options.map(o => o.text),
        inv: [...e.state.inv], held: e.held, texts: e.texts.map(x => x.lines.join(' ')), overlay: e.overlay?.img || null,
        player: e.player && [Math.round(e.player.x), Math.round(e.player.y), e.player.dir], flags: { ...e.state.flags },
      };
    },
    async act(verb, target) {
      await t.idle();
      e.sentence(verb, t.target(target));
      await sleep(60);
      return t.idle();
    },
    async use(item, target) {
      await t.idle();
      if (!e.state.inv.includes(item)) throw new Error('not carrying ' + item);
      e.sentence('use', t.target(target), item);
      await sleep(60);
      return t.idle();
    },
    async combine(a, b) {
      await t.idle();
      for (const x of [a, b]) if (!e.state.inv.includes(x)) throw new Error('not carrying ' + x);
      e.run(() => e.combine(a, b));
      await sleep(60);
      return t.idle();
    },
    async itemVerb(item, verb) {
      await t.idle();
      e.run(() => e.itemVerb(item, verb));
      await sleep(60);
      return t.idle();
    },
    async exit(target) {
      await t.idle();
      const room = e.room.id;
      e.sentence('exit', t.target(target));
      const t0 = performance.now();
      while (e.room.id === room && performance.now() - t0 < 30000) await sleep(50);
      return t.idle();
    },
    // picks the dialogue choice containing `text` (waits for the menu)
    async choose(text, timeoutMs = 60000) {
      const t0 = performance.now();
      while (!e.choices) {
        if (performance.now() - t0 > timeoutMs) throw new Error('no choices while choosing ' + text);
        await sleep(40);
      }
      const ch = e.choices;
      const i = ch.options.findIndex(o => o.text.toLowerCase().includes(text.toLowerCase()));
      if (i < 0) throw new Error(`choice "${text}" not in ${JSON.stringify(ch.options.map(o => o.text))}`);
      e.choices = null;
      ch.d.resolve(ch.options[i]);
      await sleep(60);
      return t.idle();
    },
    target(id) {
      const a = e.actors.get(id);
      if (a && a.room === e.room.id && a.visible) return { kind: 'actor', id, def: e.actorDef(a), actor: a };
      const o = e.room.objects.get(id);
      if (!o) throw new Error('no target ' + id + ' in ' + e.room.id);
      return { kind: 'object', id, def: o };
    },
    fast(on = true, timeScale = 3) { e.textSpeed = on ? 0.05 : 1; e.timeScale = on ? timeScale : 1; t.autoClick = on; e.voiceOn = !on; },
    // texts shown in a translated game without a translation (engine/i18n.js)
    missing() { return [...e.lang.missing]; },
    skipCutscene() { if (e.cutsceneDepth) { e.skipping = true; e.skipLine(); } },
  };
  // record everything said (for transcripts)
  const say = e.api.say;
  e.api.say = async (...args) => {
    const [who, text] = args.length > 1 && typeof args[1] === 'string' ? args : [e.game.player, args[0]];
    if (typeof text === 'string') t.log.push(`${who}: ${text}`);
    return say(...args);
  };
  window.__test = t;
}
