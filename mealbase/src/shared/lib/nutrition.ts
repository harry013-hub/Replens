/**
 * Pure nutrition calculations. No I/O, safe to use in browser, server and tests.
 * Precision is kept internally; round only when displaying (see format* helpers).
 */
import {
  NUTRIENT_KEYS,
  type NutrientKey,
  type NutrientTotals,
  type NutrientValues,
  type NutritionReference,
  type Portion,
  type ServingOption,
} from '../types/nutrition';

export const MAX_PORTION_QUANTITY = 100_000;

export class NutritionError extends Error {
  constructor(
    public readonly code: 'INVALID_PORTION' | 'UNIT_CONVERSION_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'NutritionError';
  }
}

export const EMPTY_VALUES: NutrientValues = { calories: null, proteinG: null, carbsG: null, fatG: null };

export function isValidQuantity(q: unknown): q is number {
  return typeof q === 'number' && Number.isFinite(q) && q > 0 && q <= MAX_PORTION_QUANTITY;
}

export function assertValidQuantity(q: unknown, what = 'Amount'): asserts q is number {
  if (!isValidQuantity(q)) {
    throw new NutritionError('INVALID_PORTION', `${what} must be a number greater than 0.`);
  }
}

/** Multiply every available nutrient by `factor`; unavailable stays unavailable. */
export function scaleValues(values: NutrientValues, factor: number): NutrientValues {
  const out = { ...EMPTY_VALUES };
  for (const k of NUTRIENT_KEYS) {
    const v = values[k];
    out[k] = v === null || v === undefined ? null : v * factor;
  }
  return out;
}

export interface PortionSource {
  reference: NutritionReference;
  servings: ServingOption[];
}

export interface PortionResult {
  values: NutrientValues;
  /** Amount of the reference unit the portion represents. */
  referenceAmount: number;
  serving: ServingOption | null;
  unitLabel: string;
}

/**
 * Compute nutrition for a portion of a food.
 *
 * Portion units:
 * - the food's own reference unit (e.g. `g` when the reference is per 100 g)
 * - `serving:<id>` for a named serving with a known size in the reference unit
 *
 * Grams, millilitres, pieces and servings are never converted into each other
 * unless a serving option supplies that conversion.
 */
export function computePortion(food: PortionSource, portion: Portion): PortionResult {
  assertValidQuantity(portion.quantity);
  const ref = food.reference;
  if (!isValidQuantity(ref.quantity)) {
    throw new NutritionError('INVALID_PORTION', 'This food has an invalid nutrition reference amount.');
  }

  if (portion.unit === ref.unit) {
    const factor = portion.quantity / ref.quantity;
    return {
      values: scaleValues(ref.values, factor),
      referenceAmount: portion.quantity,
      serving: null,
      unitLabel: referenceUnitLabel(ref),
    };
  }

  if (portion.unit.startsWith('serving:')) {
    const id = portion.unit.slice('serving:'.length);
    const serving = food.servings.find((s) => s.id === id);
    if (!serving) {
      throw new NutritionError('UNIT_CONVERSION_UNAVAILABLE', 'That serving size is not available for this food.');
    }
    if (!isValidQuantity(serving.refAmount)) {
      throw new NutritionError('UNIT_CONVERSION_UNAVAILABLE', `“${serving.label}” has no usable size.`);
    }
    const referenceAmount = portion.quantity * serving.refAmount;
    return {
      values: scaleValues(ref.values, referenceAmount / ref.quantity),
      referenceAmount,
      serving,
      unitLabel: serving.label,
    };
  }

  throw new NutritionError(
    'UNIT_CONVERSION_UNAVAILABLE',
    `Can't convert ${portion.unit} to ${referenceUnitLabel(ref)} for this food. ` +
      `Choose ${referenceUnitLabel(ref)} or add a serving size with its ${ref.unit === 'ml' ? 'volume' : 'weight'}.`,
  );
}

export function referenceUnitLabel(ref: Pick<NutritionReference, 'unit' | 'unitLabel'>): string {
  if (ref.unit === 'g' || ref.unit === 'ml') return ref.unit;
  return ref.unitLabel?.trim() || ref.unit;
}

/** Portion units a UI can offer for a food. */
export function portionUnitOptions(food: PortionSource): Array<{ value: string; label: string }> {
  const opts = [{ value: food.reference.unit as string, label: referenceUnitLabel(food.reference) }];
  for (const s of food.servings) {
    const size = food.reference.unit === 'g' || food.reference.unit === 'ml'
      ? ` (${formatNumber(s.refAmount, 1)} ${food.reference.unit})`
      : '';
    opts.push({ value: `serving:${s.id}`, label: `${s.label}${size}` });
  }
  return opts;
}

export function emptyTotals(): NutrientTotals {
  return {
    ...EMPTY_VALUES,
    itemCount: 0,
    missing: { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  };
}

/**
 * Sum nutrient values. Missing values are counted, not treated as zero:
 * a total stays null only when no item had that nutrient.
 */
export function sumNutrients(items: NutrientValues[]): NutrientTotals {
  const t = emptyTotals();
  t.itemCount = items.length;
  for (const item of items) {
    for (const k of NUTRIENT_KEYS) {
      const v = item[k];
      if (v === null || v === undefined || !Number.isFinite(v)) {
        t.missing[k] += 1;
      } else {
        t[k] = (t[k] ?? 0) + v;
      }
    }
  }
  return t;
}

export function addValues(a: NutrientValues, b: NutrientValues): NutrientValues {
  const out = { ...EMPTY_VALUES };
  for (const k of NUTRIENT_KEYS) {
    const x = a[k];
    const y = b[k];
    out[k] = x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  }
  return out;
}

export function hasAnyValue(v: NutrientValues): boolean {
  return NUTRIENT_KEYS.some((k) => v[k] !== null);
}

// ---------- display helpers (rounding happens only here) ----------

export function formatNumber(n: number, maxFractionDigits = 0): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: maxFractionDigits }).format(n);
}

export function formatNutrient(value: number | null, key: NutrientKey): string {
  if (value === null || value === undefined) return 'Not available';
  if (key === 'calories') return `${formatNumber(Math.round(value))} kcal`;
  return `${formatNumber(value, value < 10 ? 1 : 0)} g`;
}

export const NUTRIENT_LABELS: Record<NutrientKey, string> = {
  calories: 'Calories',
  proteinG: 'Protein',
  carbsG: 'Carbohydrate',
  fatG: 'Fat',
};

export function missingNote(totals: NutrientTotals, key: NutrientKey): string | null {
  const n = totals.missing[key];
  if (!n) return null;
  return `${n} ${n === 1 ? 'item has' : 'items have'} no ${NUTRIENT_LABELS[key].toLowerCase()} data`;
}
