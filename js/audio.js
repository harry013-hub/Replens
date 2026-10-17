// Short synthesized feedback sounds (no audio files, no network).
// Web Audio must be unlocked by a user tap on iOS: call unlock() from a click.

export class Feedback {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.6;
    this.speak = false;
    this._voiceOk = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    this._activeUntil = 0;
    this._nodes = [];
  }

  get speechSupported() { return this._voiceOk; }

  unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      if (!this.ctx) this.ctx = new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      // iOS: play a silent buffer inside the tap to fully unlock output.
      const b = this.ctx.createBuffer(1, 1, 22050);
      const s = this.ctx.createBufferSource();
      s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    } catch (e) {
      console.warn('[RepLens] audio unlock failed', e);
    }
  }

  _tone(freqs, durMs, gainScale = 1) {
    if (!this.enabled || !this.ctx || this.volume <= 0) return;
    const ctx = this.ctx;
    if (ctx.state !== 'running') { ctx.resume?.(); }
    const now = ctx.currentTime;
    // Never overlap: cut whatever is still ringing.
    this.stopAll();
    const master = ctx.createGain();
    master.gain.value = this.volume * 0.35 * gainScale;
    master.connect(ctx.destination);
    let t = now;
    for (const f of freqs) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + durMs / 1000 + 0.02);
      this._nodes.push(o);
      t += (durMs / 1000) * 0.55;
    }
    this._activeUntil = performance.now() + durMs * freqs.length;
  }

  rep(count) {
    this._tone([880, 1318.5], 140);
    if (this.speak && this._voiceOk && this.enabled) {
      try {
        speechSynthesis.cancel(); // avoid a growing queue of numbers
        const u = new SpeechSynthesisUtterance(String(count));
        u.rate = 1.15;
        u.volume = Math.max(0.1, this.volume);
        speechSynthesis.speak(u);
      } catch { /* speech is optional */ }
    }
  }

  tick() { this._tone([660], 90, 0.7); }
  go() { this._tone([988], 220, 0.9); }

  stopAll() {
    for (const o of this._nodes) { try { o.stop(); } catch { /* already stopped */ } }
    this._nodes = [];
    if (this._voiceOk) { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
  }

  async suspend() {
    this.stopAll();
    try { await this.ctx?.suspend(); } catch { /* ignore */ }
  }

  async close() {
    this.stopAll();
    try { await this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
  }
}
