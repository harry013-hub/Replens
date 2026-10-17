import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExerciseTracker, measureFrame } from '../js/exercises.js';
import { angleDeg } from '../js/geometry.js';
import { pushupPose, squatPose, standingArmBend, timeline, repKeyframes } from './synth.js';

function feed(tracker, samples, poseFn, W, H, { offset = 0, maskWhen } = {}) {
  const events = [];
  for (const s of samples) {
    let lm = poseFn(s.angle, s.t);
    if (maskWhen && maskWhen(s.t)) lm = null;
    const r = tracker.update(lm, W, H, s.t + offset);
    if (r.event) events.push(r.event);
  }
  return events;
}

test('angles are computed in pixel space, not distorted normalized space', () => {
  const lm = pushupPose(90, { W: 640, H: 480 });
  const m = measureFrame('pushup', lm, 640, 480);
  assert.equal(m.valid, true);
  assert.ok(Math.abs(m.raw - 90) < 0.5, `got ${m.raw}`);
  // The naive normalized computation would be wrong for a 4:3 frame:
  const naive = angleDeg(lm[11], lm[13], lm[15]);
  assert.ok(Math.abs(naive - 90) > 3, `naive=${naive}`);
});

test('push-up tracker counts reps from synthetic side-view landmarks', () => {
  const t = new ExerciseTracker('pushup');
  feed(t, timeline(repKeyframes(4, { top: 172, bottom: 75 }), 20, 3), (a) => pushupPose(a), 640, 480);
  assert.equal(t.reps, 4);
});

test('push-up uses the visible (near) side when the far side is low confidence', () => {
  const m = measureFrame('pushup', pushupPose(120), 640, 480);
  assert.equal(m.side, 'left');
});

test('standing elbow bends are never counted as push-ups', () => {
  const t = new ExerciseTracker('pushup');
  const res = [];
  for (const s of timeline(repKeyframes(5, { top: 175, bottom: 60 }), 30)) {
    res.push(t.update(standingArmBend(s.angle), 480, 640, s.t));
  }
  assert.equal(t.reps, 0);
  assert.equal(res.at(-1).status, 'adjust');
});

test('push-up side is locked mid-rep: a side swap discards the rep instead of mixing sides', () => {
  const t = new ExerciseTracker('pushup');
  const samples = timeline(repKeyframes(1, { top: 172, bottom: 75 }), 30);
  // Between 1300ms and 2200ms the near (left) side becomes invisible and the right side clear.
  feed(t, samples, (a, time) =>
    time > 1300 && time < 2200 ? pushupPose(a, { vis: 0.2, farVis: 0.95 }) : pushupPose(a), 640, 480);
  assert.equal(t.reps, 0);
});

test('push-up: tracking loss halfway through is not counted, later reps are', () => {
  const t = new ExerciseTracker('pushup');
  const kf = repKeyframes(1, { top: 172, bottom: 75 });
  const ev = feed(t, timeline(kf, 30), (a) => pushupPose(a), 640, 480, { maskWhen: (x) => x > 1500 && x < 2300 });
  assert.equal(t.reps, 0);
  assert.ok(ev.includes('lost'));
  feed(t, timeline(repKeyframes(2, { top: 172, bottom: 75 }), 30), (a) => pushupPose(a), 640, 480, { offset: 10000 });
  assert.equal(t.reps, 2);
});

test('squat tracker counts standing→lowered→standing cycles', () => {
  const t = new ExerciseTracker('squat');
  feed(t, timeline(repKeyframes(5, { top: 176, bottom: 85, downMs: 900, upMs: 900 }), 15, 3), (a) => squatPose(a), 480, 640);
  assert.equal(t.reps, 5);
});

test('squat: small knee movements and standing still are not reps', () => {
  const t = new ExerciseTracker('squat');
  feed(t, timeline([[0, 176], [1000, 176], [1500, 150], [2000, 176], [2500, 140], [3000, 176], [8000, 176]], 30, 3),
    (a) => squatPose(a), 480, 640);
  assert.equal(t.reps, 0);
});

test('squat: knee angle change without the hips lowering is rejected by the supporting check', () => {
  const t = new ExerciseTracker('squat');
  feed(t, timeline(repKeyframes(3, { top: 176, bottom: 85 }), 30), (a) => squatPose(a, { freezeHip: true }), 480, 640);
  assert.equal(t.reps, 0);
});

test('squat: entering the camera view (not detected → standing) does not count', () => {
  const t = new ExerciseTracker('squat');
  feed(t, timeline([[0, 176], [3000, 176]], 30), (a) => squatPose(a), 480, 640, { maskWhen: (x) => x < 1500 });
  assert.equal(t.reps, 0);
});

test('squat: starting at the bottom does not produce an initial rep', () => {
  const t = new ExerciseTracker('squat');
  feed(t, timeline([[0, 85], [2000, 85], [2900, 176], [4000, 176]], 30), (a) => squatPose(a), 480, 640);
  assert.equal(t.reps, 0);
});

test('squat: uses both sides when both are confident and agree', () => {
  const m = measureFrame('squat', squatPose(120), 480, 640);
  assert.equal(m.side, 'both');
  const m2 = measureFrame('squat', squatPose(120, { farVis: 0.2 }), 480, 640);
  assert.equal(m2.side, 'left');
});

test('camera switch / pause: resetMovement mid-rep discards the incomplete rep', () => {
  const t = new ExerciseTracker('squat');
  const kf = repKeyframes(1, { top: 176, bottom: 85 });
  for (const s of timeline(kf, 30)) {
    if (s.t > 1800 && t.counter.inRep && !t._didReset) { t.resetMovement(); t._didReset = true; }
    t.update(squatPose(s.angle), 480, 640, s.t);
  }
  assert.equal(t.reps, 0);
});

test('switching exercises: a squat tracker does not count push-up movements', () => {
  const sq = new ExerciseTracker('squat');
  feed(sq, timeline(repKeyframes(3, { top: 172, bottom: 75 }), 30), (a) => pushupPose(a), 640, 480);
  assert.equal(sq.reps, 0);
});

test('no pose → not detected status with a clear message', () => {
  const t = new ExerciseTracker('pushup');
  const r = t.update(null, 640, 480, 0);
  assert.equal(r.status, 'none');
  assert.match(r.message, /not clearly visible/);
});

test('missing joints produce the right guidance', () => {
  const lm = squatPose(170);
  for (const i of [25, 26, 27, 28]) lm[i].visibility = 0.1;
  const m = measureFrame('squat', lm, 480, 640);
  assert.equal(m.valid, false);
  assert.match(m.message, /hips, knees, and ankles/);
  const p = pushupPose(170);
  p[13].visibility = 0.1; p[14].visibility = 0.1;
  assert.match(measureFrame('pushup', p, 640, 480).message, /elbows/);
});

test('too close: several joints outside the frame → "Move farther back."', () => {
  const lm = squatPose(170);
  for (const i of [27, 28, 25, 26]) lm[i].y = 1.15;
  assert.equal(measureFrame('squat', lm, 480, 640).message, 'Move farther back.');
});

for (const fps of [8, 15, 30, 60]) {
  test(`push-up tracker frame-rate independence at ${fps} fps`, () => {
    const t = new ExerciseTracker('pushup');
    feed(t, timeline(repKeyframes(5, { top: 172, bottom: 75 }), fps, 2), (a) => pushupPose(a), 640, 480);
    assert.equal(t.reps, 5);
  });
}
