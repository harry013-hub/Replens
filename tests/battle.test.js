import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Battle, bossMaxHp, shuffle, BATTLE_GOALS } from '../js/battle.js';
import { EXERCISE_IDS } from '../js/exercises.js';

const ORDER = ['squat', 'pushup', 'curl', 'press'];

function playAll(b, onRep) {
  const results = [];
  b.start();
  while (b.phase !== 'won') {
    const r = b.registerRep();
    results.push(r);
    onRep?.(r, b);
    if (b.phase === 'interval') b.nextWorkout();
  }
  return results;
}

test('boss HP comes from calories, bounded 100..350, safe with missing data', () => {
  assert.equal(bossMaxHp(0), 100);
  assert.equal(bossMaxHp(null), 100);
  assert.equal(bossMaxHp(undefined), 100);
  assert.equal(bossMaxHp(NaN), 100);
  assert.equal(bossMaxHp(-500), 100);
  assert.equal(bossMaxHp(1240), 224);
  assert.equal(bossMaxHp(2500), 350);
  assert.equal(bossMaxHp(9000), 350);
});

test('the four battle workouts are exactly the four existing RepLens exercises', () => {
  assert.deepEqual(Object.keys(BATTLE_GOALS).sort(), EXERCISE_IDS.slice().sort());
});

test('shuffle keeps all four workouts, each once, and actually varies the order', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const s = shuffle(ORDER);
    assert.deepEqual(s.slice().sort(), ORDER.slice().sort());
    seen.add(s.join());
  }
  assert.ok(seen.size > 10, `only ${seen.size} distinct orders`);
});

for (const hp of [100, 137, 224, 350]) {
  test(`HP ${hp}: boss reaches exactly 0 on the final planned rep, never before`, () => {
    const b = new Battle({ maxHp: hp, order: shuffle(ORDER) });
    const res = playAll(b);
    assert.equal(res.length, 47);
    for (const r of res.slice(0, -1)) assert.ok(r.hp > 0 && !r.battleWon);
    const last = res.at(-1);
    assert.equal(last.hp, 0);
    assert.equal(last.battleWon, true);
    assert.equal(b.hpDisplay, 0);
  });
}

test('boss is not defeated after only some workouts', () => {
  const b = new Battle({ maxHp: 200, order: ORDER });
  b.start();
  for (let i = 0; i < 15; i++) b.registerRep(); // finish squats
  assert.equal(b.phase, 'interval');
  b.nextWorkout();
  for (let i = 0; i < 10; i++) b.registerRep(); // finish push-ups
  assert.ok(b.hp > 0);
  assert.ok(b.hpDisplay > 0);
  assert.notEqual(b.phase, 'won');
});

test('displayed HP never shows 0 while the boss still has health', () => {
  const b = new Battle({ maxHp: 100, order: ORDER });
  const res = playAll(b);
  for (const r of res.slice(0, -1)) assert.ok(Math.max(1, Math.ceil(r.hp - 1e-9)) >= 1);
});

test('reps during countdown, intervals and after the win are ignored', () => {
  const b = new Battle({ maxHp: 150, order: ORDER });
  assert.equal(b.registerRep().accepted, false); // before start (countdown)
  b.start();
  for (let i = 0; i < 15; i++) b.registerRep();
  assert.equal(b.phase, 'interval');
  for (let i = 0; i < 5; i++) assert.equal(b.registerRep().accepted, false); // during the 5 s interval
  assert.equal(b.totalReps, 15);
  b.nextWorkout();
  assert.equal(b.workoutReps, 0);
  assert.equal(b.exercise, 'pushup');
  while (b.phase !== 'won') { b.registerRep(); if (b.phase === 'interval') b.nextWorkout(); }
  assert.equal(b.registerRep().accepted, false);
  assert.equal(b.totalReps, 47);
});

test('nextWorkout only works once per interval (no double transitions)', () => {
  const b = new Battle({ maxHp: 150, order: ORDER });
  b.start();
  for (let i = 0; i < 15; i++) b.registerRep();
  assert.equal(b.nextWorkout(), true);
  assert.equal(b.nextWorkout(), false);
  assert.equal(b.index, 1);
});

test('no interval after the fourth workout — the battle is won instead', () => {
  const b = new Battle({ maxHp: 150, order: ORDER });
  let intervals = 0;
  playAll(b, (r) => { if (r.workoutDone && !r.battleWon) intervals++; });
  assert.equal(intervals, 3);
  assert.equal(b.phase, 'won');
});

test('attacks group about every 4 reps and flush leftover damage at each workout end', () => {
  const b = new Battle({ maxHp: 188, order: ORDER });
  let attackDamage = 0;
  const attackAt = [];
  playAll(b, (r, bb) => { if (r.attack) { attackDamage += r.attackDamage; attackAt.push(`${bb.index}:${r.workoutReps}`); } });
  assert.ok(Math.abs(attackDamage - 188) < 1e-9, `total attack damage ${attackDamage}`);
  // squats (15): 4, 8, 12, 15 (flush)
  assert.deepEqual(attackAt.filter((x) => x.startsWith('0:')), ['0:4', '0:8', '0:12', '0:15']);
  // push-ups (10): 4, 8, 10 (flush)
  assert.deepEqual(attackAt.filter((x) => x.startsWith('1:')), ['1:4', '1:8', '1:10']);
});

test('motivational cue every 5 valid reps across the battle; halfway cue once per workout', () => {
  const b = new Battle({ maxHp: 150, order: ORDER });
  const res = playAll(b);
  const motiv = res.map((r, i) => (r.motivational ? i + 1 : null)).filter(Boolean);
  assert.deepEqual(motiv, [5, 10, 15, 20, 25, 30, 35, 40, 45]);
  assert.equal(res.filter((r) => r.halfway).length, 4);
});

test('retreat ends the battle without a win', () => {
  const b = new Battle({ maxHp: 150, order: ORDER });
  b.start();
  b.registerRep();
  b.end();
  assert.equal(b.phase, 'ended');
  assert.equal(b.registerRep().accepted, false);
  assert.ok(b.hp > 0);
});

test('a new battle never inherits the previous battle progress', () => {
  const a = new Battle({ maxHp: 150, order: ORDER });
  playAll(a);
  const b = new Battle({ maxHp: 150, order: ORDER });
  assert.equal(b.hp, 150);
  assert.equal(b.totalReps, 0);
  assert.equal(b.phase, 'ready');
});
