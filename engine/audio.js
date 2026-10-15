// WebAudio: looping music with crossfades, one-shot sound effects, voice lines.

import { audioBuffer } from './assets.js';

export class Audio {
  constructor() {
    this.ctx = null;
    this.music = null;       // {name, src, gain}
    this.volumes = { music: 0.55, sfx: 0.8, voice: 1.0 };
    this.voiceSrc = null;
    this.musicOn = true;
  }

  // the F5 menu's music switch: the track keeps running silently, so switching back resumes it
  setMusicOn(on) {
    this.musicOn = on;
    if (!this.ctx || !this.music?.gain) return;
    const g = this.music.gain.gain, now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(on ? this.volumes.music : 0, now + 0.4);
  }

  // must be called from a user gesture
  unlock() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  async playMusic(path, { fade = 1.5, loopStart, loopEnd } = {}) {
    if (!this.ctx || !path) return;
    if (this.music && this.music.path === path) return;
    const old = this.music;
    this.music = { path };
    let buf;
    try { buf = await audioBuffer(this.ctx, path); } catch (e) { console.warn(e.message); return; }
    if (this.music.path !== path) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    if (loopStart != null) src.loopStart = loopStart;
    if (loopEnd != null) src.loopEnd = loopEnd;
    const gain = this.ctx.createGain();
    const now = this.ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(this.musicOn ? this.volumes.music : 0, now + fade);
    src.connect(gain).connect(this.master);
    src.start();
    Object.assign(this.music, { src, gain });
    if (old && old.gain) this.fadeOut(old, fade);
  }

  fadeOut(m, fade = 1.5) {
    const now = this.ctx.currentTime;
    m.gain.gain.cancelScheduledValues(now);
    m.gain.gain.setValueAtTime(m.gain.gain.value, now);
    m.gain.gain.linearRampToValueAtTime(0, now + fade);
    m.src.stop(now + fade + 0.05);
  }

  // looping ambience bed (waves, gulls...) on its own channel
  async playAmbience(path, volume = 0.35) {
    if (!this.ctx) return;
    if (this.amb && this.amb.path === path) return;
    const old = this.amb;
    this.amb = { path };
    if (old && old.gain) this.fadeOut(old, 1.0);
    if (!path) { this.amb = null; return; }
    let buf;
    try { buf = await audioBuffer(this.ctx, path); } catch (e) { return; }
    if (!this.amb || this.amb.path !== path) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(volume * this.volumes.sfx, this.ctx.currentTime + 1.5);
    src.connect(gain).connect(this.master);
    src.start();
    Object.assign(this.amb, { src, gain });
  }

  stopMusic(fade = 1.5) {
    if (this.music && this.music.gain) this.fadeOut(this.music, fade);
    this.music = null;
  }

  async sfx(path, volume = 1) {
    if (!this.ctx || !path) return;
    try {
      const buf = await audioBuffer(this.ctx, path);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = this.volumes.sfx * volume;
      src.connect(g).connect(this.master);
      src.start();
    } catch (e) { console.warn(e.message); }
  }

  // Plays a voice line; resolves with its duration in seconds (0 if missing).
  async voice(path) {
    if (!this.ctx || !path) return 0;
    try {
      const buf = await audioBuffer(this.ctx, path);
      this.stopVoice();
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = this.volumes.voice;
      src.connect(g).connect(this.master);
      src.start();
      this.voiceSrc = src;
      return buf.duration;
    } catch (e) { return 0; }
  }

  // A Kenny-style voice for a character without recordings ("voice": "mumble"): a fast, high, muffled run of syllables,
  // as long as the text, the same every time for the same line. Resolves with its duration in seconds.
  mumble(text, { pitch = 380 } = {}) {
    if (!this.ctx || !text) return 0;
    let seed = 0;
    for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const sr = this.ctx.sampleRate, out = [];
    const VOWELS = [[700, 1200], [500, 1700], [400, 900], [600, 1000], [350, 1500]];     // F1, F2 (Hz)
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const n = Math.max(1, Math.round(word.replace(/[^\p{L}\p{N}]/gu, '').length / 2.6));
      for (let i = 0; i < n; i++) {
        const dur = 0.06 + rnd() * 0.045, len = Math.round(dur * sr);
        const f0 = pitch * (0.85 + rnd() * 0.35), glide = (rnd() - 0.4) * 0.25, [F1, F2] = VOWELS[Math.floor(rnd() * VOWELS.length)];
        const harm = [];
        for (let k = 1; k * f0 < 2400; k++) {
          const f = k * f0, a = Math.exp(-(((f - F1) / 220) ** 2)) + 0.6 * Math.exp(-(((f - F2) / 300) ** 2)) + 0.15 / k;
          harm.push([k, a]);
        }
        let ph = 0;
        for (let j = 0; j < len; j++) {
          const t = j / len, f = f0 * (1 + glide * t);
          ph += 2 * Math.PI * f / sr;
          let v = 0;
          for (const [k, a] of harm) v += a * Math.sin(k * ph);
          out.push(v * Math.min(1, t * 8) * Math.min(1, (1 - t) * 5) * 0.22);
        }
        for (let j = Math.round((0.012 + rnd() * 0.02) * sr); j > 0; j--) out.push(0);
      }
      if (/[.,!?;:]$/.test(word)) for (let j = Math.round(0.12 * sr); j > 0; j--) out.push(0);
      else for (let j = Math.round(0.04 * sr); j > 0; j--) out.push(0);
    }
    const buf = this.ctx.createBuffer(1, out.length, sr);
    buf.getChannelData(0).set(out);
    this.stopVoice();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const lp = this.ctx.createBiquadFilter();            // through the parka
    lp.type = 'lowpass'; lp.frequency.value = 1150; lp.Q.value = 2;
    const g = this.ctx.createGain();
    g.gain.value = this.volumes.voice;
    src.connect(lp).connect(g).connect(this.master);
    src.start();
    this.voiceSrc = src;
    return buf.duration;
  }

  stopVoice() {
    if (this.voiceSrc) { try { this.voiceSrc.stop(); } catch (e) { /* already stopped */ } this.voiceSrc = null; }
  }
}
