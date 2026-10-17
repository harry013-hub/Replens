import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepCounter, STATES, validateThresholds, DEFAULT_TIMING } from '../js/counter.js';
import { timeline, repKeyframes } from './synth.js';

const TH = { topEnter: 155, topExit: 145, bottomExit: 110, bottomEnter: 100 };
const mk = (extra = {}) => new RepCounter({ ...DEFAULT_TIMING, ...TH, ...extra });

function run(counter, samples, opts = {}) {
  const events = [];
  for (const s of samples) {
    const valid = opts.invalidWhen ? !opts.invalidWhen(s.t) : true;
    const r = counter.update({ t: s.t + (opts.offset || 0), valid, value: valid ? s.angle : null });
    if (r.event) events.push(r.event);
  }
  return events;
}

test('one complete rep counts exactly once', () => {
  const c = mk();
  const ev = run(c, timeline(repKeyframes(1), 30));
  assert.equal(c.reps, 1);
  assert.deepEqual(ev.filter((e) => e === 'rep').length, 1);
  assert.equal(c.state, STATES.READY);
});

test('multiple complete reps', () => {
  const c = mk();
  run(c, timeline(repKeyframes(7), 30));
  assert.equal(c.reps, 7);
});

test('partial movement (does not reach bottom) is not counted', () => {
  const c = mk();
  const ev = run(c, timeline([[0, 170], [1000, 170], [1600, 120], [2200, 170], [2700, 170]], 30));
  assert.equal(c.reps, 0);
  assert.ok(ev.includes('partial'));
});

test('holding the top never adds reps', () => {
  const c = mk();
  run(c, timeline([[0, 170], [20000, 170]], 30, 3));
  assert.equal(c.reps, 0);
  assert.equal(c.state, STATES.READY);
});

test('holding the bottom does not duplicate; rep counts once on return', () => {
  const c = mk();
  run(c, timeline([[0, 170], [1000, 170], [1700, 80], [9000, 80], [9700, 170], [10300, 170]], 30, 3));
  assert.equal(c.reps, 1);
});

test('jitter hovering around the top thresholds does not count', () => {
  const c = mk();
  // value wanders 140..160 for a long time: crosses topExit and topEnter repeatedly but never bottom
  run(c, timeline([[0, 170], [1000, 170], [1200, 150], [15000, 150]], 30, 10));
  assert.equal(c.reps, 0);
});

test('jitter hovering around the bottom thresholds counts one rep, not many', () => {
  const c = mk();
  run(c, timeline([[0, 170], [1000, 170], [1600, 105], [8000, 105], [8700, 170], [9300, 170]], 30, 8));
  assert.equal(c.reps, 1);
});

test('reps with realistic jitter count exactly', () => {
  const c = mk();
  run(c, timeline(repKeyframes(10), 30, 4));
  assert.equal(c.reps, 10);
});

test('starting in the lowered position does not produce an initial rep', () => {
  const c = mk();
  run(c, timeline([[0, 80], [2000, 80], [2700, 170], [4000, 170]], 30));
  assert.equal(c.reps, 0);
  assert.equal(c.state, STATES.READY);
  // a full rep after that counts
  run(c, timeline(repKeyframes(1, { startHold: 0 }), 30), { offset: 4100 });
  assert.equal(c.reps, 1);
});

test('low-confidence samples in mid-rep beyond the grace period discard the movement', () => {
  const c = mk();
  const kf = repKeyframes(1); // bottom roughly 1700..1850
  const ev = run(c, timeline(kf, 30), { invalidWhen: (t) => t > 1750 && t < 2300 });
  assert.equal(c.reps, 0);
  assert.ok(ev.includes('lost'));
});

test('a brief dropout shorter than the grace period does not lose the rep', () => {
  const c = mk();
  run(c, timeline(repKeyframes(1), 30), { invalidWhen: (t) => t > 1750 && t < 1950 });
  assert.equal(c.reps, 1);
});

test('after tracking loss, counting resumes only after a stable start position', () => {
  const c = mk();
  run(c, timeline(repKeyframes(2), 30), { invalidWhen: (t) => t > 1750 && t < 2300 });
  // rep 1 lost; rep 2 (starting ~2950) needs startHold first: top hold of 400ms < 600ms startHold,
  // so the second rep is also not counted. Completed reps stay preserved (0 here).
  assert.equal(c.reps, 0);
  run(c, timeline(repKeyframes(2), 30), { offset: 10000 });
  assert.equal(c.reps, 2);
});

test('completed reps are preserved when tracking is lost', () => {
  const c = mk();
  run(c, timeline(repKeyframes(3), 30));
  assert.equal(c.reps, 3);
  run(c, timeline([[0, 170], [700, 80], [3000, 80]], 30), { offset: 20000, invalidWhen: (t) => t > 1000 });
  assert.equal(c.reps, 3);
  assert.equal(c.state, STATES.WAITING);
});

test('pause mid-rep: resetMovement discards the half rep; resuming at the bottom then rising does not count', () => {
  const c = mk();
  run(c, timeline([[0, 170], [1000, 170], [1700, 80]], 30));
  assert.equal(c.state, STATES.BOTTOM);
  c.resetMovement(); // pause
  run(c, timeline([[0, 80], [700, 170], [1500, 170]], 30), { offset: 60000 });
  assert.equal(c.reps, 0);
});

test('a long gap between samples (frozen camera / interruption) never counts across it', () => {
  const c = mk();
  run(c, timeline([[0, 170], [1000, 170], [1700, 80]], 30));
  const ev = run(c, timeline([[0, 80], [700, 170], [1500, 170]], 30), { offset: 5000 });
  assert.equal(c.reps, 0);
  assert.ok(ev.includes('gap'));
});

test('two completions closer than the minimum interval count once', () => {
  const c = mk({ minRepIntervalMs: 2000 });
  run(c, timeline(repKeyframes(2, { downMs: 250, upMs: 250, bottomHold: 60, topHold: 200 }), 30));
  assert.equal(c.reps, 1);
});

for (const fps of [6, 10, 15, 24, 30, 60]) {
  test(`frame-rate independence at ${fps} fps`, () => {
    const c = mk();
    run(c, timeline(repKeyframes(5), fps, 3));
    assert.equal(c.reps, 5);
  });
}

test('invalid samples never count', () => {
  const c = mk();
  run(c, timeline(repKeyframes(3), 30), { invalidWhen: () => true });
  assert.equal(c.reps, 0);
});

test('threshold validation enforces order and separation', () => {
  assert.equal(validateThresholds(TH), null);
  assert.ok(validateThresholds({ topEnter: 150, topExit: 152, bottomExit: 110, bottomEnter: 100 }));
  assert.ok(validateThresholds({ topEnter: 155, topExit: 145, bottomExit: 140, bottomEnter: 100 }));
  assert.ok(validateThresholds({ topEnter: 155, topExit: 145, bottomExit: 101, bottomEnter: 100 }));
  assert.throws(() => mk({ topEnter: 90 }));
});

test('supporting bottom check (confirmBottom) blocks reps when it fails', () => {
  const c = mk({ confirmBottom: () => false });
  run(c, timeline(repKeyframes(3), 30));
  assert.equal(c.reps, 0);
});
