// RepLens — UI orchestration. Wires camera → pose engine → exercise tracker → UI.

import { Camera, CameraError, cameraSupport, CAMERA_MESSAGES } from './camera.js';
import { PoseEngine } from './pose.js';
import { ExerciseTracker, EXERCISES, measureFrame } from './exercises.js';
import { STATES, validateThresholds } from './counter.js';
import { deriveThresholds } from './calibration.js';
import { Overlay } from './overlay.js';
import { Feedback } from './audio.js';
import { Store } from './storage.js';
import { SETUP_ILLUSTRATIONS } from './illustrations.js';
import { MEDIAPIPE_VERSION } from './config.js';

const $ = (id) => document.getElementById(id);
const body = document.body;

// Measured limb chains to highlight on the skeleton.
const CHAINS = {
  pushup: ['wrist', 'elbow', 'shoulder', 'hip', 'ankle'],
  squat: ['shoulder', 'hip', 'knee', 'ankle'],
};

const store = new Store();
const prefs = store.prefs;
const camera = new Camera($('video'));
const pose = new PoseEngine();
const overlay = new Overlay($('overlay'), $('video'));
const fx = new Feedback();

const app = {
  exercise: prefs.lastExercise === 'squat' ? 'squat' : 'pushup',
  phase: 'idle', // idle | setup | countdown | active | paused | finished
  tracker: null,
  session: null,
  countdownTimer: null,
  uiTimer: null,
  lastPoseAt: 0,
  lastResult: null,
  lastSession: null,
  wakeLock: null,
  devOn: false,
  calib: null,
  targetHit: false,
  transientUntil: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ts).toString();
  }
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function setScreen(name) {
  body.dataset.screen = name;
  window.scrollTo(0, 0);
}

function thresholdsFor(ex) {
  const saved = prefs.thresholds?.[ex];
  return saved && !validateThresholds(saved) ? saved : EXERCISES[ex].defaultThresholds;
}

const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
const EMBED_HINT = 'If this page is shown inside another app or preview, the camera may be blocked. Copy the link and open it directly in Safari (or Chrome on Android).';

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function renderHome() {
  document.querySelectorAll('.exercise-card').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.exercise === app.exercise));
  });
  const totals = store.totals();
  for (const ex of ['pushup', 'squat']) {
    const el = document.querySelector(`[data-total="${ex}"]`);
    el.textContent = `${totals[ex]} total reps`;
  }
  const target = prefs.target?.[app.exercise] || 0;
  $('target-value').textContent = target ? String(target) : 'Off';

  const list = $('history-list');
  list.textContent = '';
  const sessions = store.sessions.slice(0, 25);
  for (const s of sessions) {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.textContent = EXERCISES[s.exercise].name;
    title.style.fontWeight = '700';
    const reps = document.createElement('span');
    reps.className = 'h-reps';
    reps.textContent = `${s.reps}`;
    const meta = document.createElement('span');
    meta.className = 'h-meta';
    meta.textContent = `${fmtDate(s.startedAt)} · ${fmtDuration(s.durationMs)}${s.reps !== s.detectedReps ? ` · corrected (detected ${s.detectedReps})` : ''}`;
    li.append(title, reps, meta);
    list.append(li);
  }
  $('history-empty').hidden = sessions.length > 0;
  $('btn-clear-history').hidden = sessions.length === 0;
  $('storage-note').hidden = store.persistent;

  const sup = cameraSupport();
  const warn = $('env-warning');
  if (!sup.ok) {
    warn.hidden = false;
    warn.textContent = sup.kind === 'insecure'
      ? 'This page is not on HTTPS, so the browser will block the camera. Open the HTTPS version of the link. (A phone cannot use your computer’s http://192.168… address or “localhost” for the camera.)'
      : CAMERA_MESSAGES.unsupported;
  } else if (inIframe) {
    warn.hidden = false;
    warn.textContent = EMBED_HINT;
  } else {
    warn.hidden = true;
  }
}

function selectExercise(ex) {
  if (ex === app.exercise) return;
  app.exercise = ex;
  prefs.lastExercise = ex;
  store.setPref('lastExercise', ex);
  renderHome();
}

