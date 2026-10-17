import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generatePlanSlots, PlanConflictError, computeDayTotals, type ExistingSlot, SERVING_MULTIPLIERS } from '../src/services/meal-planner/planner';
import type { PlannerRecipe } from '../src/services/meal-planner/filters';
import { buildGroceryList } from '../src/services/meal-planner/grocery';
import { DEFAULT_PLANNER_PREFERENCES, type PlannerPreferences } from '../src/shared/types/planning';
import { weekDates } from '../src/shared/lib/dates';
import { PLANNED_MEAL_TYPES } from '../src/shared/types/nutrition';

const dates = weekDates('2026-10-19');

function recipe(id: string, mealTypes: PlannerRecipe['mealTypes'], calories: number, ingredients: Array<Partial<PlannerRecipe['ingredients'][number]> & { name: string }>, extra: Partial<PlannerRecipe> = {}): PlannerRecipe {
  return {
    id, name: id, mealTypes, prepMinutes: 15, budgetLevel: 'low', servings: 1, nutritionComplete: true,
    perServing: { calories, proteinG: 20, carbsG: 50, fatG: 10 },
    ingredients: ingredients.map((i) => ({ allergens: [], mayContain: [], category: 'plant', ...i })),
    ...extra,
  };
}

const RECIPES: PlannerRecipe[] = [
  recipe('oats', ['breakfast'], 380, [{ name: 'Rolled oats', mayContain: ['gluten'] }, { name: 'Milk', category: 'dairy', allergens: ['milk'] }]),
  recipe('pb-toast', ['breakfast'], 420, [{ name: 'Whole-wheat bread', allergens: ['wheat', 'gluten'] }, { name: 'Peanut butter', allergens: ['peanut'] }]),
  recipe('tofu-scramble', ['breakfast'], 350, [{ name: 'Tofu', allergens: ['soy'] }, { name: 'Spinach' }]),
  recipe('eggs', ['breakfast'], 400, [{ name: 'Egg', category: 'egg', allergens: ['egg'] }, { name: 'Mushrooms' }]),
  recipe('lentil-soup', ['lunch', 'dinner'], 450, [{ name: 'Lentils' }, { name: 'Carrot' }]),
  recipe('tuna-salad', ['lunch'], 500, [{ name: 'Tuna', category: 'fish', allergens: ['fish'] }, { name: 'Lettuce' }]),
  recipe('bean-bowl', ['lunch', 'dinner'], 600, [{ name: 'Black beans' }, { name: 'Rice' }]),
  recipe('chicken-bake', ['dinner'], 650, [{ name: 'Chicken breast', category: 'meat' }, { name: 'Sweet potato' }]),
  recipe('mushroom-pasta', ['dinner'], 700, [{ name: 'Pasta', allergens: ['wheat', 'gluten'] }, { name: 'Mushrooms' }]),
];

const prefs = (p: Partial<PlannerPreferences> = {}): PlannerPreferences => ({ ...DEFAULT_PLANNER_PREFERENCES, ...p });
const byId = new Map(RECIPES.map((r) => [r.id, r]));

