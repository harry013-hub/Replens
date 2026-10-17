// Synthetic landmark + angle-sequence generators for tests.
// These model idealised side-view poses. They test the LOGIC only — they are
// no substitute for real camera footage on a real phone.

const EMPTY = () => Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.1 }));

function put(arr, idx, p, W, H, vis) {
  arr[idx] = { x: p.x / W, y: p.y / H, z: 0, visibility: vis };
}

const L = { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 };
const R = { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 };

/** Floor push-up seen from the side, left side toward the camera. */
export function pushupPose(elbowDeg, { W = 640, H = 480, vis = 0.95, farVis = 0.3 } = {}) {
  const a = 70, b = 70; // upper arm, forearm (px)
  const th = (elbowDeg * Math.PI) / 180;
  const d = Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(th));
  const wrist = { x: 420, y: 400 };
  const shoulder = { x: 420, y: 400 - d };
  const h = Math.sqrt(Math.max(0, a * a - (d / 2) ** 2));
  const elbow = { x: 420 + h, y: 400 - d / 2 };
  const ankle = { x: 80, y: 400 };
  const hip = { x: (shoulder.x + ankle.x) / 2, y: (shoulder.y + ankle.y) / 2 };
  const knee = { x: (hip.x + ankle.x) / 2, y: (hip.y + ankle.y) / 2 };
  const lm = EMPTY();
  const pts = { shoulder, elbow, wrist, hip, knee, ankle };
  for (const k of Object.keys(pts)) {
    put(lm, L[k], pts[k], W, H, vis);
    put(lm, R[k], { x: pts[k].x + 4, y: pts[k].y - 3 }, W, H, farVis);
  }
  return lm;
}

/** Person standing upright and bending an elbow (curl) — must never count as a push-up. */
export function standingArmBend(elbowDeg, { W = 480, H = 640 } = {}) {
  const shoulder = { x: 240, y: 200 };
  const th = (elbowDeg * Math.PI) / 180;
  const elbow = { x: 240, y: 290 };
  // forearm rotates up from hanging straight down
  const beta = Math.PI - th; // 0 = hanging straight down
  const wrist = { x: 240 + 90 * Math.sin(beta), y: 290 + 90 * Math.cos(beta) };
  const hip = { x: 240, y: 380 }, knee = { x: 240, y: 480 }, ankle = { x: 240, y: 580 };
  const lm = EMPTY();
  const pts = { shoulder, elbow, wrist, hip, knee, ankle };
  for (const k of Object.keys(pts)) {
    put(lm, L[k], pts[k], W, H, 0.95);
    put(lm, R[k], pts[k], W, H, 0.95);
  }
  return lm;
}

/** Squat seen from the side. hipLowerFrac lets tests break the hip-drop support check. */
export function squatPose(kneeDeg, { W = 480, H = 640, vis = 0.95, farVis = 0.95, farOffset = 3, freezeHip = false } = {}) {
  const seg = 110;
  const phi = (((180 - kneeDeg) / 2) * Math.PI) / 180;
  const ankle = { x: 240, y: 600 };
  const knee = { x: ankle.x + seg * Math.sin(phi), y: ankle.y - seg * Math.cos(phi) };
  let hip = { x: knee.x - seg * Math.sin(phi), y: knee.y - seg * Math.cos(phi) };
  if (freezeHip) hip = { x: hip.x, y: ankle.y - 2 * seg }; // knee angle changes, hips don't drop
  const shoulder = { x: hip.x + 30, y: hip.y - 150 };
  const elbow = { x: shoulder.x + 40, y: shoulder.y + 40 };
  const wrist = { x: shoulder.x + 80, y: shoulder.y + 40 };
  const lm = EMPTY();
  const pts = { shoulder, elbow, wrist, hip, knee, ankle };
  for (const k of Object.keys(pts)) {
    put(lm, L[k], pts[k], W, H, vis);
    put(lm, R[k], { x: pts[k].x + farOffset, y: pts[k].y }, W, H, farVis);
  }
  return lm;
}

/**
 * Build a timeline of angles from keyframes [[timeMs, angle], ...] sampled at
 * `fps`, with optional deterministic jitter (±jitter degrees).
 */
export function timeline(keyframes, fps, jitter = 0, seed = 1) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const out = [];
  const end = keyframes[keyframes.length - 1][0];
  const dt = 1000 / fps;
  for (let t = 0; t <= end + 1e-9; t += dt) {
    let i = 0;
    while (i < keyframes.length - 2 && keyframes[i + 1][0] < t) i++;
    const [t0, a0] = keyframes[i], [t1, a1] = keyframes[i + 1];
    const f = t1 === t0 ? 1 : Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    out.push({ t, angle: a0 + (a1 - a0) * f + (jitter ? rand() * jitter : 0) });
  }
  return out;
}

/** Keyframes for n reps: hold top, go down over downMs, hold bottom, up over upMs. */
export function repKeyframes(n, { top = 170, bottom = 80, startHold = 1000, downMs = 700, bottomHold = 150, upMs = 700, topHold = 400 } = {}) {
  const k = [[0, top], [startHold, top]];
  let t = startHold;
  for (let i = 0; i < n; i++) {
    t += downMs; k.push([t, bottom]);
    t += bottomHold; k.push([t, bottom]);
    t += upMs; k.push([t, top]);
    t += topHold; k.push([t, top]);
  }
  return k;
}