// ---------------------------------------------------------------------------
// Setup (camera + positioning)
// ---------------------------------------------------------------------------

function goSetup() {
  const ex = EXERCISES[app.exercise];
  app.phase = 'setup';
  setScreen('setup');
  $('setup-title').textContent = `${ex.name} setup`;
  $('setup-instruction').textContent = ex.setupText;
  $('setup-illus').innerHTML = SETUP_ILLUSTRATIONS[app.exercise];
  $('setup-panel').hidden = false;
  $('workout-controls').hidden = true;
  $('hud').hidden = true;
  $('paused-overlay').hidden = true;
  $('countdown').hidden = true;
  $('btn-calibrate').hidden = app.exercise !== 'squat';
  hideError();
  app.tracker = new ExerciseTracker(app.exercise, thresholdsFor(app.exercise));
  refreshCameraUi();
  // Start fetching the model in the background (no camera involved).
  ensureModel().catch(() => {});
}

function refreshCameraUi() {
  const on = camera.active;
  $('pre-camera').hidden = on;
  $('camera-controls').hidden = !on;
  $('stage-placeholder').hidden = on;
  $('track-chip').hidden = !(on && pose.ready);
  if (!(on && pose.ready)) $('guidance').hidden = true;
  $('mirror-wrap').classList.toggle('mirrored', on && camera.mirrored);
  $('btn-start').disabled = !(on && pose.ready);
  $('btn-calibrate').disabled = !(on && pose.ready);
}

function showError(msg, { retry, embedHint } = {}) {
  const box = $('cam-error');
  box.textContent = '';
  const p = document.createElement('p');
  p.style.margin = '0';
  p.textContent = msg;
  box.append(p);
  if (embedHint || inIframe) {
    const h = document.createElement('p');
    h.style.margin = '8px 0 0';
    h.textContent = EMBED_HINT;
    box.append(h);
  }
  if (retry) {
    const b = document.createElement('button');
    b.className = 'btn btn-secondary btn-small';
    b.style.marginTop = '10px';
    b.textContent = 'Try again';
    b.addEventListener('click', retry);
    box.append(b);
  }
  box.hidden = false;
  box.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}
function hideError() { $('cam-error').hidden = true; }

let modelPromise = null;
function ensureModel() {
  if (pose.ready) return Promise.resolve();
  if (modelPromise) return modelPromise;
  const label = { library: 'Downloading tracking library…', model: 'Downloading pose model…', init: 'Starting tracker…' };
  modelPromise = pose.load(({ phase, progress }) => {
    $('loading-text').textContent = label[phase] || 'Loading…';
    $('loading-bar').style.width = `${Math.round((progress || 0) * 100)}%`;
  }).then(() => {
    $('loading').hidden = true;
    refreshCameraUi();
    if (camera.active && (app.phase === 'setup' || app.phase === 'countdown' || app.phase === 'active')) startInference();
  }).catch((e) => {
    $('loading').hidden = true;
    if (app.phase === 'setup' || app.phase === 'paused') {
      showError(`${e.message || 'The tracking model failed to load.'}`, {
        retry: () => { hideError(); if (camera.active) $('loading').hidden = false; ensureModel().catch(() => {}); },
      });
    }
    throw e;
  }).finally(() => { modelPromise = null; });
  return modelPromise;
}

async function enableCamera() {
  fx.unlock(); // this is a user tap: unlock audio now (iOS requirement)
  hideError();
  const btn = $('btn-enable-camera');
  btn.disabled = true;
  btn.textContent = 'Starting camera…';
  try {
    await camera.open(prefs.facing === 'environment' ? 'environment' : 'user');
    app.tracker?.resetMovement();
    refreshCameraUi();
    const n = await camera.countCameras();
    $('btn-switch-setup').hidden = n < 2;
    $('btn-switch-workout').hidden = n < 2;
    if (!pose.ready) {
      $('loading').hidden = false;
      await ensureModel().catch(() => {});
    } else {
      startInference();
    }
  } catch (e) {
    const err = e instanceof CameraError ? e : new CameraError('unknown', CAMERA_MESSAGES.unknown, e);
    showError(err.message, { retry: err.kind !== 'insecure' && err.kind !== 'unsupported' ? enableCamera : null, embedHint: err.kind === 'denied' });
    refreshCameraUi();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enable Camera';
  }
}

