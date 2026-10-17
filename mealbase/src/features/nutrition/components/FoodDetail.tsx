import { useMemo, useState } from 'react';
import type { Food, MealType } from '../../../shared/types/nutrition';
import { computePortion, formatNumber, isValidQuantity, NutritionError, portionUnitOptions, referenceUnitLabel } from '../../../shared/lib/nutrition';
import { Button, Field, Notice, NutrientList, Spinner } from '../../../shared/ui';
import { useNutrition } from '../app-context';
import { errorMessage, MEAL_LABELS, useAsync } from '../hooks';
import { newIdempotencyKey } from '../api/client';
import { SOURCE_NAME } from '../source-labels';

export function FoodDetail({ foodRef, mealType, date, onAdded, onViewDay }: {
  foodRef: string; mealType: MealType; date: string; onAdded: (name: string) => void; onViewDay: () => void;
}) {
  const { api } = useNutrition();
  const food = useAsync(() => api.food(foodRef), [foodRef]);

  if (food.loading && !food.data) return <Spinner label="Loading food details" />;
  if (food.error) {
    return (
      <Notice tone="error" title="Couldn't load this food">
        {food.error.message}
        <div><Button size="sm" onClick={food.reload}>Retry</Button></div>
      </Notice>
    );
  }
  if (!food.data) return null;
  return <FoodPortionForm key={food.data.id} food={food.data} mealType={mealType} date={date} onAdded={onAdded} onViewDay={onViewDay} onFoodChange={food.setData} />;
}

