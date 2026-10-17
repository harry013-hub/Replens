// Exercise definitions + per-frame measurement from pose landmarks.
// Pure logic, no DOM — unit-tested in tests/.
//
// Left/right below always mean the person's ANATOMICAL left/right as reported
// by MediaPipe on the raw (un-mirrored) camera frame. Mirroring the preview
// for the selfie camera is purely a display transform and never changes
// which landmark is "left".
//
// Thresholds are always stored in plain joint-angle degrees with the keys
//   topEnter   = "start position" (angle at which you are in the start pose)
//   topExit    = "leave start"
//   bottomExit = "leave end"
//   bottomEnter= "end position"  (the turnaround point of the rep)
// For push-ups, squats and curls the angle gets SMALLER from start to end.
// For the shoulder press it gets LARGER (bent at the shoulders → straight
// overhead), so that exercise is marked `invert` and the tracker negates
// angles and thresholds before feeding the same generic state machine.

import { toPixel, angleDeg, inclinationDeg, dist, TimeSmoother } from './geometry.js?v=20261017d';
import { RepCounter, STATES, DEFAULT_TIMING, validateThresholds } from './counter.js?v=20261017d';

export const LM = Object.freeze({
  nose: 0,
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
});

export const MIN_VISIBILITY = 0.5;
const FRAME_MARGIN = 0.02; // landmarks this far outside 0..1 are "out of frame"

export const EXERCISE_IDS = ['pushup', 'squat', 'curl', 'press'];

export const EXERCISES = Object.freeze({
  pushup: {
    id: 'pushup',
    name: 'Push-ups',
    singular: 'push-up',
    setupText:
      'Place your phone securely to your side. Keep your shoulders, elbows, wrists, hips, and ankles visible. A side view works best.',
    joints: ['shoulder', 'elbow', 'wrist', 'hip', 'ankle'],
    chain: ['wrist', 'elbow', 'shoulder', 'hip', 'ankle'],
    angleLabel: 'Elbow angle',
    invert: false,
    defaultThresholds: { topEnter: 155, topExit: 145, bottomExit: 110, bottomEnter: 100 },
    timing: { minRepIntervalMs: 450 },
    calibration: { start: 'Hold the top position, arms straight', end: 'Hold your comfortable lowered position' },
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
    chain: ['shoulder', 'hip', 'knee', 'ankle'],
    angleLabel: 'Knee angle',
    invert: false,
    defaultThresholds: { topEnter: 160, topExit: 150, bottomExit: 120, bottomEnter: 110 },
    timing: { minRepIntervalMs: 600 },
    calibration: { start: 'Stand comfortably, side-on', end: 'Lower to a comfortable position' },
    stateText: {
      [STATES.WAITING]: 'Stand tall to begin',
      [STATES.READY]: 'Ready',
      [STATES.DOWN]: 'Lowering',
      [STATES.BOTTOM]: 'Stand up',
      [STATES.UP]: 'Return to standing',
    },
  },
  curl: {
    id: 'curl',
    name: 'Bicep curls',
    singular: 'curl',
    setupText:
      'Stand side-on to the phone, about 2 m away, with your shoulders, elbows, wrists and hips visible. Curl with the arm nearest the camera, or both arms together.',
    joints: ['shoulder', 'elbow', 'wrist', 'hip'],
    chain: ['wrist', 'elbow', 'shoulder', 'hip'],
    angleLabel: 'Elbow angle',
    invert: false,
    defaultThresholds: { topEnter: 150, topExit: 140, bottomExit: 82, bottomEnter: 70 },
    timing: { minRepIntervalMs: 450 },
    calibration: { start: 'Arm straight down by your side', end: 'Curl up and hold' },
    stateText: {
      [STATES.WAITING]: 'Arms straight down to begin',
      [STATES.READY]: 'Ready',
      [STATES.DOWN]: 'Curling',
      [STATES.BOTTOM]: 'Lower',
      [STATES.UP]: 'Lower fully',
    },
  },
  press: {
    id: 'press',
    name: 'Shoulder press',
    singular: 'press',
    setupText:
      'Face the phone, about 2 m away, standing or seated. Keep your shoulders, elbows, wrists and hips visible with room above your head for your hands.',
    joints: ['shoulder', 'elbow', 'wrist', 'hip'],
    chain: ['wrist', 'elbow', 'shoulder', 'hip'],
    angleLabel: 'Elbow angle',
    invert: true, // angle increases from start (hands at shoulders) to end (overhead)
    defaultThresholds: { topEnter: 100, topExit: 110, bottomExit: 140, bottomEnter: 150 },
    timing: { minRepIntervalMs: 500 },
    calibration: { start: 'Hold the weights at your shoulders', end: 'Press overhead and hold' },
    stateText: {
      [STATES.WAITING]: 'Hands at shoulders to begin',
      [STATES.READY]: 'Ready',
      [STATES.DOWN]: 'Pressing',
      [STATES.BOTTOM]: 'Lower',
      [STATES.UP]: 'Back to shoulders',
    },
  },
});