function stopCamera() {
  stopInference();
  camera.stop();
  overlay.clear();
  app.tracker?.resetMovement();
  refreshCameraUi();
}

async function switchCamera() {
  if (!(app.phase === 'setup' || app.phase === 'paused')) return; // only when safely paused
  fx.unlock();
  stopInference();
  overlay.clear();
  app.tracker?.resetMovement(); // never count across a camera change
  try {
    await camera.switchFacing();
    store.setPref('facing', camera.facing);
    toast(camera.facing === 'user' ? 'Front camera' : 'Back camera');
  } catch (e) {
    toast(e.message || 'Could not switch camera.', 4000);
  }
  refreshCameraUi();
  if (app.phase === 'setup' && camera.active) startInference();
}

// ---------------------------------------------------------------------------
// Inference → tracker → UI
// ---------------------------------------------------------------------------

function startInference() {
  if (!pose.ready || !camera.active || document.hidden) return;
  if (pose.running) return;
  pose.start($('video'), onPose, onPoseFatal);
}

function stopInference() {
  pose.stop();
}

function onPoseFatal(err) {
  console.error(err);
  if (app.phase === 'active' || app.phase === 'countdown') pause('Tracking stopped because of an error. Tap Resume to retry.');
  else showError('Tracking stopped unexpectedly on this device.', { retry: () => { hideError(); startInference(); } });
}

function onPose({ landmarks, width, height, t }) {
  app.lastPoseAt = performance.now();
  const ex = app.exercise;
  let r;
  if (app.phase === 'active') {
    r = app.tracker.update(landmarks, width, height, t);
    handleEvent(r);
  } else {
    // Setup / countdown: guidance only, the counter is not fed.
    const m = measureFrame(ex, landmarks, width, height);
    r = { ...m, state: STATES.WAITING, stateText: null, debug: { side: m.side, raw: m.raw, conf: m.conf, extra: m.extra } };
    if (app.calib?.collecting) app.calib.samples.push({ valid: m.valid, value: m.raw });
    if (app.calib) $('calib-live').textContent = m.valid ? `${EXERCISES[ex].angleLabel}: ${Math.round(m.raw)}°` : (m.message || 'Not detected');
  }
  app.lastResult = r;
  overlay.draw(landmarks, { side: r.debug?.side, joints: CHAINS[ex] }, r.status);
  renderTracking(r);
}

function renderTracking(r) {
  const chip = $('track-chip');
  const labels = { good: 'Good', adjust: 'Adjust position', none: 'Not detected' };
  chip.dataset.status = r.status;
  $('track-label').textContent = labels[r.status];

  let msg = null;
  if (app.phase === 'setup') {
    msg = r.status === 'good' ? 'Looking good — tap Start Workout' : r.message;
  } else if (app.phase === 'active') {
    if (performance.now() < app.transientUntil) return; // keep a short-lived message visible
    if (r.status !== 'good' || r.state === STATES.WAITING) msg = r.message;
    $('hud-state').textContent = r.status === 'good' ? r.stateText : (r.status === 'none' ? 'Not detected' : 'Adjust position');
  } else if (app.phase === 'countdown') {
    msg = r.status === 'good' ? null : r.message;
  }
  const g = $('guidance');
  g.hidden = !msg;
  if (msg) g.textContent = msg;
}

function transient(msg, ms = 1400) {
  const g = $('guidance');
  g.textContent = msg;
  g.hidden = false;
  app.transientUntil = performance.now() + ms;
}

function handleEvent(r) {
  if (r.event === 'rep') {
    const el = $('rep-count');
    el.textContent = String(r.reps);
    el.classList.remove('bump');
    void el.offsetWidth; // restart animation
    el.classList.add('bump');
    fx.rep(r.reps);
    renderTarget(r.reps);
  } else if (r.event === 'partial') {
    transient(app.exercise === 'squat' ? 'Not counted — calibrate if your comfortable depth isn’t detected' : 'Not counted');
  } else if (r.event === 'lost' || r.event === 'gap') {
    transient('Tracking paused — body not clearly visible.', 1800);
  }
}

