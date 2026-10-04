// Text languages. The game is written in English; a translation is a flat map English text ->
// translated text: <game>/lang/<code>.json for the game's own texts (tools/lang.py) and
// engine/lang/<code>.json for the interface (verb labels, F5 menu). Voices stay English: only what
// is shown changes, every script keeps working on the English strings (voice lookup, choose() ids).

import { json } from './assets.js';

export const LANGS = { en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano' };

export class Lang {
  constructor() {
    this.code = 'en';
    this.map = {};
    this.missing = new Set();       // shown texts without a translation (tests, ?debug console)
  }

  async load(code, gamePath) {
    if (!LANGS[code]) code = 'en';
    let map = {};
    if (code !== 'en') {
      const [ui, game] = await Promise.all([
        json(new URL(`./lang/${code}.json`, import.meta.url).href).catch(() => ({})),
        json(gamePath(`lang/${code}.json`)).catch(() => ({})),
      ]);
      map = { ...ui, ...game };
    }
    this.code = code;
    this.map = map;
    this.missing.clear();
  }

  // t('Language: {0}', 'Deutsch'); untranslated texts stay English
  t(s, ...args) {
    if (s == null || s === '') return s;
    let r = s;
    if (this.code !== 'en') {
      r = this.map[s];
      if (r == null) { r = s; if (/[A-Za-z]/.test(s)) this.missing.add(s); }
    }
    return args.length ? r.replace(/\{(\d)\}/g, (_, i) => args[i]) : r;
  }

  // a cursor label as LucasArts' localized games show it: capital first letter ("Nimm Feder"); French names
  // carry their article, so "Parler à le peintre" contracts to "Parler au peintre"
  label(s) {
    if (this.code === 'en' || !s) return s;
    if (this.code === 'fr') s = s.replace(/(^|\s)(à|de) (le|les) /g, (_, sp, p, a) => sp + { àle: 'au ', àles: 'aux ', dele: 'du ', deles: 'des ' }[p + a]);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  next() {
    const codes = Object.keys(LANGS);
    return codes[(codes.indexOf(this.code) + 1) % codes.length];
  }
}
