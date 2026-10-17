/**
 * Core nutrition data contracts shared by the server, the UI and any host
 * application that embeds MealBase. Everything here is plain data (JSON-safe).
 *
 * Conventions
 * - IDs are opaque strings (UUIDs). Never parse them.
 * - Dates that mean "a day in the user's life" are local calendar dates, `YYYY-MM-DD`.
 * - Timestamps are ISO-8601 UTC strings.
 * - Every quantity travels with an explicit unit.
 * - `null` nutrient values mean "unavailable", never zero.
 */

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

/** Meals the weekly planner fills. Snacks are logged but not planned. */
export const PLANNED_MEAL_TYPES = ['breakfast', 'lunch', 'dinner'] as const;
export type PlannedMealType = (typeof PLANNED_MEAL_TYPES)[number];

/**
 * Units a nutrition reference can be expressed in.
 * - g / ml: physical amounts. Grams and millilitres are never converted into each other.
 * - piece: a countable item ("1 egg") whose weight is unknown unless a serving says so.
 * - serving: a named serving ("1 bowl") with no known weight.
 */
export const REFERENCE_UNITS = ['g', 'ml', 'piece', 'serving'] as const;
export type ReferenceUnit = (typeof REFERENCE_UNITS)[number];

export interface NutrientValues {
  /** kcal */
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}

export const NUTRIENT_KEYS = ['calories', 'proteinG', 'carbsG', 'fatG'] as const;
export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

/** Nutrient values for a stated reference amount, e.g. "per 100 g". */
export interface NutritionReference {
  quantity: number;
  unit: ReferenceUnit;
  /** Optional human label for piece / serving units, e.g. "slice" or "bowl". */
  unitLabel?: string | null;
  values: NutrientValues;
}

/**
 * A named portion with a known size in the food's reference unit.
 * Example: food reference is per 100 g, serving "1 cup, sliced" has refAmount 150 (g).
 */
export interface ServingOption {
  id: string;
  label: string;
  /** Short key used by recipes, e.g. "cup", "tbsp", "large". */
  unitKey: string | null;
  /** Amount of the food's reference unit contained in ONE of this serving. */
  refAmount: number;
  source: 'provider' | 'user' | 'sample';
}

export type FoodSource = 'usda' | 'off' | 'manual' | 'sample';

export interface Food {
  id: string;
  source: FoodSource;
  /** Identifier in the source system (e.g. USDA fdcId). */
  sourceFoodId: string | null;
  name: string;
  brand: string | null;
  /** Provider data type, e.g. "Foundation", "SR Legacy", "Branded". */
  dataType: string | null;
  reference: NutritionReference;
  servings: ServingOption[];
  /** True for development sample data that did not come from a live provider. */
  isSample: boolean;
  attribution: string | null;
}

/**
 * A portion selection. `unit` is either the food's reference unit
 * (`g`, `ml`, `piece`, `serving`) or `serving:<servingOptionId>`.
 */
export interface Portion {
  quantity: number;
  unit: string;
}

/** Totals over many items, with a count of items lacking each nutrient. */
export interface NutrientTotals extends NutrientValues {
  itemCount: number;
  missing: Record<NutrientKey, number>;
}

/**
 * Frozen copy of the data used to compute a logged entry's nutrition.
 * Old logs stay stable even if provider data or recipes change later.
 */
export interface NutritionSnapshot {
  version: 1;
  source: FoodSource | 'recipe' | 'plan' | 'quick';
  sourceFoodId: string | null;
  isSample: boolean;
  reference: NutritionReference;
  /** When the portion used a named serving. */
  serving: { label: string; refAmount: number } | null;
  /** Nutrition of the consumed portion (full precision). */
  values: NutrientValues;
  computedAt: string;
}

export interface FoodLogEntry {
  id: string;
  profileId: string;
  localDate: string;
  mealType: MealType;
  foodId: string | null;
  recipeId: string | null;
  displayName: string;
  quantity: number;
  unit: string;
  /** Human-readable unit, e.g. "g" or "cup, sliced". */
  unitLabel: string;
  nutrition: NutrientValues;
  snapshot: NutritionSnapshot;
  sourcePlanItemId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MealSummary {
  mealType: MealType;
  entries: FoodLogEntry[];
  totals: NutrientTotals;
}

export interface DailySummary {
  localDate: string;
  totals: NutrientTotals;
  meals: MealSummary[];
  /** Optional user-chosen target. Comparison is informational only. */
  dailyCalorieTarget: number | null;
}