function renderTarget(reps) {
  const target = prefs.target?.[app.exercise] || 0;
  $('target-wrap').hidden = !target;
  if (!target) return;
  const pct = Math.min(100, Math.round((reps / target) * 100));
  $('target-text').textContent = `of ${target}`;
  $('target-fill').style.width = `${pct}%`;
  $('target-bar').setAttribute('aria-valuenow', String(pct));
  if (reps >= target && !app.targetHit) {
    app.targetHit = true;
    toast('🎯 Target reached!');
  }
}

// ---------------------------------------------------------------------------
// Workout lifecycle
// ---------------------------------------------------------------------------

function enterWorkoutUi() {
  setScreen('workout');
  $('setup-panel').hidden = true;
  $('workout-controls').hidden = false;
  $('hud').hidden = false;
  $('hud-exercise').textContent = EXERCISES[app.exercise].name;
  syncSoundButton();
  syncSkeletonButton();
}

function startWorkout() {
  if (!camera.active || !pose.ready) return;
  fx.unlock();
  app.tracker = new ExerciseTracker(app.exercise, thresholdsFor(app.exercise));
  app.session = { startedAt: Date.now(), activeMs: 0, activeSince: null };
  app.targetHit = false;
  $('rep-count').textContent = '0';
  $('hud-timer').textContent = '0:00';
  $('hud-state').textContent = '';
  renderTarget(0);
  enterWorkoutUi();
  requestWakeLock();
  startInference();
  runCountdown(5);
  clearInterval(app.uiTimer);
  app.uiTimer = setInterval(uiTick, 250);
}

function runCountdown(seconds) {
  app.phase = 'countdown';
  clearInterval(app.countdownTimer);
  setPauseButton(false);
  $('btn-switch-workout').disabled = true;
  $('paused-overlay').hidden = true;
  const box = $('countdown');
  let n = seconds;
  box.hidden = false;
  $('countdown-num').textContent = String(n);
  fx.tick();
  app.countdownTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      clearInterval(app.countdownTimer);
      app.countdownTimer = null;
      box.hidden = true;
      beginActive();
      return;
    }
    $('countdown-num').textContent = String(n);
    fx.tick();
  }, 1000);
}

function beginActive() {
  app.phase = 'active';
  app.tracker.resetMovement(); // nothing from setup/countdown carries over
  app.session.activeSince = performance.now();
  fx.go();
  startInference();
}

function activeMs() {
  const s = app.session;
  if (!s) return 0;
  return s.activeMs + (s.activeSince != null ? performance.now() - s.activeSince : 0);
}

function uiTick() {
  if (!app.session) return;
  $('hud-timer').textContent = fmtDuration(activeMs());
  // Watchdog: frames stopped arriving while active (frozen/interrupted video).
  if (app.phase === 'active' && performance.now() - app.lastPoseAt > 1500) {
    renderTracking({ status: 'none', message: 'Camera feed interrupted — waiting for video…', state: STATES.WAITING, stateText: '' });
  }
  if (app.devOn) renderDev();
}

function pause(reason = '') {
  if (!(app.phase === 'active' || app.phase === 'countdown')) return;
  if (app.countdownTimer) { clearInterval(app.countdownTimer); app.countdownTimer = null; $('countdown').hidden = true; }
  const s = app.session;
  if (s?.activeSince != null) { s.activeMs += performance.now() - s.activeSince; s.activeSince = null; }
  app.phase = 'paused';
  stopInference();               // no inference while paused
  app.tracker.resetMovement();   // discard any half rep
  overlay.clear();
  fx.stopAll();
  releaseWakeLock();
  $('paused-reason').textContent = reason || 'Tap Resume when you are ready. You will get a short countdown.';
  $('paused-overlay').hidden = false;
  $('hud-state').textContent = '';
  $('guidance').hidden = true;
  $('track-chip').hidden = true;
  $('btn-switch-workout').disabled = false;
  setPauseButton(true);
  uiTick();
}