function FoodPortionForm({ food, mealType, date, onAdded, onViewDay, onFoodChange }: {
  food: Food; mealType: MealType; date: string; onAdded: (name: string) => void; onViewDay: () => void; onFoodChange: (f: Food) => void;
}) {
  const { api, toast } = useNutrition();
  const options = portionUnitOptions(food);
  const defaultUnit = food.servings[0] && food.reference.unit !== 'g' && food.reference.unit !== 'ml' ? `serving:${food.servings[0].id}` : food.reference.unit;
  const [qty, setQty] = useState(food.reference.unit === 'g' || food.reference.unit === 'ml' ? '100' : '1');
  const [unit, setUnit] = useState<string>(defaultUnit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One idempotency key per "add" attempt: double taps and retries can't duplicate.
  const [key, setKey] = useState(newIdempotencyKey);
  const [showServingForm, setShowServingForm] = useState(false);

  const q = Number(qty);
  const portion = useMemo(() => {
    if (!isValidQuantity(q)) return { error: 'Enter an amount greater than 0.' } as const;
    try {
      return { result: computePortion(food, { quantity: q, unit }) } as const;
    } catch (e) {
      return { error: e instanceof NutritionError ? e.message : 'Invalid portion.' } as const;
    }
  }, [food, q, unit]);

  async function add() {
    if ('error' in portion) return;
    setBusy(true);
    setError(null);
    try {
      await api.createLog({ localDate: date, mealType, foodId: food.id, quantity: q, unit, idempotencyKey: key });
      toast(`Added ${food.name} to ${MEAL_LABELS[mealType].toLowerCase()}`);
      setKey(newIdempotencyKey());
      onAdded(food.name);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="mb-stack-lg">
      <header className="mb-stack">
        <h1>{food.name}</h1>
        <div className="mb-row">
          {food.brand ? <span className="mb-muted">{food.brand}</span> : null}
          {food.isSample ? <span className="mb-badge mb-badge-sample">Sample data</span> : <span className="mb-badge">{SOURCE_NAME[food.source]}</span>}
          {food.dataType && food.source === 'usda' ? <span className="mb-badge">{food.dataType}</span> : null}
        </div>
      </header>

      <section className="mb-panel mb-stack" aria-labelledby="mb-ref">
        <h2 id="mb-ref">Per {formatNumber(food.reference.quantity, 2)} {referenceUnitLabel(food.reference)}</h2>
        <NutrientList values={food.reference.values} />
        {food.source === 'off' ? <p className="mb-hint">Entered by Open Food Facts contributors. Check it against the package label if it looks off.</p> : null}
        {food.attribution ? <p className="mb-footnote">{food.attribution}</p> : null}
      </section>

      <section className="mb-panel mb-stack" aria-labelledby="mb-portion">
        <h2 id="mb-portion">Your portion</h2>
        <div className="mb-grid-2">
          <Field label="Amount" error={'error' in portion && qty !== '' && !isValidQuantity(q) ? portion.error : null}>
            {(id, d) => <input id={id} aria-describedby={d} className="mb-input" type="number" inputMode="decimal" min="0" step="any" value={qty}
              aria-invalid={qty !== '' && !isValidQuantity(q)} onChange={(e) => setQty(e.target.value)} />}
          </Field>
          <Field label="Unit">{(id) => (
            <select id={id} className="mb-select" value={unit} onChange={(e) => setUnit(e.target.value)}>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}</Field>
        </div>
        {food.servings.length === 0 && (food.reference.unit === 'g' || food.reference.unit === 'ml') ? (
          <p className="mb-hint">No household servings are listed for this food. Weigh it in {food.reference.unit}, or add a serving size with its {food.reference.unit === 'g' ? 'weight' : 'volume'}.</p>
        ) : null}
        {food.reference.unit === 'g' || food.reference.unit === 'ml' ? (
          showServingForm ? (
            <AddServingForm food={food} onCancel={() => setShowServingForm(false)} onAdded={(f, servingId) => { onFoodChange(f); setUnit(`serving:${servingId}`); setQty('1'); setShowServingForm(false); }} />
          ) : (
            <div><Button size="sm" variant="quiet" onClick={() => setShowServingForm(true)}>Add a serving size</Button></div>
          )
        ) : null}

        {'result' in portion && portion.result ? (
          <div className="mb-stack">
            <p className="mb-small mb-muted">Estimated for {formatNumber(q, 2)} {portion.result.unitLabel}</p>
            <NutrientList values={portion.result.values} />
          </div>
        ) : qty !== '' && isValidQuantity(q) && 'error' in portion ? <Notice tone="warn">{portion.error}</Notice> : null}
      </section>

      {error ? <Notice tone="error">{error}<div><Button size="sm" onClick={add}>Try again</Button></div></Notice> : null}
      <div className="mb-row">
        <Button variant="primary" busy={busy} disabled={'error' in portion} onClick={add}>Add to {MEAL_LABELS[mealType]}</Button>
        <Button variant="quiet" onClick={onViewDay}>View day</Button>
      </div>
    </article>
  );
}

function AddServingForm({ food, onAdded, onCancel }: { food: Food; onAdded: (f: Food, servingId: string) => void; onCancel: () => void }) {
  const { api } = useNutrition();
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = Number(amount);
  const unit = food.reference.unit;
  return (
    <div className="mb-stack mb-panel" style={{ background: 'var(--mb-surface-2)' }}>
      <p className="mb-small">Add a serving you use, with its measured {unit === 'g' ? 'weight in grams' : 'volume in millilitres'}. MealBase won't guess conversions.</p>
      <div className="mb-grid-2">
        <Field label="Serving name">{(id) => <input id={id} className="mb-input" placeholder="e.g. 1 bowl" value={label} onChange={(e) => setLabel(e.target.value)} />}</Field>
        <Field label={unit === 'g' ? 'Weight (g)' : 'Volume (ml)'}>{(id) => <input id={id} className="mb-input" type="number" inputMode="decimal" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="mb-row">
        <Button size="sm" variant="primary" busy={busy} disabled={!label.trim() || !isValidQuantity(a)} onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const s = await api.addServing(food.id, label.trim(), a);
            onAdded({ ...food, servings: [...food.servings, s] }, s.id);
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}>Save serving</Button>
        <Button size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
