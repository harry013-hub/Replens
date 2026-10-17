import { useState, type FormEvent } from 'react';
import type { MealType, ReferenceUnit } from '../../../shared/types/nutrition';
import { computePortion, formatNutrient, isValidQuantity } from '../../../shared/lib/nutrition';
import { Button, Field, Notice } from '../../../shared/ui';
import { useNutrition } from '../app-context';
import { errorMessage, MEAL_LABELS } from '../hooks';
import { newIdempotencyKey } from '../api/client';

const UNIT_CHOICES: Array<{ value: ReferenceUnit; label: string }> = [
  { value: 'g', label: 'grams (g)' },
  { value: 'ml', label: 'millilitres (ml)' },
  { value: 'piece', label: 'pieces' },
  { value: 'serving', label: 'servings' },
];

function optionalNumber(v: string): number | null | 'invalid' {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 'invalid';
}

/** Manual entry: the user types values from a label. Blank nutrients are stored as unavailable, not zero. */
export function ManualFoodForm({ mealType, date, initialName, onDone }: { mealType: MealType; date: string; initialName: string; onDone: (name: string) => void }) {
  const { api, toast } = useNutrition();
  const [name, setName] = useState(initialName);
  const [brand, setBrand] = useState('');
  const [refQty, setRefQty] = useState('100');
  const [refUnit, setRefUnit] = useState<ReferenceUnit>('g');
  const [unitLabel, setUnitLabel] = useState('');
  const [cal, setCal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [eaten, setEaten] = useState('100');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFoodId, setSavedFoodId] = useState<string | null>(null);
  const [key] = useState(newIdempotencyKey);

  const nums = { cal: optionalNumber(cal), protein: optionalNumber(protein), carbs: optionalNumber(carbs), fat: optionalNumber(fat) };
  const invalidNutrient = Object.values(nums).includes('invalid');
  const rq = Number(refQty);
  const eq = Number(eaten);
  const valid = name.trim() && isValidQuantity(rq) && isValidQuantity(eq) && !invalidNutrient;

  const preview = valid
    ? computePortion(
        { reference: { quantity: rq, unit: refUnit, values: { calories: nums.cal as number | null, proteinG: nums.protein as number | null, carbsG: nums.carbs as number | null, fatG: nums.fat as number | null } }, servings: [] },
        { quantity: eq, unit: refUnit },
      ).values
    : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    let foodId = savedFoodId;
    try {
      if (!foodId) {
        const food = await api.createManualFood({
          name: name.trim(), brand: brand.trim() || null, referenceQuantity: rq, referenceUnit: refUnit,
          unitLabel: (refUnit === 'piece' || refUnit === 'serving') && unitLabel.trim() ? unitLabel.trim() : null,
          calories: nums.cal as number | null, proteinG: nums.protein as number | null, carbsG: nums.carbs as number | null, fatG: nums.fat as number | null,
        });
        foodId = food.id;
        setSavedFoodId(food.id);
      }
      await api.createLog({ localDate: date, mealType, foodId, quantity: eq, unit: refUnit, idempotencyKey: key });
      toast(`Added ${name.trim()} to ${MEAL_LABELS[mealType].toLowerCase()}`);
      onDone(name.trim());
    } catch (err) {
      setError(foodId ? `${errorMessage(err)} The food was saved to “Your foods”; select Save again to retry adding it.` : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const unitWord = refUnit === 'piece' || refUnit === 'serving' ? (unitLabel.trim() || (refUnit === 'piece' ? 'pieces' : 'servings')) : refUnit;

  return (
    <form className="mb-stack-lg" onSubmit={submit}>
      <section className="mb-panel mb-stack">
        <Field label="Food name">{(id) => <input id={id} className="mb-input" required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Brand (optional)">{(id) => <input id={id} className="mb-input" value={brand} onChange={(e) => setBrand(e.target.value)} />}</Field>
      </section>

      <section className="mb-panel mb-stack" aria-labelledby="mb-manual-ref">
        <h2 id="mb-manual-ref">Nutrition from the label</h2>
        <p className="mb-hint">Enter values exactly as listed. Leave a box empty if it isn't on the label — it will show as “Not available”, not zero.</p>
        <div className="mb-grid-2">
          <Field label="Values are for">{(id) => <input id={id} className="mb-input" type="number" inputMode="decimal" min="0" step="any" value={refQty} onChange={(e) => setRefQty(e.target.value)} />}</Field>
          <Field label="Unit">{(id) => (
            <select id={id} className="mb-select" value={refUnit} onChange={(e) => { setRefUnit(e.target.value as ReferenceUnit); if (e.target.value !== 'g' && e.target.value !== 'ml') { setRefQty('1'); setEaten('1'); } }}>
              {UNIT_CHOICES.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          )}</Field>
          {refUnit === 'piece' || refUnit === 'serving' ? (
            <Field label="Name of the unit (optional)" hint="e.g. slice, bar, cup">{(id, d) => <input id={id} aria-describedby={d} className="mb-input" value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} />}</Field>
          ) : null}
        </div>
        <div className="mb-grid-2">
          <Field label="Calories (kcal)">{(id) => <input id={id} className="mb-input" type="number" inputMode="decimal" min="0" step="any" value={cal} onChange={(e) => setCal(e.target.value)} />}</Field>
          <Field label="Protein (g)">{(id) => <input id={id} className="mb-input" type="number" inputMode="decimal" min="0" step="any" value={protein} onChange={(e) => setProtein(e.target.value)} />}</Field>
          <Field label="Carbohydrate (g)">{(id) => <input id={id} className="mb-input" type="number" inputMode="decimal" min="0" step="any" value={carbs} onChange={(e) => setCarbs(e.target.value)} />}</Field>
          <Field label="Fat (g)">{(id) => <input id={id} className="mb-input" type="number" inputMode="decimal" min="0" step="any" value={fat} onChange={(e) => setFat(e.target.value)} />}</Field>
        </div>
        {invalidNutrient ? <Notice tone="warn">Nutrient values must be 0 or more.</Notice> : null}
      </section>

      <section className="mb-panel mb-stack" aria-labelledby="mb-manual-eaten">
        <h2 id="mb-manual-eaten">How much you had</h2>
        <Field label={`Amount (${unitWord})`} error={eaten !== '' && !isValidQuantity(eq) ? 'Enter an amount greater than 0.' : null}>
          {(id, d) => <input id={id} aria-describedby={d} className="mb-input" type="number" inputMode="decimal" min="0" step="any" value={eaten} onChange={(e) => setEaten(e.target.value)} aria-invalid={eaten !== '' && !isValidQuantity(eq)} />}
        </Field>
        {preview ? <p className="mb-small">Estimated: <strong className="mb-num">{formatNutrient(preview.calories, 'calories')}</strong></p> : null}
      </section>

      {error ? <Notice tone="error">{error}</Notice> : null}
      <div><Button type="submit" variant="primary" busy={busy} disabled={!valid}>Save and add to {MEAL_LABELS[mealType]}</Button></div>
    </form>
  );
}
