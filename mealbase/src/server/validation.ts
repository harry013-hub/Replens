/**
 * Request validation (zod). Everything entering the API is checked here.
 */
import { z } from 'zod';
import { MEAL_TYPES, PLANNED_MEAL_TYPES, REFERENCE_UNITS } from '../shared/types/nutrition';
import { BUDGETS, DIETS } from '../shared/types/planning';
import { isLocalDate, isValidTimeZone } from '../shared/lib/dates';
import { MAX_PORTION_QUANTITY } from '../shared/lib/nutrition';
import { HttpError } from './http/router';
import { MAX_TARGET, MIN_TARGET } from '../services/meal-planner/planner';

export const localDate = z.string().refine(isLocalDate, 'Use a date in YYYY-MM-DD format.');
const quantity = z.number().finite().gt(0, 'Amount must be greater than 0.').max(MAX_PORTION_QUANTITY);
const nutrient = z.number().finite().min(0).max(100_000).nullable();
const shortText = (max: number) => z.string().trim().min(1).max(max);
const idempotencyKey = z.string().trim().min(8).max(100);

export const createLogSchema = z
  .object({
    localDate,
    mealType: z.enum(MEAL_TYPES),
    foodId: z.string().max(100).optional(),
    quantity: quantity.optional(),
    unit: z.string().max(100).optional(),
    quick: z
      .object({
        name: shortText(200),
        calories: nutrient,
        proteinG: nutrient.optional(),
        carbsG: nutrient.optional(),
        fatG: nutrient.optional(),
      })
      .optional(),
    displayName: z.string().trim().max(200).optional(),
    idempotencyKey: idempotencyKey.optional(),
  })
  .refine((v) => Boolean(v.quick) !== Boolean(v.foodId), 'Provide either foodId (with quantity and unit) or quick.')
  .refine((v) => !v.foodId || (v.quantity !== undefined && v.unit), 'quantity and unit are required with foodId.');

export const updateLogSchema = z
  .object({
    localDate: localDate.optional(),
    mealType: z.enum(MEAL_TYPES).optional(),
    quantity: quantity.optional(),
    unit: z.string().max(100).optional(),
    displayName: shortText(200).optional(),
  })
  .strict();

export const manualFoodSchema = z.object({
  name: shortText(200),
  brand: z.string().trim().max(200).nullable().optional(),
  referenceQuantity: quantity,
  referenceUnit: z.enum(REFERENCE_UNITS),
  unitLabel: z.string().trim().max(50).nullable().optional(),
  calories: nutrient,
  proteinG: nutrient.optional(),
  carbsG: nutrient.optional(),
  fatG: nutrient.optional(),
});

export const servingSchema = z.object({
  label: shortText(100),
  /** Amount of the food's reference unit (g or ml) in one of this serving. */
  refAmount: quantity,
  unitKey: z.string().trim().max(30).nullable().optional(),
});

export const plannerPrefsSchema = z.object({
  diet: z.enum(DIETS),
  excludeIngredients: z.array(z.string().trim().max(60)).max(50),
  allergies: z.array(z.string().trim().max(60)).max(30),
  maxPrepMinutes: z.number().int().min(5).max(600).nullable(),
  budget: z.enum(BUDGETS),
  people: z.number().int().min(1).max(20),
  mode: z.enum(['general', 'target']),
  calorieTarget: z.number().int().min(MIN_TARGET).max(MAX_TARGET).nullable(),
  targetTolerancePct: z.number().min(2).max(30),
  allowRepeats: z.boolean(),
});

export const preferencesSchema = z.object({
  dailyCalorieTarget: z.number().int().min(MIN_TARGET).max(MAX_TARGET).nullable(),
  adultConfirmed: z.boolean(),
  timezone: z.string().refine(isValidTimeZone, 'Unknown timezone.'),
  planner: plannerPrefsSchema,
});

export const generatePlanSchema = z.object({
  weekStart: localDate.optional(),
  preferences: plannerPrefsSchema.partial().optional(),
  seed: z.number().int().min(0).max(2 ** 31).optional(),
});

export const regenerateSchema = z.object({
  scope: z.enum(['week', 'day']),
  date: localDate.optional(),
  seed: z.number().int().min(0).max(2 ** 31).optional(),
});

export const updatePlanItemSchema = z
  .object({
    servings: z.number().finite().min(0.25).max(10).optional(),
    locked: z.boolean().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    recipeId: z.string().max(100).optional(),
    custom: z
      .object({
        name: shortText(200),
        calories: nutrient,
        proteinG: nutrient.optional(),
        carbsG: nutrient.optional(),
        fatG: nutrient.optional(),
        ingredients: z.array(z.string().trim().max(200)).max(50).optional(),
        instructions: z.array(z.string().trim().max(1000)).max(30).optional(),
      })
      .optional(),
  })
  .strict()
  .refine((v) => !(v.recipeId && v.custom), 'Choose a recipe or a custom meal, not both.');

export const logPlanItemSchema = z.object({
  servingsEaten: z.number().finite().gt(0).max(20),
  localDate,
  mealType: z.enum(MEAL_TYPES),
  idempotencyKey,
  allowRepeat: z.boolean().optional(),
});

export const recipeSchema = z.object({
  name: shortText(200),
  description: z.string().trim().max(1000).nullable().optional(),
  mealTypes: z.array(z.enum(PLANNED_MEAL_TYPES)).min(1),
  prepMinutes: z.number().int().min(0).max(600),
  budgetLevel: z.enum(['low', 'medium', 'high']),
  servings: z.number().finite().gt(0).max(50),
  instructions: z.array(z.string().trim().min(1).max(1000)).max(30),
  ingredients: z
    .array(
      z.object({
        name: shortText(200),
        quantity: z.number().finite().gt(0).max(100_000).nullable(),
        unit: shortText(30),
        foodId: z.string().max(100).nullable(),
        allergens: z.array(z.string().max(30)).max(10).optional(),
      }),
    )
    .min(1)
    .max(60),
});

export const registerSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
  displayName: z.string().trim().max(100).optional(),
  timezone: z.string().refine(isValidTimeZone).optional(),
});

export const loginSchema = z.object({ email: z.string().trim().max(200), password: z.string().max(200) });

export const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().refine(isValidTimeZone, 'Unknown timezone.').optional(),
});

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
    throw new HttpError(400, 'VALIDATION_ERROR', `${where}${first?.message ?? 'Invalid request.'}`, r.error.issues);
  }
  return r.data;
}