async function resume() {
  if (app.phase !== 'paused') return;
  fx.unlock();
  if (!camera.active) {
    try {
      await camera.open(camera.facing);
      refreshCameraUi();
    } catch (e) {
      $('paused-reason').textContent = `${e.message} Then tap Resume again.`;
      return;
    }
  }
  if (!pose.ready) {
    try { $('loading').hidden = false; await ensureModel(); } catch { $('paused-reason').textContent = 'The tracking model is not available. Check your connection and tap Resume again.'; return; }
  }
  $('track-chip').hidden = false;
  $('mirror-wrap').classList.toggle('mirrored', camera.mirrored);
  app.tracker.resetMovement(); // require a stable start pose again
  requestWakeLock();
  startInference();
  runCountdown(3);
}

function setPauseButton(paused) {
  $('pause-label').textContent = paused ? 'Resume' : 'Pause';
  $('btn-pause').setAttribute('aria-label', paused ? 'Resume' : 'Pause');
  $('btn-pause').querySelector('.ctl-icon').textContent = paused ? '▶' : '❚❚';
  $('btn-switch-workout').setAttribute('aria-label', paused ? 'Switch camera' : 'Switch camera (pause first)');
}

function finish() {
  if (!app.session) return;
  if (app.countdownTimer) { clearInterval(app.countdownTimer); app.countdownTimer = null; }
  const s = app.session;
  if (s.activeSince != null) { s.activeMs += performance.now() - s.activeSince; s.activeSince = null; }
  clearInterval(app.uiTimer);
  app.phase = 'finished';
  stopInference();
  camera.stop();                 // release the camera completely
  overlay.clear();
  fx.stopAll();
  releaseWakeLock();
  const reps = app.tracker.reps;
  const rec = store.addSession({
    exercise: app.exercise, reps, detectedReps: reps, durationMs: s.activeMs,
    startedAt: s.startedAt, endedAt: Date.now(),
  });
  app.lastSession = rec;
  app.session = null;
  renderSummary();
  setScreen('summary');
}

function renderSummary() {
  const s = app.lastSession;
  $('sum-exercise').textContent = EXERCISES[s.exercise].name;
  $('sum-reps').textContent = String(s.reps);
  $('sum-reps-edit').textContent = String(s.reps);
  $('sum-duration').textContent = fmtDuration(s.durationMs);
  $('sum-date').textContent = fmtDate(s.startedAt);
  const c = $('sum-corrected');
  c.hidden = s.reps === s.detectedReps;
  c.textContent = `Corrected manually — RepLens detected ${s.detectedReps}.`;
  $('btn-rep-minus').disabled = s.reps <= 0;
  $('sum-storage').textContent = store.persistent
    ? 'Saved on this device only.'
    : 'History can’t be saved in this browser mode — this summary disappears when you close the page.';
}

function correctReps(delta) {
  const s = app.lastSession;
  if (!s) return;
  store.updateSession(s.id, { reps: s.reps + delta });
  renderSummary();
}

// ---------------------------------------------------------------------------
// Page lifecycle, interruptions, wake lock
// ---------------------------------------------------------------------------

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || app.wakeLock) return;
  try {
    app.wakeLock = await navigator.wakeLock.request('screen');
    app.wakeLock.addEventListener?.('release', () => { app.wakeLock = null; });
  } catch {
    app.wakeLock = null; // unsupported or refused (e.g. low power mode) — fine
  }
}
function releaseWakeLock() {
  try { app.wakeLock?.release(); } catch { /* ignore */ }
  app.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (app.phase === 'active' || app.phase === 'countdown') {
      pause('Paused because you left the app. Tap Resume when you are back in position.');
    }
    stopInference();
    fx.suspend();
    if (app.calib) cancelCalibration();
  } else {
    if (app.phase === 'setup') {
      if (camera.stream && !camera.active) { camera.stop(); showError(CAMERA_MESSAGES.interrupted + ' Tap Enable Camera to restart it.'); }
      refreshCameraUi();
      startInference();
    } else if (app.phase === 'paused' && !camera.active) {
      $('paused-reason').textContent = 'The camera was turned off while you were away. Tap Resume to reconnect.';
    }
  }
});

