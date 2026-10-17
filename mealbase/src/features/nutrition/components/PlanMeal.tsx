import { useMemo, useState } from 'react';
import type { MealPlan, MealPlanItem, Recipe } from '../../../shared/types/planning';
import { MEAL_TYPES, type MealType } from '../../../shared/types/nutrition';
import { formatLocalDate, isLocalDate } from '../../../shared/lib/dates';
import { formatNumber, formatNutrient, scaleValues } from '../../../shared/lib/nutrition';
import { Button, Dialog, Field, Icon, Notice, NutrientList, Spinner } from '../../../shared/ui';
import { useNutrition } from '../app-context';
import { errorMessage, MEAL_LABELS, todayLocal, useAsync } from '../hooks';
import { ApiError, newIdempotencyKey } from '../api/client';

const STEP = 0.25;

export function basisBadge(basis: MealPlanItem['recipe']['nutritionBasis']) {
  if (basis === 'sample' || basis === 'mixed') return <span className="mb-badge mb-badge-sample">Sample nutrition data</span>;
  if (basis === 'manual') return <span className="mb-badge">Entered by you</span>;
  if (basis === 'none') return <span className="mb-badge mb-badge-warn">No nutrition data</span>;
  return null;
}

export function PlanMealCard({ item, onPlan, onLog, onDetails, onChoose }: {
  item: MealPlanItem; onPlan: (p: MealPlan) => void; onLog: (i: MealPlanItem) => void; onDetails: (i: MealPlanItem) => void; onChoose: (i: MealPlanItem) => void;
}) {
  const { api, toast } = useNutrition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(name: string, fn: () => Promise<MealPlan>, done?: string) {
    setBusy(name);
    setError(null);
    try {
      onPlan(await fn());
      if (done) toast(done);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const changeServings = (delta: number) => {
    const next = Math.round((item.servings + delta) / STEP) * STEP;
    if (next < 0.25 || next > 10) return;
    void act('servings', () => api.updatePlanItem(item.id, { servings: next }));
  };

  return (
    <article className="mb-plan-meal" data-locked={item.locked} aria-label={`${MEAL_LABELS[item.mealType]}: ${item.name}`}>
      <div className="mb-row-between">
        <span className="mb-plan-meal-type">{MEAL_LABELS[item.mealType]}</span>
        <div className="mb-row">
          {item.locked ? <span className="mb-badge mb-badge-accent"><Icon name="lock" />Locked</span> : null}
          {item.loggedCount ? <span className="mb-badge mb-badge-accent"><Icon name="check" />Logged</span> : null}
          {basisBadge(item.recipe.nutritionBasis)}
        </div>
      </div>
      <h3>{item.name}</h3>
      <div className="mb-row-between">
        <div className="mb-stepper" role="group" aria-label="Servings">
          <button type="button" aria-label="Fewer servings" disabled={busy !== null || item.servings <= 0.25} onClick={() => changeServings(-STEP)}>−</button>
          <span aria-live="polite">{formatNumber(item.servings, 2)} {item.servings === 1 ? 'serving' : 'servings'}</span>
          <button type="button" aria-label="More servings" disabled={busy !== null || item.servings >= 10} onClick={() => changeServings(STEP)}>+</button>
        </div>
        <strong className="mb-num">{formatNutrient(item.nutrition.calories, 'calories')}</strong>
      </div>
      <p className="mb-small mb-muted mb-num">
        Protein {formatNutrient(item.nutrition.proteinG, 'proteinG')} · Carbohydrate {formatNutrient(item.nutrition.carbsG, 'carbsG')} · Fat {formatNutrient(item.nutrition.fatG, 'fatG')}
      </p>
      {item.flags.length ? <ul className="mb-small" style={{ paddingLeft: '1.2em', color: 'var(--mb-warn-ink)' }}>{item.flags.map((f) => <li key={f}>{f}</li>)}</ul> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="mb-plan-actions">
        <Button size="sm" variant="primary" onClick={() => onLog(item)}>Log as eaten</Button>
        <Button size="sm" onClick={() => onDetails(item)}>Recipe</Button>
        <Button size="sm" disabled={item.locked} busy={busy === 'swap'} onClick={() => act('swap', () => api.replacePlanItem(item.id), `Swapped ${MEAL_LABELS[item.mealType].toLowerCase()}`)}>
          <Icon name="swap" />Swap
        </Button>
        <Button size="sm" disabled={item.locked} onClick={() => onChoose(item)}>Choose…</Button>
        <Button size="sm" variant="quiet" busy={busy === 'lock'} aria-pressed={item.locked}
          onClick={() => act('lock', () => api.updatePlanItem(item.id, { locked: !item.locked }), item.locked ? 'Meal unlocked' : 'Meal locked')}>
          <Icon name={item.locked ? 'unlock' : 'lock'} />{item.locked ? 'Unlock' : 'Lock'}
        </Button>
      </div>
    </article>
  );
}

/** Steps 1–5 of "Log as eaten": show plan, adjust amount, confirm date & meal, create entry, refresh totals. */
export function LogPlannedDialog({ item, onClose, onLogged }: { item: MealPlanItem | null; onClose: () => void; onLogged: () => void }) {
  const { api, toast, navigate, me } = useNutrition();
  const today = todayLocal(me.timezone);
  const [state, setState] = useState<{ id: string; amount: string; date: string; meal: MealType; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [already, setAlready] = useState(false);

  if (item && state?.id !== item.id) {
    // A meal planned for a future day is most likely being eaten today.
    setState({ id: item.id, amount: String(item.servings), date: item.date > today ? today : item.date, meal: item.mealType, key: newIdempotencyKey() });
    setError(null);
    setAlready(false);
  }
  if (!item && state) setState(null);

  const amount = Number(state?.amount);
  const validAmount = Number.isFinite(amount) && amount > 0 && amount <= 20;
  const est = item && validAmount ? scaleValues(item.recipe.nutritionPerServing, amount) : null;

  async function submit(allowRepeat = false) {
    if (!item || !state || !validAmount || !isLocalDate(state.date)) return;
    setBusy(true);
    setError(null);
    try {
      // A fresh key is used only when the user explicitly chooses to log again.
      const key = allowRepeat ? newIdempotencyKey() : state.key;
      await api.logPlanItem(item.id, { servingsEaten: amount, localDate: state.date, mealType: state.meal, idempotencyKey: key, allowRepeat });
      toast(`Logged ${item.name}`);
      onLogged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ALREADY_LOGGED') setAlready(true);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(item)} title="Log as eaten" onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      {already ? (
        <Button variant="primary" busy={busy} onClick={() => submit(true)}>Log it again</Button>
      ) : (
        <Button variant="primary" busy={busy} disabled={!validAmount || !state || !isLocalDate(state.date)} onClick={() => submit(false)}>Add to food log</Button>
      )}
    </>}>
      {item && state ? (
        <div className="mb-stack">
          <p><strong>{item.name}</strong></p>
          <p className="mb-small mb-muted">Planned: {formatNumber(item.servings, 2)} {item.servings === 1 ? 'serving' : 'servings'} on {formatLocalDate(item.date)} · {formatNutrient(item.nutrition.calories, 'calories')}</p>
          {already ? (
            <Notice tone="warn" title="Already in your food log">
              This planned meal was logged before. Log it again only if you ate it a second time.
              <div><Button size="sm" variant="quiet" onClick={() => { onClose(); navigate(`/?date=${item.date}`); }}>View that day</Button></div>
            </Notice>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field label="Servings you ate" error={state.amount !== '' && !validAmount ? 'Enter an amount between 0 and 20.' : null}>
            {(id, d) => <input id={id} aria-describedby={d} className="mb-input" type="number" inputMode="decimal" min="0" step="0.25" value={state.amount}
              onChange={(e) => setState({ ...state, amount: e.target.value })} aria-invalid={state.amount !== '' && !validAmount} />}
          </Field>
          <div className="mb-grid-2">
            <Field label="Date" hint={state.date !== item.date ? `Planned for ${formatLocalDate(item.date)}` : undefined}>{(id, d) => <input id={id} aria-describedby={d} className="mb-input" type="date" value={state.date} onChange={(e) => setState({ ...state, date: e.target.value })} />}</Field>
            <Field label="Meal">{(id) => (
              <select id={id} className="mb-select" value={state.meal} onChange={(e) => setState({ ...state, meal: e.target.value as MealType })}>
                {MEAL_TYPES.map((m) => <option key={m} value={m}>{MEAL_LABELS[m]}</option>)}
              </select>
            )}</Field>
          </div>
          {est ? <p className="mb-small">Will add an estimated <strong className="mb-num">{formatNutrient(est.calories, 'calories')}</strong> to {MEAL_LABELS[state.meal].toLowerCase()} on {formatLocalDate(state.date)}.</p> : null}
          <p className="mb-hint">The log keeps its own copy of these values, so later plan changes won't alter it.</p>
        </div>
      ) : null}
    </Dialog>
  );
}

export function MealDetailsDialog({ item, people, onClose, onPlan }: { item: MealPlanItem | null; people: number; onClose: () => void; onPlan: (p: MealPlan) => void }) {
  const { api } = useNutrition();
  const [notes, setNotes] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (item && notes?.id !== item.id) setNotes({ id: item.id, text: item.notes ?? '' });

  const r = item?.recipe;
  const factor = item && r ? (item.servings * people) / (r.servings || 1) : 1;
  return (
    <Dialog open={Boolean(item)} title={item?.name ?? 'Recipe'} onClose={onClose}>
      {item && r ? (
        <div className="mb-stack-lg">
          <div className="mb-row">
            {r.prepMinutes !== null ? <span className="mb-badge">{r.prepMinutes} min</span> : null}
            {basisBadge(r.nutritionBasis)}
            {!r.nutritionComplete ? <span className="mb-badge mb-badge-warn">Incomplete estimate</span> : null}
          </div>
          <section className="mb-stack">
            <h3>Planned portion ({formatNumber(item.servings, 2)} {item.servings === 1 ? 'serving' : 'servings'}, per person)</h3>
            <NutrientList values={item.nutrition} />
            <p className="mb-hint">Estimates calculated from ingredient records{r.nutritionBasis === 'sample' || r.nutritionBasis === 'mixed' ? ' that include development sample data' : ''}. Not verified nutrition data.</p>
          </section>
          {r.ingredients.length ? (
            <section className="mb-stack">
              <h3>Ingredients{factor !== 1 ? ` (for ${people} ${people === 1 ? 'person' : 'people'})` : ''}</h3>
              <ul style={{ paddingLeft: '1.2em' }}>
                {r.ingredients.map((ing, i) => (
                  <li key={i}>{ing.quantity !== null ? `${formatNumber(ing.quantity * factor, 2)} ${ing.unit} ` : ''}{ing.name}{ing.quantity === null && ing.unit === 'to taste' ? ' (to taste)' : ''}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {r.instructions.length ? (
            <section className="mb-stack">
              <h3>Preparation</h3>
              <ol style={{ paddingLeft: '1.2em', display: 'grid', gap: 6 }}>{r.instructions.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </section>
          ) : null}
          <section className="mb-stack">
            <Field label="Notes">{(id) => <textarea id={id} className="mb-textarea" value={notes?.text ?? ''} onChange={(e) => setNotes({ id: item.id, text: e.target.value })} />}</Field>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div><Button size="sm" busy={busy} disabled={(notes?.text ?? '') === (item.notes ?? '')} onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                onPlan(await api.updatePlanItem(item.id, { notes: notes?.text.trim() || null }));
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}>Save notes</Button></div>
          </section>
        </div>
      ) : null}
    </Dialog>
  );
}

export function ChooseMealDialog({ item, onClose, onPlan }: { item: MealPlanItem | null; onClose: () => void; onPlan: (p: MealPlan) => void }) {
  const { api, toast } = useNutrition();
  const recipes = useAsync(() => (item ? api.recipes() : Promise.resolve([] as Recipe[])), [item?.id]);
  const [tab, setTab] = useState<'recipes' | 'custom'>('recipes');
  const [filter, setFilter] = useState('');
  const [custom, setCustom] = useState({ name: '', calories: '', protein: '', carbs: '', fat: '', ingredients: '', instructions: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = useMemo(() => {
    const all = recipes.data ?? [];
    const f = filter.trim().toLowerCase();
    return all
      .filter((r) => !f || r.name.toLowerCase().includes(f))
      .sort((a, b) => Number(b.mealTypes.includes(item?.mealType as never)) - Number(a.mealTypes.includes(item?.mealType as never)) || a.name.localeCompare(b.name));
  }, [recipes.data, filter, item?.mealType]);

  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const customValid = custom.name.trim() && [custom.calories, custom.protein, custom.carbs, custom.fat].every((v) => v.trim() === '' || (Number.isFinite(Number(v)) && Number(v) >= 0));

  async function choose(fn: () => Promise<MealPlan>) {
    setBusy(true);
    setError(null);
    try {
      onPlan(await fn());
      toast('Meal updated');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(item)} title={item ? `Choose ${MEAL_LABELS[item.mealType].toLowerCase()}` : 'Choose meal'} onClose={onClose}>
      <div className="mb-segmented" role="tablist">
        <label><input type="radio" name="mb-choose" checked={tab === 'recipes'} onChange={() => setTab('recipes')} />From recipes</label>
        <label><input type="radio" name="mb-choose" checked={tab === 'custom'} onChange={() => setTab('custom')} />My own meal</label>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {tab === 'recipes' ? (
        <div className="mb-stack">
          <input className="mb-input" type="search" aria-label="Filter recipes" placeholder="Filter recipes" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {recipes.loading ? <Spinner label="Loading recipes" /> : null}
          {recipes.error ? <Notice tone="error">{recipes.error.message} <Button size="sm" onClick={recipes.reload}>Retry</Button></Notice> : null}
          <div className="mb-list" style={{ maxHeight: 360, overflow: 'auto' }}>
            {list.map((r) => (
              <button key={r.id} type="button" className="mb-list-item" disabled={busy} onClick={() => item && choose(() => api.updatePlanItem(item.id, { recipeId: r.id }))}>
                <span>
                  <strong>{r.name}</strong>
                  <span className="mb-hint" style={{ display: 'block' }}>{r.mealTypes.map((m) => MEAL_LABELS[m]).join(', ')} · {r.prepMinutes} min{r.ownerProfileId ? ' · Your recipe' : ''}</span>
                </span>
                <span className="mb-small mb-num">{formatNutrient(r.nutrition.perServing.calories, 'calories')}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mb-stack">
          <Field label="Meal name">{(id) => <input id={id} className="mb-input" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />}</Field>
          <p className="mb-hint">Add nutrition if you know it; leave blank for “Not available”.</p>
          <div className="mb-grid-2">
            <Field label="Calories (kcal)">{(id) => <input id={id} className="mb-input" type="number" min="0" inputMode="decimal" value={custom.calories} onChange={(e) => setCustom({ ...custom, calories: e.target.value })} />}</Field>
            <Field label="Protein (g)">{(id) => <input id={id} className="mb-input" type="number" min="0" inputMode="decimal" value={custom.protein} onChange={(e) => setCustom({ ...custom, protein: e.target.value })} />}</Field>
            <Field label="Carbohydrate (g)">{(id) => <input id={id} className="mb-input" type="number" min="0" inputMode="decimal" value={custom.carbs} onChange={(e) => setCustom({ ...custom, carbs: e.target.value })} />}</Field>
            <Field label="Fat (g)">{(id) => <input id={id} className="mb-input" type="number" min="0" inputMode="decimal" value={custom.fat} onChange={(e) => setCustom({ ...custom, fat: e.target.value })} />}</Field>
          </div>
          <Field label="Ingredients (one per line, optional)">{(id) => <textarea id={id} className="mb-textarea" value={custom.ingredients} onChange={(e) => setCustom({ ...custom, ingredients: e.target.value })} />}</Field>
          <Field label="Preparation steps (one per line, optional)">{(id) => <textarea id={id} className="mb-textarea" value={custom.instructions} onChange={(e) => setCustom({ ...custom, instructions: e.target.value })} />}</Field>
          <div><Button variant="primary" busy={busy} disabled={!customValid} onClick={() => item && choose(() => api.updatePlanItem(item.id, {
            custom: {
              name: custom.name.trim(), calories: num(custom.calories), proteinG: num(custom.protein), carbsG: num(custom.carbs), fatG: num(custom.fat),
              ingredients: custom.ingredients.split('\n').map((s) => s.trim()).filter(Boolean),
              instructions: custom.instructions.split('\n').map((s) => s.trim()).filter(Boolean),
            },
          }))}>Use this meal</Button></div>
        </div>
      )}
    </Dialog>
  );
}
