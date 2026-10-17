// Exercise definitions + per-frame measurement from pose landmarks.
// Pure logic, no DOM — unit-tested in tests/.
//
// Left/right below always mean the person's ANATOMICAL left/right as reported
// by MediaPipe on the raw (un-mirrored) camera frame. Mirroring the preview
// for the selfie camera is purely a display transform and never changes
// which landmark is "left".

import { toPixel, angleDeg, inclinationDeg, dist, TimeSmoother } from './geometry.js';
import { RepCounter, STATES, DEFAULT_TIMING } from './counter.js';

export const LM = Object.freeze({
  nose: 0,
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
});

export const MIN_VISIBILITY = 0.5;
const FRAME_MARGIN = 0.02; // landmarks this far outside 0..1 are "out of frame"

export const EXERCISES = Object.freeze({
  pushup: {
    id: 'pushup',
    name: 'Push-ups',
    singular: 'push-up',
    setupText:
      'Place your phone securely to your side. Keep your shoulders, elbows, wrists, hips, and ankles visible. A side view works best.',
    joints: ['shoulder', 'elbow', 'wrist', 'hip', 'ankle'],
    angleLabel: 'Elbow angle',
    defaultThresholds: { topEnter: 155, topExit: 145, bottomExit: 110, bottomEnter: 100 },
    timing: { minRepIntervalMs: 450 },
    stateText: {
      [STATES.WAITING]: 'Get into top position',
      [STATES.READY]: 'Ready',
      [STATES.DOWN]: 'Lowering',
      [STATES.BOTTOM]: 'Push up',
      [STATES.UP]: 'Return to top',
    },
  },
  squat: {
    id: 'squat',
    name: 'Squats',
    singular: 'squat',
    setupText:
      'Place your phone securely to your side, far enough away to show your shoulders, hips, knees, and ankles.',
    joints: ['shoulder', 'hip', 'knee', 'ankle'],
    angleLabel: 'Knee angle',
    defaultThresholds: { topEnter: 160, topExit: 150, bottomExit: 120, bottomEnter: 110 },
    timing: { minRepIntervalMs: 600 },
    stateText: {
      [STATES.WAITING]: 'Stand tall to begin',
      [STATES.READY]: 'Ready',
      [STATES.DOWN]: 'Lowering',
      [STATES.BOTTOM]: 'Stand up',
      [STATES.UP]: 'Return to standing',
    },
  },
});

function lmOk(lm) {
  if (!lm) return false;
  const vis = lm.visibility ?? 1;
  const inFrame =
    lm.x >= -FRAME_MARGIN && lm.x <= 1 + FRAME_MARGIN &&
    lm.y >= -FRAME_MARGIN && lm.y <= 1 + FRAME_MARGIN;
  return vis >= MIN_VISIBILITY && inFrame;
}

function sideInfo(landmarks, side, joints) {
  const idx = LM[side];
  const conf = {};
  const missing = [];
  let minVis = 1;
  for (const j of joints) {
    const lm = landmarks[idx[j]];
    const vis = lm ? (lm.visibility ?? 1) : 0;
    conf[j] = vis;
    minVis = Math.min(minVis, vis);
    if (!lmOk(lm)) missing.push(j);
  }
  return { side, conf, missing, score: missing.length ? minVis * 0.5 : minVis, ok: missing.length === 0 };
}

function pts(landmarks, side, joints, W, H) {
  const out = {};
  for (const j of joints) out[j] = toPixel(landmarks[LM[side][j]], W, H);
  return out;
}

// --- Per-exercise geometry -------------------------------------------------

function measurePushupSide(p) {
  const value = angleDeg(p.shoulder, p.elbow, p.wrist);
  const torso = dist(p.shoulder, p.hip);
  const bodyIncl = inclinationDeg(p.shoulder, p.ankle); // 0 = horizontal
  const bodyLine = angleDeg(p.shoulder, p.hip, p.ankle); // 180 = straight
  const armLen = dist(p.shoulder, p.elbow) + dist(p.elbow, p.wrist);
  let postureMsg = null;
  // These checks only tell a push-up apart from e.g. standing and bending an
  // elbow. They are loose on purpose and are not form judgments.
  if (!(bodyIncl <= 45)) postureMsg = 'Get into push-up position (side view)';
  else if (!(p.wrist.y >= p.shoulder.y - 0.15 * armLen)) postureMsg = 'Hands should be on the floor below your shoulders';
  else if (!(bodyLine >= 125)) postureMsg = 'Standard floor push-ups only — legs extended';
  return {
    value,
    aux: { drop: torso > 1 ? (p.wrist.y - p.shoulder.y) / torso : null },
    postureMsg,
    extra: { bodyIncl, bodyLine },
  };
}

