/**
 * Recipes, weekly meal plans, grocery lists and "Log as eaten".
 * Planned meals live in meal_plan_items and never touch the food log until the
 * user explicitly logs them.
 */
import type { Db } from '../../database/connection';
import { nowIso, transaction } from '../../database/connection';
import { FoodRepository } from '../../database/repositories/foods';
import { LogRepository } from '../../database/repositories/logs';
import { PlanRepository, type PlanItemRow, type PlanItemWrite, type PlanRow } from '../../database/repositories/plans';
import { RecipeRepository, type RecipeInput, type RecipeRecord } from '../../database/repositories/recipes';
import type { PreferencesRepository, ProfileRepository } from '../../database/repositories/profiles';
import type { GeneratePlanRequest, LogPlanItemRequest, LogPlanItemResponse, UpdatePlanItemRequest } from '../../shared/types/api';
import type { NutrientValues, NutritionSnapshot, PlannedMealType } from '../../shared/types/nutrition';
import {
  DEFAULT_PLANNER_PREFERENCES,
  type GroceryLine,
  type MealPlan,
  type PlannerPreferences,
  type PlanRecipeSnapshot,
  type Recipe,
} from '../../shared/types/planning';
import { nextWeekStart, todayInTimeZone, weekDates, addDays } from '../../shared/lib/dates';
import { scaleValues } from '../../shared/lib/nutrition';
import { detectAllergensByName, detectCategoriesByName } from '../../shared/lib/allergens';
import {
  buildGroceryList,
  computeDayTotals,
  computeRecipeNutrition,
  generatePlanSlots,
  PlanConflictError,
  preferenceWarnings,
  type ExistingSlot,
  type PlannerRecipe,
  type RegenerateScope,
} from '../../services/meal-planner';
import { HttpError } from '../http/router';
import type { EventSink } from './events';

export interface RecipeCreateInput {
  name: string;
  description?: string | null;
  mealTypes: PlannedMealType[];
  prepMinutes: number;
  budgetLevel: 'low' | 'medium' | 'high';
  servings: number;
  instructions: string[];
  ingredients: Array<{ name: string; quantity: number | null; unit: string; foodId: string | null; allergens?: string[] }>;
}

export class PlanningService {
  readonly recipes: RecipeRepository;
  readonly plans: PlanRepository;
  private readonly foods: FoodRepository;
  private readonly logs: LogRepository;

  constructor(
    private readonly db: Db,
    private readonly profiles: ProfileRepository,
    private readonly prefs: PreferencesRepository,
    private readonly events: EventSink,
  ) {
    this.recipes = new RecipeRepository(db);
    this.plans = new PlanRepository(db);
    this.foods = new FoodRepository(db);
    this.logs = new LogRepository(db);
  }

  // ---------- recipes ----------

  private withNutrition(records: RecipeRecord[], profileId: string): Recipe[] {
    const foodIds = records.flatMap((r) => r.ingredients.map((i) => i.foodId).filter((x): x is string => Boolean(x)));
    const foods = this.foods.getMany(foodIds, profileId);
    return records.map((r) => ({ ...r, nutrition: computeRecipeNutrition(r, foods) }));
  }

  listRecipes(profileId: string): Recipe[] {
    return this.withNutrition(this.recipes.listVisible(profileId), profileId);
  }

  getRecipe(profileId: string, id: string): Recipe {
    const r = this.recipes.getVisible(profileId, id);
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Recipe not found.');
    return this.withNutrition([r], profileId)[0];
  }

