/**
 * Allergen and diet matching for recipe filtering.
 *
 * IMPORTANT: this is a planning aid, not a safety guarantee. It only knows the
 * ingredient names and tags in the recipe data. Product labels, recipes'
 * hidden ingredients and cross-contact are outside what it can check.
 */
import type { Diet } from '../types/planning';

export const KNOWN_ALLERGENS = [
  'milk', 'egg', 'peanut', 'tree_nut', 'soy', 'wheat', 'gluten', 'fish', 'shellfish', 'sesame',
] as const;
export type AllergenKey = (typeof KNOWN_ALLERGENS)[number];

const ALLERGEN_SYNONYMS: Record<string, AllergenKey[]> = {
  milk: ['milk'], dairy: ['milk'], lactose: ['milk'], 'cow milk': ['milk'],
  egg: ['egg'], eggs: ['egg'],
  peanut: ['peanut'], peanuts: ['peanut'],
  'tree nut': ['tree_nut'], 'tree nuts': ['tree_nut'], tree_nut: ['tree_nut'],
  nut: ['tree_nut', 'peanut'], nuts: ['tree_nut', 'peanut'],
  almond: ['tree_nut'], almonds: ['tree_nut'], walnut: ['tree_nut'], cashew: ['tree_nut'],
  soy: ['soy'], soya: ['soy'], soybean: ['soy'],
  wheat: ['wheat', 'gluten'], gluten: ['gluten'], coeliac: ['gluten'], celiac: ['gluten'],
  fish: ['fish'],
  shellfish: ['shellfish'], crustacean: ['shellfish'], shrimp: ['shellfish'], prawn: ['shellfish'],
  sesame: ['sesame'],
};

/** Name keywords that indicate an allergen when no explicit tag exists. */
const ALLERGEN_KEYWORDS: Record<AllergenKey, string[]> = {
  milk: ['milk', 'cheese', 'cheddar', 'feta', 'mozzarella', 'parmesan', 'yogurt', 'yoghurt', 'butter', 'cream', 'whey', 'cottage'],
  egg: ['egg', 'mayonnaise'],
  peanut: ['peanut'],
  tree_nut: ['almond', 'walnut', 'cashew', 'pecan', 'pistachio', 'hazelnut', 'macadamia', 'brazil nut'],
  soy: ['soy', 'tofu', 'edamame', 'tempeh', 'miso'],
  wheat: ['wheat', 'bread', 'pasta', 'flour', 'couscous', 'bulgur', 'pita', 'noodle', 'spaghetti'],
  gluten: ['wheat', 'bread', 'pasta', 'flour', 'couscous', 'bulgur', 'barley', 'rye', 'pita', 'noodle', 'spaghetti', 'seitan'],
  fish: ['fish', 'salmon', 'tuna', 'cod', 'sardine', 'anchovy', 'trout', 'mackerel', 'haddock'],
  shellfish: ['shrimp', 'prawn', 'crab', 'lobster', 'mussel', 'clam', 'oyster', 'scallop'],
  sesame: ['sesame', 'tahini', 'hummus'],
};

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  meat: ['chicken', 'beef', 'pork', 'turkey', 'lamb', 'bacon', 'ham', 'sausage', 'steak', 'mince'],
  fish: ALLERGEN_KEYWORDS.fish,
  shellfish: ALLERGEN_KEYWORDS.shellfish,
  dairy: ALLERGEN_KEYWORDS.milk,
  egg: ['egg'],
  honey: ['honey'],
};

/** Keywords that should not trigger a match despite containing one, e.g. "peanut butter" ≠ dairy. */
const NEGATIVE_PHRASES: Record<string, string[]> = {
  milk: ['peanut butter', 'almond butter', 'soy milk', 'soymilk', 'almond milk', 'oat milk', 'coconut milk', 'cocoa butter', 'butternut', 'butter bean'],
  dairy: ['peanut butter', 'almond butter', 'soy milk', 'soymilk', 'almond milk', 'oat milk', 'coconut milk', 'cocoa butter', 'butternut', 'butter bean'],
  egg: ['eggplant'],
};

function containsWord(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}(e?s)?([^a-z]|$)`, 'i').test(text);
}

function stripNegatives(text: string, key: string): string {
  let t = text.toLowerCase();
  for (const p of NEGATIVE_PHRASES[key] ?? []) t = t.split(p).join(' ');
  return t;
}

export function nameMentions(name: string, keyword: string): boolean {
  return containsWord(name.toLowerCase(), keyword.toLowerCase().trim());
}

export function detectAllergensByName(name: string): AllergenKey[] {
  return KNOWN_ALLERGENS.filter((key) => {
    const text = stripNegatives(name, key);
    return ALLERGEN_KEYWORDS[key].some((kw) => containsWord(text, kw));
  });
}

export function detectCategoriesByName(name: string): string[] {
  return Object.keys(CATEGORY_KEYWORDS).filter((cat) => {
    const text = stripNegatives(name, cat);
    return CATEGORY_KEYWORDS[cat].some((kw) => containsWord(text, kw));
  });
}

/** Map a user's allergy text to known allergen keys. Empty = unknown term. */
export function resolveAllergy(term: string): AllergenKey[] {
  const t = term.trim().toLowerCase();
  return ALLERGEN_SYNONYMS[t] ?? (KNOWN_ALLERGENS.includes(t as AllergenKey) ? [t as AllergenKey] : []);
}

const DIET_BLOCKS: Record<Diet, string[]> = {
  none: [],
  pescatarian: ['meat'],
  vegetarian: ['meat', 'fish', 'shellfish'],
  vegan: ['meat', 'fish', 'shellfish', 'dairy', 'egg', 'honey'],
};

export function blockedCategories(diet: Diet): string[] {
  return DIET_BLOCKS[diet];
}

export function allergenLabel(key: string): string {
  return key === 'tree_nut' ? 'tree nuts' : key;
}
