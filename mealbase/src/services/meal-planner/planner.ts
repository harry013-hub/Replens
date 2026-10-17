/**
 * Recipe-based weekly planner. Deterministic for a given seed; no LLM required.
 *
 * - Fills breakfast, lunch and dinner for each date in scope.
 * - Never touches locked slots.
 * - In target mode, picks recipes and portion multipliers (0.75–2 servings)
 *   to land near the daily target. It never shrinks portions below 0.75 of a
 *   serving and never leaves a meal out to hit a number.
 */
import { PLANNED_MEAL_TYPES, type NutrientValues, type PlannedMealType } from '../../shared/types/nutrition';
import type { DayTotal, PlannerPreferences } from '../../shared/types/planning';
import { addValues, EMPTY_VALUES, scaleValues } from '../../shared/lib/nutrition';
import { evaluateRecipe, explainNoCandidates, type PlannerRecipe, type RecipeEvaluation } from './filters';

export const SERVING_MULTIPLIERS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export const MIN_TARGET = 1000;
export const MAX_TARGET = 6000;

export class PlanConflictError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join(' '));
    this.name = 'PlanConflictError';
  }
}

export interface ExistingSlot {
  date: string;
  mealType: PlannedMealType;
  recipeId: string | null;
  servings: number;
  locked: boolean;
  /** Estimated calories for the planned portion (already scaled by servings). */
  calories: number | null;
}

export type RegenerateScope =
  | { scope: 'week' }
  | { scope: 'day'; date: string }
  | { scope: 'slot'; date: string; mealType: PlannedMealType };

export interface GenerateInput {
  recipes: PlannerRecipe[];
  prefs: PlannerPreferences;
  dates: string[];
  existing: ExistingSlot[];
  regenerate: RegenerateScope;
  targetApplied: boolean;
  seed: number;
}

export interface GeneratedSlot {
  date: string;
  mealType: PlannedMealType;
  recipeId: string;
  servings: number;
  flags: string[];
}

export interface GenerateOutput {
  slots: GeneratedSlot[];
}

