import type { Db } from '../connection';
import { newId, nowIso, parseJson } from '../connection';
import type { PlannedMealType } from '../../shared/types/nutrition';
import type { BudgetLevel, Recipe, RecipeIngredient } from '../../shared/types/planning';

export type RecipeRecord = Omit<Recipe, 'nutrition'>;

interface RecipeRow {
  id: string;
  owner_profile_id: string | null;
  seed_key: string | null;
  name: string;
  description: string | null;
  meal_types_json: string;
  prep_minutes: number;
  budget_level: BudgetLevel;
  servings: number;
  instructions_json: string;
  is_sample: number;
  created_at: string;
  updated_at: string;
}

interface IngredientRow {
  id: string;
  recipe_id: string;
  name: string;
  quantity: number | null;
  unit: string;
  food_id: string | null;
  allergens_json: string;
  may_contain_json: string;
  category: string | null;
  sort_order: number;
}

export interface RecipeInput {
  name: string;
  description: string | null;
  mealTypes: PlannedMealType[];
  prepMinutes: number;
  budgetLevel: BudgetLevel;
  servings: number;
  instructions: string[];
  ingredients: Array<Omit<RecipeIngredient, 'id' | 'sortOrder'>>;
  isSample?: boolean;
  seedKey?: string | null;
}

export class RecipeRepository {
  constructor(private readonly db: Db) {}

  private hydrate(rows: RecipeRow[]): RecipeRecord[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const ing = this.db
      .prepare(`SELECT * FROM recipe_ingredients WHERE recipe_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort_order`)
      .all(...ids) as unknown as IngredientRow[];
    const byRecipe = new Map<string, RecipeIngredient[]>();
    for (const i of ing) {
      if (!byRecipe.has(i.recipe_id)) byRecipe.set(i.recipe_id, []);
      byRecipe.get(i.recipe_id)!.push({
        id: i.id, name: i.name, quantity: i.quantity, unit: i.unit, foodId: i.food_id,
        allergens: parseJson(i.allergens_json, []), mayContain: parseJson(i.may_contain_json, []),
        category: i.category, sortOrder: i.sort_order,
      });
    }
    return rows.map((r) => ({
      id: r.id,
      ownerProfileId: r.owner_profile_id,
      name: r.name,
      description: r.description,
      mealTypes: parseJson<PlannedMealType[]>(r.meal_types_json, []),
      prepMinutes: r.prep_minutes,
      budgetLevel: r.budget_level,
      servings: r.servings,
      instructions: parseJson<string[]>(r.instructions_json, []),
      ingredients: byRecipe.get(r.id) ?? [],
      isSample: r.is_sample === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  listVisible(profileId: string): RecipeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM recipes WHERE owner_profile_id IS NULL OR owner_profile_id = ? ORDER BY name')
      .all(profileId) as unknown as RecipeRow[];
    return this.hydrate(rows);
  }

  getVisible(profileId: string, id: string): RecipeRecord | null {
    const row = this.db
      .prepare('SELECT * FROM recipes WHERE id = ? AND (owner_profile_id IS NULL OR owner_profile_id = ?)')
      .get(id, profileId) as RecipeRow | undefined;
    return row ? this.hydrate([row])[0] : null;
  }

  isOwnedBy(profileId: string, id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM recipes WHERE id = ? AND owner_profile_id = ?').get(id, profileId));
  }

  findBySeedKey(seedKey: string): string | null {
    const r = this.db.prepare('SELECT id FROM recipes WHERE seed_key = ?').get(seedKey) as { id: string } | undefined;
    return r?.id ?? null;
  }

  create(ownerProfileId: string | null, input: RecipeInput): string {
    const id = newId();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO recipes (id, owner_profile_id, seed_key, name, description, meal_types_json, prep_minutes, budget_level, servings,
          instructions_json, is_sample, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, ownerProfileId, input.seedKey ?? null, input.name, input.description, JSON.stringify(input.mealTypes), input.prepMinutes,
        input.budgetLevel, input.servings, JSON.stringify(input.instructions), input.isSample ? 1 : 0, ts, ts);
    this.writeIngredients(id, input.ingredients);
    return id;
  }

  update(id: string, input: RecipeInput): void {
    this.db
      .prepare(
        `UPDATE recipes SET name=?, description=?, meal_types_json=?, prep_minutes=?, budget_level=?, servings=?, instructions_json=?,
          is_sample=?, updated_at=? WHERE id=?`,
      )
      .run(input.name, input.description, JSON.stringify(input.mealTypes), input.prepMinutes, input.budgetLevel, input.servings,
        JSON.stringify(input.instructions), input.isSample ? 1 : 0, nowIso(), id);
    this.db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);
    this.writeIngredients(id, input.ingredients);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
  }

  private writeIngredients(recipeId: string, ingredients: RecipeInput['ingredients']) {
    const ins = this.db.prepare(
      `INSERT INTO recipe_ingredients (id, recipe_id, name, quantity, unit, food_id, allergens_json, may_contain_json, category, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    ingredients.forEach((i, idx) =>
      ins.run(newId(), recipeId, i.name, i.quantity, i.unit, i.foodId, JSON.stringify(i.allergens ?? []),
        JSON.stringify(i.mayContain ?? []), i.category ?? null, idx),
    );
  }
}