// Leaving the page: release everything.
window.addEventListener('pagehide', () => {
  stopInference();
  camera.stop();
  fx.stopAll();
  releaseWakeLock();
  if (app.phase === 'active' || app.phase === 'countdown') {
    // keep the state consistent if the page comes back from the back/forward cache
    pause('Paused because you left the page.');
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    refreshCameraUi();
    if (app.phase === 'paused') $('paused-reason').textContent = 'Tap Resume to reconnect the camera.';
  }
});

camera.onInterrupted = (reason) => {
  if (app.phase === 'active' || app.phase === 'countdown') {
    pause(`${CAMERA_MESSAGES.interrupted} Tap Resume to continue.`);
    if (reason === 'ended') camera.stop();
  } else if (app.phase === 'setup' && reason === 'ended') {
    stopCamera();
    showError(`${CAMERA_MESSAGES.interrupted} Tap Enable Camera to restart it.`);
  }
};

// ---------------------------------------------------------------------------
// Settings, calibration, dev panel
// ---------------------------------------------------------------------------

function openSheet(id) { $(id).hidden = false; }
function closeSheet(id) { $(id).hidden = true; }

function openSettings() {
  $('set-sound').checked = prefs.sound;
  $('set-volume').value = String(prefs.volume);
  $('set-speak').checked = prefs.speak;
  $('row-speak').hidden = !fx.speechSupported;
  $('set-skeleton').checked = prefs.skeleton;
  $('set-dev').checked = app.devOn;
  $('set-cpu').checked = !!prefs.forceCpu;
  $('th-ex-name').textContent = EXERCISES[app.exercise].name;
  fillThresholds(thresholdsFor(app.exercise));
  $('th-error').hidden = true;
  openSheet('settings');
}

function fillThresholds(th) {
  for (const k of ['topEnter', 'topExit', 'bottomExit', 'bottomEnter']) $(`th-${k}`).value = String(th[k]);
}

function saveThresholds(th) {
  const err = validateThresholds(th);
  if (err) { $('th-error').textContent = err; $('th-error').hidden = false; return false; }
  $('th-error').hidden = true;
  prefs.thresholds = { ...prefs.thresholds, [app.exercise]: th };
  store.setPref('thresholds', prefs.thresholds);
  app.tracker?.setThresholds(th); // also discards any half rep
  return true;
}

function applyFx() {
  fx.enabled = !!prefs.sound;
  fx.volume = Number(prefs.volume) || 0;
  fx.speak = !!prefs.speak;
  overlay.enabled = !!prefs.skeleton;
  if (!overlay.enabled) overlay.clear();
}

