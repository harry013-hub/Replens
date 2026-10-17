import { useState } from 'react';
import { DIETS, type PlannerPreferences } from '../../../shared/types/planning';
import { Field, Notice } from '../../../shared/ui';
import { Link } from '../app-context';

const DIET_LABELS: Record<PlannerPreferences['diet'], string> = {
  none: 'No preference', vegetarian: 'Vegetarian', vegan: 'Vegan', pescatarian: 'Pescatarian',
};

function listToText(list: string[]) {
  return list.join(', ');
}
function textToList(text: string) {
  return text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
}

export function PlanPreferencesForm({ value, onChange, adultConfirmed }: {
  value: PlannerPreferences; onChange: (p: PlannerPreferences) => void; adultConfirmed: boolean;
}) {
  const set = <K extends keyof PlannerPreferences>(k: K, v: PlannerPreferences[K]) => onChange({ ...value, [k]: v });
  // Keep raw text while typing so commas aren't swallowed.
  const [excludeText, setExcludeText] = useState(listToText(value.excludeIngredients));
  const [allergyText, setAllergyText] = useState(listToText(value.allergies));

  return (
    <div className="mb-stack-lg">
      <fieldset className="mb-fieldset">
        <legend>Dietary preference</legend>
        <div className="mb-segmented">
          {DIETS.map((d) => (
            <label key={d}><input type="radio" name="mb-diet" checked={value.diet === d} onChange={() => set('diet', d)} />{DIET_LABELS[d]}</label>
          ))}
        </div>
      </fieldset>

      <div className="mb-grid-2">
        <Field label="Allergies" hint="Separate with commas, e.g. peanut, milk, sesame.">
          {(id, d) => <input id={id} aria-describedby={d} className="mb-input" value={allergyText}
            onChange={(e) => { setAllergyText(e.target.value); set('allergies', textToList(e.target.value)); }} />}
        </Field>
        <Field label="Ingredients to leave out" hint="e.g. mushrooms, coriander">
          {(id, d) => <input id={id} aria-describedby={d} className="mb-input" value={excludeText}
            onChange={(e) => { setExcludeText(e.target.value); set('excludeIngredients', textToList(e.target.value)); }} />}
        </Field>
      </div>
      {value.allergies.length ? (
        <Notice tone="warn">Allergy filtering checks recipe ingredient names and tags only. It can't see product labels or cross-contact, so always check packaging.</Notice>
      ) : null}

      <div className="mb-grid-2">
        <Field label="Preparation time">{(id) => (
          <select id={id} className="mb-select" value={value.maxPrepMinutes ?? ''} onChange={(e) => set('maxPrepMinutes', e.target.value ? Number(e.target.value) : null)}>
            <option value="">Any</option>
            <option value="10">Up to 10 minutes</option>
            <option value="15">Up to 15 minutes</option>
            <option value="20">Up to 20 minutes</option>
            <option value="30">Up to 30 minutes</option>
            <option value="45">Up to 45 minutes</option>
          </select>
        )}</Field>
        <Field label="Budget" hint="A rough guide to ingredient choice. No live prices are used.">{(id, d) => (
          <select id={id} aria-describedby={d} className="mb-select" value={value.budget} onChange={(e) => set('budget', e.target.value as PlannerPreferences['budget'])}>
            <option value="any">Any</option>
            <option value="medium">Lower to moderate</option>
            <option value="low">Lower cost</option>
          </select>
        )}</Field>
        <Field label="People" hint="Scales the grocery list. Nutrition stays per person.">{(id, d) => (
          <input id={id} aria-describedby={d} className="mb-input" type="number" min={1} max={20} value={value.people}
            onChange={(e) => set('people', Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))))} />
        )}</Field>
      </div>

      <label className="mb-check">
        <input type="checkbox" checked={value.allowRepeats} onChange={(e) => set('allowRepeats', e.target.checked)} />
        <span>Repeated meals are fine<br /><span className="mb-hint">Turn off to use each recipe at most once per week.</span></span>
      </label>

      <fieldset className="mb-fieldset">
        <legend>Planning mode</legend>
        <div className="mb-segmented">
          <label><input type="radio" name="mb-mode" checked={value.mode === 'general'} onChange={() => set('mode', 'general')} />General meal planning</label>
          <label><input type="radio" name="mb-mode" disabled={!adultConfirmed} checked={value.mode === 'target'} onChange={() => set('mode', 'target')} />Fit my daily calorie target</label>
        </div>
        {!adultConfirmed ? (
          <p className="mb-hint">Target-based planning is for adults (18+) using a target they already have. Confirm your age and add a target in <Link to="/settings">Settings</Link> to use it.</p>
        ) : null}
      </fieldset>

      {value.mode === 'target' ? (
        <div className="mb-grid-2">
          <Field label="Daily calorie target (kcal)" hint="Use the target you or your health professional chose. Snacks aren't planned.">{(id, d) => (
            <input id={id} aria-describedby={d} className="mb-input" type="number" min={1000} max={6000} step={50} value={value.calorieTarget ?? ''}
              onChange={(e) => set('calorieTarget', e.target.value ? Math.round(Number(e.target.value)) : null)} />
          )}</Field>
          <Field label="Allowed difference" hint="How close each day should be.">{(id, d) => (
            <select id={id} aria-describedby={d} className="mb-select" value={value.targetTolerancePct} onChange={(e) => set('targetTolerancePct', Number(e.target.value))}>
              {[5, 10, 15, 20].map((n) => <option key={n} value={n}>± {n}%</option>)}
            </select>
          )}</Field>
        </div>
      ) : (
        <p className="mb-hint">General planning uses one recipe serving per meal with no calorie target. Adjust servings afterwards to suit your appetite.</p>
      )}
    </div>
  );
}
