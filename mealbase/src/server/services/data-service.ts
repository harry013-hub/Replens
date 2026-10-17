/**
 * Export, import and deletion of personal data.
 *
 * Formats (documented in docs/DATA-FORMATS.md):
 * - Food log CSV  – one row per log entry, UTF-8, header row, RFC 4180 quoting.
 * - Plans JSON    – { format: "mealbase.plans", version: 1, … }
 */
import type { Db } from '../../database/connection';
import { transaction } from '../../database/connection';
import { LogRepository } from '../../database/repositories/logs';
import { PlanRepository } from '../../database/repositories/plans';
import { RecipeRepository } from '../../database/repositories/recipes';
import { FoodRepository } from '../../database/repositories/foods';
import type { PreferencesRepository, ProfileRepository } from '../../database/repositories/profiles';
import { isLocalDate } from '../../shared/lib/dates';
import { HttpError } from '../http/router';
import { parse } from '../validation';
import type { PlanningService } from './planning-service';

export { CSV_COLUMNS, logsToCsv, PLANS_EXPORT_FORMAT, PLANS_EXPORT_VERSION } from './export-format';
import { importSchema, logsToCsv, PLANS_EXPORT_FORMAT, PLANS_EXPORT_VERSION } from './export-format';

export class DataService {
  private logs: LogRepository;
  private plans: PlanRepository;
  private recipes: RecipeRepository;
  private foods: FoodRepository;

  constructor(
    private readonly db: Db,
    private readonly profiles: ProfileRepository,
    private readonly prefs: PreferencesRepository,
    private readonly planning: PlanningService,
  ) {
    this.logs = new LogRepository(db);
    this.plans = new PlanRepository(db);
    this.recipes = new RecipeRepository(db);
    this.foods = new FoodRepository(db);
  }

  exportLogsCsv(profileId: string, from: string, to: string): string {
    if (!isLocalDate(from) || !isLocalDate(to) || from > to) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a valid date range.');
    return logsToCsv(this.logs.listRange(profileId, from, to));
  }

  exportPlansJson(profileId: string) {
    const profile = this.profiles.get(profileId)!;
    const prefs = this.prefs.get(profileId, profile.timezone);
    const plans = this.plans.list(profileId).map((p) => this.planning.getPlan(profileId, p.id));
    return {
      format: PLANS_EXPORT_FORMAT,
      version: PLANS_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      timezone: profile.timezone,
      preferences: { dailyCalorieTarget: prefs.dailyCalorieTarget, planner: prefs.planner },
      plans: plans.map((p) => ({
        weekStart: p.weekStart,
        status: p.status,
        preferences: p.preferences,
        targetApplied: p.targetApplied,
        items: p.items.map((i) => ({
          date: i.date, mealType: i.mealType, recipeId: i.recipeId, name: i.name, servings: i.servings,
          notes: i.notes, locked: i.locked, nutrition: i.nutrition, recipe: i.recipe,
        })),
      })),
    };
  }

  /** Imports plans as new drafts (never overwrites saved plans) and optionally preferences. */
  importPlansJson(profileId: string, body: unknown, opts: { includePreferences: boolean }): { plans: number; preferences: boolean } {
    const data = parse(importSchema, body);
    const profile = this.profiles.get(profileId)!;
    return transaction(this.db, () => {
      let prefsImported = false;
      if (opts.includePreferences && data.preferences) {
        const cur = this.prefs.get(profileId, profile.timezone);
        this.prefs.save(profileId, {
          dailyCalorieTarget: data.preferences.dailyCalorieTarget !== undefined ? data.preferences.dailyCalorieTarget : cur.dailyCalorieTarget,
          adultConfirmed: cur.adultConfirmed, // never imported: must be confirmed by the user
          planner: data.preferences.planner
            ? { ...data.preferences.planner, mode: cur.adultConfirmed ? data.preferences.planner.mode : 'general' }
            : cur.planner,
        });
        prefsImported = true;
      }
      for (const p of data.plans) {
        const targetApplied = p.targetApplied && this.prefs.get(profileId, profile.timezone).adultConfirmed;
        const plan = this.plans.create(profileId, p.weekStart, p.preferences, targetApplied, ['Imported plan. Nutrition values were taken from the export file.'], 0);
        const dates = this.planning.planDates(p.weekStart);
        for (const i of p.items) {
          if (!dates.includes(i.date)) throw new HttpError(400, 'VALIDATION_ERROR', `Plan item date ${i.date} is outside the week of ${p.weekStart}.`);
          const recipeId = i.recipeId && this.recipes.getVisible(profileId, i.recipeId) ? i.recipeId : null;
          const per = i.recipe.nutritionPerServing;
          this.plans.upsertItem(plan.id, {
            date: i.date, mealType: i.mealType, recipeId, foodId: null, name: i.name, servings: i.servings,
            nutrition: {
              calories: per.calories === null ? null : per.calories * i.servings,
              proteinG: per.proteinG === null ? null : per.proteinG * i.servings,
              carbsG: per.carbsG === null ? null : per.carbsG * i.servings,
              fatG: per.fatG === null ? null : per.fatG * i.servings,
            },
            recipe: { ...i.recipe, recipeId }, notes: i.notes, locked: i.locked, flags: ['Imported'],
          });
        }
      }
      return { plans: data.plans.length, preferences: prefsImported };
    });
  }

  deleteHistory(profileId: string): number {
    return this.logs.deleteAll(profileId);
  }

  /** Remove every piece of personal nutrition data for this profile. */
  deleteAll(profileId: string): void {
    transaction(this.db, () => {
      this.logs.deleteAll(profileId);
      this.plans.deleteAll(profileId);
      this.db.prepare('DELETE FROM recipes WHERE owner_profile_id = ?').run(profileId);
      this.foods.deleteManualForProfile(profileId);
      this.db.prepare('DELETE FROM user_preferences WHERE profile_id = ?').run(profileId);
    });
  }
}
