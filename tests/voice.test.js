import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { VoicePlayer, VOICE_LINES, IDLE_EVERY_MS } from '../js/voice.js';

class FakeAudio {
  constructor() { this.listeners = {}; this.played = []; this.paused = true; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  play() { this.paused = false; this.played.push(this.src); return Promise.resolve(); }
  pause() { this.paused = true; }
  end() { this.paused = true; for (const fn of this.listeners.ended || []) fn(); }
}

function mk() {
  let t = 0;
  const audio = new FakeAudio();
  const v = new VoicePlayer({ createAudio: () => audio, now: () => t, random: () => 0 });
  return { v, audio, advance: (ms) => { t += ms; } };
}
const cat = (url) => Object.entries(VOICE_LINES).find(([, l]) => l.includes(url))?.[0];

test('every supplied audio file is mapped, and every mapped file exists', () => {
  const files = readdirSync(new URL('../assets/audio/', import.meta.url));
  const mapped = Object.values(VOICE_LINES).flat().map((u) => decodeURIComponent(u.split('/').pop()));
  assert.deepEqual(mapped.slice().sort(), files.slice().sort());
});

test('only one clip at a time: a lower-or-equal priority clip is dropped while busy', () => {
  const { v, audio } = mk();
  assert.equal(v.play('hit'), true);
  assert.equal(v.play('motivational'), false);
  assert.equal(v.play('idle'), false);
  assert.equal(audio.played.length, 1);
});

test('higher priority cuts in (countdown over idle; hit over motivational)', () => {
  const { v, audio } = mk();
  v.play('idle');
  assert.equal(v.play('countdown'), true);
  assert.equal(cat(audio.src), 'countdown');
  audio.end();
  v.play('motivational');
  assert.equal(v.play('hit'), true);
  assert.equal(cat(audio.src), 'hit');
});

test('the same line is never restarted while playing', () => {
  const { v } = mk();
  v.play('countdown');
  assert.equal(v.play('countdown'), false);
});

test('idle line about every 8 s, only when nothing else is playing', () => {
  const { v, audio, advance } = mk();
  v.startIdle();
  advance(IDLE_EVERY_MS - 100);
  assert.equal(v.tickIdle(), false);
  advance(200);
  assert.equal(v.tickIdle(), true);
  assert.equal(cat(audio.src), 'idle');
  assert.equal(v.tickIdle(), false); // busy
  audio.end();
  advance(3000);
  assert.equal(v.tickIdle(), false); // 8 s measured from the end of the last clip
  v.play('motivational'); audio.end();
  advance(IDLE_EVERY_MS - 1);
  assert.equal(v.tickIdle(), false);
  v.stopIdle();
  advance(20000);
  assert.equal(v.tickIdle(), false);
});

test('consecutive picks in a category avoid repeating the same line', () => {
  const { v, audio } = mk();
  v.play('motivational'); const a = audio.src; audio.end();
  v.play('motivational'); const b = audio.src; audio.end();
  assert.notEqual(a, b);
});

test('queued lines play right after the current one (used for victory sounds)', () => {
  const { v, audio } = mk();
  v.play('death');
  v.play('clapping', { queue: true });
  assert.equal(cat(audio.src), 'death');
  audio.end();
  assert.equal(cat(audio.src), 'clapping');
});

test('muted player plays nothing; stopAll clears everything', () => {
  const { v, audio } = mk();
  v.enabled = false;
  assert.equal(v.play('hit'), false);
  v.enabled = true;
  v.play('death'); v.play('clapping', { queue: true });
  v.stopAll();
  assert.equal(v.busy, false);
  audio.end();
  assert.equal(audio.played.length, 1);
});