function syncSoundButton() {
  const b = $('btn-sound');
  b.setAttribute('aria-pressed', String(!!prefs.sound));
  b.setAttribute('aria-label', prefs.sound ? 'Sound on' : 'Sound off');
}
function syncSkeletonButton() {
  const b = $('btn-skeleton');
  b.setAttribute('aria-pressed', String(!!prefs.skeleton));
  b.setAttribute('aria-label', prefs.skeleton ? 'Skeleton overlay on' : 'Skeleton overlay off');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCalibration() {
  if (app.calib?.running) return;
  const c = { running: true, collecting: false, samples: [], cancelled: false };
  app.calib = c;
  $('calib-go').disabled = true;
  const bar = $('calib-bar');
  const say = (t) => { $('calib-text').textContent = t; };
  const collect = async (label) => {
    for (let i = 3; i > 0; i--) {
      if (c.cancelled) return null;
      say(`${label} — starting in ${i}…`);
      fx.tick();
      await sleep(1000);
    }
    say(`${label} — hold still…`);
    c.samples = [];
    c.collecting = true;
    const start = performance.now();
    while (performance.now() - start < 2000) {
      if (c.cancelled) return null;
      bar.style.width = `${Math.round(((performance.now() - start) / 2000) * 100)}%`;
      await sleep(100);
    }
    c.collecting = false;
    bar.style.width = '0%';
    fx.go();
    return c.samples.slice();
  };
  const top = await collect('Stand comfortably, side-on');
  const low = top && await collect('Lower to a comfortable position');
  c.running = false;
  $('calib-go').disabled = false;
  if (c.cancelled || !top || !low) return;
  const r = deriveThresholds(top, low);
  if (!r.ok) {
    say(`${r.error}`);
    $('calib-go').textContent = 'Try again';
    return;
  }
  saveThresholds(r.thresholds);
  closeSheet('calib');
  app.calib = null;
  toast(`Calibrated: standing ≈${Math.round(r.topMedian)}°, lowered ≈${Math.round(r.lowMedian)}°`, 4000);
}

function openCalibration() {
  if (!camera.active || !pose.ready) return;
  $('calib-text').textContent = 'Optional. Records your comfortable standing and lowered positions so counting fits your range. There is no “right” depth — pick what is comfortable. You will hear a beep at each step.';
  $('calib-go').textContent = 'Begin';
  $('calib-live').textContent = '';
  $('calib-bar').style.width = '0%';
  app.calib = { running: false, collecting: false, samples: [] };
  openSheet('calib');
}

function cancelCalibration() {
  if (app.calib) app.calib.cancelled = true;
  app.calib = null;
  closeSheet('calib');
}

function renderDev() {
  const r = app.lastResult;
  const st = pose.stats;
  const conf = r?.debug?.conf;
  const fmtConf = (o) => o ? Object.entries(o).map(([k, v]) => `${k.slice(0, 3)}:${v.toFixed(2)}`).join(' ') : '—';
  const th = app.tracker?.thresholds || thresholdsFor(app.exercise);
  $('dev-text').textContent = [
    `tasks-vision ${pose.libLabel || MEDIAPIPE_VERSION} · ${pose.delegate || '—'}`,
    `model: ${pose.modelLabel || '—'}`,
    `video: ${$('video').videoWidth}×${$('video').videoHeight} mirror:${camera.mirrored}`,
    `infer: ${st.inferenceMs.toFixed(1)} ms · every ${st.intervalMs.toFixed(0)} ms · ${st.fps.toFixed(1)} fps`,
    `phase: ${app.phase} · state: ${app.tracker?.state ?? '—'}`,
    `status: ${r?.status ?? '—'} · side: ${r?.debug?.side ?? '—'}`,
    `angle raw: ${r?.debug?.raw?.toFixed?.(1) ?? '—'} smooth: ${r?.debug?.smooth?.toFixed?.(1) ?? '—'}`,
    `th: top≥${th.topEnter} leave<${th.topExit} | up≥${th.bottomExit} bottom≤${th.bottomEnter}`,
    `L ${fmtConf(conf?.left)}`,
    `R ${fmtConf(conf?.right)}`,
    `reps: ${app.tracker?.reps ?? 0}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

document.querySelectorAll('.exercise-card').forEach((b) => b.addEventListener('click', () => selectExercise(b.dataset.exercise)));
document.querySelectorAll('[data-target-step]').forEach((b) => b.addEventListener('click', () => {
  const cur = prefs.target?.[app.exercise] || 0;
  const next = Math.max(0, Math.min(500, cur + Number(b.dataset.targetStep)));
  prefs.target = { ...prefs.target, [app.exercise]: next };
  store.setPref('target', prefs.target);
  renderHome();
}));

$('btn-continue').addEventListener('click', () => { fx.unlock(); goSetup(); });
$('btn-back').addEventListener('click', () => { stopCamera(); app.phase = 'idle'; renderHome(); setScreen('home'); });
$('btn-enable-camera').addEventListener('click', enableCamera);
$('btn-stop-camera').addEventListener('click', stopCamera);
$('btn-switch-setup').addEventListener('click', switchCamera);
$('btn-switch-workout').addEventListener('click', switchCamera);
$('btn-start').addEventListener('click', startWorkout);
$('btn-calibrate').addEventListener('click', openCalibration);
$('calib-go').addEventListener('click', () => { fx.unlock(); runCalibration(); });
$('calib-cancel').addEventListener('click', cancelCalibration);

$('btn-pause').addEventListener('click', () => (app.phase === 'paused' ? resume() : pause()));
$('btn-finish').addEventListener('click', finish);
$('btn-sound').addEventListener('click', () => {
  fx.unlock();
  prefs.sound = !prefs.sound;
  store.setPref('sound', prefs.sound);
  applyFx();
  syncSoundButton();
  toast(prefs.sound ? 'Sound on' : 'Sound off', 1200);
});
$('btn-skeleton').addEventListener('click', () => {
  prefs.skeleton = !prefs.skeleton;
  store.setPref('skeleton', prefs.skeleton);
  applyFx();
  syncSkeletonButton();
});

$('btn-again').addEventListener('click', () => {
  goSetup();
  enableCamera(); // this click is a user gesture, so the camera may reopen directly
});
$('btn-home').addEventListener('click', () => { app.phase = 'idle'; renderHome(); setScreen('home'); });
$('btn-rep-minus').addEventListener('click', () => correctReps(-1));
$('btn-rep-plus').addEventListener('click', () => correctReps(1));

$('btn-clear-history').addEventListener('click', () => openSheet('confirm'));
document.querySelectorAll('#confirm [data-cancel]').forEach((b) => b.addEventListener('click', () => closeSheet('confirm')));
$('confirm-yes').addEventListener('click', () => { store.clearHistory(); closeSheet('confirm'); renderHome(); toast('History cleared'); });

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-home').addEventListener('click', openSettings);
document.querySelectorAll('#settings [data-close]').forEach((b) => b.addEventListener('click', () => closeSheet('settings')));
$('set-sound').addEventListener('change', (e) => { prefs.sound = e.target.checked; store.setPref('sound', prefs.sound); applyFx(); syncSoundButton(); });
$('set-volume').addEventListener('input', (e) => { prefs.volume = Number(e.target.value); store.setPref('volume', prefs.volume); applyFx(); });
$('set-volume').addEventListener('change', () => { fx.unlock(); fx.rep(0); });
$('set-speak').addEventListener('change', (e) => { prefs.speak = e.target.checked; store.setPref('speak', prefs.speak); applyFx(); });
$('set-skeleton').addEventListener('change', (e) => { prefs.skeleton = e.target.checked; store.setPref('skeleton', prefs.skeleton); applyFx(); syncSkeletonButton(); });
$('set-dev').addEventListener('change', (e) => {
  app.devOn = e.target.checked;
  $('dev').hidden = !app.devOn;
  if (app.devOn) { renderDev(); clearInterval(app.devTimer); app.devTimer = setInterval(renderDev, 250); } else clearInterval(app.devTimer);
});
$('set-cpu').addEventListener('change', async (e) => {
  prefs.forceCpu = e.target.checked;
  store.setPref('forceCpu', prefs.forceCpu);
  pose.forceCpu = prefs.forceCpu;
  if (pose.ready) {
    const wasRunning = pose.running;
    pose.dispose();
    app.tracker?.resetMovement();
    overlay.clear();
    refreshCameraUi();
    try {
      await ensureModel();
      toast(`Tracking now uses ${pose.delegate}`);
    } catch { /* error shown by ensureModel */ }
    if (wasRunning && app.phase === 'setup') startInference();
  }
});
$('th-save').addEventListener('click', () => {
  const th = {};
  for (const k of ['topEnter', 'topExit', 'bottomExit', 'bottomEnter']) th[k] = Number($(`th-${k}`).value);
  if (saveThresholds(th)) toast('Thresholds saved');
});
$('th-reset').addEventListener('click', () => {
  prefs.thresholds = { ...prefs.thresholds, [app.exercise]: null };
  store.setPref('thresholds', prefs.thresholds);
  const d = EXERCISES[app.exercise].defaultThresholds;
  fillThresholds(d);
  app.tracker?.setThresholds(d);
  $('th-error').hidden = true;
  toast('Defaults restored');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSheet('settings'); closeSheet('confirm'); if (app.calib) cancelCalibration(); }
  if (body.dataset.screen === 'workout' && (e.key === ' ' || e.key === 'p') && e.target === document.body) {
    e.preventDefault();
    app.phase === 'paused' ? resume() : pause();
  }
});

// ---------------------------------------------------------------------------
pose.forceCpu = !!prefs.forceCpu;
applyFx();
renderHome();
setScreen('home');

// Expose for debugging in the console (no data leaves the device).
window.RepLens = { app, pose, camera, store };