describe('weekly planner', () => {
  it('creates 21 slots: breakfast, lunch and dinner for seven days', () => {
    const out = generatePlanSlots({ recipes: RECIPES, prefs: prefs(), dates, existing: [], regenerate: { scope: 'week' }, targetApplied: false, seed: 42 });
    assert.equal(out.slots.length, 21);
    for (const d of dates) {
      assert.deepEqual(out.slots.filter((s) => s.date === d).map((s) => s.mealType).sort(), [...PLANNED_MEAL_TYPES].sort());
    }
    for (const s of out.slots) assert.ok(byId.get(s.recipeId)!.mealTypes.includes(s.mealType));
  });

  it('is reproducible for the same seed', () => {
    const a = generatePlanSlots({ recipes: RECIPES, prefs: prefs(), dates, existing: [], regenerate: { scope: 'week' }, targetApplied: false, seed: 7 });
    const b = generatePlanSlots({ recipes: RECIPES, prefs: prefs(), dates, existing: [], regenerate: { scope: 'week' }, targetApplied: false, seed: 7 });
    assert.deepEqual(a, b);
  });

  it('never touches locked meals when regenerating the week or a day', () => {
    const first = generatePlanSlots({ recipes: RECIPES, prefs: prefs(), dates, existing: [], regenerate: { scope: 'week' }, targetApplied: false, seed: 1 });
    const existing: ExistingSlot[] = first.slots.map((s) => ({ ...s, locked: false, calories: byId.get(s.recipeId)!.perServing.calories }));
    existing[0].locked = true; // Monday breakfast
    existing[5].locked = true; // Tuesday dinner
    for (let seed = 0; seed < 20; seed++) {
      const week = generatePlanSlots({ recipes: RECIPES, prefs: prefs(), dates, existing, regenerate: { scope: 'week' }, targetApplied: false, seed });
      assert.equal(week.slots.length, 19);
      assert.ok(!week.slots.some((s) => s.date === existing[0].date && s.mealType === existing[0].mealType));
      assert.ok(!week.slots.some((s) => s.date === existing[5].date && s.mealType === existing[5].mealType));
    }
    const day = generatePlanSlots({ recipes: RECIPES, prefs: prefs(), dates, existing, regenerate: { scope: 'day', date: dates[0] }, targetApplied: false, seed: 3 });
    assert.equal(day.slots.length, 2);
    assert.ok(day.slots.every((s) => s.date === dates[0] && s.mealType !== 'breakfast'));
  });

  it('swapping one slot chooses a different recipe when one exists', () => {
    const existing: ExistingSlot[] = [{ date: dates[0], mealType: 'breakfast', recipeId: 'oats', servings: 1, locked: false, calories: 380 }];
    for (let seed = 0; seed < 15; seed++) {
      const out = generatePlanSlots({ recipes: RECIPES, prefs: prefs(), dates, existing, regenerate: { scope: 'slot', date: dates[0], mealType: 'breakfast' }, targetApplied: false, seed });
      const swapped = out.slots.find((s) => s.date === dates[0] && s.mealType === 'breakfast')!;
      assert.notEqual(swapped.recipeId, 'oats');
    }
  });

  it('respects excluded ingredients and allergies, and flags uncertain matches', () => {
    const out = generatePlanSlots({
      recipes: RECIPES, prefs: prefs({ excludeIngredients: ['mushroom'], allergies: ['peanut', 'gluten'] }), dates, existing: [], regenerate: { scope: 'week' }, targetApplied: false, seed: 11,
    });
    const used = new Set(out.slots.map((s) => s.recipeId));
    for (const banned of ['pb-toast', 'eggs', 'mushroom-pasta']) assert.ok(!used.has(banned), `${banned} should be excluded`);
    const oats = out.slots.find((s) => s.recipeId === 'oats');
    assert.ok(oats, 'oats remain eligible (only may-contain gluten)');
    assert.ok(oats!.flags.some((f) => /may contain gluten/.test(f)));
  });

  it('applies diets using ingredient categories and names', () => {
    const vegan = generatePlanSlots({ recipes: RECIPES, prefs: prefs({ diet: 'vegan' }), dates, existing: [], regenerate: { scope: 'week' }, targetApplied: false, seed: 5 });
    const used = new Set(vegan.slots.map((s) => s.recipeId));
    for (const r of ['oats', 'eggs', 'tuna-salad', 'chicken-bake']) assert.ok(!used.has(r));
    const pesc = generatePlanSlots({ recipes: RECIPES, prefs: prefs({ diet: 'pescatarian' }), dates, existing: [], regenerate: { scope: 'week' }, targetApplied: false, seed: 5 });
    assert.ok(!pesc.slots.some((s) => s.recipeId === 'chicken-bake'));
  });

  it('explains conflicts instead of ignoring preferences', () => {
    assert.throws(
      () => generatePlanSlots({ recipes: RECIPES, prefs: prefs({ allergies: ['soy', 'egg', 'milk', 'peanut'] }), dates, existing: [], regenerate: { scope: 'week' }, targetApplied: false, seed: 1 }),
      (e: unknown) => e instanceof PlanConflictError && e.problems.some((p) => /breakfast/.test(p) && /allergy/.test(p)),
    );
    assert.throws(
      () => generatePlanSlots({ recipes: RECIPES, prefs: prefs({ allowRepeats: false }), dates, existing: [], regenerate: { scope: 'week' }, targetApplied: false, seed: 1 }),
      (e: unknown) => e instanceof PlanConflictError && e.problems.some((p) => /without repeating/.test(p)),
    );
  });

  it('does not repeat recipes when repeats are off and enough exist', () => {
    const many: PlannerRecipe[] = [];
    for (const m of PLANNED_MEAL_TYPES) for (let i = 0; i < 8; i++) many.push(recipe(`${m}-${i}`, [m], 400 + i * 10, [{ name: 'Rice' }]));
    const out = generatePlanSlots({ recipes: many, prefs: prefs({ allowRepeats: false }), dates, existing: [], regenerate: { scope: 'week' }, targetApplied: false, seed: 9 });
    assert.equal(new Set(out.slots.map((s) => s.recipeId)).size, 21);
  });

  it('fits a calorie target with realistic portions and reports honest differences', () => {
    const target = 2000;
    const out = generatePlanSlots({ recipes: RECIPES, prefs: prefs({ mode: 'target', calorieTarget: target, targetTolerancePct: 10 }), dates, existing: [], regenerate: { scope: 'week' }, targetApplied: true, seed: 21 });
    assert.equal(out.slots.length, 21, 'no meals are omitted to hit a number');
    for (const s of out.slots) assert.ok((SERVING_MULTIPLIERS as readonly number[]).includes(s.servings) && s.servings >= 0.75);
    const items = out.slots.map((s) => ({ date: s.date, nutrition: { ...byId.get(s.recipeId)!.perServing, calories: byId.get(s.recipeId)!.perServing.calories! * s.servings } }));
    const totals = computeDayTotals(items, dates, target, 10);
    for (const d of totals) {
      assert.ok(d.withinTolerance, `${d.date} total ${d.nutrition.calories} should be within 10% of ${target}`);
      assert.equal(d.difference, d.nutrition.calories! - target);
    }
  });

  it('says so when a target cannot be met rather than shrinking portions', () => {
    const out = generatePlanSlots({ recipes: RECIPES, prefs: prefs({ mode: 'target', calorieTarget: 1000, targetTolerancePct: 5 }), dates, existing: [], regenerate: { scope: 'week' }, targetApplied: true, seed: 2 });
    assert.ok(out.slots.every((s) => s.servings >= 0.75));
    const items = out.slots.map((s) => ({ date: s.date, nutrition: { calories: byId.get(s.recipeId)!.perServing.calories! * s.servings, proteinG: null, carbsG: null, fatG: null } }));
    const totals = computeDayTotals(items, dates, 1000, 5);
    assert.ok(totals.some((d) => d.withinTolerance === false), 'impossible targets are reported as outside tolerance');
  });
});

