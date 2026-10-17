// Supplied Skelesquat voice lines, matched to their triggers by the condition
// written in each file name (e.g. "Boss 1 hit (if boss 1 hit).m4a").
// One clip plays at a time. A higher-priority clip may cut in on a lower one;
// otherwise new clips are dropped, so nothing overlaps or stacks up.

const DIR = new URL('../assets/audio/', import.meta.url).href;
const f = (name) => DIR + encodeURIComponent(name);

/** Category → supplied files. Conditions quoted from the file names. */
export const VOICE_LINES = Object.freeze({
  // "(when start on count down)"
  countdown: [f('Read set go (when start on count down).m4a')],
  // "(if boss 1 hit)"
  hit: [f('Boss 1 hit (if boss 1 hit).m4a'), f('Boss 1 hit 2 (if boss 1 hit).m4a')],
  // "(idle boss)", "(idle)", "(idle for boss)"
  idle: [
    f('Boss 1 idle 3 (idle boss).m4a'),
    f('Boss 1 other idle sound (idle).m4a'),
    f('Boss 1 sound (idle for boss).m4a'),
  ],
  // "(good)" — encouragement during exercise
  motivational: [
    f('Superb (good).m4a'), f('Superb 2 (good).m4a'), f('Superb louder (good).m4a'),
    f('Keep going (good).m4a'), f('Never give up (good).m4a'), f('You got this (good).m4a'),
    f('You’re doing great (good).m4a'),
  ],
  // "(halfway if set rep count)"
  halfway: [f('Halfway there (halfway if set rep count).m4a')],
  // "(to fast or not counts)"
  tooFast: [f('To fast (if it says to fast or not counts).m4a')],
  // "(if it says go lower)" — a lowering movement that stopped short
  goLower: [f('Go Lower (if it says go lower).m4a')],
  // "(if rep doesn’t count)"
  tryAgain: [f('Try again (if rep doesn’t count).m4a')],
  // "(if done)" — a workout's rep goal reached
  wellDone: [f('Well done(if done).m4a')],
  // "(if boss dies)" / "(boss death chose 1 or 2 for death)"
  death: [f('Boss 1 death (if boss dies).m4a'), f('Boss 1 death sound 2 ( boss death chose 1 or 2 for death).m4a')],
  // "(when finished)"
  clapping: [f('Clapping (when finished).m4a')],
  // "Level Up (good)" — played once the boss is beaten
  levelUp: [f('Level Up (good).m4a')],
});

/** Lower number = higher priority. */
export const PRIORITY = Object.freeze({
  countdown: 1, death: 1, clapping: 1, levelUp: 1,
  hit: 2, wellDone: 2,
  halfway: 3, motivational: 3, tooFast: 3, goLower: 3, tryAgain: 3,
  idle: 4,
});

export const IDLE_EVERY_MS = 8000;

/**
 * @param {object} opts
 * @param {() => HTMLAudioElement} [opts.createAudio]  injectable for tests
 * @param {() => number} [opts.now]
 * @param {() => number} [opts.random]
 */
export class VoicePlayer {
  constructor({ createAudio, now, random } = {}) {
    this.createAudio = createAudio || (() => new Audio());
    this.now = now || (() => performance.now());
    this.random = random || Math.random;
    this.el = null;
    this.current = null;     // { category, url, priority }
    this.enabled = true;
    this.volume = 0.8;
    this.lastIndex = {};
    this.lastEndedAt = -Infinity;
    this.idleOn = false;
    this._idleTimer = null;
    this._queue = [];
  }

  _audio() {
    if (!this.el) {
      this.el = this.createAudio();
      this.el.preload = 'auto';
      this.el.addEventListener?.('ended', () => this._finished());
      this.el.addEventListener?.('error', () => this._finished());
    }
    return this.el;
  }

  _finished() {
    this.current = null;
    this.lastEndedAt = this.now();
    const next = this._queue.shift();
    if (next) this.play(next);
  }

  get busy() { return !!this.current; }

  /** Must be called inside a user tap so iOS lets later clips play. */
  unlock() {
    const a = this._audio();
    if (this._unlocked) return;
    this._unlocked = true;
    try {
      if (this.current) return; // something is already playing from a tap
      a.muted = true;
      const url = VOICE_LINES.idle[0];
      a.src = url;
      const p = a.play();
      const reset = () => {
        // Only stop our silent unlock play, never a real clip started meanwhile.
        if (!this.current && a.src === url) { try { a.pause(); a.currentTime = 0; } catch { /* ignore */ } }
        a.muted = false;
      };
      if (p?.then) p.then(reset, () => { a.muted = false; }); else reset();
    } catch { a.muted = false; }
  }

  _pick(category) {
    const list = VOICE_LINES[category] || [];
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    let i = Math.floor(this.random() * list.length);
    if (i === this.lastIndex[category]) i = (i + 1) % list.length; // avoid immediate repeats
    this.lastIndex[category] = i;
    return list[i];
  }

  /**
   * Play a clip from a category. Returns true if it started.
   * @param {object} [o]
   * @param {boolean} [o.queue]  if busy, play right after the current clip instead of dropping
   */
  play(category, { queue = false } = {}) {
    if (!this.enabled) return false;
    const priority = PRIORITY[category] ?? 4;
    if (this.current) {
      if (this.current.category === category && category !== 'hit') return false; // never restart the same line
      if (priority >= this.current.priority) {
        if (queue && this._queue.length < 3) this._queue.push(category);
        return false;
      }
    }
    const url = this._pick(category);
    if (!url) return false;
    const a = this._audio();
    try {
      a.pause();
      a.muted = false;
      a.volume = Math.max(0, Math.min(1, this.volume));
      a.src = url;
      a.currentTime = 0;
      this.current = { category, url, priority };
      const p = a.play();
      if (p?.catch) p.catch(() => { if (this.current?.url === url) this._finished(); });
      return true;
    } catch {
      this.current = null;
      return false;
    }
  }

  /** Idle dialogue about every 8 s, only while nothing else is playing. */
  startIdle() {
    if (this.idleOn) return;
    this.idleOn = true;
    this.lastEndedAt = Math.max(this.lastEndedAt, this.now());
    this._idleTimer = setInterval(() => this.tickIdle(), 500);
  }

  tickIdle() {
    if (!this.idleOn || this.current || !this.enabled) return false;
    if (this.now() - this.lastEndedAt < IDLE_EVERY_MS) return false;
    const ok = this.play('idle');
    if (!ok) this.lastEndedAt = this.now();
    return ok;
  }

  stopIdle() {
    this.idleOn = false;
    clearInterval(this._idleTimer);
    this._idleTimer = null;
  }

  stopAll() {
    this._queue = [];
    if (this.el) { try { this.el.pause(); } catch { /* ignore */ } }
    if (this.current) { this.current = null; this.lastEndedAt = this.now(); }
  }

  dispose() {
    this.stopIdle();
    this.stopAll();
  }
}
