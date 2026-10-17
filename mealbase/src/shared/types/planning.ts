import type { NutrientValues, PlannedMealType } from './nutrition';

export const DIETS = ['none', 'vegetarian', 'vegan', 'pescatarian'] as const;
export type Diet = (typeof DIETS)[number];

export const BUDGETS = ['any', 'low', 'medium'] as const;
/** Rough ingredient-selection preference. Not based on live prices. */
export type BudgetPreference = (typeof BUDGETS)[number];
export type BudgetLevel = 'low' | 'medium' | 'high';

export interface PlannerPreferences {
  diet: Diet;
  /** Ingredient names to leave out, matched against ingredient names. */
  excludeIngredients: string[];
  /** Allergies. Known allergens (milk, egg, peanut, …) use ingredient tags + names. */
  allergies: string[];
  /** null = no limit */
  maxPrepMinutes: number | null;
  budget: BudgetPreference;
  /** Number of people the grocery list should cover. Nutrition is shown per person. */
  people: number;
  /**
   * 'general' plans normal portions with no calorie target.
   * 'target' fits meals to the adult user's own daily target (requires adult confirmation).
   */
  mode: 'general' | 'target';
  /** Daily calorie target used for planning. Only applied in 'target' mode for confirmed adults. */
  calorieTarget: number | null;
  /** Allowed difference from the target, in percent. */
  targetTolerancePct: number;
  allowRepeats: boolean;
}

export const DEFAULT_PLANNER_PREFERENCES: PlannerPreferences = {
  diet: 'none',
  excludeIngredients: [],
  allergies: [],
  maxPrepMinutes: null,
  budget: 'any',
  people: 1,
  mode: 'general',
  calorieTarget: null,
  targetTolerancePct: 10,
  allowRepeats: true,
};

export interface RecipeIngredient {
  id: string;
  name: string;
  /** null for "to taste" style ingredients that are not counted. */
  quantity: number | null;
  /** g, ml, kg, l, tsp, tbsp, cup, piece, or a serving key such as "large" or "slice". */
  unit: string;
  /** Linked food record used to compute nutrition. */
  foodId: string | null;
  /** Explicit allergen tags (known). */
  allergens: string[];
  /** Possible cross-contact or uncertain allergen tags. */
  mayContain: string[];
  /** meat | fish | shellfish | dairy | egg | honey | plant | null */
  category: string | null;
  sortOrder: number;
}

export interface RecipeNutrition {
  /** Per serving of the recipe. Values are null when no ingredient provided data. */
  perServing: NutrientValues;
  /** False when one or more ingredients could not be matched or converted. */
  complete: boolean;
  issues: string[];
  /** Where the underlying numbers came from. */
  basis: 'usda' | 'sample' | 'manual' | 'mixed' | 'none';
}

export interface Recipe {
  id: string;
  ownerProfileId: string | null;
  name: string;
  description: string | null;
  mealTypes: PlannedMealType[];
  prepMinutes: number;
  budgetLevel: BudgetLevel;
  /** How many servings the ingredient list makes. */
  servings: number;
  instructions: string[];
  ingredients: RecipeIngredient[];
  nutrition: RecipeNutrition;
  isSample: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Recipe data frozen into a plan item so later recipe edits don't rewrite plans. */
export interface PlanRecipeSnapshot {
  recipeId: string | null;
  name: string;
  servings: number;
  prepMinutes: number | null;
  instructions: string[];
  ingredients: Array<Pick<RecipeIngredient, 'name' | 'quantity' | 'unit'>>;
  nutritionPerServing: NutrientValues;
  nutritionBasis: RecipeNutrition['basis'];
  nutritionComplete: boolean;
}

export interface MealPlanItem {
  id: string;
  planId: string;
  date: string;
  mealType: PlannedMealType;
  recipeId: string | null;
  foodId: string | null;
  name: string;
  /** Planned servings per person (multiplier of one recipe serving). */
  servings: number;
  /** Estimated nutrition for the planned portion, per person. */
  nutrition: NutrientValues;
  recipe: PlanRecipeSnapshot;
  notes: string | null;
  locked: boolean;
  /** Warnings such as uncertain allergen matches. */
  flags: string[];
  /** Number of food-log entries created from this item. */
  loggedCount: number;
  createdAt: string;
  updatedAt: string;
}

export type PlanStatus = 'draft' | 'saved' | 'replaced';

export interface DayTotal {
  date: string;
  nutrition: NutrientValues;
  target: number | null;
  difference: number | null;
  withinTolerance: boolean | null;
}

export interface MealPlan {
  id: string;
  profileId: string;
  weekStart: string;
  weekEnd: string;
  status: PlanStatus;
  preferences: PlannerPreferences;
  /** True when a calorie target was actually applied. */
  targetApplied: boolean;
  items: MealPlanItem[];
  dayTotals: DayTotal[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GroceryLine {
  name: string;
  amounts: Array<{ quantity: number; unit: string }>;
  recipes: string[];
}