/** Threshold labels as shown in Settings, in key order. */
export const THRESHOLD_LABELS = {
  topEnter: 'Start position °',
  topExit: 'Leave start °',
  bottomExit: 'Leave end °',
  bottomEnter: 'End position °',
};

/** Convert user-facing degree thresholds to the counter's internal space. */
export function toInternal(exId, th) {
  if (!EXERCISES[exId].invert) return { ...th };
  return { topEnter: -th.topEnter, topExit: -th.topExit, bottomExit: -th.bottomExit, bottomEnter: -th.bottomEnter };
}
export const fromInternal = toInternal; // negation is its own inverse

/** Validate user-facing thresholds for an exercise; returns an error string or null. */
export function validateExerciseThresholds(exId, th) {
  const vals = [th?.topEnter, th?.topExit, th?.bottomExit, th?.bottomEnter];
  if (!vals.every(Number.isFinite)) return 'All thresholds must be numbers.';
  if (vals.some((n) => n < 20 || n > 180)) return 'Thresholds must be between 20° and 180°.';
  const err = validateThresholds(toInternal(exId, th));
  if (!err) return null;
  return EXERCISES[exId].invert
    ? `${err.replace('above', 'beyond')} (for this exercise the angle increases from start to end)`
    : err;
}

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
// The posture checks below only tell an exercise apart from look-alike
// movements. They are loose on purpose and are NOT form judgements.

