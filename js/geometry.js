// Geometry helpers. Pure functions, no DOM — unit-tested in tests/.

/**
 * Convert a MediaPipe normalized landmark (x,y in 0..1 of image width/height)
 * into pixel coordinates. Angles must be computed in pixel space: in a
 * 640x480 frame, a 0.1 step in x is 64px but a 0.1 step in y is 48px, so
 * angles computed from raw normalized values would be distorted.
 */
export function toPixel(lm, width, height) {
  return { x: lm.x * width, y: lm.y * height };
}

/** Interior angle ABC in degrees (0..180), with B as the vertex. */
export function angleDeg(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const magA = Math.hypot(abx, aby), magC = Math.hypot(cbx, cby);
  if (magA < 1e-6 || magC < 1e-6) return NaN;
  let cos = (abx * cbx + aby * cby) / (magA * magC);
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Angle of the segment a→b measured from horizontal, folded into 0..90°. */
export function inclinationDeg(a, b) {
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  if (dx < 1e-6 && dy < 1e-6) return NaN;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Frame-rate-independent exponential smoothing. The blend factor depends on
 * the real elapsed time, so 10 fps and 30 fps devices get the same lag.
 */
export class TimeSmoother {
  constructor(tauMs = 90) {
    this.tauMs = tauMs;
    this.reset();
  }
  reset() {
    this.value = null;
    this.lastT = null;
  }
  update(v, t) {
    if (!Number.isFinite(v)) return this.value;
    if (this.value === null || this.lastT === null || t <= this.lastT) {
      this.value = v;
    } else {
      const dt = t - this.lastT;
      const alpha = 1 - Math.exp(-dt / this.tauMs);
      this.value += alpha * (v - this.value);
    }
    this.lastT = t;
    return this.value;
  }
}

/**
 * Compute where the video content actually appears inside an element when
 * displayed with object-fit: contain or cover. Returns the drawn rectangle in
 * the element's CSS pixel space (may extend beyond the element for cover).
 */
export function fitRect(videoW, videoH, boxW, boxH, fit = 'contain') {
  if (!videoW || !videoH || !boxW || !boxH) return { x: 0, y: 0, w: boxW, h: boxH, scale: 1 };
  const scale = fit === 'cover'
    ? Math.max(boxW / videoW, boxH / videoH)
    : Math.min(boxW / videoW, boxH / videoH);
  const w = videoW * scale, h = videoH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, scale };
}
