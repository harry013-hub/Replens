// Generic rep-counting state machine. Pure logic, no DOM, no MediaPipe.
//
// It consumes already-measured, already-smoothed samples:
//   { t: ms timestamp, valid: boolean, value: joint angle in degrees, aux?: object }
// For both supported exercises the angle gets SMALLER as the user lowers
// (elbow angle for push-ups, knee angle for squats), so "top" means a large
// angle and "bottom" means a small one.
//
// Cycle: WAITING_FOR_START → READY_AT_TOP → MOVING_DOWN → BOTTOM_REACHED
//        → RETURNING_TO_TOP → (stable at top) → +1 rep → READY_AT_TOP

export const STATES = Object.freeze({
  WAITING: 'WAITING_FOR_START',
  READY: 'READY_AT_TOP',
  DOWN: 'MOVING_DOWN',
  BOTTOM: 'BOTTOM_REACHED',
  UP: 'RETURNING_TO_TOP',
});

export const DEFAULT_TIMING = Object.freeze({
  startHoldMs: 600,      // stable top needed before counting can begin
  returnHoldMs: 120,     // stable top needed to finish a rep
  bottomHoldMs: 50,      // brief dwell to confirm the bottom
  deepMarginDeg: 12,     // a single sample this far past bottomEnter also confirms bottom
  minRepIntervalMs: 500, // two completions closer than this = noise, not a rep
  lostGraceMs: 300,      // brief dropouts tolerated before the movement is discarded
  maxGapMs: 700,         // a gap between samples longer than this is an interruption
});

/**
 * Ordered thresholds (degrees):
 *   topEnter > topExit > bottomExit > bottomEnter
 * topEnter/topExit and bottomEnter/bottomExit are the hysteresis pairs.
 */
export function validateThresholds(th) {
  const { topEnter, topExit, bottomExit, bottomEnter } = th || {};
  const nums = [topEnter, topExit, bottomExit, bottomEnter];
  if (!nums.every(Number.isFinite)) return 'All thresholds must be numbers.';
  if (nums.some((n) => n < 20 || n > 180)) return 'Thresholds must be between 20° and 180°.';
  if (!(topEnter - topExit >= 4)) return 'Top entry must be at least 4° above top exit.';
  if (!(bottomExit - bottomEnter >= 4)) return 'Bottom exit must be at least 4° above bottom entry.';
  if (!(topExit - bottomExit >= 10)) return 'Top and bottom zones must be at least 10° apart.';
  return null;
}

export class RepCounter {
  constructor(config) {
    this.setConfig(config);
    this.reps = 0;
    this._clearMovement();
  }

  setConfig(config) {
    const err = validateThresholds(config);
    if (err) throw new Error(`Invalid thresholds: ${err}`);
    this.cfg = { ...DEFAULT_TIMING, ...config };
    this._clearMovement();
  }

  _clearMovement() {
    this.state = STATES.WAITING;
    this.topSince = null;
    this.bottomSince = null;
    this.bottomSamples = 0;
    this.invalidSince = null;
    this.lastT = null;
    this.refAux = null;
    this.minValue = null;
    this.lastRepT = this.lastRepT ?? null;
  }

  /** Discard any incomplete movement but keep the completed rep count. */
  resetMovement() {
    this._clearMovement();
    this.lastRepT = null;
  }

  resetAll() {
    this.reps = 0;
    this.resetMovement();
  }

  get inRep() {
    return this.state === STATES.DOWN || this.state === STATES.BOTTOM || this.state === STATES.UP;
  }

  /**
   * Feed one sample. Returns { state, event } where event is one of:
   *   null | 'ready' | 'rep' | 'partial' | 'too-fast' | 'lost' | 'gap'
   */
  update(sample) {
    const { t } = sample;
    const c = this.cfg;
    let event = null;

    // A long gap between samples (paused loop, frozen camera, slow device
    // stall) is treated as an interruption: never count across it.
    if (this.lastT !== null && t - this.lastT > c.maxGapMs) {
      const hadMovement = this.state !== STATES.WAITING;
      this._clearMovement();
      if (hadMovement) event = 'gap';
    }
    this.lastT = t;

    if (!sample.valid || !Number.isFinite(sample.value)) {
      if (this.invalidSince === null) this.invalidSince = t;
      // Any in-progress top/bottom dwell is broken by an invalid sample.
      this.topSince = null;
      this.bottomSince = null;
      this.bottomSamples = 0;
      if (t - this.invalidSince >= c.lostGraceMs && this.state !== STATES.WAITING) {
        const wasInRep = this.inRep;
        this._clearMovement();
        this.invalidSince = t;
        this.lastT = t;
        event = wasInRep ? 'lost' : event;
      }
      return { state: this.state, event };
    }
    this.invalidSince = null;

    const v = sample.value;
    const atTop = v >= c.topEnter;
    const confirmOk = typeof c.confirmBottom === 'function'
      ? !!c.confirmBottom(sample.aux, this.refAux)
      : true;
    const atBottom = v <= c.bottomEnter && confirmOk;

    switch (this.state) {
      case STATES.WAITING: {
        if (atTop) {
          if (this.topSince === null) this.topSince = t;
          if (t - this.topSince >= c.startHoldMs) {
            this.state = STATES.READY;
            this.refAux = sample.aux ?? null;
            this.topSince = null;
            event = event ?? 'ready';
          }
        } else {
          this.topSince = null;
        }
        break;
      }
      case STATES.READY: {
        if (atTop) this.refAux = sample.aux ?? this.refAux; // keep the top reference fresh
        if (v < c.topExit) {
          this.state = STATES.DOWN;
          this.minValue = v;
          this.bottomSince = null;
          this.bottomSamples = 0;
        }
        break;
      }
      case STATES.DOWN: {
        this.minValue = Math.min(this.minValue ?? v, v);
        if (atBottom) {
          if (this.bottomSince === null) this.bottomSince = t;
          this.bottomSamples += 1;
          const held = t - this.bottomSince >= c.bottomHoldMs || this.bottomSamples >= 2;
          const deep = v <= c.bottomEnter - c.deepMarginDeg;
          if (held || deep) {
            this.state = STATES.BOTTOM;
            this.bottomSince = null;
            this.bottomSamples = 0;
          }
        } else {
          this.bottomSince = null;
          this.bottomSamples = 0;
          if (atTop) {
            // Came back up without reaching the bottom: not a rep.
            this.state = STATES.READY;
            this.refAux = sample.aux ?? this.refAux;
            event = event ?? 'partial';
          }
        }
        break;
      }
      case STATES.BOTTOM: {
        this.minValue = Math.min(this.minValue ?? v, v);
        if (v >= c.bottomExit) {
          this.state = STATES.UP;
          this.topSince = null;
        }
        break;
      }
      case STATES.UP: {
        if (v <= c.bottomEnter) {
          // Went back down before reaching the top — still the same rep.
          this.state = STATES.BOTTOM;
          this.topSince = null;
          break;
        }
        if (atTop) {
          if (this.topSince === null) this.topSince = t;
          if (t - this.topSince >= c.returnHoldMs) {
            this.topSince = null;
            this.state = STATES.READY;
            this.refAux = sample.aux ?? this.refAux;
            if (this.lastRepT !== null && t - this.lastRepT < c.minRepIntervalMs) {
              event = 'too-fast';
            } else {
              this.reps += 1;
              this.lastRepT = t;
              event = 'rep';
            }
          }
        } else {
          this.topSince = null;
        }
        break;
      }
    }
    return { state: this.state, event };
  }
}
