/**
 * Recipe nutrition computed from ingredient quantities and linked food records.
 */
import { NUTRIENT_KEYS, type Food, type NutrientValues } from '../../shared/types/nutrition';
import type { RecipeIngredient, RecipeNutrition } from '../../shared/types/planning';
import { EMPTY_VALUES, scaleValues, sumNutrients } from '../../shared/lib/nutrition';
import { convertUnit, normalizeUnit, unitFamily } from '../../shared/lib/units';

export interface IngredientResolution {
  values: NutrientValues | null;
  referenceAmount: number | null;
  issue: string | null;
}

/** Amount of the food's reference unit that an ingredient line represents, or null. */
export function ingredientReferenceAmount(
  ing: Pick<RecipeIngredient, 'quantity' | 'unit'>,
  food: Pick<Food, 'reference' | 'servings'>,
): number | null {
  if (ing.quantity === null || !(ing.quantity > 0)) return null;
  const unit = normalizeUnit(ing.unit);
  const refUnit = food.reference.unit;

  if (unit === refUnit) return ing.quantity;

  // Same physical family as the reference (e.g. kg → g, l → ml, tbsp → ml).
  if ((refUnit === 'g' || refUnit === 'ml')) {
    const direct = convertUnit(ing.quantity, unit, refUnit);
    if (direct !== null) return direct;
  }

  // A named serving with the same key (e.g. "large" egg, "slice" of bread).
  const byKey = food.servings.find((s) => s.unitKey && normalizeUnit(s.unitKey) === unit);
  if (byKey) return ing.quantity * byKey.refAmount;

  // A volume measure we can convert to a volume serving the provider gave a weight for
  // (e.g. tbsp of milk using the "cup = 244 g" serving).
  if (unitFamily(unit) === 'volume') {
    for (const s of food.servings) {
      if (!s.unitKey || unitFamily(s.unitKey) !== 'volume') continue;
      const inServingUnits = convertUnit(ing.quantity, unit, s.unitKey);
      if (inServingUnits !== null) return inServingUnits * s.refAmount;
    }
  }
  return null;
}

export function resolveIngredient(
  ing: Pick<RecipeIngredient, 'name' | 'quantity' | 'unit' | 'foodId'>,
  foodsById: Map<string, Food>,
): IngredientResolution {
  if (ing.quantity === null) return { values: null, referenceAmount: null, issue: null };
  if (!ing.foodId) return { values: null, referenceAmount: null, issue: `${ing.name}: no food record linked` };
  const food = foodsById.get(ing.foodId);
  if (!food) return { values: null, referenceAmount: null, issue: `${ing.name}: linked food not found` };
  const amount = ingredientReferenceAmount(ing, food);
  if (amount === null) {
    return {
      values: null,
      referenceAmount: null,
      issue: `${ing.name}: can't convert ${ing.unit} to ${food.reference.unit} without a serving weight`,
    };
  }
  return { values: scaleValues(food.reference.values, amount / food.reference.quantity), referenceAmount: amount, issue: null };
}

export function computeRecipeNutrition(
  recipe: { servings: number; ingredients: Array<Pick<RecipeIngredient, 'name' | 'quantity' | 'unit' | 'foodId'>> },
  foodsById: Map<string, Food>,
): RecipeNutrition {
  const issues: string[] = [];
  const values: NutrientValues[] = [];
  const sources = new Set<string>();

  for (const ing of recipe.ingredients) {
    const r = resolveIngredient(ing, foodsById);
    if (r.issue) issues.push(r.issue);
    if (r.values) {
      values.push(r.values);
      const food = ing.foodId ? foodsById.get(ing.foodId) : undefined;
      if (food) sources.add(food.source);
      for (const k of NUTRIENT_KEYS) {
        if (r.values[k] === null) issues.push(`${ing.name}: ${k === 'calories' ? 'calories' : k.replace('G', '')} not available`);
      }
    }
  }

  const totals = sumNutrients(values);
  const servings = recipe.servings > 0 ? recipe.servings : 1;
  const perServing = values.length
    ? scaleValues({ calories: totals.calories, proteinG: totals.proteinG, carbsG: totals.carbsG, fatG: totals.fatG }, 1 / servings)
    : { ...EMPTY_VALUES };

  const basis: RecipeNutrition['basis'] =
    sources.size === 0 ? 'none' : sources.size > 1 ? 'mixed' : ([...sources][0] as 'usda' | 'off' | 'sample' | 'manual');

  return { perServing, complete: issues.length === 0 && values.length > 0, issues, basis };
}
