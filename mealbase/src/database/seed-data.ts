/** Seed definitions (browser-safe: no database imports). */
import type { PlannedMealType } from '../shared/types/nutrition';
import type { BudgetLevel } from '../shared/types/planning';
import sampleFoods from './seed/sample-foods.json';
import recipeSeed from './seed/recipes.json';

export interface SampleFoodDef {
  name: string;
  per100g: [number | null, number | null, number | null, number | null];
  servings: Array<[string, string | null, number]>;
  category: string;
  allergens?: string[];
  mayContain?: string[];
  usdaQuery?: string;
}

export interface RecipeSeedDef {
  key: string;
  name: string;
  description?: string;
  mealTypes: PlannedMealType[];
  prepMinutes: number;
  budget: BudgetLevel;
  servings: number;
  ingredients: Array<{ food: string | null; qty: number | null; unit: string; name?: string }>;
  instructions: string[];
}

export const SAMPLE_FOODS = (sampleFoods as unknown as { foods: Record<string, SampleFoodDef> }).foods;
export const RECIPE_SEEDS = (recipeSeed as unknown as { recipes: RecipeSeedDef[] }).recipes;

