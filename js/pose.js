// Pose detection: loads MediaPipe Pose Landmarker and runs it on video frames.
// Knows nothing about reps — it only hands landmark arrays to a callback.
// All processing happens in this browser tab; frames are never sent anywhere.

import { LIB_SOURCES, MODEL_SOURCES } from './config.js?v=20261017d';

export class PoseLoadError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.kind = kind; // 'library' | 'model' | 'init'
    this.cause = cause;
  }
}

async function fetchWithProgress(url, onProgress, signal) {
  const res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress?.(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  onProgress?.(1);
  return out;
}

export class PoseEngine {
  constructor() {
    this.landmarker = null;
    this.vision = null;
    this.lib = null;
    this.modelBytes = null;
    this.delegate = null;
    this.libLabel = null;
    this.modelLabel = null;
    this.running = false;
    this._loading = null;
    this._frameHandle = null;
    this._lastVideoTime = -1;
    this._lastTs = 0;
    this._lastRun = 0;
    this._busy = false;
    this._errors = 0;
    this.stats = { inferenceMs: 0, intervalMs: 50, fps: 0, frames: 0 };
    this.forceCpu = false; // "compatibility mode" setting
  }

  get ready() { return !!this.landmarker; }

  /** Load library, WASM and model. Safe to call repeatedly. */
  load(onStatus) {
    if (this.landmarker) return Promise.resolve();
    if (!this._loading) {
      this._loading = this._load(onStatus).finally(() => { this._loading = null; });
    }
    return this._loading;
  }

  async _load(onStatus) {
    // 1. Library (+ matching WASM folder)
    let lastErr = null;
    if (!this.lib) {
      onStatus?.({ phase: 'library', progress: 0 });
      for (const src of LIB_SOURCES) {
        try {
          const mod = await import(/* webpackIgnore: true */ src.module);
          if (!mod.FilesetResolver || !mod.PoseLandmarker) throw new Error('Unexpected module shape');
          const vision = await mod.FilesetResolver.forVisionTasks(src.wasm);
          this.lib = { mod, vision, src };
          this.libLabel = src.label;
          break;
        } catch (e) {
          lastErr = e;
          if (!src.optional) console.warn(`[RepLens] pose library from ${src.label} failed`, e);
        }
      }
      if (!this.lib) {
        throw new PoseLoadError('library', 'Could not download the tracking library. Check your internet connection and try again.', lastErr);
      }
    }

    // 2. Model file
    if (!this.modelBytes) {
      for (const src of MODEL_SOURCES) {
        try {
          onStatus?.({ phase: 'model', progress: 0 });
          this.modelBytes = await fetchWithProgress(src.url, (p) => onStatus?.({ phase: 'model', progress: p }));
          if (this.modelBytes.length < 100000) throw new Error('Model file too small');
          this.modelLabel = src.label;
          break;
        } catch (e) {
          this.modelBytes = null;
          lastErr = e;
          if (!src.optional) console.warn(`[RepLens] model from ${src.label} failed`, e);
        }
      }
      if (!this.modelBytes) {
        throw new PoseLoadError('model', 'Could not download the pose model (about 6 MB). Check your internet connection and try again.', lastErr);
      }
    }

    // 3. Create the landmarker: try GPU first, fall back to CPU.
    onStatus?.({ phase: 'init', progress: 1 });
    const canGpu = typeof document !== 'undefined' && !!document.createElement('canvas').getContext('webgl2');
    const delegates = canGpu && !this.forceCpu ? ['GPU', 'CPU'] : ['CPU'];
    for (const d of delegates) {
      try {
        this.landmarker = await this._create(d);
        this.delegate = d;
        return;
      } catch (e) {
        lastErr = e;
        console.warn(`[RepLens] ${d} delegate failed`, e);
      }
    }
    throw new PoseLoadError('init', 'The tracking model could not start on this device/browser.', lastErr);
  }

  async _create(delegate) {
    const { mod, vision } = this.lib;
    return mod.PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetBuffer: this.modelBytes, delegate },
      runningMode: 'VIDEO',
      numPoses: 1, // one-person tracking
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });
  }

  /**
   * Start processing frames from `video`. `onResult({landmarks|null, width,
   * height, t})` is called after each inference. Only one inference runs at
   * a time; identical video frames are skipped; the rate adapts to the device.
   */
  start(video, onResult, onFatal) {
    if (!this.landmarker) throw new Error('PoseEngine not loaded');
    this.stop();
    this.running = true;
    this._video = video;
    this._onResult = onResult;
    this._onFatal = onFatal;
    this._lastVideoTime = -1;
    this._lastRun = 0;
    this._errors = 0;
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this._frameHandle != null) {
      if (this._usedRvfc && this._video?.cancelVideoFrameCallback) this._video.cancelVideoFrameCallback(this._frameHandle);
      else cancelAnimationFrame(this._frameHandle);
    }
    this._frameHandle = null;
  }

  _schedule() {
    if (!this.running) return;
    const v = this._video;
    // requestVideoFrameCallback fires once per NEW video frame where supported
    // (Safari 15.4+, Chrome). Otherwise poll with rAF and compare currentTime.
    if (v && 'requestVideoFrameCallback' in v) {
      this._usedRvfc = true;
      this._frameHandle = v.requestVideoFrameCallback(() => this._tick());
    } else {
      this._usedRvfc = false;
      this._frameHandle = requestAnimationFrame(() => this._tick());
    }
  }

  _tick() {
    this._frameHandle = null;
    if (!this.running) return;
    const v = this._video;
    const now = performance.now();
    const ready = v && v.readyState >= 2 && v.videoWidth > 0 && !v.paused;
    const newFrame = ready && v.currentTime !== this._lastVideoTime;
    // Adaptive throttle: leave the main thread idle between inferences so
    // taps stay responsive on slower phones.
    if (newFrame && !this._busy && now - this._lastRun >= this.stats.intervalMs) {
      this._busy = true;
      this._lastVideoTime = v.currentTime;
      // MediaPipe needs strictly increasing timestamps in VIDEO mode.
      const ts = Math.max(now, this._lastTs + 1);
      this._lastTs = ts;
      let landmarks = null;
      const t0 = performance.now();
      try {
        const result = this.landmarker.detectForVideo(v, ts);
        const pose = result?.landmarks?.[0];
        // Copy out plain numbers; MediaPipe may reuse result memory.
        if (pose) landmarks = pose.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 }));
        result?.close?.();
        this._errors = 0;
      } catch (e) {
        this._errors += 1;
        console.warn('[RepLens] inference error', e);
        if (this._errors >= 3) {
          this._busy = false;
          this._recover(e);
          return;
        }
      }
      const dt = performance.now() - t0;
      const s = this.stats;
      s.inferenceMs = s.frames ? s.inferenceMs * 0.85 + dt * 0.15 : dt;
      s.intervalMs = Math.min(250, Math.max(33, s.inferenceMs * 1.8));
      if (this._lastRun) s.fps = s.fps * 0.85 + (1000 / (now - this._lastRun)) * 0.15;
      s.frames += 1;
      this._lastRun = now;
      this._busy = false;
      try {
        this._onResult?.({ landmarks, width: v.videoWidth, height: v.videoHeight, t: now });
      } catch (e) {
        console.error('[RepLens] result handler error', e);
      }
    }
    this._schedule();
  }

  async _recover(err) {
    // Repeated runtime failures (e.g. lost GPU context): retry once on CPU.
    this.stop();
    if (this.delegate === 'GPU') {
      try {
        this.landmarker?.close?.();
        this.landmarker = await this._create('CPU');
        this.delegate = 'CPU';
        this.start(this._video, this._onResult, this._onFatal);
        return;
      } catch (e) {
        err = e;
      }
    }
    this._onFatal?.(err);
  }

  /** Release the model and WASM memory (the downloaded library/model bytes are kept for reuse). */
  dispose() {
    this.stop();
    try { this.landmarker?.close?.(); } catch { /* ignore */ }
    this.landmarker = null;
    this.delegate = null;
  }
}
