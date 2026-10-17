/**
 * Unit families for recipe ingredients and grocery lists.
 * Only well-defined conversions are listed. Mass and volume are never mixed.
 */
export type UnitFamily = 'mass' | 'volume' | 'count';

interface UnitDef {
  family: 'mass' | 'volume';
  /** size in the family base unit (g or ml) */
  toBase: number;
}

const UNIT_DEFS: Record<string, UnitDef> = {
  g: { family: 'mass', toBase: 1 },
  kg: { family: 'mass', toBase: 1000 },
  oz: { family: 'mass', toBase: 28.349523125 },
  lb: { family: 'mass', toBase: 453.59237 },
  ml: { family: 'volume', toBase: 1 },
  l: { family: 'volume', toBase: 1000 },
  // US customary volume measures
  tsp: { family: 'volume', toBase: 4.92892159375 },
  tbsp: { family: 'volume', toBase: 14.78676478125 },
  cup: { family: 'volume', toBase: 236.5882365 },
  'fl oz': { family: 'volume', toBase: 29.5735295625 },
};

const ALIASES: Record<string, string> = {
  gram: 'g', grams: 'g', gr: 'g',
  kilogram: 'kg', kilograms: 'kg',
  milliliter: 'ml', millilitre: 'ml', milliliters: 'ml', millilitres: 'ml', mL: 'ml',
  liter: 'l', litre: 'l', liters: 'l', litres: 'l', L: 'l',
  teaspoon: 'tsp', teaspoons: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp',
  cups: 'cup',
  ounce: 'oz', ounces: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  pieces: 'piece', pc: 'piece', pcs: 'piece',
};

export function normalizeUnit(unit: string): string {
  const u = unit.trim();
  return ALIASES[u] ?? ALIASES[u.toLowerCase()] ?? u.toLowerCase();
}

export function unitFamily(unit: string): UnitFamily {
  return UNIT_DEFS[normalizeUnit(unit)]?.family ?? 'count';
}

/** Convert between two units of the same family; null when no valid conversion exists. */
export function convertUnit(quantity: number, from: string, to: string): number | null {
  const f = normalizeUnit(from);
  const t = normalizeUnit(to);
  if (f === t) return quantity;
  const a = UNIT_DEFS[f];
  const b = UNIT_DEFS[t];
  if (!a || !b || a.family !== b.family) return null;
  return (quantity * a.toBase) / b.toBase;
}

export function baseUnitFor(unit: string): string {
  const def = UNIT_DEFS[normalizeUnit(unit)];
  if (!def) return normalizeUnit(unit);
  return def.family === 'mass' ? 'g' : 'ml';
}
