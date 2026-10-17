// Skeleton overlay drawn on a canvas that sits exactly on top of the <video>.
// The video uses object-fit: contain, so we compute the same letterboxed
// rectangle here. Mirroring for the selfie camera is applied with one CSS
// transform on the wrapper around BOTH video and canvas, so the drawing
// stays aligned without ever swapping anatomical left/right landmarks.

import { fitRect } from './geometry.js';
import { LM, MIN_VISIBILITY } from './exercises.js';

const CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 31], [28, 32], [27, 29], [28, 30],
];

export class Overlay {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.enabled = true;
    this.fit = 'contain';
    this._resize = this._resize.bind(this);
    if ('ResizeObserver' in window) {
      this._ro = new ResizeObserver(this._resize);
      this._ro.observe(canvas);
    } else {
      window.addEventListener('resize', this._resize);
    }
    this._resize();
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w && h && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** highlight: { side: 'left'|'right'|'both', joints: [...] } joints used for counting */
  draw(landmarks, highlight, status) {
    this._resize();
    const ctx = this.ctx;
    this.clear();
    if (!this.enabled || !landmarks) return;
    const v = this.video;
    const cssW = this.canvas.width / this.dpr, cssH = this.canvas.height / this.dpr;
    const r = fitRect(v.videoWidth, v.videoHeight, cssW, cssH, this.fit);
    const P = (lm) => ({ x: (r.x + lm.x * r.w) * this.dpr, y: (r.y + lm.y * r.h) * this.dpr });
    const visible = (lm) => lm && (lm.visibility ?? 1) >= MIN_VISIBILITY;

    const accent = status === 'good' ? '#5BF0B4' : status === 'adjust' ? '#FFC857' : '#FF6B6B';
    const lw = Math.max(3, 4 * this.dpr * (r.w / 640));
    ctx.lineCap = 'round';

    // base skeleton
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = lw * 0.7;
    for (const [a, b] of CONNECTIONS) {
      const A = landmarks[a], B = landmarks[b];
      if (!visible(A) || !visible(B)) continue;
      const pa = P(A), pb = P(B);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }

    // highlighted measured limb chain(s)
    if (highlight?.joints?.length) {
      const sides = highlight.side === 'both' ? ['left', 'right'] : highlight.side ? [highlight.side] : [];
      ctx.strokeStyle = accent;
      ctx.lineWidth = lw * 1.3;
      for (const s of sides) {
        const chain = highlight.joints.map((j) => landmarks[LM[s][j]]);
        ctx.beginPath();
        let started = false;
        for (const lm of chain) {
          if (!visible(lm)) { started = false; continue; }
          const p = P(lm);
          if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
    }

    // joints
    for (let i = 11; i <= 28; i++) {
      const lm = landmarks[i];
      if (!visible(lm) || (i >= 17 && i <= 22)) continue; // skip finger points
      const p = P(lm);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(p.x, p.y, lw * 0.9, 0, Math.PI * 2); ctx.fill();
    }
  }
}
