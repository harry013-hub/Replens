/**
 * MealBase nutrition module — public browser-safe API.
 *
 * Import into a host application:
 *   import { NutritionApp, NutritionApiClient, subscribeNutritionEvents } from 'mealbase';
 *   import 'mealbase/styles.css';   // or import the two CSS files below
 *
 * Server-side pieces live in `src/server/public.ts`.
 */

// Data contracts
export * from './shared/types';

// Pure functions (usable on server or client)
export {
  computePortion, sumNutrients, scaleValues, addValues, portionUnitOptions, referenceUnitLabel,
  isValidQuantity, formatNutrient, formatNumber, NutritionError, NUTRIENT_LABELS, MAX_PORTION_QUANTITY,
} from './shared/lib/nutrition';
export { todayInTimeZone, nextWeekStart, startOfWeek, weekDates, addDays, isLocalDate, browserTimeZone, formatLocalDate } from './shared/lib/dates';
export { convertUnit, normalizeUnit, unitFamily } from './shared/lib/units';
export { resolveAllergy, detectAllergensByName, KNOWN_ALLERGENS } from './shared/lib/allergens';
export { buildGroceryList } from './services/meal-planner/grocery';
export { generatePlanSlots, computeDayTotals, PlanConflictError } from './services/meal-planner/planner';
export { computeRecipeNutrition } from './services/meal-planner/recipe-nutrition';

// API client & integration events (shared runtime only)
export { NutritionApiClient, ApiError, newIdempotencyKey } from './features/nutrition/api/client';
export { emitNutritionEvent, subscribeNutritionEvents } from './services/integration/events';

// UI
export { NutritionApp, type NutritionAppProps } from './features/nutrition/NutritionApp';
