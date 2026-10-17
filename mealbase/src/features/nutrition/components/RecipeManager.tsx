import { useState } from 'react';
import type { FoodSearchResult } from '../../../shared/types/api';
import type { Recipe } from '../../../shared/types/planning';
import { PLANNED_MEAL_TYPES } from '../../../shared/types/nutrition';
import { formatNutrient } from '../../../shared/lib/nutrition';
import { Button, ConfirmDialog, Dialog, Field, Notice, Spinner } from '../../../shared/ui';
import { useNutrition } from '../app-context';
import { errorMessage, MEAL_LABELS, useAsync } from '../hooks';
import type { RecipeEditorInput } from '../api/client';
import { basisBadge } from './PlanMeal';
import { SOURCE_BADGE } from '../source-labels';

interface IngredientDraft { name: string; quantity: string; unit: string; foodId: string | null; foodLabel: string | null }
interface Draft {
  id: string | null; name: string; mealTypes: RecipeEditorInput['mealTypes']; prepMinutes: string; budgetLevel: RecipeEditorInput['budgetLevel'];
  servings: string; instructions: string; ingredients: IngredientDraft[];
}

const UNITS = ['g', 'ml', 'cup', 'tbsp', 'tsp', 'piece', 'slice', 'large', 'medium', 'clove', 'to taste'];

function emptyDraft(): Draft {
  return { id: null, name: '', mealTypes: ['dinner'], prepMinutes: '20', budgetLevel: 'medium', servings: '2', instructions: '', ingredients: [{ name: '', quantity: '', unit: 'g', foodId: null, foodLabel: null }] };
}

function fromRecipe(r: Recipe, copy: boolean): Draft {
  return {
    id: copy ? null : r.id,
    name: copy ? `${r.name} (my version)` : r.name,
    mealTypes: r.mealTypes, prepMinutes: String(r.prepMinutes), budgetLevel: r.budgetLevel, servings: String(r.servings),
    instructions: r.instructions.join('\n'),
    ingredients: r.ingredients.map((i) => ({ name: i.name, quantity: i.quantity === null ? '' : String(i.quantity), unit: i.unit, foodId: i.foodId, foodLabel: i.foodId ? i.name : null })),
  };
}