describe('grocery list', () => {
  const snap = (name: string, servings: number, ingredients: Array<{ name: string; quantity: number | null; unit: string }>) => ({
    recipeId: null, name, servings, prepMinutes: 10, instructions: [], ingredients,
    nutritionPerServing: { calories: null, proteinG: null, carbsG: null, fatG: null }, nutritionBasis: 'none' as const, nutritionComplete: false,
  });

  it('combines compatible units and keeps incompatible ones separate', () => {
    const lines = buildGroceryList([
      { recipe: snap('A', 1, [{ name: 'Rolled oats', quantity: 50, unit: 'g' }, { name: 'Milk', quantity: 1, unit: 'cup' }]), servings: 1 },
      { recipe: snap('B', 2, [{ name: 'rolled oats', quantity: 1, unit: 'kg' }, { name: 'Milk', quantity: 2, unit: 'tbsp' }, { name: 'Milk', quantity: 100, unit: 'g' }]), servings: 1 },
      { recipe: snap('C', 1, [{ name: 'Egg', quantity: 2, unit: 'large' }, { name: 'Salt', quantity: null, unit: 'to taste' }]), servings: 1.5 },
    ], 2);
    const oats = lines.find((l) => l.name.toLowerCase() === 'rolled oats')!;
    // A: 50 g × 2 people; B: 1 kg × (1 serving × 2 people / 2 yield) = 1 kg → 1.1 kg
    assert.deepEqual(oats.amounts, [{ quantity: 1.1, unit: 'kg' }]);
    const milk = lines.find((l) => l.name === 'Milk')!;
    assert.equal(milk.amounts.length, 2, 'volume and mass of milk stay separate');
    const vol = milk.amounts.find((a) => a.unit === 'ml')!;
    assert.ok(Math.abs(vol.quantity - (2 * 236.5882365 + 2 * 14.78676478125)) < 1e-6);
    assert.deepEqual(milk.amounts.find((a) => a.unit === 'g'), { quantity: 100, unit: 'g' });
    assert.deepEqual(lines.find((l) => l.name === 'Egg')!.amounts, [{ quantity: 6, unit: 'large' }]);
    assert.deepEqual(lines.find((l) => l.name === 'Salt')!.amounts, [{ quantity: 0, unit: 'to taste' }]);
  });
});
