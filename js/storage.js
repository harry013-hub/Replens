// Local-only persistence of session SUMMARIES and preferences.
// Never stores video, images, or landmark data.

const KEY = 'replens.v1';
const MAX_SESSIONS = 200;

export const DEFAULT_PREFS = Object.freeze({
  sound: true,
  volume: 0.6,
  speak: false,
  skeleton: true,
  facing: 'user',
  target: { pushup: 0, squat: 0, curl: 0, press: 0 },
  thresholds: { pushup: null, squat: null, curl: null, press: null }, // null = defaults
});

function probe(storage) {
  try {
    const k = '__replens_probe__';
    storage.setItem(k, '1');
    storage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

export class Store {
  /** @param backend an object with getItem/setItem/removeItem, or undefined for localStorage */
  constructor(backend) {
    let b = backend;
    if (b === undefined) {
      try { b = typeof localStorage !== 'undefined' ? localStorage : null; } catch { b = null; }
    }
    this.persistent = !!b && probe(b);
    this.backend = this.persistent ? b : null;
    this.data = this._read();
  }

  _empty() {
    return { version: 1, sessions: [], prefs: structuredCloneSafe(DEFAULT_PREFS) };
  }

  _read() {
    if (!this.backend) return this._empty();
    try {
      const raw = this.backend.getItem(KEY);
      if (!raw) return this._empty();
      const d = JSON.parse(raw);
      const base = this._empty();
      return {
        version: 1,
        sessions: Array.isArray(d.sessions) ? d.sessions.filter(validSession) : [],
        prefs: {
          ...base.prefs,
          ...(d.prefs || {}),
          target: { ...base.prefs.target, ...(d.prefs?.target || {}) },
          thresholds: { ...base.prefs.thresholds, ...(d.prefs?.thresholds || {}) },
        },
      };
    } catch {
      return this._empty();
    }
  }

  _write() {
    if (!this.backend) return false;
    try {
      this.backend.setItem(KEY, JSON.stringify(this.data));
      return true;
    } catch {
      // Quota or private-mode failure: keep working in memory.
      this.persistent = false;
      return false;
    }
  }

  get prefs() { return this.data.prefs; }

  setPref(key, value) {
    this.data.prefs[key] = value;
    this._write();
  }

  get sessions() { return this.data.sessions; }

  addSession(s) {
    const rec = {
      id: s.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      exercise: s.exercise,
      reps: Math.max(0, s.reps | 0),
      detectedReps: Math.max(0, s.detectedReps ?? s.reps | 0),
      durationMs: Math.max(0, Math.round(s.durationMs || 0)),
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    };
    this.data.sessions.unshift(rec);
    if (this.data.sessions.length > MAX_SESSIONS) this.data.sessions.length = MAX_SESSIONS;
    this._write();
    return rec;
  }

  updateSession(id, patch) {
    const s = this.data.sessions.find((x) => x.id === id);
    if (!s) return null;
    if (patch.reps != null) s.reps = Math.max(0, patch.reps | 0);
    this._write();
    return s;
  }

  totals() {
    const t = { pushup: 0, squat: 0, curl: 0, press: 0 };
    for (const s of this.data.sessions) if (s.exercise in t) t[s.exercise] += s.reps;
    return t;
  }

  clearHistory() {
    this.data.sessions = [];
    this._write();
  }
}

function validSession(s) {
  return s && ['pushup', 'squat', 'curl', 'press'].includes(s.exercise) && Number.isFinite(s.reps);
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}
