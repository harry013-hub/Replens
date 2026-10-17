// Background music: main menu loop and battle loop (supplied tracks).
// Plays the .m4a copy where supported (iPhone), otherwise the original .ogg.
// Kept quieter than the voice lines; only one track plays at a time.

const DIR = new URL('../assets/music/', import.meta.url).href;
const TRACKS = { menu: 'main_menu_music', battle: 'battle_music' };

export class MusicPlayer {
  constructor() {
    this.enabled = true;
    this.volume = 0.35;
    this.current = null; // 'menu' | 'battle' | null
    this.wanted = null;  // what should play once audio is allowed
    this.unlocked = false;
    this.els = {};
  }

  _el(name) {
    if (!this.els[name]) {
      const a = new Audio();
      const m4a = a.canPlayType('audio/mp4; codecs="mp4a.40.2"');
      a.src = DIR + TRACKS[name] + (m4a ? '.m4a' : '.ogg');
      a.loop = true;
      a.preload = 'auto';
      this.els[name] = a;
    }
    return this.els[name];
  }

  setVolume(v) {
    this.volume = v;
    for (const a of Object.values(this.els)) a.volume = Math.max(0, Math.min(1, v));
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this._pauseAll(); else if (this.wanted) this.play(this.wanted);
  }

  /** Call from a user tap: browsers only allow sound after one. */
  unlock() {
    this.unlocked = true;
    if (this.wanted && this.current !== this.wanted) this.play(this.wanted);
  }

  play(name) {
    this.wanted = name;
    if (!this.enabled || !this.unlocked) return;
    for (const [n, a] of Object.entries(this.els)) if (n !== name) { a.pause(); a.currentTime = 0; }
    const a = this._el(name);
    a.volume = Math.max(0, Math.min(1, this.volume));
    this.current = name;
    const p = a.play();
    if (p?.catch) p.catch(() => { if (this.current === name) this.current = null; });
  }

  /** Pause without forgetting what should play (app paused / hidden). */
  pause() {
    this._pauseAll();
  }

  resume() {
    if (this.wanted) this.play(this.wanted);
  }

  stop() {
    this.wanted = null;
    for (const a of Object.values(this.els)) { a.pause(); a.currentTime = 0; }
    this.current = null;
  }

  _pauseAll() {
    for (const a of Object.values(this.els)) a.pause();
    this.current = null;
  }
}