  private recipeInput(profileId: string, input: RecipeCreateInput): RecipeInput {
    const ids = input.ingredients.map((i) => i.foodId).filter((x): x is string => Boolean(x));
    const visible = this.foods.getMany(ids, profileId);
    for (const id of ids) if (!visible.has(id)) throw new HttpError(400, 'VALIDATION_ERROR', 'An ingredient links to a food that was not found.');
    return {
      ...input,
      description: input.description ?? null,
      isSample: false,
      seedKey: null,
      ingredients: input.ingredients.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unit: i.unit,
        foodId: i.foodId,
        // User recipes: explicit allergens if given, plus name-based detection.
        allergens: [...new Set([...(i.allergens ?? []), ...detectAllergensByName(i.name)])],
        mayContain: [],
        category: detectCategoriesByName(i.name)[0] ?? null,
      })),
    };
  }

  createRecipe(profileId: string, input: RecipeCreateInput): Recipe {
    const id = transaction(this.db, () => this.recipes.create(profileId, this.recipeInput(profileId, input)));
    return this.getRecipe(profileId, id);
  }

  updateRecipe(profileId: string, id: string, input: RecipeCreateInput): Recipe {
    if (!this.recipes.isOwnedBy(profileId, id)) throw new HttpError(404, 'NOT_FOUND', 'You can only edit your own recipes. Duplicate a starter recipe to change it.');
    transaction(this.db, () => this.recipes.update(id, this.recipeInput(profileId, input)));
    return this.getRecipe(profileId, id);
  }

  deleteRecipe(profileId: string, id: string): void {
    if (!this.recipes.isOwnedBy(profileId, id)) throw new HttpError(404, 'NOT_FOUND', 'Recipe not found.');
    this.recipes.delete(id);
  }

  private toPlannerRecipe(r: Recipe): PlannerRecipe {
    return {
      id: r.id,
      name: r.name,
      mealTypes: r.mealTypes,
      prepMinutes: r.prepMinutes,
      budgetLevel: r.budgetLevel,
      servings: r.servings,
      perServing: r.nutrition.perServing,
      nutritionComplete: r.nutrition.complete,
      ingredients: r.ingredients.map((i) => ({ name: i.name, allergens: i.allergens, mayContain: i.mayContain, category: i.category })),
    };
  }

  private snapshotRecipe(r: Recipe): PlanRecipeSnapshot {
    return {
      recipeId: r.id,
      name: r.name,
      servings: r.servings,
      prepMinutes: r.prepMinutes,
      instructions: r.instructions,
      ingredients: r.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
      nutritionPerServing: r.nutrition.perServing,
      nutritionBasis: r.nutrition.basis,
      nutritionComplete: r.nutrition.complete,
    };
  }

  // ---------- preferences ----------

  resolvePlannerPrefs(profileId: string, partial?: Partial<PlannerPreferences>): { prefs: PlannerPreferences; targetApplied: boolean } {
    const profile = this.profiles.get(profileId)!;
    const saved = this.prefs.get(profileId, profile.timezone);
    const prefs: PlannerPreferences = { ...DEFAULT_PLANNER_PREFERENCES, ...saved.planner, ...(partial ?? {}) };
    if (prefs.mode === 'target') {
      if (!saved.adultConfirmed) {
        throw new HttpError(400, 'VALIDATION_ERROR',
          'Planning around a calorie target is for adults. Confirm you are 18 or older in Settings, or use general planning.');
      }
      prefs.calorieTarget = prefs.calorieTarget ?? saved.dailyCalorieTarget;
      if (!prefs.calorieTarget) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter a daily calorie target, or switch to general planning.');
      }
      return { prefs, targetApplied: true };
    }
    return { prefs: { ...prefs, calorieTarget: null }, targetApplied: false };
  }

  // ---------- plans ----------

  private eligibleRecipes(profileId: string): { recipes: Recipe[]; planner: PlannerRecipe[] } {
    const recipes = this.listRecipes(profileId);
    return { recipes, planner: recipes.map((r) => this.toPlannerRecipe(r)) };
  }

  private runPlanner(
    profileId: string,
    plan: Pick<PlanRow, 'weekStart' | 'preferences' | 'targetApplied'>,
    existing: PlanItemRow[],
    regenerate: RegenerateScope,
    seed: number,
  ) {
    const { recipes, planner } = this.eligibleRecipes(profileId);
    const byId = new Map(recipes.map((r) => [r.id, r]));
    const existingSlots: ExistingSlot[] = existing.map((i) => ({
      date: i.date, mealType: i.mealType, recipeId: i.recipeId, servings: i.servings, locked: i.locked, calories: i.nutrition.calories,
    }));
    try {
      const out = generatePlanSlots({
        recipes: planner,
        prefs: plan.preferences,
        dates: weekDates(plan.weekStart),
        existing: existingSlots,
        regenerate,
        targetApplied: plan.targetApplied,
        seed,
      });
      return out.slots.map((s) => {
        const r = byId.get(s.recipeId)!;
        const snap = this.snapshotRecipe(r);
        const prev = existing.find((e) => e.date === s.date && e.mealType === s.mealType);
        const w: PlanItemWrite = {
          date: s.date, mealType: s.mealType, recipeId: r.id, foodId: null, name: r.name, servings: s.servings,
          nutrition: scaleValues(snap.nutritionPerServing, s.servings), recipe: snap, notes: prev?.notes ?? null, locked: false, flags: s.flags,
        };
        return w;
      });
    } catch (err) {
      if (err instanceof PlanConflictError) {
        throw new HttpError(422, 'PLAN_CONFLICT', 'Your preferences can’t all be met with the current recipes.', { problems: err.problems });
      }
      throw err;
    }
  }

  generatePlan(profileId: string, req: GeneratePlanRequest): MealPlan {
    const profile = this.profiles.get(profileId)!;
    const weekStart = req.weekStart ?? nextWeekStart(todayInTimeZone(profile.timezone));
    const { prefs, targetApplied } = this.resolvePlannerPrefs(profileId, req.preferences);
    const seed = req.seed ?? Math.floor(Math.random() * 2 ** 31);
    const writes = this.runPlanner(profileId, { weekStart, preferences: prefs, targetApplied }, [], { scope: 'week' }, seed);
    const plan = transaction(this.db, () => {
      const p = this.plans.create(profileId, weekStart, prefs, targetApplied, preferenceWarnings(prefs), seed);
      for (const w of writes) this.plans.upsertItem(p.id, w);
      return p;
    });
    return this.getPlan(profileId, plan.id);
  }

  getPlan(profileId: string, id: string): MealPlan {
    const plan = this.plans.get(profileId, id);
    if (!plan) throw new HttpError(404, 'NOT_FOUND', 'Meal plan not found.');
    const items = this.plans.items(plan.id);
    const counts = this.logs.countsForPlanItems(profileId, items.map((i) => i.id));
    const dates = weekDates(plan.weekStart);
    const target = plan.targetApplied ? plan.preferences.calorieTarget : null;
    return {
      id: plan.id,
      profileId: plan.profileId,
      weekStart: plan.weekStart,
      weekEnd: addDays(plan.weekStart, 6),
      status: plan.status,
      preferences: plan.preferences,
      targetApplied: plan.targetApplied,
      items: items.map((i) => ({ ...i, loggedCount: counts.get(i.id) ?? 0 })),
      dayTotals: computeDayTotals(items, dates, target, plan.preferences.targetTolerancePct),
      warnings: plan.warnings,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }

  listPlans(profileId: string) {
    return this.plans.list(profileId).map((p) => ({
      id: p.id, weekStart: p.weekStart, weekEnd: addDays(p.weekStart, 6), status: p.status, updatedAt: p.updatedAt,
    }));
  }

  regenerate(profileId: string, planId: string, scope: 'week' | 'day', date?: string, seed?: number): MealPlan {
    const plan = this.plans.get(profileId, planId);
    if (!plan) throw new HttpError(404, 'NOT_FOUND', 'Meal plan not found.');
    if (scope === 'day' && (!date || !weekDates(plan.weekStart).includes(date))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a day inside this plan.');
    }
    const existing = this.plans.items(plan.id);
    const regen: RegenerateScope = scope === 'week' ? { scope: 'week' } : { scope: 'day', date: date! };
    const writes = this.runPlanner(profileId, plan, existing, regen, seed ?? Math.floor(Math.random() * 2 ** 31));
    transaction(this.db, () => {
      for (const w of writes) this.plans.upsertItem(plan.id, w);
      this.plans.touch(plan.id);
    });
    return this.getPlan(profileId, plan.id);
  }

  /** Swap one meal for another recipe chosen by the planner. */
  replaceItem(profileId: string, itemId: string, seed?: number): MealPlan {
    const item = this.plans.getItem(profileId, itemId);
    if (!item) throw new HttpError(404, 'NOT_FOUND', 'Planned meal not found.');
    if (item.locked) throw new HttpError(409, 'CONFLICT', 'This meal is locked. Unlock it to swap.');
    const plan = this.plans.get(profileId, item.planId)!;
    const existing = this.plans.items(plan.id);
    const writes = this.runPlanner(profileId, plan, existing, { scope: 'slot', date: item.date, mealType: item.mealType }, seed ?? Math.floor(Math.random() * 2 ** 31));
    transaction(this.db, () => {
      for (const w of writes) this.plans.upsertItem(plan.id, w);
      this.plans.touch(plan.id);
    });
    return this.getPlan(profileId, plan.id);
  }

  updateItem(profileId: string, itemId: string, patch: UpdatePlanItemRequest): MealPlan {
    const item = this.plans.getItem(profileId, itemId);
    if (!item) throw new HttpError(404, 'NOT_FOUND', 'Planned meal not found.');
    let w: PlanItemWrite = {
      date: item.date, mealType: item.mealType, recipeId: item.recipeId, foodId: item.foodId, name: item.name, servings: item.servings,
      nutrition: item.nutrition, recipe: item.recipe, notes: item.notes, locked: item.locked, flags: item.flags,
    };
    if (patch.recipeId) {
      const r = this.getRecipe(profileId, patch.recipeId);
      if (!r.mealTypes.includes(item.mealType)) {
        // Allowed, but tell the user in the item flags.
        w.flags = [`Usually a ${r.mealTypes.join('/')} recipe.`];
      } else {
        w.flags = [];
      }
      const snap = this.snapshotRecipe(r);
      w = { ...w, recipeId: r.id, foodId: null, name: r.name, recipe: snap, servings: patch.servings ?? 1 };
    } else if (patch.custom) {
      const values: NutrientValues = {
        calories: patch.custom.calories,
        proteinG: patch.custom.proteinG ?? null,
        carbsG: patch.custom.carbsG ?? null,
        fatG: patch.custom.fatG ?? null,
      };
      w = {
        ...w, recipeId: null, foodId: null, name: patch.custom.name, servings: patch.servings ?? 1, flags: ['Nutrition entered by you.'],
        recipe: {
          recipeId: null, name: patch.custom.name, servings: 1, prepMinutes: null,
          instructions: patch.custom.instructions ?? [],
          ingredients: (patch.custom.ingredients ?? []).filter(Boolean).map((name) => ({ name, quantity: null, unit: 'to taste' })),
          nutritionPerServing: values, nutritionBasis: 'manual', nutritionComplete: values.calories !== null,
        },
      };
    }
    if (patch.servings !== undefined) w.servings = patch.servings;
    if (patch.locked !== undefined) w.locked = patch.locked;
    if (patch.notes !== undefined) w.notes = patch.notes;
    w.nutrition = scaleValues(w.recipe.nutritionPerServing, w.servings);

    transaction(this.db, () => {
      this.plans.upsertItem(item.planId, w);
      this.plans.touch(item.planId);
    });
    return this.getPlan(profileId, item.planId);
  }

  savePlan(profileId: string, planId: string, overwrite: boolean): MealPlan {
    const plan = this.plans.get(profileId, planId);
    if (!plan) throw new HttpError(404, 'NOT_FOUND', 'Meal plan not found.');
    if (plan.status === 'saved') return this.getPlan(profileId, planId);
    transaction(this.db, () => {
      const existing = this.plans.findSaved(profileId, plan.weekStart);
      if (existing && existing.id !== plan.id) {
        if (!overwrite) {
          throw new HttpError(409, 'PLAN_EXISTS', `You already have a saved plan for the week of ${plan.weekStart}. Replace it?`, { existingPlanId: existing.id });
        }
        this.plans.updateMeta(existing.id, { status: 'replaced' });
      }
      this.plans.updateMeta(plan.id, { status: 'saved' });
    });
    this.events.emit('nutrition:plan-saved', profileId, { planId, weekStart: plan.weekStart });
    return this.getPlan(profileId, planId);
  }

  deletePlan(profileId: string, planId: string): void {
    if (!this.plans.delete(profileId, planId)) throw new HttpError(404, 'NOT_FOUND', 'Meal plan not found.');
  }

  groceryList(profileId: string, planId: string, from?: string, to?: string): { people: number; lines: GroceryLine[] } {
    const plan = this.getPlan(profileId, planId);
    const items = plan.items.filter((i) => (!from || i.date >= from) && (!to || i.date <= to));
    return { people: plan.preferences.people, lines: buildGroceryList(items.map((i) => ({ recipe: i.recipe, servings: i.servings })), plan.preferences.people) };
  }

  /**
   * Record a planned meal as eaten. Creates a separate food-log entry with its
   * own nutrition snapshot; later plan edits never change it.
   */
  logItem(profileId: string, itemId: string, req: LogPlanItemRequest): LogPlanItemResponse {
    const result = transaction(this.db, () => {
      const prior = this.logs.findByIdempotencyKey(profileId, req.idempotencyKey);
      if (prior) return { entry: prior, duplicate: true };

      const item = this.plans.getItem(profileId, itemId);
      if (!item) throw new HttpError(404, 'NOT_FOUND', 'Planned meal not found.');
      const already = this.logs.findByPlanItem(profileId, itemId);
      if (already.length && !req.allowRepeat) {
        throw new HttpError(409, 'ALREADY_LOGGED', 'This planned meal is already in your food log.', { entryId: already[0].id });
      }
      const perServing = item.recipe.nutritionPerServing;
      const values = scaleValues(perServing, req.servingsEaten);
      const basis = item.recipe.nutritionBasis;
      const snapshot: NutritionSnapshot = {
        version: 1,
        source: 'plan',
        sourceFoodId: item.recipeId,
        isSample: basis === 'sample' || basis === 'mixed',
        reference: { quantity: 1, unit: 'serving', unitLabel: 'serving', values: perServing },
        serving: null,
        values,
        computedAt: nowIso(),
      };
      const entry = this.logs.create({
        profileId,
        localDate: req.localDate,
        mealType: req.mealType,
        foodId: null,
        recipeId: item.recipeId,
        displayName: item.name,
        quantity: req.servingsEaten,
        unit: 'serving',
        unitLabel: req.servingsEaten === 1 ? 'serving' : 'servings',
        nutrition: values,
        snapshot,
        sourcePlanItemId: item.id,
        idempotencyKey: req.idempotencyKey,
      });
      return { entry, duplicate: false };
    });
    if (!result.duplicate) this.events.emit('nutrition:food-logged', profileId, { entry: result.entry });
    return result;
  }

  planDates(weekStart: string): string[] {
    return weekDates(weekStart);
  }
}

