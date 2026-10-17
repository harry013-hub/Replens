import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../js/storage.js';

class Mem {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
class Broken { getItem() { throw new Error('x'); } setItem() { throw new Error('quota'); } removeItem() {} }

const sess = (exercise, reps) => ({ exercise, reps, durationMs: 60000, startedAt: 1, endedAt: 2 });

test('sessions persist across instances and totals stay separate per exercise', () => {
  const mem = new Mem();
  const a = new Store(mem);
  a.addSession(sess('pushup', 10));
  a.addSession(sess('squat', 7));
  a.addSession(sess('pushup', 5));
  const b = new Store(mem);
  assert.equal(b.sessions.length, 3);
  assert.deepEqual(b.totals(), { pushup: 15, squat: 7, curl: 0, press: 0 });
});

test('only summaries are stored — no extra fields leak in', () => {
  const mem = new Mem();
  const s = new Store(mem);
  s.addSession({ ...sess('pushup', 3), landmarks: [[1, 2, 3]], video: 'blob:...' });
  const raw = mem.getItem('replens.v1');
  assert.ok(!raw.includes('landmarks') && !raw.includes('blob:'));
});

test('correction updates reps but keeps the detected count', () => {
  const s = new Store(new Mem());
  const r = s.addSession(sess('squat', 8));
  s.updateSession(r.id, { reps: 9 });
  assert.equal(s.sessions[0].reps, 9);
  assert.equal(s.sessions[0].detectedReps, 8);
  s.updateSession(r.id, { reps: -4 });
  assert.equal(s.sessions[0].reps, 0);
});

test('clear history', () => {
  const mem = new Mem();
  const s = new Store(mem);
  s.addSession(sess('pushup', 1));
  s.clearHistory();
  assert.equal(new Store(mem).sessions.length, 0);
});

test('unavailable storage falls back to memory without throwing', () => {
  const s = new Store(new Broken());
  assert.equal(s.persistent, false);
  s.addSession(sess('pushup', 4));
  assert.equal(s.totals().pushup, 4);
  const n = new Store(null);
  assert.equal(n.persistent, false);
});

test('corrupt saved data is ignored safely', () => {
  const mem = new Mem();
  mem.setItem('replens.v1', '{not json');
  const s = new Store(mem);
  assert.equal(s.sessions.length, 0);
  assert.equal(s.prefs.sound, true);
});
