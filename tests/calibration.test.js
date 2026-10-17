import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveThresholds } from '../js/calibration.js';
import { validateThresholds } from '../js/counter.js';

const hold = (v, n = 20, spread = 2, validEvery = 1) =>
  Array.from({ length: n }, (_, i) => ({ valid: i % validEvery === 0, value: v + ((i % 5) - 2) * (spread / 2) }));

test('good calibration yields ordered, separated thresholds inside the user range', () => {
  const r = deriveThresholds(hold(172), hold(95));
  assert.equal(r.ok, true);
  const th = r.thresholds;
  assert.equal(validateThresholds(th), null);
  assert.ok(th.topEnter < 172 && th.bottomEnter > 95);
});

test('shallow but distinct comfortable depth is accepted (no depth pressure)', () => {
  const r = deriveThresholds(hold(174), hold(130));
  assert.equal(r.ok, true);
  assert.equal(validateThresholds(r.thresholds), null);
});

test('positions too similar are rejected', () => {
  const r = deriveThresholds(hold(170), hold(150));
  assert.equal(r.ok, false);
  assert.match(r.error, /too similar/);
});

test('poor tracking is rejected', () => {
  const r = deriveThresholds(hold(170, 20, 2, 3), hold(95));
  assert.equal(r.ok, false);
  assert.match(r.error, /Top position/);
});

test('unsteady measurements are rejected', () => {
  const r = deriveThresholds(hold(170), hold(100, 20, 40));
  assert.equal(r.ok, false);
  assert.match(r.error, /unsteady/);
});

test('too few samples are rejected', () => {
  assert.equal(deriveThresholds(hold(170, 4), hold(95)).ok, false);
});
