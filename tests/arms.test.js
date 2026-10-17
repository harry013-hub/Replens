import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExerciseTracker, measureFrame, validateExerciseThresholds, EXERCISES } from '../js/exercises.js';
import { curlPose, pressPose, pushupPose, squatPose, timeline, repKeyframes } from './synth.js';

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

// ---- bicep curls ----
test('curl: extended → curled → extended counts reps', () => {
  const t = new ExerciseTracker('curl');
  feed(t, timeline(repKeyframes(5, { top: 170, bottom: 45 }), 20, 3), (a) => curlPose(a), 480, 640);
  assert.equal(t.reps, 5);
});

test('curl: measured angle matches geometry in pixel space', () => {
  const m = measureFrame('curl', curlPose(90), 480, 640);
  assert.equal(m.valid, true);
  assert.ok(Math.abs(m.raw - 90) < 4, `got ${m.raw}`); // synthetic upper arm is tilted ~2.6°
});

test('curl: half curls (never reaching the curled position) are not counted', () => {
  const t = new ExerciseTracker('curl');
  feed(t, timeline(repKeyframes(4, { top: 170, bottom: 105 }), 30), (a) => curlPose(a), 480, 640);
  assert.equal(t.reps, 0);
});

test('curl: starting curled does not give a free rep', () => {
  const t = new ExerciseTracker('curl');
  feed(t, timeline([[0, 45], [2000, 45], [2700, 170], [4000, 170]], 30), (a) => curlPose(a), 480, 640);
  assert.equal(t.reps, 0);
});

test('curl: push-up and squat movements are not counted as curls', () => {
  const a = new ExerciseTracker('curl');
  feed(a, timeline(repKeyframes(3, { top: 172, bottom: 70 }), 30), (x) => pushupPose(x), 640, 480);
  assert.equal(a.reps, 0);
  const b = new ExerciseTracker('curl');
  feed(b, timeline(repKeyframes(3, { top: 176, bottom: 85 }), 30), (x) => squatPose(x), 480, 640);
  assert.equal(b.reps, 0);
});

test('curl: tracking loss mid-rep discards that rep only', () => {
  const t = new ExerciseTracker('curl');
  const ev = feed(t, timeline(repKeyframes(1, { top: 170, bottom: 45 }), 30), (a) => curlPose(a), 480, 640,
    { maskWhen: (x) => x > 1500 && x < 2300 });
  assert.equal(t.reps, 0);
  assert.ok(ev.includes('lost'));
  feed(t, timeline(repKeyframes(2, { top: 170, bottom: 45 }), 30), (a) => curlPose(a), 480, 640, { offset: 10000 });
  assert.equal(t.reps, 2);
});

for (const fps of [8, 15, 30, 60]) {
  test(`curl: frame-rate independence at ${fps} fps`, () => {
    const t = new ExerciseTracker('curl');
    feed(t, timeline(repKeyframes(4, { top: 170, bottom: 45 }), fps, 2), (a) => curlPose(a), 480, 640);
    assert.equal(t.reps, 4);
  });
}

// ---- shoulder press (angle increases during the working phase) ----
test('press: shoulders → overhead → shoulders counts reps', () => {
  const t = new ExerciseTracker('press');
  feed(t, timeline(repKeyframes(5, { top: 85, bottom: 170 }), 20, 3), (a) => pressPose(a), 640, 480);
  assert.equal(t.reps, 5);
});

test('press: uses both arms from a front view', () => {
  const m = measureFrame('press', pressPose(120), 640, 480);
  assert.equal(m.side, 'both');
  assert.ok(Math.abs(m.raw - 120) < 1.5, `got ${m.raw}`);
});

test('press: partial presses (not reaching overhead) are not counted', () => {
  const t = new ExerciseTracker('press');
  feed(t, timeline(repKeyframes(4, { top: 85, bottom: 130 }), 30), (a) => pressPose(a), 640, 480);
  assert.equal(t.reps, 0);
});

test('press: starting with arms overhead does not give a free rep', () => {
  const t = new ExerciseTracker('press');
  feed(t, timeline([[0, 170], [2000, 170], [2700, 85], [4000, 85]], 30), (a) => pressPose(a), 640, 480);
  assert.equal(t.reps, 0);
});

test('press: arms hanging at the sides are "adjust", never counted', () => {
  const t = new ExerciseTracker('press');
  let r;
  for (const s of timeline([[0, 0], [5000, 0]], 30)) r = t.update(pressPose(0, { hanging: true }), 640, 480, s.t);
  assert.equal(t.reps, 0);
  assert.equal(r.status, 'adjust');
  assert.match(r.message, /shoulder height/);
});

test('press: holding overhead adds nothing', () => {
  const t = new ExerciseTracker('press');
  feed(t, timeline([[0, 85], [1000, 85], [1700, 170], [9000, 170]], 30, 4), (a) => pressPose(a), 640, 480);
  assert.equal(t.reps, 0);
});

for (const fps of [8, 15, 30, 60]) {
  test(`press: frame-rate independence at ${fps} fps`, () => {
    const t = new ExerciseTracker('press');
    feed(t, timeline(repKeyframes(4, { top: 85, bottom: 170 }), fps, 2), (a) => pressPose(a), 640, 480);
    assert.equal(t.reps, 4);
  });
}

test('press: curls are not counted as presses', () => {
  const t = new ExerciseTracker('press');
  feed(t, timeline(repKeyframes(3, { top: 170, bottom: 45 }), 30), (a) => curlPose(a), 480, 640);
  assert.equal(t.reps, 0);
});

// ---- thresholds ----
test('every exercise default thresholds validate', () => {
  for (const id of Object.keys(EXERCISES)) assert.equal(validateExerciseThresholds(id, EXERCISES[id].defaultThresholds), null, id);
});

test('press thresholds must increase from start to end; push-up thresholds must decrease', () => {
  assert.ok(validateExerciseThresholds('press', { topEnter: 155, topExit: 145, bottomExit: 110, bottomEnter: 100 }));
  assert.ok(validateExerciseThresholds('pushup', { topEnter: 100, topExit: 110, bottomExit: 140, bottomEnter: 150 }));
  assert.ok(validateExerciseThresholds('curl', { topEnter: 150, topExit: 140, bottomExit: 82, bottomEnter: 10 }));
});