function measureSquatSide(p) {
  const value = angleDeg(p.hip, p.knee, p.ankle);
  const torso = dist(p.shoulder, p.hip);
  const torsoIncl = inclinationDeg(p.shoulder, p.hip); // 90 = upright
  let postureMsg = null;
  if (!(p.shoulder.y < p.hip.y && p.hip.y < p.ankle.y)) postureMsg = 'Stand upright, side-on to the camera';
  else if (!(torsoIncl >= 30)) postureMsg = 'Stand upright, side-on to the camera';
  return {
    value,
    aux: { hipY: p.hip.y, torso: torso > 1 ? torso : null },
    postureMsg,
    extra: { torsoIncl },
  };
}

// Supporting checks for the bottom of a rep, relative to the user's own
// top position (refAux is captured while they are at the top).
function confirmPushupBottom(aux, ref) {
  if (!aux || aux.drop == null || !ref || ref.drop == null) return true;
  // Shoulders must have come down toward the hands, not just the elbow bending.
  return aux.drop <= ref.drop * 0.85;
}
function confirmSquatBottom(aux, ref) {
  if (!aux || !ref || ref.torso == null || aux.hipY == null || ref.hipY == null) return true;
  // Hips must have actually moved down (relative to the user's torso length),
  // not only the knee angle changing — e.g. lifting one knee is not a squat.
  return (aux.hipY - ref.hipY) / ref.torso >= 0.06;
}

const SIDE_IMPL = {
  pushup: { measure: measurePushupSide, confirmBottom: confirmPushupBottom, allowBoth: false },
  squat: { measure: measureSquatSide, confirmBottom: confirmSquatBottom, allowBoth: true },
};

function missingMessage(exId, missing, frameIssue) {
  if (frameIssue === 'too-close') return 'Move farther back.';
  if (frameIssue === 'too-far') return 'Move closer to the camera.';
  const has = (j) => missing.includes(j);
  if (exId === 'pushup') {
    if (has('elbow')) return 'Keep your elbows visible.';
    if (has('wrist')) return 'Keep your hands visible.';
    if (has('shoulder')) return 'Keep your shoulders in frame.';
    return 'Keep your hips and ankles in frame.';
  }
  if (has('hip') || has('knee') || has('ankle')) return 'Keep your hips, knees, and ankles in frame.';
  return 'Keep your shoulders in frame.';
}

/** Detect framing problems from where the landmarks fall in the image. */
function frameIssue(landmarks) {
  const body = [11, 12, 23, 24, 25, 26, 27, 28].map((i) => landmarks[i]).filter(Boolean);
  if (!body.length) return null;
  const xs = body.map((l) => l.x), ys = body.map((l) => l.y);
  const outCount = body.filter((l) => l.x < -FRAME_MARGIN || l.x > 1 + FRAME_MARGIN || l.y < -FRAME_MARGIN || l.y > 1 + FRAME_MARGIN).length;
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  if (outCount >= 2 || spanX > 0.95 || spanY > 0.95) return 'too-close';
  if (Math.max(spanX, spanY) < 0.22) return 'too-far';
  return null;
}

/**
 * Measure one frame for an exercise.
 * @param lockedSide  null, 'left', 'right' or 'both'. When set (mid-rep), only
 *                    that side may be used, so measurements never jump sides.
 */
