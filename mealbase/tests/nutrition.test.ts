import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePortion, formatNutrient, NutritionError, scaleValues, sumNutrients } from '../src/shared/lib/nutrition';
import type { NutritionReference, ServingOption } from '../src/shared/types/nutrition';
import { convertUnit } from '../src/shared/lib/units';

const per100g: NutritionReference = { quantity: 100, unit: 'g', values: { calories: 89, proteinG: 1.09, carbsG: 22.84, fatG: 0.33 } };
const servings: ServingOption[] = [{ id: 's1', label: '1 cup, sliced', unitKey: 'cup', refAmount: 150, source: 'provider' }];

describe('portion calculations', () => {
  it('scales a per-100 g reference to a 150 g portion', () => {
    const r = computePortion({ reference: per100g, servings }, { quantity: 150, unit: 'g' });
    assert.equal(r.values.calories, 133.5);
    assert.ok(Math.abs(r.values.proteinG! - 1.635) < 1e-9);
    assert.equal(r.referenceAmount, 150);
  });

  it('uses a provider serving weight for named servings', () => {
    const r = computePortion({ reference: per100g, servings }, { quantity: 2, unit: 'serving:s1' });
    assert.equal(r.referenceAmount, 300);
    assert.equal(r.values.calories, 267);
    assert.equal(r.unitLabel, '1 cup, sliced');
  });

  it('keeps full precision internally and rounds only for display', () => {
    const r = computePortion({ reference: per100g, servings: [] }, { quantity: 33, unit: 'g' });
    assert.equal(r.values.calories, 29.37);
    assert.equal(formatNutrient(r.values.calories, 'calories'), '29 kcal');
  });

  it('rejects zero, negative, NaN and absurd quantities', () => {
    for (const q of [0, -5, Number.NaN, Infinity, 1e9]) {
      assert.throws(() => computePortion({ reference: per100g, servings }, { quantity: q, unit: 'g' }), (e: unknown) => e instanceof NutritionError && e.code === 'INVALID_PORTION');
    }
  });

  it('never converts grams to millilitres or cups without a supplied conversion', () => {
    assert.throws(() => computePortion({ reference: per100g, servings: [] }, { quantity: 100, unit: 'ml' }), (e: unknown) => e instanceof NutritionError && e.code === 'UNIT_CONVERSION_UNAVAILABLE');
    assert.throws(() => computePortion({ reference: per100g, servings: [] }, { quantity: 1, unit: 'cup' }), /add a serving size/i);
    const perPiece: NutritionReference = { quantity: 1, unit: 'piece', unitLabel: 'bar', values: { calories: 210, proteinG: 10, carbsG: null, fatG: 7 } };
    assert.throws(() => computePortion({ reference: perPiece, servings: [] }, { quantity: 40, unit: 'g' }), NutritionError);
    assert.equal(computePortion({ reference: perPiece, servings: [] }, { quantity: 2, unit: 'piece' }).values.calories, 420);
  });

  it('keeps missing nutrients unavailable instead of zero', () => {
    const ref: NutritionReference = { quantity: 100, unit: 'g', values: { calories: 50, proteinG: null, carbsG: 9, fatG: null } };
    const r = computePortion({ reference: ref, servings: [] }, { quantity: 200, unit: 'g' });
    assert.equal(r.values.proteinG, null);
    assert.equal(r.values.fatG, null);
    assert.equal(formatNutrient(r.values.proteinG, 'proteinG'), 'Not available');
  });

  it('serving lookups fail clearly for unknown servings', () => {
    assert.throws(() => computePortion({ reference: per100g, servings }, { quantity: 1, unit: 'serving:nope' }), /not available/);
  });
});

describe('daily totals', () => {
  it('sums available values and counts missing ones', () => {
    const t = sumNutrients([
      { calories: 100, proteinG: 5, carbsG: null, fatG: 1 },
      { calories: null, proteinG: 2, carbsG: 10, fatG: null },
      { calories: 250.5, proteinG: null, carbsG: 30, fatG: 9 },
    ]);
    assert.equal(t.calories, 350.5);
    assert.equal(t.proteinG, 7);
    assert.equal(t.carbsG, 40);
    assert.equal(t.fatG, 10);
    assert.deepEqual(t.missing, { calories: 1, proteinG: 1, carbsG: 1, fatG: 1 });
    assert.equal(t.itemCount, 3);
  });

  it('an empty day has null totals and zero items', () => {
    const t = sumNutrients([]);
    assert.equal(t.calories, null);
    assert.equal(t.itemCount, 0);
  });

  it('scaleValues preserves nulls', () => {
    assert.deepEqual(scaleValues({ calories: 10, proteinG: null, carbsG: 2, fatG: null }, 3), { calories: 30, proteinG: null, carbsG: 6, fatG: null });
  });
});

describe('unit conversion', () => {
  it('converts within a family only', () => {
    assert.equal(convertUnit(1.5, 'kg', 'g'), 1500);
    assert.ok(Math.abs(convertUnit(3, 'tsp', 'tbsp')! - 1) < 1e-9);
    assert.equal(convertUnit(100, 'g', 'ml'), null);
    assert.equal(convertUnit(1, 'cup', 'g'), null);
    assert.equal(convertUnit(2, 'piece', 'g'), null);
  });
});
