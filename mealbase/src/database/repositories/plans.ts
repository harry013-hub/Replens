import type { Db } from '../connection';
import { newId, nowIso, parseJson } from '../connection';
import type { NutrientValues, PlannedMealType } from '../../shared/types/nutrition';
import type { PlannerPreferences, PlanRecipeSnapshot, PlanStatus } from '../../shared/types/planning';

export interface PlanRow {
  id: string;
  profileId: string;
  weekStart: string;
  status: PlanStatus;
  preferences: PlannerPreferences;
  targetApplied: boolean;
  warnings: string[];
  seed: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanItemRow {
  id: string;
  planId: string;
  date: string;
  mealType: PlannedMealType;
  recipeId: string | null;
  foodId: string | null;
  name: string;
  servings: number;
  nutrition: NutrientValues;
  recipe: PlanRecipeSnapshot;
  notes: string | null;
  locked: boolean;
  flags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanItemWrite {
  date: string;
  mealType: PlannedMealType;
  recipeId: string | null;
  foodId: string | null;
  name: string;
  servings: number;
  nutrition: NutrientValues;
  recipe: PlanRecipeSnapshot;
  notes: string | null;
  locked: boolean;
  flags: string[];
}

function planFromRow(r: any): PlanRow {
  return {
    id: r.id, profileId: r.profile_id, weekStart: r.week_start, status: r.status,
    preferences: parseJson(r.preferences_json, {} as PlannerPreferences), targetApplied: r.target_applied === 1,
    warnings: parseJson(r.warnings_json, []), seed: r.seed, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function itemFromRow(r: any): PlanItemRow {
  return {
    id: r.id, planId: r.plan_id, date: r.date, mealType: r.meal_type, recipeId: r.recipe_id, foodId: r.food_id, name: r.name,
    servings: r.servings, nutrition: { calories: r.calories, proteinG: r.protein_g, carbsG: r.carbs_g, fatG: r.fat_g },
    recipe: parseJson(r.recipe_snapshot_json, {} as PlanRecipeSnapshot), notes: r.notes, locked: r.locked === 1,
    flags: parseJson(r.flags_json, []), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class PlanRepository {
  constructor(private readonly db: Db) {}

  get(profileId: string, id: string): PlanRow | null {
    const r = this.db.prepare('SELECT * FROM meal_plans WHERE id = ? AND profile_id = ?').get(id, profileId);
    return r ? planFromRow(r) : null;
  }

  list(profileId: string): PlanRow[] {
    return (this.db
      .prepare("SELECT * FROM meal_plans WHERE profile_id = ? AND status != 'replaced' ORDER BY week_start DESC, updated_at DESC")
      .all(profileId) as any[]).map(planFromRow);
  }

  findSaved(profileId: string, weekStart: string): PlanRow | null {
    const r = this.db.prepare("SELECT * FROM meal_plans WHERE profile_id = ? AND week_start = ? AND status = 'saved'").get(profileId, weekStart);
    return r ? planFromRow(r) : null;
  }

  create(profileId: string, weekStart: string, prefs: PlannerPreferences, targetApplied: boolean, warnings: string[], seed: number): PlanRow {
    const id = newId();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO meal_plans (id, profile_id, week_start, status, preferences_json, target_applied, warnings_json, seed, created_at, updated_at)
         VALUES (?,?,?,'draft',?,?,?,?,?,?)`,
      )
      .run(id, profileId, weekStart, JSON.stringify(prefs), targetApplied ? 1 : 0, JSON.stringify(warnings), seed, ts, ts);
    return this.get(profileId, id)!;
  }

  updateMeta(id: string, patch: { status?: PlanStatus; warnings?: string[]; preferences?: PlannerPreferences; targetApplied?: boolean; seed?: number }): void {
    const r = this.db.prepare('SELECT * FROM meal_plans WHERE id = ?').get(id) as any;
    if (!r) return;
    const cur = planFromRow(r);
    this.db
      .prepare('UPDATE meal_plans SET status=?, warnings_json=?, preferences_json=?, target_applied=?, seed=?, updated_at=? WHERE id=?')
      .run(patch.status ?? cur.status, JSON.stringify(patch.warnings ?? cur.warnings), JSON.stringify(patch.preferences ?? cur.preferences),
        (patch.targetApplied ?? cur.targetApplied) ? 1 : 0, patch.seed ?? cur.seed, nowIso(), id);
  }

  touch(id: string): void {
    this.db.prepare('UPDATE meal_plans SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  }

  delete(profileId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM meal_plans WHERE id = ? AND profile_id = ?').run(id, profileId).changes) > 0;
  }

  deleteAll(profileId: string): void {
    this.db.prepare('DELETE FROM meal_plans WHERE profile_id = ?').run(profileId);
  }

  items(planId: string): PlanItemRow[] {
    return (this.db.prepare(`SELECT * FROM meal_plan_items WHERE plan_id = ? ORDER BY date, CASE meal_type WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 ELSE 2 END`).all(planId) as any[]).map(itemFromRow);
  }

  /** Item lookup scoped through the owning plan's profile. */
  getItem(profileId: string, itemId: string): PlanItemRow | null {
    const r = this.db
      .prepare('SELECT i.* FROM meal_plan_items i JOIN meal_plans p ON p.id = i.plan_id WHERE i.id = ? AND p.profile_id = ?')
      .get(itemId, profileId);
    return r ? itemFromRow(r) : null;
  }

  /** Insert or replace the item in a (date, meal) slot. Keeps the item id when the slot exists. */
  upsertItem(planId: string, w: PlanItemWrite): string {
    const existing = this.db
      .prepare('SELECT id FROM meal_plan_items WHERE plan_id = ? AND date = ? AND meal_type = ?')
      .get(planId, w.date, w.mealType) as { id: string } | undefined;
    const ts = nowIso();
    const n = w.nutrition;
    if (existing) {
      this.db
        .prepare(
          `UPDATE meal_plan_items SET recipe_id=?, food_id=?, name=?, servings=?, calories=?, protein_g=?, carbs_g=?, fat_g=?,
            recipe_snapshot_json=?, notes=?, locked=?, flags_json=?, updated_at=? WHERE id=?`,
        )
        .run(w.recipeId, w.foodId, w.name, w.servings, n.calories, n.proteinG, n.carbsG, n.fatG, JSON.stringify(w.recipe), w.notes,
          w.locked ? 1 : 0, JSON.stringify(w.flags), ts, existing.id);
      return existing.id;
    }
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO meal_plan_items (id, plan_id, date, meal_type, recipe_id, food_id, name, servings, calories, protein_g, carbs_g, fat_g,
          recipe_snapshot_json, notes, locked, flags_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, planId, w.date, w.mealType, w.recipeId, w.foodId, w.name, w.servings, n.calories, n.proteinG, n.carbsG, n.fatG,
        JSON.stringify(w.recipe), w.notes, w.locked ? 1 : 0, JSON.stringify(w.flags), ts, ts);
    return id;
  }
}
