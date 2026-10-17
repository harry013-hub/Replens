/**
 * Seeds development sample foods and the editable starter recipe collection.
 * Safe to re-run: foods are matched by key, recipes by `key` (seed_key).
 * Ingredient links that were re-pointed to USDA foods by the match script are
 * preserved unless `force` is set.
 */
import type { Db } from './connection';
import { newId, nowIso, transaction } from './connection';
import { RecipeRepository } from './repositories/recipes';
import { RECIPE_SEEDS, SAMPLE_FOODS } from './seed-data';

export { RECIPE_SEEDS, SAMPLE_FOODS };

export function seedSampleFoods(db: Db): Map<string, string> {
  const ids = new Map<string, string>();
  const find = db.prepare("SELECT id FROM foods WHERE source = 'sample' AND source_food_id = ? AND owner_profile_id IS NULL");
  const ts = nowIso();
  for (const [key, f] of Object.entries(SAMPLE_FOODS)) {
    const [kcal, p, c, fat] = f.per100g;
    const existing = find.get(key) as { id: string } | undefined;
    let id: string;
    if (existing) {
      id = existing.id;
      db.prepare('UPDATE foods SET name=?, calories=?, protein_g=?, carbs_g=?, fat_g=?, updated_at=? WHERE id=?').run(f.name, kcal, p, c, fat, ts, id);
      db.prepare("DELETE FROM food_servings WHERE food_id = ? AND source = 'sample'").run(id);
    } else {
      id = newId();
      db.prepare(
        `INSERT INTO foods (id, source, source_food_id, owner_profile_id, name, brand, data_type, ref_quantity, ref_unit, ref_unit_label,
          calories, protein_g, carbs_g, fat_g, attribution, notes_json, fetched_at, created_at, updated_at)
         VALUES (?, 'sample', ?, NULL, ?, NULL, 'Sample data', 100, 'g', NULL, ?, ?, ?, ?,
          'Development sample data (approximate, not from a live provider)', '[]', NULL, ?, ?)`,
      ).run(id, key, f.name, kcal, p, c, fat, ts, ts);
    }
    const ins = db.prepare(
      `INSERT INTO food_servings (id, food_id, owner_profile_id, label, unit_key, ref_amount, source, sort_order) VALUES (?,?,NULL,?,?,?,'sample',?)`,
    );
    f.servings.forEach(([label, unitKey, grams], i) => ins.run(newId(), id, label, unitKey, grams, i));
    ids.set(key, id);
  }
  return ids;
}

export function seedRecipes(db: Db, foodIds: Map<string, string>, opts: { force?: boolean } = {}): { created: number; updated: number; skipped: number } {
  const repo = new RecipeRepository(db);
  let created = 0, updated = 0, skipped = 0;
  for (const r of RECIPE_SEEDS) {
    const ingredients = r.ingredients.map((i) => {
      const def = i.food ? SAMPLE_FOODS[i.food] : null;
      if (i.food && !def) throw new Error(`Recipe "${r.key}" references unknown food "${i.food}"`);
      return {
        name: i.name ?? def?.name ?? 'Ingredient',
        quantity: i.qty,
        unit: i.unit,
        foodId: i.food ? foodIds.get(i.food) ?? null : null,
        allergens: def?.allergens ?? [],
        mayContain: def?.mayContain ?? [],
        category: def?.category ?? null,
      };
    });
    const input = {
      name: r.name,
      description: r.description ?? null,
      mealTypes: r.mealTypes,
      prepMinutes: r.prepMinutes,
      budgetLevel: r.budget,
      servings: r.servings,
      instructions: r.instructions,
      ingredients,
      isSample: true,
      seedKey: r.key,
    };
    const existingId = repo.findBySeedKey(r.key);
    if (!existingId) {
      repo.create(null, input);
      created++;
    } else if (opts.force) {
      repo.update(existingId, input);
      updated++;
    } else {
      skipped++;
    }
  }
  return { created, updated, skipped };
}

export function seedDatabase(db: Db, opts: { force?: boolean } = {}) {
  return transaction(db, () => {
    const foodIds = seedSampleFoods(db);
    return { foods: foodIds.size, recipes: seedRecipes(db, foodIds, opts) };
  });
}

export function isSeeded(db: Db): boolean {
  return Boolean(db.prepare('SELECT 1 FROM recipes WHERE seed_key IS NOT NULL LIMIT 1').get());
}
