import type { Db } from '../connection';
import { newId, nowIso, parseJson } from '../connection';
import type { FoodLogEntry, MealType, NutrientValues, NutritionSnapshot } from '../../shared/types/nutrition';

interface LogRow {
  id: string;
  profile_id: string;
  local_date: string;
  meal_type: MealType;
  food_id: string | null;
  recipe_id: string | null;
  display_name: string;
  quantity: number;
  unit: string;
  unit_label: string;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  snapshot_json: string;
  source_plan_item_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

function toEntry(r: LogRow): FoodLogEntry {
  return {
    id: r.id,
    profileId: r.profile_id,
    localDate: r.local_date,
    mealType: r.meal_type,
    foodId: r.food_id,
    recipeId: r.recipe_id,
    displayName: r.display_name,
    quantity: r.quantity,
    unit: r.unit,
    unitLabel: r.unit_label,
    nutrition: { calories: r.calories, proteinG: r.protein_g, carbsG: r.carbs_g, fatG: r.fat_g },
    snapshot: parseJson<NutritionSnapshot>(r.snapshot_json, null as unknown as NutritionSnapshot),
    sourcePlanItemId: r.source_plan_item_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface NewLogEntry {
  profileId: string;
  localDate: string;
  mealType: MealType;
  foodId: string | null;
  recipeId: string | null;
  displayName: string;
  quantity: number;
  unit: string;
  unitLabel: string;
  nutrition: NutrientValues;
  snapshot: NutritionSnapshot;
  sourcePlanItemId: string | null;
  idempotencyKey: string | null;
}

export class LogRepository {
  constructor(private readonly db: Db) {}

  /** Every read is scoped by profile id. */
  get(profileId: string, id: string): FoodLogEntry | null {
    const r = this.db.prepare('SELECT * FROM food_log_entries WHERE id = ? AND profile_id = ?').get(id, profileId) as LogRow | undefined;
    return r ? toEntry(r) : null;
  }

  findByIdempotencyKey(profileId: string, key: string): FoodLogEntry | null {
    const r = this.db
      .prepare('SELECT * FROM food_log_entries WHERE profile_id = ? AND idempotency_key = ?')
      .get(profileId, key) as LogRow | undefined;
    return r ? toEntry(r) : null;
  }

  findByPlanItem(profileId: string, planItemId: string): FoodLogEntry[] {
    return (this.db
      .prepare('SELECT * FROM food_log_entries WHERE profile_id = ? AND source_plan_item_id = ? ORDER BY created_at')
      .all(profileId, planItemId) as unknown as LogRow[]).map(toEntry);
  }

  listRange(profileId: string, from: string, to: string): FoodLogEntry[] {
    return (this.db
      .prepare('SELECT * FROM food_log_entries WHERE profile_id = ? AND local_date BETWEEN ? AND ? ORDER BY local_date, created_at')
      .all(profileId, from, to) as unknown as LogRow[]).map(toEntry);
  }

  create(e: NewLogEntry): FoodLogEntry {
    const id = newId();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO food_log_entries (id, profile_id, local_date, meal_type, food_id, recipe_id, display_name, quantity, unit, unit_label,
          calories, protein_g, carbs_g, fat_g, snapshot_json, source_plan_item_id, idempotency_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, e.profileId, e.localDate, e.mealType, e.foodId, e.recipeId, e.displayName, e.quantity, e.unit, e.unitLabel,
        e.nutrition.calories, e.nutrition.proteinG, e.nutrition.carbsG, e.nutrition.fatG, JSON.stringify(e.snapshot),
        e.sourcePlanItemId, e.idempotencyKey, ts, ts);
    return this.get(e.profileId, id)!;
  }

  update(profileId: string, id: string, patch: Partial<Pick<NewLogEntry, 'localDate' | 'mealType' | 'displayName' | 'quantity' | 'unit' | 'unitLabel' | 'nutrition' | 'snapshot'>>): FoodLogEntry | null {
    const cur = this.get(profileId, id);
    if (!cur) return null;
    const n = patch.nutrition ?? cur.nutrition;
    this.db
      .prepare(
        `UPDATE food_log_entries SET local_date=?, meal_type=?, display_name=?, quantity=?, unit=?, unit_label=?,
          calories=?, protein_g=?, carbs_g=?, fat_g=?, snapshot_json=?, updated_at=? WHERE id=? AND profile_id=?`,
      )
      .run(patch.localDate ?? cur.localDate, patch.mealType ?? cur.mealType, patch.displayName ?? cur.displayName,
        patch.quantity ?? cur.quantity, patch.unit ?? cur.unit, patch.unitLabel ?? cur.unitLabel,
        n.calories, n.proteinG, n.carbsG, n.fatG, JSON.stringify(patch.snapshot ?? cur.snapshot), nowIso(), id, profileId);
    return this.get(profileId, id);
  }

  delete(profileId: string, id: string): FoodLogEntry | null {
    const cur = this.get(profileId, id);
    if (!cur) return null;
    this.db.prepare('DELETE FROM food_log_entries WHERE id = ? AND profile_id = ?').run(id, profileId);
    return cur;
  }

  deleteAll(profileId: string): number {
    return Number(this.db.prepare('DELETE FROM food_log_entries WHERE profile_id = ?').run(profileId).changes);
  }

  dailyTotals(profileId: string, from: string, to: string): Array<{
    local_date: string; entry_count: number; calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null; missing_calories: number;
  }> {
    return this.db
      .prepare(
        `SELECT local_date, COUNT(*) AS entry_count, SUM(calories) AS calories, SUM(protein_g) AS protein_g,
                SUM(carbs_g) AS carbs_g, SUM(fat_g) AS fat_g, SUM(CASE WHEN calories IS NULL THEN 1 ELSE 0 END) AS missing_calories
         FROM food_log_entries WHERE profile_id = ? AND local_date BETWEEN ? AND ? GROUP BY local_date ORDER BY local_date DESC`,
      )
      .all(profileId, from, to) as any;
  }

  countsForPlanItems(profileId: string, itemIds: string[]): Map<string, number> {
    const map = new Map<string, number>();
    if (!itemIds.length) return map;
    const rows = this.db
      .prepare(
        `SELECT source_plan_item_id AS id, COUNT(*) AS n FROM food_log_entries WHERE profile_id = ? AND source_plan_item_id IN (${itemIds.map(() => '?').join(',')}) GROUP BY source_plan_item_id`,
      )
      .all(profileId, ...itemIds) as Array<{ id: string; n: number }>;
    for (const r of rows) map.set(r.id, Number(r.n));
    return map;
  }
}