function measurePushupSide(p) {
  const value = angleDeg(p.shoulder, p.elbow, p.wrist);
  const torso = dist(p.shoulder, p.hip);
  const bodyIncl = inclinationDeg(p.shoulder, p.ankle); // 0 = horizontal
  const bodyLine = angleDeg(p.shoulder, p.hip, p.ankle); // 180 = straight
  const armLen = dist(p.shoulder, p.elbow) + dist(p.elbow, p.wrist);
  let postureMsg = null;
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

function measureCurlSide(p) {
  const value = angleDeg(p.shoulder, p.elbow, p.wrist);
  const torso = dist(p.shoulder, p.hip);
  const torsoIncl = inclinationDeg(p.shoulder, p.hip); // 90 = upright
  let postureMsg = null;
  // Upright body with the upper arm hanging down: rules out push-ups, presses
  // and lying down. Elbow must stay below the shoulder.
  if (!(p.shoulder.y < p.hip.y && torsoIncl >= 55)) postureMsg = 'Stand or sit upright';
  else if (!(p.elbow.y > p.shoulder.y + 0.15 * torso)) postureMsg = 'Keep your upper arm by your side';
  return {
    value,
    aux: { wristDrop: torso > 1 ? (p.wrist.y - p.shoulder.y) / torso : null },
    postureMsg,
    extra: { torsoIncl },
  };
}

function measurePressSide(p) {
  const value = angleDeg(p.shoulder, p.elbow, p.wrist);
  const torso = dist(p.shoulder, p.hip);
  const torsoIncl = inclinationDeg(p.shoulder, p.hip);
  let postureMsg = null;
  // Upright, hands above the elbows (holding weights up). Arms hanging at the
  // sides therefore never look like a press.
  if (!(p.shoulder.y < p.hip.y && torsoIncl >= 55)) postureMsg = 'Stand or sit upright';
  else if (!(p.wrist.y < p.elbow.y)) postureMsg = 'Hold the weights at shoulder height';
  return {
    value,
    aux: { wristRise: torso > 1 ? (p.shoulder.y - p.wrist.y) / torso : null },
    postureMsg,
    extra: { torsoIncl },
  };
}

// Supporting checks for the END of a rep, relative to the user's own start
// position (refAux is captured while they hold the start position).
function confirmPushupBottom(aux, ref) {
  if (!aux || aux.drop == null || !ref || ref.drop == null) return true;
  // Shoulders must have come down toward the hands, not just the elbow bending.
  return aux.drop <= ref.drop * 0.85;
}
function confirmSquatBottom(aux, ref) {
  if (!aux || !ref || ref.torso == null || aux.hipY == null || ref.hipY == null) return true;
  // Hips must have actually moved down, not only the knee angle changing.
  return (aux.hipY - ref.hipY) / ref.torso >= 0.06;
}
function confirmCurlTop(aux, ref) {
  if (!aux || aux.wristDrop == null || !ref || ref.wristDrop == null) return true;
  // The hand must have actually risen toward the shoulder.
  return aux.wristDrop <= ref.wristDrop - 0.35;
}
function confirmPressTop(aux, ref) {
  if (!aux || aux.wristRise == null || !ref || ref.wristRise == null) return true;
  // The hands must have actually gone up, well above where they started.
  return aux.wristRise >= ref.wristRise + 0.2;
}

const SIDE_IMPL = {
  pushup: { measure: measurePushupSide, confirmEnd: confirmPushupBottom, allowBoth: false, agree: 20 },
  squat: { measure: measureSquatSide, confirmEnd: confirmSquatBottom, allowBoth: true, agree: 20 },
  curl: { measure: measureCurlSide, confirmEnd: confirmCurlTop, allowBoth: true, agree: 25 },
  press: { measure: measurePressSide, confirmEnd: confirmPressTop, allowBoth: true, agree: 25 },
};

function missingMessage(exId, missing, frameIssue) {
  if (frameIssue === 'too-close') return 'Move farther back.';
  if (frameIssue === 'too-far') return 'Move closer to the camera.';
  const has = (j) => missing.includes(j);
  if (exId === 'squat') {
    if (has('hip') || has('knee') || has('ankle')) return 'Keep your hips, knees, and ankles in frame.';
    return 'Keep your shoulders in frame.';
  }
  if (has('elbow')) return 'Keep your elbows visible.';
  if (has('wrist')) return exId === 'press' ? 'Keep your hands in frame — leave room above your head.' : 'Keep your hands visible.';
  if (has('shoulder')) return 'Keep your shoulders in frame.';
  return exId === 'pushup' ? 'Keep your hips and ankles in frame.' : 'Keep your hips in frame.';
}

/** Detect framing problems from where this exercise's joints fall in the image. */
function frameIssue(landmarks, joints) {
  const idx = joints.flatMap((j) => [LM.left[j], LM.right[j]]);
  const body = idx.map((i) => landmarks[i]).filter(Boolean);
  if (!body.length) return null;
  const xs = body.map((l) => l.x), ys = body.map((l) => l.y);
  const outCount = body.filter((l) => l.x < -FRAME_MARGIN || l.x > 1 + FRAME_MARGIN || l.y < -FRAME_MARGIN || l.y > 1 + FRAME_MARGIN).length;
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  if (outCount >= 2 || spanX > 0.95 || spanY > 0.95) return 'too-close';
  if (Math.max(spanX, spanY) < 0.15) return 'too-far';
  return null;
}

/**
 * Measure one frame for an exercise. Returned `raw` is the plain joint angle
 * in degrees (not inverted).
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
  const issue = frameIssue(landmarks, ex.joints);
  const conf = { left: L.conf, right: R.conf };

  const evalSide = (s) => {
    const m = impl.measure(pts(landmarks, s, ex.joints, W, H));
    return Number.isFinite(m.value) ? m : null;
  };

  let side = null;
  if (lockedSide === 'both') {
    side = L.ok && R.ok ? 'both' : L.ok ? 'left' : R.ok ? 'right' : null;
  } else if (lockedSide) {
    side = (lockedSide === 'left' ? L : R).ok ? lockedSide : null;
  } else if (impl.allowBoth && L.ok && R.ok) {
    side = 'both';
  } else {
    const best = L.score >= R.score ? L : R;
    const pref = preferredSide === 'left' ? L : preferredSide === 'right' ? R : null;
    // Hysteresis: stay on the previously used side unless the other is clearly better.
    side = pref && pref.ok && pref.score + 0.15 >= best.score ? pref.side : best.ok ? best.side : null;
  }

  if (!side) {
    const best = L.score >= R.score ? L : R;
    return {
      status: 'adjust', valid: false, conf, side: lockedSide,
      message: lockedSide && best.ok
        ? 'Tracking paused — body not clearly visible.'
        : missingMessage(exId, best.missing, issue),
    };
  }

  let m;
  if (side === 'both') {
    const ml = evalSide('left'), mr = evalSide('right');
    if (ml && mr && Math.abs(ml.value - mr.value) <= impl.agree) {
      m = {
        value: (ml.value + mr.value) / 2,
        aux: averageAux(ml.aux, mr.aux),
        postureMsg: ml.postureMsg && mr.postureMsg ? ml.postureMsg : null,
        extra: ml.extra,
      };
    } else {
      // Sides disagree (far side occluded, or one arm working): use the more
      // confident side — or for arm exercises, the arm that is clearly moving
      // is still a subset of the locked pair.
      side = L.score >= R.score ? 'left' : 'right';
      m = side === 'left' ? ml : mr;
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
    this.sign = this.ex.invert ? -1 : 1;
    this.smoother = new TimeSmoother(80);
    this._timing = timing;
    this.setThresholds(thresholds || this.ex.defaultThresholds);
    this.side = null;
  }

  /** @param th user-facing thresholds in degrees */
  setThresholds(th) {
    const reps = this.counter?.reps ?? 0;
    this.thresholds = { ...th };
    this.internal = toInternal(this.exId, th);
    this.counter = new RepCounter({
      ...DEFAULT_TIMING,
      ...this.ex.timing,
      ...this._timing,
      ...this.internal,
      confirmBottom: SIDE_IMPL[this.exId].confirmEnd,
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
        // 'both'↔single side is the same limb(s) averaged or not → keep it.
        const flipped = this.side && this.side !== 'both' && m.side !== 'both';
        if (flipped || !this.side) this.smoother.reset();
        this.side = m.side;
      }
      smooth = this.smoother.update(this.sign * m.raw, t);
    }
    const before = this.counter.state;
    const res = this.counter.update({ t, valid: m.valid, value: smooth, aux: m.aux });
    if (res.event === 'lost' || res.event === 'gap') {
      this.smoother.reset();
      this.side = null;
    }
    let message = m.message;
    if (m.valid && res.state === STATES.WAITING) {
      if (smooth >= this.internal.topEnter) message = 'Hold still in the starting position…';
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
      debug: { side: m.side ?? this.side, raw: m.raw, smooth: smooth == null ? null : this.sign * smooth, conf: m.conf, extra: m.extra },
    };
  }
}
