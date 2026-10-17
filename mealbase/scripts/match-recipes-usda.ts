/**
 * Re-link starter recipe ingredients from development SAMPLE foods to live
 * USDA FoodData Central records.
 *
 *   USDA_API_KEY=... npm run recipes:match-usda            # dry run: prints proposed matches
 *   USDA_API_KEY=... npm run recipes:match-usda -- --apply # writes the links
 *
 * For each sample food it searches Foundation + SR Legacy using the `usdaQuery`
 * in src/database/seed/sample-foods.json, takes the first result, fetches its
 * details (nutrients + portion weights) and caches it. Review the printed
 * matches before applying — automatic matching can pick the wrong food.
 *
 * Gram-based ingredient amounts always resolve. Household units (cup, large,
 * slice…) resolve only if the USDA record lists a portion with that unit; the
 * script reports any that don't so you can edit the recipe to use grams.
 */
import { openDatabase, migrate, transaction } from '../src/database/connection';
import { seedDatabase, SAMPLE_FOODS } from '../src/database/seed';
import { FoodRepository } from '../src/database/repositories/foods';
import { UsdaFoodProvider } from '../src/services/food-provider/usda';
import { ingredientReferenceAmount } from '../src/services/meal-planner/recipe-nutrition';
import { loadConfig } from '../src/server/config';

const apply = process.argv.includes('--apply');
const config = loadConfig();
if (!config.usdaApiKey) {
  console.error('Set USDA_API_KEY first (free key: https://fdc.nal.usda.gov/api-key-signup).');
  process.exit(1);
}
if (config.usdaApiKey === 'DEMO_KEY') {
  console.warn('DEMO_KEY allows ~30 requests/hour; this script needs about 2 per food. Use your own key.');
}

const db = openDatabase(config.databasePath);
migrate(db);
seedDatabase(db);
const foods = new FoodRepository(db);

const provider = new UsdaFoodProvider({ apiKey: config.usdaApiKey, baseUrl: config.usdaBaseUrl, pageSize: 5 });

const sampleIds = new Map<string, string>(
  (db.prepare("SELECT id, source_food_id FROM foods WHERE source = 'sample'").all() as Array<{ id: string; source_food_id: string }>).map((r) => [r.source_food_id, r.id]),
);

let matched = 0;
const problems: string[] = [];
for (const [key, def] of Object.entries(SAMPLE_FOODS)) {
  const query = def.usdaQuery ?? def.name;
  try {
    const page = await provider.search(query, 1);
    const hit = page.items.find((i) => i.dataType === 'SR Legacy' || i.dataType === 'Foundation') ?? page.items[0];
    if (!hit) { problems.push(`${key}: no USDA result for "${query}"`); continue; }
    const pf = await provider.getFood(hit.sourceFoodId);
    console.log(`${key.padEnd(14)} → ${pf.name} [${pf.dataType} ${pf.sourceFoodId}] ${pf.reference.values.calories?.toFixed(0) ?? '?'} kcal/100 g`);
    if (!apply) continue;
    transaction(db, () => {
      const usdaId = foods.upsertProviderFood(pf);
      const sampleId = sampleIds.get(key)!;
      const ings = db.prepare('SELECT id, name, quantity, unit FROM recipe_ingredients WHERE food_id = ?').all(sampleId) as Array<{ id: string; name: string; quantity: number | null; unit: string }>;
      const usdaFood = foods.getVisible(usdaId, 'none')!;
      for (const ing of ings) {
        if (ing.quantity !== null && ingredientReferenceAmount(ing, usdaFood) === null) {
          problems.push(`${ing.name}: USDA record has no "${ing.unit}" portion; change this ingredient to grams in recipes.json`);
          continue; // keep the sample link rather than lose nutrition
        }
        db.prepare('UPDATE recipe_ingredients SET food_id = ? WHERE id = ?').run(usdaId, ing.id);
        matched++;
      }
    });
  } catch (err) {
    problems.push(`${key}: ${(err as Error).message}`);
  }
}
console.log(apply ? `\nRe-linked ${matched} ingredient lines to USDA records.` : '\nDry run. Re-run with --apply to write these links.');
if (problems.length) console.log('\nNeeds attention:\n- ' + problems.join('\n- '));
db.close();