export function RecipeManager({ onChanged }: { onChanged?: () => void }) {
  const { api, me, toast } = useNutrition();
  const recipes = useAsync(() => api.recipes(), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Recipe | null>(null);
  const [busy, setBusy] = useState(false);

  const mine = (recipes.data ?? []).filter((r) => r.ownerProfileId === me.profileId);
  const starters = (recipes.data ?? []).filter((r) => r.ownerProfileId === null);

  return (
    <section className="mb-panel mb-stack" aria-labelledby="mb-myrecipes">
      <div className="mb-row-between">
        <h2 id="mb-myrecipes">My recipes</h2>
        <Button size="sm" onClick={() => setDraft(emptyDraft())}>New recipe</Button>
      </div>
      {recipes.loading ? <Spinner label="Loading recipes" /> : null}
      {recipes.error ? <Notice tone="error">{recipes.error.message} <Button size="sm" onClick={recipes.reload}>Retry</Button></Notice> : null}
      {recipes.data && !mine.length ? <p className="mb-muted mb-small">Add your own recipes, or copy a starter recipe to change it. Your recipes join the planner's choices.</p> : null}
      <div className="mb-list">
        {mine.map((r) => (
          <div key={r.id} className="mb-list-item" style={{ cursor: 'default' }}>
            <span>
              <strong>{r.name}</strong>
              <span className="mb-hint" style={{ display: 'block' }}>{r.mealTypes.map((m) => MEAL_LABELS[m]).join(', ')} · {formatNutrient(r.nutrition.perServing.calories, 'calories')} per serving {r.nutrition.complete ? '' : '· incomplete estimate'}</span>
            </span>
            <span className="mb-row">
              <Button size="sm" variant="quiet" onClick={() => setDraft(fromRecipe(r, false))}>Edit</Button>
              <Button size="sm" variant="quiet" className="mb-btn-danger" onClick={() => setDeleting(r)}>Delete</Button>
            </span>
          </div>
        ))}
      </div>
      {starters.length ? (
        <details>
          <summary className="mb-small" style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>Starter recipes ({starters.length})</summary>
          <div className="mb-list">
            {starters.map((r) => (
              <div key={r.id} className="mb-list-item" style={{ cursor: 'default' }}>
                <span><strong>{r.name}</strong> <span className="mb-hint">{formatNutrient(r.nutrition.perServing.calories, 'calories')}/serving</span> {basisBadge(r.nutrition.basis)}</span>
                <Button size="sm" variant="quiet" onClick={() => setDraft(fromRecipe(r, true))}>Copy &amp; edit</Button>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <RecipeEditor draft={draft} onClose={() => setDraft(null)} onSaved={(r) => { setDraft(null); recipes.reload(); onChanged?.(); toast(`Saved ${r.name}`); }} />
      <ConfirmDialog open={Boolean(deleting)} title="Delete recipe?" danger busy={busy} confirmLabel="Delete recipe"
        body={<p>{deleting?.name} will be removed. Existing plans and logs keep their copies.</p>}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          setBusy(true);
          try {
            await api.deleteRecipe(deleting.id);
            setDeleting(null);
            recipes.reload();
          } catch (e) {
            toast(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }} />
    </section>
  );
}

function RecipeEditor({ draft, onClose, onSaved }: { draft: Draft | null; onClose: () => void; onSaved: (r: Recipe) => void }) {
  const { api } = useNutrition();
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState<number | null>(null);
  const [saved, setSaved] = useState<Recipe | null>(null);
  if (draft && d === null) setD(draft);
  if (!draft && d !== null) { setD(null); setSaved(null); setError(null); }
  if (!d) return <Dialog open={false} title="" onClose={onClose}>{null}</Dialog>;

  const setIng = (i: number, patch: Partial<IngredientDraft>) => setD({ ...d, ingredients: d.ingredients.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const valid = d.name.trim() && d.mealTypes.length && Number(d.servings) > 0 && Number(d.prepMinutes) >= 0 &&
    d.ingredients.some((i) => i.name.trim()) &&
    d.ingredients.every((i) => !i.name.trim() || i.unit === 'to taste' || Number(i.quantity) > 0);

  async function save() {
    if (!d || !valid) return;
    setBusy(true);
    setError(null);
    const input: RecipeEditorInput = {
      name: d.name.trim(), mealTypes: d.mealTypes, prepMinutes: Math.round(Number(d.prepMinutes)), budgetLevel: d.budgetLevel,
      servings: Number(d.servings),
      instructions: d.instructions.split('\n').map((s) => s.trim()).filter(Boolean),
      ingredients: d.ingredients.filter((i) => i.name.trim()).map((i) => ({
        name: i.name.trim(), quantity: i.unit === 'to taste' ? null : Number(i.quantity), unit: i.unit, foodId: i.foodId,
      })),
    };
    try {
      const r = d.id ? await api.updateRecipe(d.id, input) : await api.createRecipe(input);
      if (r.nutrition.issues.length) {
        setSaved(r);
        setD({ ...d, id: r.id });
      } else {
        onSaved(r);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title={d.id ? 'Edit recipe' : 'New recipe'} onClose={onClose} footer={<>
      <Button onClick={onClose}>{saved ? 'Close' : 'Cancel'}</Button>
      <Button variant="primary" busy={busy} disabled={!valid} onClick={save}>Save recipe</Button>
    </>}>
      <div className="mb-stack-lg">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {saved ? (
          <Notice tone="warn" title="Saved — nutrition estimate is incomplete">
            <ul>{saved.nutrition.issues.map((x) => <li key={x}>{x}</li>)}</ul>
            Link each ingredient to a food and use a unit that food supports (grams always work).
          </Notice>
        ) : null}
        <Field label="Recipe name">{(id) => <input id={id} className="mb-input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />}</Field>
        <fieldset className="mb-fieldset">
          <legend>Good for</legend>
          <div className="mb-segmented">
            {PLANNED_MEAL_TYPES.map((m) => (
              <label key={m}><input type="checkbox" checked={d.mealTypes.includes(m)}
                onChange={(e) => setD({ ...d, mealTypes: e.target.checked ? [...d.mealTypes, m] : d.mealTypes.filter((x) => x !== m) })} />{MEAL_LABELS[m]}</label>
            ))}
          </div>
        </fieldset>
        <div className="mb-grid-2">
          <Field label="Makes (servings)">{(id) => <input id={id} className="mb-input" type="number" min="0.5" step="0.5" value={d.servings} onChange={(e) => setD({ ...d, servings: e.target.value })} />}</Field>
          <Field label="Prep time (minutes)">{(id) => <input id={id} className="mb-input" type="number" min="0" value={d.prepMinutes} onChange={(e) => setD({ ...d, prepMinutes: e.target.value })} />}</Field>
          <Field label="Cost">{(id) => (
            <select id={id} className="mb-select" value={d.budgetLevel} onChange={(e) => setD({ ...d, budgetLevel: e.target.value as Draft['budgetLevel'] })}>
              <option value="low">Lower</option><option value="medium">Moderate</option><option value="high">Higher</option>
            </select>
          )}</Field>
        </div>

        <fieldset className="mb-fieldset">
          <legend>Ingredients</legend>
          <p className="mb-hint">Link an ingredient to a food so MealBase can estimate nutrition. Unlinked ingredients are listed but not counted.</p>
          {d.ingredients.map((ing, i) => (
            <div key={i} className="mb-stack" style={{ borderTop: i ? '1px dashed var(--mb-line)' : undefined, paddingTop: i ? 8 : 0 }}>
              <div className="mb-grid-2">
                <Field label={`Ingredient ${i + 1}`}>{(id) => <input id={id} className="mb-input" value={ing.name} onChange={(e) => setIng(i, { name: e.target.value })} />}</Field>
                <Field label="Amount">{(id) => <input id={id} className="mb-input" type="number" min="0" step="any" disabled={ing.unit === 'to taste'} value={ing.quantity} onChange={(e) => setIng(i, { quantity: e.target.value })} />}</Field>
                <Field label="Unit">{(id) => (
                  <select id={id} className="mb-select" value={ing.unit} onChange={(e) => setIng(i, { unit: e.target.value })}>
                    {[...new Set([...UNITS, ing.unit])].map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                )}</Field>
              </div>
              <div className="mb-row">
                {ing.foodId ? <span className="mb-badge mb-badge-accent">Linked: {ing.foodLabel ?? 'food'}</span> : <span className="mb-badge">Not linked</span>}
                <Button size="sm" variant="quiet" onClick={() => setLinking(linking === i ? null : i)}>{ing.foodId ? 'Change food' : 'Link food'}</Button>
                {ing.foodId ? <Button size="sm" variant="quiet" onClick={() => setIng(i, { foodId: null, foodLabel: null })}>Unlink</Button> : null}
                <Button size="sm" variant="quiet" className="mb-btn-danger" disabled={d.ingredients.length === 1}
                  onClick={() => setD({ ...d, ingredients: d.ingredients.filter((_, j) => j !== i) })}>Remove</Button>
              </div>
              {linking === i ? <FoodLinker initial={ing.name} onPick={(foodId, label) => { setIng(i, { foodId, foodLabel: label, name: ing.name || label }); setLinking(null); }} /> : null}
            </div>
          ))}
          <div><Button size="sm" onClick={() => setD({ ...d, ingredients: [...d.ingredients, { name: '', quantity: '', unit: 'g', foodId: null, foodLabel: null }] })}>Add ingredient</Button></div>
        </fieldset>

        <Field label="Preparation steps (one per line)">{(id) => <textarea id={id} className="mb-textarea" value={d.instructions} onChange={(e) => setD({ ...d, instructions: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}

function FoodLinker({ initial, onPick }: { initial: string; onPick: (foodId: string, label: string) => void }) {
  const { api } = useNutrition();
  const [q, setQ] = useState(initial);
  const [results, setResults] = useState<FoodSearchResult[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    if (q.trim().length < 2) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.searchFoods(q.trim());
      setResults([...r.results, ...r.mine, ...r.sample]);
      if (r.provider.status !== 'ok') setMsg(r.provider.message);
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-stack mb-panel" style={{ background: 'var(--mb-surface-2)' }}>
      <div className="mb-row" style={{ flexWrap: 'nowrap' }}>
        <input className="mb-input" aria-label="Search for a food to link" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
        <Button size="sm" busy={busy} onClick={search}>Search</Button>
      </div>
      {msg ? <p className="mb-hint">{msg}</p> : null}
      {results && !results.length ? <p className="mb-hint">No matches. Add the food manually from Food Search first, then link it here.</p> : null}
      <div className="mb-list" style={{ maxHeight: 220, overflow: 'auto' }}>
        {(results ?? []).map((r) => (
          <button key={r.ref} type="button" className="mb-list-item" onClick={async () => {
            setBusy(true);
            try {
              const food = await api.food(r.ref);
              onPick(food.id, food.name);
            } catch (e) {
              setMsg(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}>
            <span>{r.name}{r.brand ? <span className="mb-muted"> · {r.brand}</span> : null}</span>
            {r.isSample ? <span className="mb-badge mb-badge-sample">Sample</span> : <span className="mb-badge">{SOURCE_BADGE[r.source]}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