export function measureFrame(exId, landmarks, W, H, lockedSide = null, preferredSide = null) {
  const ex = EXERCISES[exId];
  const impl = SIDE_IMPL[exId];
  if (!landmarks || landmarks.length < 29 || !W || !H) {
    return { status: 'none', valid: false, message: 'Tracking paused — body not clearly visible.' };
  }
  const L = sideInfo(landmarks, 'left', ex.joints);
  const R = sideInfo(landmarks, 'right', ex.joints);
  const issue = frameIssue(landmarks);
  const conf = { left: L.conf, right: R.conf };

  const evalSide = (s) => {
    const m = impl.measure(pts(landmarks, s, ex.joints, W, H));
    return Number.isFinite(m.value) ? m : null;
  };

  // Which side(s) may we use?
  let side = null;
  if (lockedSide === 'both') {
    side = L.ok && R.ok ? 'both' : L.ok ? 'left' : R.ok ? 'right' : null;
  } else if (lockedSide) {
    side = (lockedSide === 'left' ? L : R).ok ? lockedSide : null;
  } else {
    if (impl.allowBoth && L.ok && R.ok) {
      side = 'both';
    } else {
      const best = L.score >= R.score ? L : R;
      const pref = preferredSide === 'left' ? L : preferredSide === 'right' ? R : null;
      // Hysteresis: stay on the previously used side unless the other is clearly better.
      side = pref && pref.ok && pref.score + 0.15 >= best.score ? pref.side : best.ok ? best.side : null;
    }
  }

  if (!side) {
    const best = L.score >= R.score ? L : R;
    const lostLock = !!lockedSide;
    return {
      status: 'adjust', valid: false, conf, side: lockedSide,
      message: lostLock && best.ok
        ? 'Tracking paused — body not clearly visible.'
        : missingMessage(exId, best.missing, issue),
    };
  }

  let m;
  if (side === 'both') {
    const ml = evalSide('left'), mr = evalSide('right');
    if (ml && mr && Math.abs(ml.value - mr.value) <= 20) {
      m = {
        value: (ml.value + mr.value) / 2,
        aux: averageAux(ml.aux, mr.aux),
        postureMsg: ml.postureMsg && mr.postureMsg ? ml.postureMsg : null,
        extra: ml.extra,
      };
    } else {
      // Sides disagree (usually the far side is occluded): use the more confident one.
      side = L.score >= R.score ? 'left' : 'right';
      if (lockedSide === 'both' || !lockedSide) m = side === 'left' ? ml : mr;
    }
  } else {
    m = evalSide(side);
  }

  if (!m) {
    return { status: 'adjust', valid: false, conf, side, message: missingMessage(exId, [], issue) };
  }
  if (m.postureMsg) {
    return { status: 'adjust', valid: false, conf, side, raw: m.value, message: m.postureMsg };
  }
  return { status: 'good', valid: true, conf, side, raw: m.value, aux: m.aux, extra: m.extra, message: null };
}

function averageAux(a, b) {
  const out = {};
  for (const k of Object.keys(a || {})) {
    out[k] = a[k] != null && b?.[k] != null ? (a[k] + b[k]) / 2 : a[k] ?? b?.[k] ?? null;
  }
  return out;
}

/**
 * Combines measurement, smoothing, side locking and the rep state machine.
 * Pose detection lives elsewhere (pose.js) — this only sees landmark arrays.
 */
export class ExerciseTracker {
  constructor(exId, thresholds = null, timing = {}) {
    this.exId = exId;
    this.ex = EXERCISES[exId];
    this.smoother = new TimeSmoother(80);
    this._timing = timing;
    this.setThresholds(thresholds || this.ex.defaultThresholds);
    this.side = null;
  }

  setThresholds(th) {
    const reps = this.counter?.reps ?? 0;
    this.thresholds = { ...th };
    this.counter = new RepCounter({
      ...DEFAULT_TIMING,
      ...this.ex.timing,
      ...this._timing,
      ...this.thresholds,
      confirmBottom: SIDE_IMPL[this.exId].confirmBottom,
    });
    this.counter.reps = reps;
    this.smoother?.reset();
  }

  get reps() { return this.counter.reps; }
  set reps(n) { this.counter.reps = Math.max(0, n | 0); }
  get state() { return this.counter.state; }

  /** Drop the incomplete movement (pause, camera change, interruption). */
  resetMovement() {
    this.counter.resetMovement();
    this.smoother.reset();
    this.side = null;
  }

  resetAll() {
    this.counter.resetAll();
    this.smoother.reset();
    this.side = null;
  }

  update(landmarks, W, H, t) {
    const locked = this.counter.inRep ? this.side : null;
    const m = measureFrame(this.exId, landmarks, W, H, locked, this.side);
    let smooth = null;
    if (m.valid) {
      if (!locked && m.side !== this.side) {
        // left↔right is a different measurement → restart smoothing.
        // 'both'↔single side is the same leg(s) averaged or not → keep it.
        const flipped = this.side && this.side !== 'both' && m.side !== 'both';
        if (flipped || !this.side) this.smoother.reset();
        this.side = m.side;
      }
      // When locked to 'both' and one side drops out, measureFrame returns the
      // remaining side — a subset of the locked pair, never the opposite side.
      smooth = this.smoother.update(m.raw, t);
    }
    const before = this.counter.state;
    const res = this.counter.update({ t, valid: m.valid, value: smooth, aux: m.aux });
    if (res.event === 'lost' || res.event === 'gap') {
      this.smoother.reset();
      this.side = null;
    }
    let message = m.message;
    if (m.valid && res.state === STATES.WAITING) {
      if (smooth >= this.thresholds.topEnter) message = 'Hold still in the starting position…';
      else message = this.counter.reps > 0 || before !== STATES.WAITING
        ? 'Return to the starting position.'
        : this.ex.stateText[STATES.WAITING];
    }
    return {
      status: m.status,
      valid: m.valid,
      message,
      state: res.state,
      stateText: this.ex.stateText[res.state],
      event: res.event,
      reps: this.counter.reps,
      debug: { side: m.side ?? this.side, raw: m.raw, smooth, conf: m.conf, extra: m.extra },
    };
  }
}
