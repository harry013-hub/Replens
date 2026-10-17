// Shows today's food total from MealBase (same site, same browser) on the RepLens home screen.
// Read-only and optional: workouts never depend on it. MealBase stores its data in
// localStorage under "mealbase.v1" (see mealbase/src/local/backend.ts).
const el = document.getElementById('meals-today');
const out = document.getElementById('meals-today-kcal');

function localDate(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function mealsTodayKcal(storage = globalThis.localStorage) {
  let state;
  try { state = JSON.parse(storage.getItem('mealbase.v1') || 'null'); } catch { return null; }
  if (!state || state.version !== 1 || !Array.isArray(state.logs)) return null;
  let tz = 'UTC';
  try { tz = state.profile?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* keep UTC */ }
  const today = localDate(tz);
  const entries = state.logs.filter((l) => l.localDate === today);
  const known = entries.filter((l) => typeof l.nutrition?.calories === 'number');
  return { entries: entries.length, kcal: known.reduce((s, l) => s + l.nutrition.calories, 0) };
}

function render() {
  if (!el || !out) return;
  const t = mealsTodayKcal();
  if (!t) { el.hidden = true; return; }
  out.textContent = t.entries ? `${Math.round(t.kcal).toLocaleString()} kcal` : 'Nothing logged';
  el.hidden = false;
}

render();
window.addEventListener('pageshow', render);
window.addEventListener('storage', (e) => { if (e.key === 'mealbase.v1') render(); });
