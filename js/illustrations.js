// Simple setup illustrations (inline SVG, no external assets).

const phone = (x, y) => `
  <rect class="i-phone" x="${x}" y="${y}" width="16" height="30" rx="4"/>
  <circle cx="${x + 8}" cy="${y + 6}" r="2.5" fill="currentColor" style="color:var(--accent)"/>`;

export const SETUP_ILLUSTRATIONS = {
  pushup: `
  <svg viewBox="0 0 360 150" role="img" aria-label="Phone standing on the floor beside a person in push-up position, side view">
    <line x1="10" y1="130" x2="350" y2="130" class="i-floor"/>
    <path class="i-ray" d="M180 18 L40 110 M180 18 L330 110"/>
    ${phone(172, 6)}
    <text x="200" y="22" class="i-label">phone ~2 m away, side view</text>
    <circle cx="285" cy="72" r="10" class="i-head"/>
    <path class="i-person" d="M272 80 L95 112 L60 126"/>
    <path class="i-person" d="M268 82 L272 104 L268 126"/>
    <text x="40" y="148" class="i-label">shoulders · elbows · wrists · hips · ankles visible</text>
  </svg>`,
  squat: `
  <svg viewBox="0 0 360 170" role="img" aria-label="Phone standing at waist height beside a person squatting, side view">
    <line x1="10" y1="150" x2="350" y2="150" class="i-floor"/>
    <path class="i-ray" d="M80 70 L250 10 M80 70 L250 150"/>
    <line x1="80" y1="100" x2="80" y2="150" stroke="#33415c" stroke-width="4"/>
    ${phone(72, 60)}
    <text x="20" y="54" class="i-label">phone ~2–3 m away</text>
    <circle cx="250" cy="30" r="10" class="i-head"/>
    <path class="i-person" d="M248 41 L236 88"/>
    <path class="i-person" d="M236 88 L270 98 L258 148"/>
    <path class="i-person" d="M246 52 L282 64"/>
    <text x="120" y="168" class="i-label">shoulders · hips · knees · ankles visible</text>
  </svg>`,
  curl: `
  <svg viewBox="0 0 360 170" role="img" aria-label="Phone at chest height beside a person doing a bicep curl, side view">
    <line x1="10" y1="150" x2="350" y2="150" class="i-floor"/>
    <path class="i-ray" d="M80 70 L250 10 M80 70 L250 150"/>
    <line x1="80" y1="100" x2="80" y2="150" stroke="#33415c" stroke-width="4"/>
    ${phone(72, 60)}
    <text x="20" y="54" class="i-label">phone ~2 m away, side view</text>
    <circle cx="250" cy="26" r="10" class="i-head"/>
    <path class="i-person" d="M250 37 L250 95 L242 148 M250 95 L258 148"/>
    <path class="i-person" d="M250 44 L254 76 L280 52"/>
    <rect x="276" y="44" width="14" height="10" rx="3" class="i-head"/>
    <text x="110" y="168" class="i-label">shoulders · elbows · wrists · hips visible</text>
  </svg>`,
  press: `
  <svg viewBox="0 0 360 170" role="img" aria-label="Phone facing a person doing a shoulder press, front view">
    <line x1="10" y1="150" x2="350" y2="150" class="i-floor"/>
    <path class="i-ray" d="M60 80 L230 4 M60 80 L230 150"/>
    <line x1="60" y1="110" x2="60" y2="150" stroke="#33415c" stroke-width="4"/>
    ${phone(52, 70)}
    <text x="10" y="62" class="i-label">phone ~2 m, facing you</text>
    <circle cx="250" cy="52" r="10" class="i-head"/>
    <path class="i-person" d="M250 63 L250 108 L240 148 M250 108 L260 148"/>
    <path class="i-person" d="M250 68 L224 64 L222 28 M250 68 L276 64 L278 28"/>
    <rect x="208" y="20" width="28" height="8" rx="3" class="i-head"/>
    <rect x="264" y="20" width="28" height="8" rx="3" class="i-head"/>
    <text x="100" y="168" class="i-label">leave room above your head for your hands</text>
  </svg>`,
};
