// audio-engine.js — Web Audio playback, analyser, and offline rendering

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.tracks = new Map(); // id -> { buffer, gain, source, playing, volume }
    this.previewSources = [];
    this._nextId = 1;
    this.onEnded = null;
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  addTrack(buffer, name, volume = 1) {
    const id = this._nextId++;
    this.tracks.set(id, {
      id,
      name,
      buffer,
      volume,
      source: null,
      startedAt: 0,
      pausedOffset: 0,
      playing: false,
    });
    return id;
  }

  removeTrack(id) {
    const t = this.tracks.get(id);
    if (t?.source) { try { t.source.stop(); } catch {} }
    this.tracks.delete(id);
  }

  setVolume(id, v) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.volume = Math.min(1, Math.max(0, v));
    if (t.previewGain) {
      t.previewGain.gain.setTargetAtTime(t.volume, this.ctx.currentTime, 0.02);
    }
  }

  get tracksList() { return [...this.tracks.values()]; }

  totalDuration() {
    let max = 0;
    for (const t of this.tracks.values()) max = Math.max(max, t.buffer.duration);
    return max;
  }

  // ---- Live preview ----

  async startPreview(onProgress) {
    this.ensureContext();
    this.stopPreview();

    const ctx = this.ctx;
    const master = ctx.createGain();
    master.connect(this.analyser);

    const dur = this.totalDuration();
    const t0 = ctx.currentTime;
    this.previewSources = [];

    for (const t of this.tracks.values()) {
      const src = ctx.createBufferSource();
      src.buffer = t.buffer;
      const gain = ctx.createGain();
      gain.gain.value = t.volume;
      t.previewGain = gain;
      src.connect(gain).connect(master);
      src.start(t0);
      t.source = src;
      t.playing = true;
      t.startedAt = t0;
      t.pausedOffset = 0;

      src.onended = () => {
        if (t.source === src) { t.playing = false; t.source = null; t.previewGain = null; }
      };
      this.previewSources.push(src);
    }

    return new Promise((resolve) => {
      const tick = () => {
        const elapsed = ctx.currentTime - t0;
        if (onProgress) onProgress(Math.min(elapsed / dur, 1), elapsed, dur);
        if (elapsed < dur && this.previewSources.length) {
          requestAnimationFrame(tick);
        } else {
          this.stopPreview();
          resolve();
        }
      };
      tick();
    });
  }

  stopPreview() {
    for (const src of this.previewSources) {
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    }
    this.previewSources = [];
    for (const t of this.tracks.values()) {
      if (t.source) { t.playing = false; t.source = null; t.previewGain = null; }
    }
    if (this.onEnded) this.onEnded();
  }

  isPreviewing() { return this.previewSources.length > 0; }

  getAnalyserData() {
    if (!this.analyser) return null;
    return new Uint8Array(this.analyser.frequencyBinCount);
  }

  // ---- Offline render ----

  async renderOffline(formatSampleRate = 44100) {
    const dur = Math.max(0.1, this.totalDuration());
    const offline = new OfflineAudioContext(2, Math.ceil(dur * formatSampleRate), formatSampleRate);

    for (const t of this.tracks.values()) {
      const src = offline.createBufferSource();
      src.buffer = t.buffer;
      const gain = offline.createGain();
      gain.gain.value = t.volume;
      src.connect(gain).connect(offline.destination);
      src.start(0);
    }

    return offline.startRendering();
  }
}
