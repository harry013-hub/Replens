/** Export/import formats shared by the server and the in-browser backend (no database imports). */
import { z } from 'zod';
import type { FoodLogEntry } from '../../shared/types/nutrition';
import { PLANNED_MEAL_TYPES } from '../../shared/types/nutrition';
import { localDate, plannerPrefsSchema } from '../validation';

export const PLANS_EXPORT_FORMAT = 'mealbase.plans';
export const PLANS_EXPORT_VERSION = 1;

export const CSV_COLUMNS = [
  'entry_id', 'local_date', 'meal_type', 'name', 'quantity', 'unit', 'calories_kcal', 'protein_g', 'carbohydrate_g', 'fat_g',
  'nutrition_source', 'sample_data', 'source_plan_item_id', 'created_at', 'updated_at',
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s) && typeof v !== 'number') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function logsToCsv(entries: FoodLogEntry[]): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const e of entries) {
    rows.push([
      e.id, e.localDate, e.mealType, e.displayName, e.quantity, e.unitLabel,
      e.nutrition.calories, e.nutrition.proteinG, e.nutrition.carbsG, e.nutrition.fatG,
      e.snapshot?.source ?? '', e.snapshot?.isSample ? 'yes' : 'no', e.sourcePlanItemId, e.createdAt, e.updatedAt,
    ].map(csvCell).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

const nutrientValues = z.object({
  calories: z.number().finite().min(0).nullable(),
  proteinG: z.number().finite().min(0).nullable(),
  carbsG: z.number().finite().min(0).nullable(),
  fatG: z.number().finite().min(0).nullable(),
});

export const importSchema = z.object({
  format: z.literal(PLANS_EXPORT_FORMAT),
  version: z.literal(PLANS_EXPORT_VERSION),
  preferences: z
    .object({
      dailyCalorieTarget: z.number().int().min(1000).max(6000).nullable(),
      planner: plannerPrefsSchema,
    })
    .partial()
    .optional(),
  plans: z
    .array(
      z.object({
        weekStart: localDate,
        preferences: plannerPrefsSchema,
        targetApplied: z.boolean(),
        items: z
          .array(
            z.object({
              date: localDate,
              mealType: z.enum(PLANNED_MEAL_TYPES),
              recipeId: z.string().max(100).nullable(),
              name: z.string().trim().min(1).max(200),
              servings: z.number().finite().gt(0).max(10),
              notes: z.string().max(1000).nullable(),
              locked: z.boolean(),
              recipe: z.object({
                recipeId: z.string().max(100).nullable(),
                name: z.string().max(200),
                servings: z.number().finite().gt(0).max(50),
                prepMinutes: z.number().int().min(0).max(600).nullable(),
                instructions: z.array(z.string().max(1000)).max(30),
                ingredients: z.array(z.object({ name: z.string().max(200), quantity: z.number().finite().gt(0).nullable(), unit: z.string().max(30) })).max(60),
                nutritionPerServing: nutrientValues,
                nutritionBasis: z.enum(['usda', 'off', 'sample', 'manual', 'mixed', 'none']),
                nutritionComplete: z.boolean(),
              }),
            }),
          )
          .max(21),
      }),
    )
    .max(104),
});

