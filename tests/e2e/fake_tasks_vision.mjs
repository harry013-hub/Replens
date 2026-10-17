// TEST-ONLY stand-in for @mediapipe/tasks-vision, injected by the browser test
// (tests/e2e/browser_test.py) via request interception. It returns synthetic
// landmarks driven by window.__fakePose so the full UI pipeline (camera →
// engine → tracker → UI) can be exercised without the real model.
// It is never loaded by the real app.
import { pushupPose, squatPose } from '../synth.js';

export const FilesetResolver = {
  async forVisionTasks() { return { fake: true }; },
};

export class PoseLandmarker {
  static async createFromOptions(_vision, opts) {
    window.__fakeCreateOpts = opts;
    if (window.__failCreate) throw new Error('simulated init failure');
    return new PoseLandmarker();
  }
  detectForVideo(video, ts) {
    window.__fakeCalls = (window.__fakeCalls || 0) + 1;
    if (ts <= (this._last || 0)) throw new Error('timestamps must increase');
    this._last = ts;
    const p = window.__fakePose || { kind: 'none' };
    if (p.kind === 'none') return { landmarks: [] };
    const lm = p.kind === 'pushup' ? pushupPose(p.angle) : squatPose(p.angle);
    return { landmarks: [lm] };
  }
  close() {}
}
