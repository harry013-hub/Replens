/**
 * Decide which recipes fit a user's planning preferences, and explain why not.
 */
import type { NutrientValues, PlannedMealType } from '../../shared/types/nutrition';
import type { BudgetLevel, PlannerPreferences } from '../../shared/types/planning';
import {
  allergenLabel,
  blockedCategories,
  detectAllergensByName,
  detectCategoriesByName,
  nameMentions,
  resolveAllergy,
} from '../../shared/lib/allergens';

export interface PlannerIngredient {
  name: string;
  allergens: string[];
  mayContain: string[];
  category: string | null;
}

export interface PlannerRecipe {
  id: string;
  name: string;
  mealTypes: PlannedMealType[];
  prepMinutes: number;
  budgetLevel: BudgetLevel;
  servings: number;
  perServing: NutrientValues;
  nutritionComplete: boolean;
  ingredients: PlannerIngredient[];
}

export type ExclusionReason = 'diet' | 'excluded-ingredient' | 'allergy' | 'prep-time' | 'budget' | 'no-calorie-data';

export interface RecipeEvaluation {
  eligible: boolean;
  reasons: ExclusionReason[];
  /** Warnings to show with the meal when it is used. */
  flags: string[];
}

export function evaluateRecipe(recipe: PlannerRecipe, prefs: PlannerPreferences, targetApplied: boolean): RecipeEvaluation {
  const reasons = new Set<ExclusionReason>();
  const flags: string[] = [];

  const blocked = blockedCategories(prefs.diet);
  if (blocked.length) {
    for (const ing of recipe.ingredients) {
      const cats = new Set([...(ing.category ? [ing.category] : []), ...detectCategoriesByName(ing.name)]);
      if (blocked.some((b) => cats.has(b))) reasons.add('diet');
    }
  }

  for (const term of prefs.excludeIngredients) {
    if (!term.trim()) continue;
    if (nameMentions(recipe.name, term) || recipe.ingredients.some((i) => nameMentions(i.name, term))) {
      reasons.add('excluded-ingredient');
    }
  }

  for (const term of prefs.allergies) {
    if (!term.trim()) continue;
    const keys = resolveAllergy(term);
    if (keys.length === 0) {
      if (recipe.ingredients.some((i) => nameMentions(i.name, term)) || nameMentions(recipe.name, term)) {
        reasons.add('allergy');
      }
      continue;
    }
    for (const ing of recipe.ingredients) {
      const tagged = ing.allergens.some((a) => keys.includes(a as never));
      const detected = detectAllergensByName(ing.name).some((a) => keys.includes(a));
      if (tagged || detected) reasons.add('allergy');
      const maybe = ing.mayContain.filter((a) => keys.includes(a as never));
      for (const m of maybe) flags.push(`Check labels: ${ing.name} may contain ${allergenLabel(m)}.`);
    }
  }

  if (prefs.maxPrepMinutes !== null && recipe.prepMinutes > prefs.maxPrepMinutes) reasons.add('prep-time');

  if (prefs.budget === 'low' && recipe.budgetLevel !== 'low') reasons.add('budget');
  if (prefs.budget === 'medium' && recipe.budgetLevel === 'high') reasons.add('budget');

  if (targetApplied && recipe.perServing.calories === null) reasons.add('no-calorie-data');

  if (!recipe.nutritionComplete) flags.push('Nutrition estimate is incomplete for this recipe.');

  return { eligible: reasons.size === 0, reasons: [...reasons], flags: [...new Set(flags)] };
}

/** Plan-level warnings about preferences we can only partly check. */
export function preferenceWarnings(prefs: PlannerPreferences): string[] {
  const warnings: string[] = [];
  for (const term of prefs.allergies) {
    if (term.trim() && resolveAllergy(term).length === 0) {
      warnings.push(`“${term}” isn't in the built-in allergen list, so only ingredient names were checked.`);
    }
  }
  if (prefs.allergies.some((a) => a.trim())) {
    warnings.push('Allergy filtering uses recipe ingredient names and tags only. Always check product labels and cross-contact information.');
  }
  if (prefs.budget !== 'any') {
    warnings.push('Budget is a rough ingredient preference. MealBase has no live grocery prices.');
  }
  return warnings;
}

const REASON_TEXT: Record<ExclusionReason, (p: PlannerPreferences) => string> = {
  diet: (p) => `not ${p.diet}`,
  'excluded-ingredient': () => 'contain an excluded ingredient',
  allergy: () => 'match an allergy',
  'prep-time': (p) => `take longer than ${p.maxPrepMinutes} minutes`,
  budget: (p) => `are above the ${p.budget} budget preference`,
  'no-calorie-data': () => 'have no calorie data (needed to fit a target)',
};

export function explainNoCandidates(
  mealType: PlannedMealType,
  evaluations: Array<{ recipe: PlannerRecipe; evaluation: RecipeEvaluation }>,
  prefs: PlannerPreferences,
): string {
  const relevant = evaluations.filter((e) => e.recipe.mealTypes.includes(mealType));
  if (relevant.length === 0) return `There are no ${mealType} recipes in the collection yet. Add one in “My recipes”.`;
  const counts = new Map<ExclusionReason, number>();
  for (const { evaluation } of relevant) for (const r of evaluation.reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  const parts = [...counts.entries()].map(([r, n]) => `${n} ${REASON_TEXT[r](prefs)}`);
  return `None of the ${relevant.length} ${mealType} recipes fit: ${parts.join('; ')}. Loosen a preference or add your own ${mealType} recipe.`;
}
