// Camera access: video only, opened only from a user tap, fully released on stop.

import { CAMERA } from './config.js';

export class CameraError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.kind = kind; // 'insecure' | 'unsupported' | 'denied' | 'notfound' | 'inuse' | 'interrupted' | 'unknown'
    this.cause = cause;
  }
}

export function cameraSupport() {
  if (typeof window === 'undefined') return { ok: false, kind: 'unsupported' };
  if (!window.isSecureContext) return { ok: false, kind: 'insecure' };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, kind: 'unsupported' };
  return { ok: true };
}

const MESSAGES = {
  insecure: 'Camera access needs a secure (HTTPS) page. Open the HTTPS link instead of a local http:// address.',
  unsupported: 'This browser cannot use the camera. On iPhone, open the link directly in Safari.',
  denied: 'Camera permission was denied. To fix it on iPhone: tap “aA” in the Safari address bar → Website Settings → Camera → Allow, then reload. On Android Chrome: tap the lock icon → Permissions → Camera.',
  notfound: 'No camera was found on this device.',
  inuse: 'The camera is busy in another app or tab. Close it there, then try again.',
  interrupted: 'The camera stopped unexpectedly (for example a call, another app, or the screen locking).',
  unknown: 'The camera could not be started.',
};

export function classifyCameraError(e) {
  const name = e?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'notfound';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'inuse';
  return 'unknown';
}

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facing = 'user';
    this.onInterrupted = null; // set by the app
    this._opening = null;
  }

  get active() {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  /** Whether the current camera is the selfie camera (preview gets mirrored). */
  get mirrored() {
    const s = this.stream?.getVideoTracks()[0]?.getSettings?.() || {};
    if (s.facingMode) return s.facingMode === 'user';
    return this.facing === 'user'; // desktop webcams often omit facingMode
  }

  async open(facing = this.facing) {
    const sup = cameraSupport();
    if (!sup.ok) throw new CameraError(sup.kind, MESSAGES[sup.kind]);
    // Never keep two streams open: release the old one first (required on iOS).
    this.stop();
    const base = {
      width: { ideal: CAMERA.width },
      height: { ideal: CAMERA.height },
      frameRate: { ideal: CAMERA.frameRate, max: 30 },
    };
    const attempts = [
      { audio: false, video: { ...base, facingMode: { ideal: facing } } },
      { audio: false, video: true }, // looser fallback if constraints fail
    ];
    let lastErr = null;
    for (const constraints of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (e) {
        lastErr = e;
        const kind = classifyCameraError(e);
        if (kind === 'denied' || kind === 'inuse') break; // retrying won't help
      }
    }
    if (!this.stream) {
      const kind = classifyCameraError(lastErr);
      throw new CameraError(kind, MESSAGES[kind], lastErr);
    }
    this.facing = facing;
    for (const track of this.stream.getVideoTracks()) {
      track.addEventListener('ended', () => this._interrupted('ended'));
      // iOS mutes the track during phone calls / Siri / other camera apps.
      track.addEventListener('mute', () => this._interrupted('mute'));
    }
    const v = this.video;
    v.muted = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    v.srcObject = this.stream;
    try {
      await v.play();
    } catch (e) {
      // Autoplay of a muted inline video normally succeeds after a tap.
      if (e?.name !== 'AbortError') console.warn('[RepLens] video.play()', e);
    }
    await this._waitForDimensions();
    return this.stream;
  }

  _waitForDimensions() {
    const v = this.video;
    if (v.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { v.removeEventListener('loadedmetadata', done); resolve(); };
      v.addEventListener('loadedmetadata', done);
      setTimeout(done, 4000);
    });
  }

  _interrupted(reason) {
    if (!this.stream) return;
    this.onInterrupted?.(reason);
  }

  /** Stop every track and detach the stream. */
  stop() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
      }
    }
    this.stream = null;
    if (this.video) {
      try { this.video.pause(); } catch { /* ignore */ }
      this.video.srcObject = null;
    }
  }

  /** Count cameras (labels/ids are only available after permission is granted). */
  async countCameras() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return 0;
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput').length;
    } catch {
      return 0;
    }
  }

  /** Switch front/back. On failure, try to reopen the previous camera. */
  async switchFacing() {
    const prev = this.facing;
    const next = prev === 'user' ? 'environment' : 'user';
    try {
      await this.open(next);
    } catch (e) {
      try { await this.open(prev); } catch { /* report original error */ }
      throw e;
    }
  }
}

export { MESSAGES as CAMERA_MESSAGES };
