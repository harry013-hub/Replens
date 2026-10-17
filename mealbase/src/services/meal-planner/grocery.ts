/**
 * Grocery list from a plan. Combines quantities only where a valid unit
 * conversion exists; otherwise amounts are listed separately.
 */
import type { GroceryLine, PlanRecipeSnapshot } from '../../shared/types/planning';
import { baseUnitFor, convertUnit, normalizeUnit, unitFamily } from '../../shared/lib/units';

export interface GroceryInputItem {
  recipe: PlanRecipeSnapshot;
  /** planned servings per person */
  servings: number;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildGroceryList(items: GroceryInputItem[], people: number): GroceryLine[] {
  const lines = new Map<string, { name: string; buckets: Map<string, Array<{ q: number; unit: string }>>; recipes: Set<string> }>();

  for (const item of items) {
    const yieldServings = item.recipe.servings > 0 ? item.recipe.servings : 1;
    const factor = (item.servings * Math.max(1, people)) / yieldServings;
    for (const ing of item.recipe.ingredients) {
      const k = normalizeName(ing.name);
      if (!lines.has(k)) lines.set(k, { name: ing.name.trim(), buckets: new Map(), recipes: new Set() });
      const line = lines.get(k)!;
      line.recipes.add(item.recipe.name);
      if (ing.quantity === null) {
        if (!line.buckets.has('to taste')) line.buckets.set('to taste', []);
        continue;
      }
      const unit = normalizeUnit(ing.unit);
      const fam = unitFamily(unit);
      const bucketKey = fam === 'count' ? `count:${unit}` : fam;
      if (!line.buckets.has(bucketKey)) line.buckets.set(bucketKey, []);
      line.buckets.get(bucketKey)!.push({ q: ing.quantity * factor, unit });
    }
  }

  const result: GroceryLine[] = [];
  for (const line of lines.values()) {
    const amounts: GroceryLine['amounts'] = [];
    for (const [bucketKey, parts] of line.buckets) {
      if (bucketKey === 'to taste') {
        amounts.push({ quantity: 0, unit: 'to taste' });
        continue;
      }
      const units = new Set(parts.map((p) => p.unit));
      if (units.size === 1) {
        amounts.push({ quantity: parts.reduce((s, p) => s + p.q, 0), unit: parts[0].unit });
      } else {
        const base = baseUnitFor(parts[0].unit);
        const total = parts.reduce((s, p) => s + (convertUnit(p.q, p.unit, base) ?? 0), 0);
        amounts.push({ quantity: total, unit: base });
      }
    }
    // Present large metric amounts in kg / l.
    for (const a of amounts) {
      if (a.unit === 'g' && a.quantity >= 1000) { a.quantity /= 1000; a.unit = 'kg'; }
      if (a.unit === 'ml' && a.quantity >= 1000) { a.quantity /= 1000; a.unit = 'l'; }
    }
    result.push({ name: line.name, amounts, recipes: [...line.recipes].sort() });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
