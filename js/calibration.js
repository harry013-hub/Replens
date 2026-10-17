// Guided calibration: turn a user's own comfortable top and lowered positions
// into ordered thresholds. Pure logic — unit-tested in tests/.

import { validateThresholds } from './counter.js?v=20261017e';

export const CALIBRATION = Object.freeze({
  minSamples: 8,
  minValidRatio: 0.7,
  maxSpreadDeg: 15,   // interquartile range allowed while "holding still"
  minRangeDeg: 35,    // top and lowered positions must differ at least this much
});

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Summarise one held position. samples: [{ valid, value }] */
export function summarizeHold(samples) {
  const total = samples.length;
  const vals = samples.filter((s) => s.valid && Number.isFinite(s.value)).map((s) => s.value).sort((a, b) => a - b);
  if (total < CALIBRATION.minSamples || vals.length < CALIBRATION.minSamples) {
    return { ok: false, error: 'Not enough clear tracking. Make sure your whole body is visible and try again.' };
  }
  if (vals.length / total < CALIBRATION.minValidRatio) {
    return { ok: false, error: 'Tracking was unreliable. Check lighting and framing, then try again.' };
  }
  const spread = quantile(vals, 0.75) - quantile(vals, 0.25);
  if (spread > CALIBRATION.maxSpreadDeg) {
    return { ok: false, error: 'Measurements were unsteady. Hold the position still and try again.' };
  }
  return { ok: true, median: quantile(vals, 0.5), spread };
}

/**
 * Derive thresholds from the two held positions.
 * Thresholds sit a quarter of the way in from each end of the user's range,
 * with hysteresis gaps, and are always validated for order and separation.
 */
export function deriveThresholds(topSamples, lowSamples) {
  const top = summarizeHold(topSamples);
  if (!top.ok) return { ok: false, error: `Top position: ${top.error}` };
  const low = summarizeHold(lowSamples);
  if (!low.ok) return { ok: false, error: `Lowered position: ${low.error}` };
  const range = top.median - low.median;
  if (range < CALIBRATION.minRangeDeg) {
    return {
      ok: false,
      error: 'The two positions were too similar to tell apart. Try a slightly deeper comfortable position, or keep the default settings.',
    };
  }
  const r = (n) => Math.round(n);
  const topEnter = r(Math.min(top.median - 5, top.median - 0.2 * range));
  const bottomEnter = r(Math.max(low.median + 5, low.median + 0.2 * range));
  const hyst = Math.max(5, Math.min(10, r(range * 0.1)));
  const th = { topEnter, topExit: topEnter - hyst, bottomExit: bottomEnter + hyst, bottomEnter };
  const err = validateThresholds(th);
  if (err) return { ok: false, error: `Could not build reliable thresholds (${err}) Keep the default settings.` };
  return { ok: true, thresholds: th, topMedian: top.median, lowMedian: low.median };
}
