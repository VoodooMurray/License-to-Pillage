// WebAudio: looping music with crossfades, one-shot sound effects, voice lines.

import { audioBuffer } from './assets.js';

export class Audio {
  constructor() {
    this.ctx = null;
    this.music = null;       // {name, src, gain}
    this.volumes = { music: 0.55, sfx: 0.8, voice: 1.0 };
    this.voiceSrc = null;
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
    gain.gain.linearRampToValueAtTime(this.volumes.music, now + fade);
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

  stopVoice() {
    if (this.voiceSrc) { try { this.voiceSrc.stop(); } catch (e) { /* already stopped */ } this.voiceSrc = null; }
  }
}