/** Small seeded PRNG (mulberry32) so plans are reproducible in tests. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function key(date: string, mealType: string) {
  return `${date}|${mealType}`;
}

export function generatePlanSlots(input: GenerateInput): GenerateOutput {
  const { recipes, prefs, dates, existing, regenerate, targetApplied } = input;
  const rng = createRng(input.seed);

  const evaluations = recipes.map((recipe) => ({ recipe, evaluation: evaluateRecipe(recipe, prefs, targetApplied) }));
  const evalById = new Map<string, RecipeEvaluation>(evaluations.map((e) => [e.recipe.id, e.evaluation]));
  const eligible = evaluations.filter((e) => e.evaluation.eligible).map((e) => e.recipe);

  const existingByKey = new Map(existing.map((s) => [key(s.date, s.mealType), s]));

  // Which slots must be (re)filled?
  const inScope = (date: string, mealType: PlannedMealType) =>
    regenerate.scope === 'week' ||
    (regenerate.scope === 'day' && regenerate.date === date) ||
    (regenerate.scope === 'slot' && regenerate.date === date && regenerate.mealType === mealType);

  const toFill: Array<{ date: string; mealType: PlannedMealType }> = [];
  for (const date of dates) {
    for (const mealType of PLANNED_MEAL_TYPES) {
      const ex = existingByKey.get(key(date, mealType));
      if (ex?.locked) continue;
      if (!ex || inScope(date, mealType)) toFill.push({ date, mealType });
    }
  }

  // Usage of recipes in slots we keep.
  const fillKeys = new Set(toFill.map((s) => key(s.date, s.mealType)));
  const usage = new Map<string, number>();
  const usedOnDate = new Map<string, Set<string>>();
  const kept = existing.filter((s) => !fillKeys.has(key(s.date, s.mealType)));
  for (const s of kept) {
    if (!s.recipeId) continue;
    usage.set(s.recipeId, (usage.get(s.recipeId) ?? 0) + 1);
    if (!usedOnDate.has(s.date)) usedOnDate.set(s.date, new Set());
    usedOnDate.get(s.date)!.add(s.recipeId);
  }

  // Pre-flight conflict check per meal type.
  const problems: string[] = [];
  for (const mealType of PLANNED_MEAL_TYPES) {
    const needed = toFill.filter((s) => s.mealType === mealType).length;
    if (needed === 0) continue;
    const pool = eligible.filter((r) => r.mealTypes.includes(mealType));
    if (pool.length === 0) {
      problems.push(explainNoCandidates(mealType, evaluations, prefs));
    } else if (!prefs.allowRepeats) {
      const replaced = regenerate.scope === 'slot' ? existingByKey.get(key(regenerate.date, regenerate.mealType))?.recipeId : null;
      const fresh = pool.filter((r) => !usage.get(r.id) && r.id !== replaced).length;
      if (fresh < needed) {
        problems.push(
          `Only ${fresh} ${mealType} recipe${fresh === 1 ? '' : 's'} fit your preferences without repeating, but ${needed} ${needed === 1 ? 'is' : 'are'} needed. Allow repeated meals or add more ${mealType} recipes.`,
        );
      }
    }
  }
  if (problems.length) throw new PlanConflictError(problems);

  const replacedRecipe = regenerate.scope === 'slot'
    ? existingByKey.get(key(regenerate.date, regenerate.mealType))?.recipeId ?? null
    : null;

  const candidatesFor = (date: string, mealType: PlannedMealType, takenToday: Set<string>) => {
    let pool = eligible.filter((r) => r.mealTypes.includes(mealType));
    if (replacedRecipe && pool.length > 1) pool = pool.filter((r) => r.id !== replacedRecipe);
    if (!prefs.allowRepeats) pool = pool.filter((r) => !usage.get(r.id));
    // Avoid the same recipe twice in one day when there is any alternative.
    const notToday = pool.filter((r) => !takenToday.has(r.id));
    return notToday.length ? notToday : pool;
  };

  const repeatPenalty = (id: string, date: string) => {
    let p = (usage.get(id) ?? 0) * 1.0;
    // Prefer not repeating on adjacent days.
    const idx = dates.indexOf(date);
    for (const d of [dates[idx - 1], dates[idx + 1]]) if (d && usedOnDate.get(d)?.has(id)) p += 1.5;
    return p;
  };

  const pickWeighted = (pool: PlannerRecipe[], date: string): PlannerRecipe => {
    const weights = pool.map((r) => 1 / (1 + repeatPenalty(r.id, date) * 2));
    const total = weights.reduce((a, b) => a + b, 0);
    let x = rng() * total;
    for (let i = 0; i < pool.length; i++) {
      x -= weights[i];
      if (x <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  };

  const record = (id: string, date: string) => {
    usage.set(id, (usage.get(id) ?? 0) + 1);
    if (!usedOnDate.has(date)) usedOnDate.set(date, new Set());
    usedOnDate.get(date)!.add(id);
  };

  const out: GeneratedSlot[] = [];
  const target = targetApplied ? prefs.calorieTarget : null;

  for (const date of dates) {
    const slots = toFill.filter((s) => s.date === date);
    if (!slots.length) continue;
    const takenToday = new Set(usedOnDate.get(date) ?? []);

    if (target === null) {
      for (const s of slots) {
        const r = pickWeighted(candidatesFor(date, s.mealType, takenToday), date);
        takenToday.add(r.id);
        record(r.id, date);
        out.push({ date, mealType: s.mealType, recipeId: r.id, servings: 1, flags: evalById.get(r.id)?.flags ?? [] });
      }
      continue;
    }

    // Target mode: search combinations of recipes and multipliers.
    const keptCalories = kept
      .filter((s) => s.date === date)
      .reduce((sum, s) => sum + (s.calories ?? 0), 0);
    const remaining = target - keptCalories;

    let best: { picks: PlannerRecipe[]; mults: number[]; score: number } | null = null;
    const ATTEMPTS = 250;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const picks: PlannerRecipe[] = [];
      const taken = new Set(takenToday);
      for (const s of slots) {
        const pool = candidatesFor(date, s.mealType, taken).filter((r) => prefs.allowRepeats || !picks.includes(r));
        const r = pickWeighted(pool.length ? pool : candidatesFor(date, s.mealType, taken), date);
        picks.push(r);
        taken.add(r.id);
      }
      const base = picks.map((r) => r.perServing.calories ?? 0);
      const choice = bestMultipliers(base, remaining);
      const penalty = picks.reduce((p, r) => p + repeatPenalty(r.id, date) * 40, 0);
      const score = choice.error + choice.deviation * 15 + penalty;
      if (!best || score < best.score) best = { picks, mults: choice.mults, score };
    }

    best!.picks.forEach((r, i) => {
      record(r.id, date);
      out.push({ date, mealType: slots[i].mealType, recipeId: r.id, servings: best!.mults[i], flags: evalById.get(r.id)?.flags ?? [] });
    });
  }

  return { slots: out };
}

/** Exhaustively choose multipliers (≤3 slots × 6 options) closest to the target. */
function bestMultipliers(base: number[], target: number): { mults: number[]; error: number; deviation: number } {
  let best = { mults: base.map(() => 1), error: Infinity, deviation: Infinity };
  const n = base.length;
  const idx = new Array(n).fill(0);
  const M = SERVING_MULTIPLIERS;
  for (;;) {
    let total = 0;
    let deviation = 0;
    for (let i = 0; i < n; i++) {
      total += base[i] * M[idx[i]];
      deviation += Math.abs(M[idx[i]] - 1);
    }
    const error = Math.abs(total - target);
    if (error + deviation * 15 < best.error + best.deviation * 15) {
      best = { mults: idx.map((j) => M[j]), error, deviation };
    }
    let i = 0;
    while (i < n && ++idx[i] === M.length) idx[i++] = 0;
    if (i === n) break;
  }
  return best;
}

export function computeDayTotals(
  items: Array<{ date: string; nutrition: NutrientValues }>,
  dates: string[],
  target: number | null,
  tolerancePct: number,
): DayTotal[] {
  return dates.map((date) => {
    const nutrition = items
      .filter((i) => i.date === date)
      .reduce((acc, i) => addValues(acc, i.nutrition), { ...EMPTY_VALUES });
    if (target === null || nutrition.calories === null) {
      return { date, nutrition, target, difference: null, withinTolerance: null };
    }
    const difference = nutrition.calories - target;
    return {
      date,
      nutrition,
      target,
      difference,
      withinTolerance: Math.abs(difference) <= (target * tolerancePct) / 100,
    };
  });
}

export function itemNutrition(perServing: NutrientValues, servings: number): NutrientValues {
  return scaleValues(perServing, servings);
}
