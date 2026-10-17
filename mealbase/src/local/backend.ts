/**
 * In-browser MealBase backend for static hosting (e.g. inside RepLens on Netlify
 * or GitHub Pages). It answers the same /api/v1/nutrition routes as the Node
 * server, so the UI and NutritionApiClient are unchanged — the client simply
 * gets `backend.fetch` instead of `window.fetch`.
 *
 * Data lives in this browser's localStorage under one key (single user, this
 * device only), like RepLens's own history. Every write is applied to a copy
 * and committed only after it was stored, so a failed save never looks saved.
 *
 * Business rules come from the same shared modules the server uses:
 * portion maths, planner, grocery list, recipe nutrition, validation, CSV/JSON formats.
 */
import type { ClientConfig, CreateLogEntryRequest, FoodSearchResponse, FoodSearchResult, HistoryDay, Me, UserPreferences } from '../shared/types/api';
import { MEAL_TYPES, type DailySummary, type Food, type FoodLogEntry, type NutrientValues, type NutritionSnapshot, type ServingOption } from '../shared/types/nutrition';
import {
  DEFAULT_PLANNER_PREFERENCES, type MealPlan, type MealPlanItem, type PlannerPreferences, type PlanRecipeSnapshot, type PlanStatus, type Recipe, type RecipeIngredient,
} from '../shared/types/planning';
import { computePortion, NutritionError, scaleValues, sumNutrients } from '../shared/lib/nutrition';
import { addDays, browserTimeZone, dateRange, isLocalDate, nextWeekStart, todayInTimeZone, weekDates } from '../shared/lib/dates';
import { detectAllergensByName, detectCategoriesByName } from '../shared/lib/allergens';
import { buildGroceryList, computeDayTotals, computeRecipeNutrition, generatePlanSlots, PlanConflictError, preferenceWarnings, type ExistingSlot, type PlannerRecipe, type RegenerateScope } from '../services/meal-planner';
import { ProviderError, type FoodProvider, type ProviderFood } from '../services/food-provider/types';
import type { z } from 'zod';
import { HttpError } from '../server/http/router';
import {
  createLogSchema, generatePlanSchema, logPlanItemSchema, manualFoodSchema, parse, preferencesSchema, profileSchema, recipeSchema,
  regenerateSchema, servingSchema, updateLogSchema, updatePlanItemSchema,
} from '../server/validation';
import { importSchema, logsToCsv, PLANS_EXPORT_FORMAT, PLANS_EXPORT_VERSION } from '../server/services/export-format';
import { RECIPE_SEEDS, SAMPLE_FOODS } from '../database/seed-data';

export const STORAGE_KEY = 'mealbase.v1';
const PROFILE_ID = 'local-user';

type StoredLog = FoodLogEntry & { idempotencyKey: string | null };
type StoredRecipe = Omit<Recipe, 'nutrition'> & { seedKey: string | null };
interface StoredPlan {
  id: string; weekStart: string; status: PlanStatus; preferences: PlannerPreferences; targetApplied: boolean;
  warnings: string[]; createdAt: string; updatedAt: string;
}
type StoredItem = Omit<MealPlanItem, 'loggedCount'>;

export interface LocalState {
  version: 1;
  profile: { id: string; displayName: string; timezone: string; createdAt: string };
  prefs: { dailyCalorieTarget: number | null; adultConfirmed: boolean; planner: PlannerPreferences; updatedAt: string | null };
  foods: Record<string, Food>;
  logs: StoredLog[];
  recipes: Record<string, StoredRecipe>;
  plans: Record<string, StoredPlan>;
  items: Record<string, StoredItem>;
}

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export interface LocalBackendOptions {
  storage?: StorageLike | null;
  provider?: (FoodProvider & {
    probe?: () => Promise<unknown>; usingDemoKey?: boolean; mode?: 'proxy' | 'direct' | null;
    deviceKey?: () => string | null; setDeviceKey?: (k: string | null) => void;
  }) | null;
  workout?: { url: string | null; label: string };
  sampleFoodsEnabled?: boolean;
  now?: () => Date;
  newId?: () => string;
}

const SOURCE_LABEL: Record<Food['source'], string> = { usda: 'USDA FoodData Central', manual: 'Entered by you', sample: 'Sample data (not from USDA)' };

function seedState(now: string, tz: string): LocalState {
  const foods: Record<string, Food> = {};
  for (const [key, f] of Object.entries(SAMPLE_FOODS)) {
    const [calories, proteinG, carbsG, fatG] = f.per100g;
    const id = `sample:${key}`;
    foods[id] = {
      id, source: 'sample', sourceFoodId: key, name: f.name, brand: null, dataType: 'Sample data',
      reference: { quantity: 100, unit: 'g', unitLabel: null, values: { calories, proteinG, carbsG, fatG } },
      servings: f.servings.map(([label, unitKey, grams], i) => ({ id: `${id}:${i}`, label, unitKey, refAmount: grams, source: 'sample' as const })),
      isSample: true, attribution: 'Development sample data (approximate, not from a live provider)',
    };
  }
  const recipes: Record<string, StoredRecipe> = {};
  for (const r of RECIPE_SEEDS) {
    const id = `seed:${r.key}`;
    recipes[id] = {
      id, ownerProfileId: null, seedKey: r.key, name: r.name, description: r.description ?? null, mealTypes: r.mealTypes,
      prepMinutes: r.prepMinutes, budgetLevel: r.budget, servings: r.servings, instructions: r.instructions, isSample: true,
      createdAt: now, updatedAt: now,
      ingredients: r.ingredients.map((i, idx) => {
        const def = i.food ? SAMPLE_FOODS[i.food] : null;
        return {
          id: `${id}:${idx}`, name: i.name ?? def?.name ?? 'Ingredient', quantity: i.qty, unit: i.unit,
          foodId: i.food ? `sample:${i.food}` : null, allergens: def?.allergens ?? [], mayContain: def?.mayContain ?? [],
          category: def?.category ?? null, sortOrder: idx,
        };
      }),
    };
  }
  return {
    version: 1,
    profile: { id: PROFILE_ID, displayName: 'Me', timezone: tz, createdAt: now },
    prefs: { dailyCalorieTarget: null, adultConfirmed: false, planner: { ...DEFAULT_PLANNER_PREFERENCES }, updatedAt: null },
    foods, logs: [], recipes, plans: {}, items: {},
  };
}

export class LocalBackend {
  private state: LocalState;
  /** 'device' = saved in localStorage; 'memory' = storage unavailable, lost on close. */
  readonly persistence: 'device' | 'memory';
  private readonly storage: StorageLike | null;
  private readonly provider: LocalBackendOptions['provider'];
  private readonly opts: LocalBackendOptions;

  constructor(opts: LocalBackendOptions = {}) {
    this.opts = opts;
    this.provider = opts.provider ?? null;
    let storage: StorageLike | null = opts.storage === undefined ? (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })() : opts.storage;
    // Probe that we can actually write (Safari Private Browsing, disabled storage…).
    if (storage) {
      try { storage.setItem(`${STORAGE_KEY}.probe`, '1'); storage.removeItem(`${STORAGE_KEY}.probe`); } catch { storage = null; }
    }
    this.storage = storage;
    this.persistence = storage ? 'device' : 'memory';
    const now = this.nowIso();
    let loaded: LocalState | null = null;
    if (storage) {
      try {
        const raw = storage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && parsed.version === 1 && parsed.foods && parsed.recipes) loaded = parsed;
      } catch { loaded = null; }
    }
    this.state = loaded ?? seedState(now, browserTimeZoneSafe());
    if (!loaded) this.trySave(this.state);
  }

  // ---------------- plumbing ----------------

  private nowIso() { return (this.opts.now?.() ?? new Date()).toISOString(); }
  private id() { return this.opts.newId?.() ?? (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`); }
  private today() { return todayInTimeZone(this.state.profile.timezone, this.opts.now?.() ?? new Date()); }

  private trySave(s: LocalState): boolean {
    if (!this.storage) return true;
    try { this.storage.setItem(STORAGE_KEY, JSON.stringify(s)); return true; } catch { return false; }
  }

  /** Apply a change to a copy; keep it only if it could be stored. */
  private mutate<T>(fn: (s: LocalState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    if (!this.trySave(draft)) {
      throw new HttpError(507, 'STORAGE_ERROR', 'This browser couldn’t save the change (storage is full or blocked), so nothing was saved.');
    }
    this.state = draft;
    return result;
  }

  /** Drop-in replacement for window.fetch, scoped to the MealBase API base path. */
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://local');
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string' && init.body) {
      try { body = JSON.parse(init.body); } catch { return this.errorResponse(new HttpError(400, 'VALIDATION_ERROR', 'Request body is not valid JSON.')); }
    }
    const path = url.pathname.replace(/^.*\/api\/v1\/nutrition/, '') || '/';
    try {
      const r = await this.route(method, path, url.searchParams, body);
      if (r.raw) {
        return new Response(r.raw.data, { status: 200, headers: { 'Content-Type': r.raw.contentType, 'Content-Disposition': `attachment; filename="${r.raw.filename}"` } });
      }
      if (r.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      if (err instanceof HttpError) return this.errorResponse(err);
      if (err instanceof NutritionError) return this.errorResponse(new HttpError(400, err.code, err.message));
      console.error('[mealbase] local backend error', err);
      return this.errorResponse(new HttpError(500, 'INTERNAL_ERROR', 'Something went wrong. Nothing was saved.'));
    }
  };

  private errorResponse(err: HttpError): Response {
    return new Response(JSON.stringify({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }), {
      status: err.status, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ---------------- routing ----------------

  private async route(method: string, path: string, q: URLSearchParams, body: unknown): Promise<{ status?: number; body?: unknown; raw?: { contentType: string; data: string; filename: string } }> {
    const seg = path.split('/').filter(Boolean);
    const is = (m: string, ...parts: string[]) => method === m && seg.length === parts.length && parts.every((p, i) => p === '*' || p === seg[i]);
    const date = (name: string, fallback?: string) => {
      const v = q.get(name) ?? fallback;
      if (!v || !isLocalDate(v)) throw new HttpError(400, 'VALIDATION_ERROR', `Query parameter "${name}" must be a date (YYYY-MM-DD).`);
      return v;
    };

    if (is('GET', 'health')) return { body: { ok: true } };
    if (is('GET', 'config')) return { body: await this.config() };
    if (is('PUT', 'device', 'usda-key')) {
      if (!this.provider?.setDeviceKey) throw new HttpError(404, 'NOT_FOUND', 'This site keeps its food database key on the server.');
      const key = (body as { key?: unknown } | undefined)?.key;
      if (key !== null && (typeof key !== 'string' || !/^[A-Za-z0-9]{20,64}$/.test(key.trim()))) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'That doesn’t look like a data.gov API key (20–64 letters and numbers).');
      }
      try { this.provider.setDeviceKey(key as string | null); } catch { throw new HttpError(507, 'STORAGE_ERROR', 'This browser couldn’t save the key.'); }
      return { body: await this.config() };
    }
    if (seg[0] === 'auth') throw new HttpError(404, 'NOT_FOUND', 'This MealBase runs on your device and has no accounts.');
    if (is('GET', 'me')) return { body: this.me() };
    if (is('PATCH', 'me')) {
      const input = parse(profileSchema, body);
      this.mutate((s) => { if (input.displayName) s.profile.displayName = input.displayName; if (input.timezone) s.profile.timezone = input.timezone; });
      return { body: this.me() };
    }
    if (is('GET', 'preferences')) return { body: this.prefs() };
    if (is('PUT', 'preferences')) {
      const input = parse(preferencesSchema, body);
      if (!input.adultConfirmed && input.planner.mode === 'target') {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Planning around a calorie target is for adults. Confirm you are 18 or older, or use general planning.');
      }
      this.mutate((s) => {
        s.profile.timezone = input.timezone;
        s.prefs = { dailyCalorieTarget: input.dailyCalorieTarget, adultConfirmed: input.adultConfirmed, planner: input.planner, updatedAt: this.nowIso() };
      });
      return { body: this.prefs() };
    }

    // log
    if (is('GET', 'summary')) return { body: this.summary(date('date', this.today())) };
    if (is('GET', 'logs')) {
      const from = date('from'); const to = date('to', from);
      try { dateRange(from, to, 370); } catch (e) { throw new HttpError(400, 'VALIDATION_ERROR', (e as Error).message); }
      return { body: { entries: this.logsIn(from, to) } };
    }
    if (is('POST', 'logs')) { const r = this.createLog(parse(createLogSchema, body)); return { status: r.duplicate ? 200 : 201, body: r }; }
    if (is('PATCH', 'logs', '*')) return { body: { entry: this.updateLog(seg[1], parse(updateLogSchema, body)) } };
    if (is('DELETE', 'logs', '*')) {
      if (!this.state.logs.some((l) => l.id === seg[1])) throw new HttpError(404, 'NOT_FOUND', 'Entry not found.');
      this.mutate((s) => { s.logs = s.logs.filter((l) => l.id !== seg[1]); });
      return { status: 204 };
    }
    if (is('GET', 'history')) { const to = date('to', this.today()); const from = date('from', addDays(to, -29)); return { body: { days: this.history(from, to) } }; }

    // foods
    if (is('GET', 'foods', 'search')) return { body: await this.search(q.get('q') ?? '', Math.max(1, Math.min(50, Number(q.get('page')) || 1))) };
    if (is('GET', 'foods', 'recent')) return { body: { foods: this.recentFoods() } };
    if (is('POST', 'foods')) {
      const input = parse(manualFoodSchema, body);
      const id = this.id();
      this.mutate((s) => {
        s.foods[id] = {
          id, source: 'manual', sourceFoodId: null, name: input.name, brand: input.brand ?? null, dataType: 'Manual entry',
          reference: { quantity: input.referenceQuantity, unit: input.referenceUnit, unitLabel: input.unitLabel ?? null,
            values: { calories: input.calories, proteinG: input.proteinG ?? null, carbsG: input.carbsG ?? null, fatG: input.fatG ?? null } },
          servings: [], isSample: false, attribution: 'Entered by you',
        };
      });
      return { status: 201, body: { food: this.state.foods[id] } };
    }
    if (is('GET', 'foods', '*')) return { body: { food: await this.getFood(decodeURIComponent(seg[1])) } };
    if (is('POST', 'foods', '*', 'servings')) {
      const input = parse(servingSchema, body);
      const food = this.state.foods[seg[1]];
      if (!food) throw new HttpError(404, 'NOT_FOUND', 'Food not found.');
      if (food.reference.unit !== 'g' && food.reference.unit !== 'ml') {
        throw new HttpError(400, 'UNIT_CONVERSION_UNAVAILABLE', 'Serving sizes can only be added to foods measured in grams or millilitres.');
      }
      const serving: ServingOption = { id: this.id(), label: input.label, unitKey: input.unitKey ?? null, refAmount: input.refAmount, source: 'user' };
      this.mutate((s) => { s.foods[seg[1]].servings.push(serving); });
      return { status: 201, body: { serving } };
    }

    // recipes
    if (is('GET', 'recipes')) return { body: { recipes: this.recipes() } };
    if (is('POST', 'recipes')) {
      const input = parse(recipeSchema, body);
      const id = this.id();
      this.mutate((s) => { s.recipes[id] = this.recipeRecord(s, id, input, this.nowIso()); });
      return { status: 201, body: { recipe: this.recipe(id) } };
    }
    if (is('GET', 'recipes', '*')) return { body: { recipe: this.recipe(seg[1]) } };
    if (is('PUT', 'recipes', '*')) {
      const cur = this.state.recipes[seg[1]];
      if (!cur || cur.ownerProfileId !== PROFILE_ID) throw new HttpError(404, 'NOT_FOUND', 'You can only edit your own recipes. Copy a starter recipe to change it.');
      const input = parse(recipeSchema, body);
      this.mutate((s) => { s.recipes[seg[1]] = { ...this.recipeRecord(s, seg[1], input, cur.createdAt), updatedAt: this.nowIso() }; });
      return { body: { recipe: this.recipe(seg[1]) } };
    }
    if (is('DELETE', 'recipes', '*')) {
      const cur = this.state.recipes[seg[1]];
      if (!cur || cur.ownerProfileId !== PROFILE_ID) throw new HttpError(404, 'NOT_FOUND', 'Recipe not found.');
      this.mutate((s) => { delete s.recipes[seg[1]]; });
      return { status: 204 };
    }

    // plans
    if (is('GET', 'plans')) return { body: { plans: this.listPlans() } };
    if (is('POST', 'plans')) return { status: 201, body: { plan: this.generatePlan(parse(generatePlanSchema, body)) } };
    if (is('GET', 'plans', '*')) return { body: { plan: this.plan(seg[1]) } };
    if (is('DELETE', 'plans', '*')) {
      if (!this.state.plans[seg[1]]) throw new HttpError(404, 'NOT_FOUND', 'Meal plan not found.');
      this.mutate((s) => {
        delete s.plans[seg[1]];
        for (const [id, it] of Object.entries(s.items)) if (it.planId === seg[1]) delete s.items[id];
      });
      return { status: 204 };
    }
    if (is('POST', 'plans', '*', 'regenerate')) {
      const input = parse(regenerateSchema, body);
      return { body: { plan: this.regenerate(seg[1], input.scope, input.date, input.seed) } };
    }
    if (is('POST', 'plans', '*', 'save')) return { body: { plan: this.savePlan(seg[1], (body as { overwrite?: unknown } | undefined)?.overwrite === true) } };
    if (is('GET', 'plans', '*', 'grocery-list')) {
      const plan = this.plan(seg[1]);
      const from = q.get('from'); const to = q.get('to');
      const items = plan.items.filter((i) => (!from || i.date >= from) && (!to || i.date <= to));
      return { body: { people: plan.preferences.people, lines: buildGroceryList(items.map((i) => ({ recipe: i.recipe, servings: i.servings })), plan.preferences.people) } };
    }
    if (is('PATCH', 'plan-items', '*')) return { body: { plan: this.updateItem(seg[1], parse(updatePlanItemSchema, body)) } };
    if (is('POST', 'plan-items', '*', 'replace')) return { body: { plan: this.replaceItem(seg[1]) } };
    if (is('POST', 'plan-items', '*', 'log')) {
      const r = this.logItem(seg[1], parse(logPlanItemSchema, body));
      return { status: r.duplicate ? 200 : 201, body: r };
    }

    // data
    if (is('GET', 'export', 'logs.csv')) {
      const to = date('to', this.today()); const from = date('from', addDays(to, -365));
      if (from > to) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a valid date range.');
      return { raw: { contentType: 'text/csv; charset=utf-8', data: logsToCsv(this.logsIn(from, to)), filename: `mealbase-food-log-${from}-to-${to}.csv` } };
    }
    if (is('GET', 'export', 'plans.json')) {
      const data = this.exportPlans();
      return { raw: { contentType: 'application/json; charset=utf-8', data: JSON.stringify(data, null, 2), filename: `mealbase-plans-${data.exportedAt.slice(0, 10)}.json` } };
    }
    if (is('POST', 'import', 'plans')) return { status: 201, body: this.importPlans(body, q.get('includePreferences') !== 'false') };
    if (is('DELETE', 'data', 'history') || is('DELETE', 'data', 'all')) {
      if ((body as { confirm?: unknown } | undefined)?.confirm !== 'DELETE') throw new HttpError(400, 'VALIDATION_ERROR', 'Send { "confirm": "DELETE" } to confirm.');
      if (seg[1] === 'history') {
        const n = this.state.logs.length;
        this.mutate((s) => { s.logs = []; });
        return { body: { deletedEntries: n } };
      }
      this.mutate((s) => {
        const fresh = seedState(this.nowIso(), s.profile.timezone);
        // Keep cached USDA foods (not personal); drop everything personal.
        for (const [id, f] of Object.entries(s.foods)) if (f.source === 'usda') fresh.foods[id] = { ...f, servings: f.servings.filter((x) => x.source !== 'user') };
        Object.assign(s, fresh);
      });
      return { status: 204 };
    }
    throw new HttpError(404, 'NOT_FOUND', 'No such API route.');
  }

  // ---------------- profile & config ----------------

  private async config(): Promise<ClientConfig> {
    if (this.provider?.probe) await this.provider.probe();
    return {
      apiVersion: 'v1',
      authMode: 'local',
      foodProvider: {
        id: 'usda', configured: Boolean(this.provider?.isConfigured()), usingDemoKey: Boolean(this.provider?.usingDemoKey),
        attribution: this.provider?.attribution ?? 'U.S. Department of Agriculture, Agricultural Research Service. FoodData Central. fdc.nal.usda.gov (public domain, CC0 1.0).',
        mode: this.provider?.mode ?? 'proxy',
        deviceKeySet: Boolean(this.provider?.deviceKey?.()),
      },
      sampleFoodsEnabled: this.opts.sampleFoodsEnabled ?? true,
      workout: { configured: Boolean(this.opts.workout?.url), url: this.opts.workout?.url ?? null, label: this.opts.workout?.label ?? 'Workouts' },
      persistence: this.persistence,
    };
  }

  private me(): Me {
    const p = this.state.profile;
    return { profileId: p.id, displayName: p.displayName, email: null, timezone: p.timezone, authMode: 'local' };
  }

  private prefs(): UserPreferences {
    const p = this.state.prefs;
    return { dailyCalorieTarget: p.dailyCalorieTarget, adultConfirmed: p.adultConfirmed, timezone: this.state.profile.timezone, planner: { ...DEFAULT_PLANNER_PREFERENCES, ...p.planner }, updatedAt: p.updatedAt };
  }

  // ---------------- log ----------------

  private publicLog(l: StoredLog): FoodLogEntry {
    const { idempotencyKey: _k, ...rest } = l;
    return rest;
  }

  private logsIn(from: string, to: string): FoodLogEntry[] {
    return this.state.logs.filter((l) => l.localDate >= from && l.localDate <= to)
      .sort((a, b) => a.localDate.localeCompare(b.localDate) || a.createdAt.localeCompare(b.createdAt))
      .map((l) => this.publicLog(l));
  }

  private summary(localDate: string): DailySummary {
    const entries = this.logsIn(localDate, localDate);
    return {
      localDate,
      totals: sumNutrients(entries.map((e) => e.nutrition)),
      meals: MEAL_TYPES.map((mealType) => {
        const list = entries.filter((e) => e.mealType === mealType);
        return { mealType, entries: list, totals: sumNutrients(list.map((e) => e.nutrition)) };
      }),
      dailyCalorieTarget: this.state.prefs.dailyCalorieTarget,
    };
  }

  private history(from: string, to: string): HistoryDay[] {
    const byDay = new Map<string, FoodLogEntry[]>();
    for (const l of this.logsIn(from, to)) byDay.set(l.localDate, [...(byDay.get(l.localDate) ?? []), l]);
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([localDate, list]) => {
      const t = sumNutrients(list.map((e) => e.nutrition));
      return { localDate, entryCount: list.length, nutrition: { calories: t.calories, proteinG: t.proteinG, carbsG: t.carbsG, fatG: t.fatG }, missingCalories: t.missing.calories };
    });
  }

  private newLog(s: LocalState, e: Omit<StoredLog, 'id' | 'profileId' | 'createdAt' | 'updatedAt'>): StoredLog {
    const ts = this.nowIso();
    const entry: StoredLog = { ...e, id: this.id(), profileId: PROFILE_ID, createdAt: ts, updatedAt: ts };
    s.logs.push(entry);
    return entry;
  }

  private createLog(req: CreateLogEntryRequest): { entry: FoodLogEntry; duplicate: boolean } {
    if (req.idempotencyKey) {
      const prior = this.state.logs.find((l) => l.idempotencyKey === req.idempotencyKey);
      if (prior) return { entry: this.publicLog(prior), duplicate: true };
    }
    return this.mutate((s) => {
      if (req.quick) {
        const values: NutrientValues = { calories: req.quick.calories, proteinG: req.quick.proteinG ?? null, carbsG: req.quick.carbsG ?? null, fatG: req.quick.fatG ?? null };
        const snapshot: NutritionSnapshot = { version: 1, source: 'quick', sourceFoodId: null, isSample: false, reference: { quantity: 1, unit: 'serving', unitLabel: 'serving', values }, serving: null, values, computedAt: this.nowIso() };
        const e = this.newLog(s, { localDate: req.localDate, mealType: req.mealType, foodId: null, recipeId: null, displayName: req.displayName || req.quick.name,
          quantity: 1, unit: 'serving', unitLabel: 'serving', nutrition: values, snapshot, sourcePlanItemId: null, idempotencyKey: req.idempotencyKey ?? null });
        return { entry: this.publicLog(e), duplicate: false };
      }
      const food = s.foods[req.foodId!];
      if (!food) throw new HttpError(404, 'NOT_FOUND', 'Food not found. Search for it again.');
      const portion = computePortion(food, { quantity: req.quantity!, unit: req.unit! });
      const snapshot: NutritionSnapshot = {
        version: 1, source: food.source, sourceFoodId: food.sourceFoodId, isSample: food.isSample, reference: food.reference,
        serving: portion.serving ? { label: portion.serving.label, refAmount: portion.serving.refAmount } : null, values: portion.values, computedAt: this.nowIso(),
      };
      const e = this.newLog(s, {
        localDate: req.localDate, mealType: req.mealType, foodId: food.id, recipeId: null,
        displayName: req.displayName || (food.brand ? `${food.name} (${food.brand})` : food.name),
        quantity: req.quantity!, unit: req.unit!, unitLabel: portion.unitLabel, nutrition: portion.values, snapshot, sourcePlanItemId: null,
        idempotencyKey: req.idempotencyKey ?? null,
      });
      return { entry: this.publicLog(e), duplicate: false };
    });
  }

  private updateLog(id: string, patch: { localDate?: string; mealType?: FoodLogEntry['mealType']; quantity?: number; unit?: string; displayName?: string }): FoodLogEntry {
    const cur = this.state.logs.find((l) => l.id === id);
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Entry not found.');
    return this.mutate((s) => {
      const e = s.logs.find((l) => l.id === id)!;
      if (patch.quantity !== undefined || patch.unit !== undefined) {
        const quantity = patch.quantity ?? e.quantity;
        const unit = patch.unit ?? e.unit;
        const snap = e.snapshot;
        const servings: ServingOption[] = snap.serving ? [{ id: 'snapshot', label: snap.serving.label, unitKey: null, refAmount: snap.serving.refAmount, source: 'provider' }] : [];
        const effective = unit === e.unit && e.unit.startsWith('serving:') ? 'serving:snapshot' : unit;
        if (effective !== snap.reference.unit && effective !== 'serving:snapshot') {
          throw new HttpError(400, 'UNIT_CONVERSION_UNAVAILABLE', 'To change the unit, delete this entry and add the food again.');
        }
        const portion = computePortion({ reference: snap.reference, servings }, { quantity, unit: effective });
        e.quantity = quantity;
        e.unit = unit;
        e.unitLabel = snap.serving && effective === 'serving:snapshot' ? snap.serving.label : portion.unitLabel;
        e.nutrition = portion.values;
        e.snapshot = { ...snap, serving: effective === 'serving:snapshot' ? snap.serving : null, values: portion.values, computedAt: this.nowIso() };
      }
      if (patch.localDate) e.localDate = patch.localDate;
      if (patch.mealType) e.mealType = patch.mealType;
      if (patch.displayName) e.displayName = patch.displayName;
      e.updatedAt = this.nowIso();
      return this.publicLog(e);
    });
  }

  // ---------------- foods ----------------

  private toResult(f: Food): FoodSearchResult {
    return { ref: f.id, name: f.name, brand: f.brand, source: f.source, sourceLabel: SOURCE_LABEL[f.source], dataType: f.dataType,
      preview: { quantity: f.reference.quantity, unit: f.reference.unit, values: f.reference.values }, isSample: f.isSample };
  }

  private async search(query: string, page: number): Promise<FoodSearchResponse> {
    const q = query.trim();
    if (q.length < 2) throw new HttpError(400, 'VALIDATION_ERROR', 'Type at least 2 characters to search.');
    if (q.length > 100) throw new HttpError(400, 'VALIDATION_ERROR', 'Search text is too long.');
    const needle = q.toLowerCase();
    const all = Object.values(this.state.foods);
    const res: FoodSearchResponse = {
      query: q, page, totalPages: null,
      provider: { id: 'usda', status: 'ok', message: null, attribution: this.provider?.attribution ?? '' },
      results: [],
      mine: page === 1 ? all.filter((f) => f.source === 'manual' && f.name.toLowerCase().includes(needle)).slice(0, 10).map((f) => this.toResult(f)) : [],
      sample: page === 1 && (this.opts.sampleFoodsEnabled ?? true) ? all.filter((f) => f.source === 'sample' && f.name.toLowerCase().includes(needle)).slice(0, 10).map((f) => this.toResult(f)) : [],
    };
    if (!this.provider) {
      res.provider.status = 'not_configured';
      res.provider.message = 'Food database search isn’t set up on this site. You can still add foods manually.';
      return res;
    }
    try {
      const p = await this.provider.search(q, page);
      res.totalPages = p.totalPages;
      res.results = p.items.map((i) => ({
        ref: `usda:${i.sourceFoodId}`, name: i.name, brand: i.brand, source: 'usda', sourceLabel: SOURCE_LABEL.usda + (i.dataType ? ` · ${i.dataType}` : ''),
        dataType: i.dataType, preview: i.preview, isSample: false,
      }));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      res.provider.status = err.code === 'NOT_CONFIGURED' ? 'not_configured' : err.code === 'RATE_LIMITED' ? 'rate_limited' : err.code === 'UNAVAILABLE' ? 'unavailable' : 'error';
      res.provider.message = err.message;
    }
    return res;
  }

  private cacheProviderFood(s: LocalState, p: ProviderFood): string {
    const existing = Object.values(s.foods).find((f) => f.source === 'usda' && f.sourceFoodId === p.sourceFoodId);
    const id = existing?.id ?? `usda:${p.sourceFoodId}`;
    const userServings = existing?.servings.filter((x) => x.source === 'user') ?? [];
    s.foods[id] = {
      id, source: 'usda', sourceFoodId: p.sourceFoodId, name: p.name, brand: p.brand, dataType: p.dataType, reference: p.reference,
      servings: [...p.servings.map((x, i) => ({ ...x, id: `${id}:p${i}` })), ...userServings], isSample: false, attribution: p.attribution,
    };
    return id;
  }

  private async getFood(ref: string): Promise<Food> {
    if (ref.startsWith('usda:')) {
      const sourceId = ref.slice(5);
      if (!this.provider) {
        const cached = this.state.foods[ref];
        if (cached) return cached;
        throw new HttpError(503, 'PROVIDER_NOT_CONFIGURED', 'Food database search isn’t set up on this site.');
      }
      try {
        const pf = await this.provider.getFood(sourceId);
        const id = this.mutate((s) => this.cacheProviderFood(s, pf));
        return this.state.foods[id];
      } catch (err) {
        if (err instanceof ProviderError) {
          const cached = this.state.foods[ref];
          if (cached && err.code !== 'NOT_FOUND') return cached;
          const map = { NOT_CONFIGURED: [503, 'PROVIDER_NOT_CONFIGURED'], RATE_LIMITED: [429, 'PROVIDER_RATE_LIMITED'], NOT_FOUND: [404, 'NOT_FOUND'], BAD_RESPONSE: [502, 'PROVIDER_BAD_RESPONSE'], UNAVAILABLE: [503, 'PROVIDER_UNAVAILABLE'] } as const;
          const [status, code] = map[err.code];
          throw new HttpError(status, code, err.message);
        }
        throw err;
      }
    }
    const f = this.state.foods[ref];
    if (!f) throw new HttpError(404, 'NOT_FOUND', 'Food not found.');
    return f;
  }

  private recentFoods(): Food[] {
    const seen: string[] = [];
    for (const l of [...this.state.logs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (l.foodId && !seen.includes(l.foodId) && this.state.foods[l.foodId]) seen.push(l.foodId);
      if (seen.length >= 12) break;
    }
    return seen.map((id) => this.state.foods[id]);
  }

  // ---------------- recipes ----------------

  private withNutrition(r: StoredRecipe): Recipe {
    const foods = new Map<string, Food>();
    for (const i of r.ingredients) if (i.foodId && this.state.foods[i.foodId]) foods.set(i.foodId, this.state.foods[i.foodId]);
    const { seedKey: _s, ...rest } = r;
    return { ...rest, nutrition: computeRecipeNutrition(r, foods) };
  }

  private recipes(): Recipe[] {
    return Object.values(this.state.recipes).map((r) => this.withNutrition(r)).sort((a, b) => a.name.localeCompare(b.name));
  }

  private recipe(id: string): Recipe {
    const r = this.state.recipes[id];
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Recipe not found.');
    return this.withNutrition(r);
  }

  private recipeRecord(s: LocalState, id: string, input: z.infer<typeof recipeSchema>, createdAt: string): StoredRecipe {
    for (const i of input.ingredients) if (i.foodId && !s.foods[i.foodId]) throw new HttpError(400, 'VALIDATION_ERROR', 'An ingredient links to a food that was not found.');
    return {
      id, ownerProfileId: PROFILE_ID, seedKey: null, name: input.name, description: input.description ?? null, mealTypes: input.mealTypes,
      prepMinutes: input.prepMinutes, budgetLevel: input.budgetLevel, servings: input.servings, instructions: input.instructions, isSample: false,
      createdAt, updatedAt: createdAt,
      ingredients: input.ingredients.map((i, idx): RecipeIngredient => ({
        id: `${id}:${idx}`, name: i.name, quantity: i.quantity, unit: i.unit, foodId: i.foodId,
        allergens: [...new Set([...(i.allergens ?? []), ...detectAllergensByName(i.name)])], mayContain: [],
        category: detectCategoriesByName(i.name)[0] ?? null, sortOrder: idx,
      })),
    };
  }

  // ---------------- plans ----------------

  private snapshot(r: Recipe): PlanRecipeSnapshot {
    return {
      recipeId: r.id, name: r.name, servings: r.servings, prepMinutes: r.prepMinutes, instructions: r.instructions,
      ingredients: r.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
      nutritionPerServing: r.nutrition.perServing, nutritionBasis: r.nutrition.basis, nutritionComplete: r.nutrition.complete,
    };
  }

  private plannerRecipes(): { all: Recipe[]; planner: PlannerRecipe[] } {
    const all = this.recipes();
    return {
      all,
      planner: all.map((r) => ({
        id: r.id, name: r.name, mealTypes: r.mealTypes, prepMinutes: r.prepMinutes, budgetLevel: r.budgetLevel, servings: r.servings,
        perServing: r.nutrition.perServing, nutritionComplete: r.nutrition.complete,
        ingredients: r.ingredients.map((i) => ({ name: i.name, allergens: i.allergens, mayContain: i.mayContain, category: i.category })),
      })),
    };
  }

  private resolvePrefs(partial?: Partial<PlannerPreferences>): { prefs: PlannerPreferences; targetApplied: boolean } {
    const saved = this.state.prefs;
    const prefs: PlannerPreferences = { ...DEFAULT_PLANNER_PREFERENCES, ...saved.planner, ...(partial ?? {}) };
    if (prefs.mode === 'target') {
      if (!saved.adultConfirmed) throw new HttpError(400, 'VALIDATION_ERROR', 'Planning around a calorie target is for adults. Confirm you are 18 or older in Settings, or use general planning.');
      prefs.calorieTarget = prefs.calorieTarget ?? saved.dailyCalorieTarget;
      if (!prefs.calorieTarget) throw new HttpError(400, 'VALIDATION_ERROR', 'Enter a daily calorie target, or switch to general planning.');
      return { prefs, targetApplied: true };
    }
    return { prefs: { ...prefs, calorieTarget: null }, targetApplied: false };
  }

  private itemsOf(s: LocalState, planId: string): StoredItem[] {
    const order = { breakfast: 0, lunch: 1, dinner: 2 } as const;
    return Object.values(s.items).filter((i) => i.planId === planId).sort((a, b) => a.date.localeCompare(b.date) || order[a.mealType] - order[b.mealType]);
  }

  /** Run the planner and write the results into `s` (draft state). */
  private fill(s: LocalState, plan: StoredPlan, regenerate: RegenerateScope, seed: number) {
    const { all, planner } = this.plannerRecipes();
    const byId = new Map(all.map((r) => [r.id, r]));
    const existing = this.itemsOf(s, plan.id);
    const slots: ExistingSlot[] = existing.map((i) => ({ date: i.date, mealType: i.mealType, recipeId: i.recipeId, servings: i.servings, locked: i.locked, calories: i.nutrition.calories }));
    let out;
    try {
      out = generatePlanSlots({ recipes: planner, prefs: plan.preferences, dates: weekDates(plan.weekStart), existing: slots, regenerate, targetApplied: plan.targetApplied, seed });
    } catch (err) {
      if (err instanceof PlanConflictError) throw new HttpError(422, 'PLAN_CONFLICT', 'Your preferences can’t all be met with the current recipes.', { problems: err.problems });
      throw err;
    }
    const ts = this.nowIso();
    for (const slot of out.slots) {
      const r = byId.get(slot.recipeId)!;
      const snap = this.snapshot(r);
      const prev = existing.find((e) => e.date === slot.date && e.mealType === slot.mealType);
      const id = prev?.id ?? this.id();
      s.items[id] = {
        id, planId: plan.id, date: slot.date, mealType: slot.mealType, recipeId: r.id, foodId: null, name: r.name, servings: slot.servings,
        nutrition: scaleValues(snap.nutritionPerServing, slot.servings), recipe: snap, notes: prev?.notes ?? null, locked: false, flags: slot.flags,
        createdAt: prev?.createdAt ?? ts, updatedAt: ts,
      };
    }
    s.plans[plan.id] = { ...s.plans[plan.id], updatedAt: ts };
  }

  private generatePlan(req: { weekStart?: string; preferences?: Partial<PlannerPreferences>; seed?: number }): MealPlan {
    const weekStart = req.weekStart ?? nextWeekStart(this.today());
    const { prefs, targetApplied } = this.resolvePrefs(req.preferences);
    const id = this.id();
    const ts = this.nowIso();
    this.mutate((s) => {
      const plan: StoredPlan = { id, weekStart, status: 'draft', preferences: prefs, targetApplied, warnings: preferenceWarnings(prefs), createdAt: ts, updatedAt: ts };
      s.plans[id] = plan;
      this.fill(s, plan, { scope: 'week' }, req.seed ?? Math.floor(Math.random() * 2 ** 31));
    });
    return this.plan(id);
  }

  private plan(id: string): MealPlan {
    const p = this.state.plans[id];
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Meal plan not found.');
    const items = this.itemsOf(this.state, id);
    const target = p.targetApplied ? p.preferences.calorieTarget : null;
    return {
      ...p, profileId: PROFILE_ID, weekEnd: addDays(p.weekStart, 6),
      items: items.map((i) => ({ ...i, loggedCount: this.state.logs.filter((l) => l.sourcePlanItemId === i.id).length })),
      dayTotals: computeDayTotals(items, weekDates(p.weekStart), target, p.preferences.targetTolerancePct),
    };
  }

  private listPlans() {
    return Object.values(this.state.plans).filter((p) => p.status !== 'replaced')
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || b.updatedAt.localeCompare(a.updatedAt))
      .map((p) => ({ id: p.id, weekStart: p.weekStart, weekEnd: addDays(p.weekStart, 6), status: p.status, updatedAt: p.updatedAt }));
  }

  private regenerate(planId: string, scope: 'week' | 'day', date?: string, seed?: number): MealPlan {
    const plan = this.state.plans[planId];
    if (!plan) throw new HttpError(404, 'NOT_FOUND', 'Meal plan not found.');
    if (scope === 'day' && (!date || !weekDates(plan.weekStart).includes(date))) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a day inside this plan.');
    this.mutate((s) => this.fill(s, plan, scope === 'week' ? { scope: 'week' } : { scope: 'day', date: date! }, seed ?? Math.floor(Math.random() * 2 ** 31)));
    return this.plan(planId);
  }

  private replaceItem(itemId: string): MealPlan {
    const item = this.state.items[itemId];
    if (!item) throw new HttpError(404, 'NOT_FOUND', 'Planned meal not found.');
    if (item.locked) throw new HttpError(409, 'CONFLICT', 'This meal is locked. Unlock it to swap.');
    this.mutate((s) => this.fill(s, s.plans[item.planId], { scope: 'slot', date: item.date, mealType: item.mealType }, Math.floor(Math.random() * 2 ** 31)));
    return this.plan(item.planId);
  }

  private updateItem(itemId: string, patch: z.infer<typeof updatePlanItemSchema>): MealPlan {
    const item = this.state.items[itemId];
    if (!item) throw new HttpError(404, 'NOT_FOUND', 'Planned meal not found.');
    const chosen = patch.recipeId ? this.recipe(patch.recipeId) : null;
    this.mutate((s) => {
      const w = s.items[itemId];
      if (chosen) {
        w.flags = chosen.mealTypes.includes(w.mealType) ? [] : [`Usually a ${chosen.mealTypes.join('/')} recipe.`];
        Object.assign(w, { recipeId: chosen.id, foodId: null, name: chosen.name, recipe: this.snapshot(chosen), servings: patch.servings ?? 1 });
      } else if (patch.custom) {
        const c = patch.custom;
        const values: NutrientValues = { calories: c.calories, proteinG: c.proteinG ?? null, carbsG: c.carbsG ?? null, fatG: c.fatG ?? null };
        Object.assign(w, {
          recipeId: null, foodId: null, name: c.name, servings: patch.servings ?? 1, flags: ['Nutrition entered by you.'],
          recipe: {
            recipeId: null, name: c.name, servings: 1, prepMinutes: null, instructions: c.instructions ?? [],
            ingredients: (c.ingredients ?? []).filter(Boolean).map((name) => ({ name, quantity: null, unit: 'to taste' })),
            nutritionPerServing: values, nutritionBasis: 'manual', nutritionComplete: values.calories !== null,
          },
        });
      }
      if (patch.servings !== undefined) w.servings = patch.servings;
      if (patch.locked !== undefined) w.locked = patch.locked;
      if (patch.notes !== undefined) w.notes = patch.notes;
      w.nutrition = scaleValues(w.recipe.nutritionPerServing, w.servings);
      w.updatedAt = this.nowIso();
      s.plans[w.planId].updatedAt = w.updatedAt;
    });
    return this.plan(item.planId);
  }

  private savePlan(planId: string, overwrite: boolean): MealPlan {
    const plan = this.state.plans[planId];
    if (!plan) throw new HttpError(404, 'NOT_FOUND', 'Meal plan not found.');
    if (plan.status === 'saved') return this.plan(planId);
    const other = Object.values(this.state.plans).find((p) => p.id !== planId && p.weekStart === plan.weekStart && p.status === 'saved');
    if (other && !overwrite) {
      throw new HttpError(409, 'PLAN_EXISTS', `You already have a saved plan for the week of ${plan.weekStart}. Replace it?`, { existingPlanId: other.id });
    }
    this.mutate((s) => {
      if (other) s.plans[other.id].status = 'replaced';
      s.plans[planId].status = 'saved';
      s.plans[planId].updatedAt = this.nowIso();
    });
    return this.plan(planId);
  }

  private logItem(itemId: string, req: { servingsEaten: number; localDate: string; mealType: FoodLogEntry['mealType']; idempotencyKey: string; allowRepeat?: boolean }) {
    const prior = this.state.logs.find((l) => l.idempotencyKey === req.idempotencyKey);
    if (prior) return { entry: this.publicLog(prior), duplicate: true };
    const item = this.state.items[itemId];
    if (!item) throw new HttpError(404, 'NOT_FOUND', 'Planned meal not found.');
    const already = this.state.logs.find((l) => l.sourcePlanItemId === itemId);
    if (already && !req.allowRepeat) throw new HttpError(409, 'ALREADY_LOGGED', 'This planned meal is already in your food log.', { entryId: already.id });
    return this.mutate((s) => {
      const per = item.recipe.nutritionPerServing;
      const values = scaleValues(per, req.servingsEaten);
      const basis = item.recipe.nutritionBasis;
      const e = this.newLog(s, {
        localDate: req.localDate, mealType: req.mealType, foodId: null, recipeId: item.recipeId, displayName: item.name,
        quantity: req.servingsEaten, unit: 'serving', unitLabel: req.servingsEaten === 1 ? 'serving' : 'servings', nutrition: values,
        snapshot: { version: 1, source: 'plan', sourceFoodId: item.recipeId, isSample: basis === 'sample' || basis === 'mixed',
          reference: { quantity: 1, unit: 'serving', unitLabel: 'serving', values: per }, serving: null, values, computedAt: this.nowIso() },
        sourcePlanItemId: item.id, idempotencyKey: req.idempotencyKey,
      });
      return { entry: this.publicLog(e), duplicate: false };
    });
  }

  // ---------------- export / import ----------------

  private exportPlans() {
    return {
      format: PLANS_EXPORT_FORMAT, version: PLANS_EXPORT_VERSION, exportedAt: this.nowIso(), timezone: this.state.profile.timezone,
      preferences: { dailyCalorieTarget: this.state.prefs.dailyCalorieTarget, planner: this.prefs().planner },
      plans: this.listPlans().map((x) => this.plan(x.id)).map((p) => ({
        weekStart: p.weekStart, status: p.status, preferences: p.preferences, targetApplied: p.targetApplied,
        items: p.items.map((i) => ({ date: i.date, mealType: i.mealType, recipeId: i.recipeId, name: i.name, servings: i.servings, notes: i.notes, locked: i.locked, nutrition: i.nutrition, recipe: i.recipe })),
      })),
    };
  }

  private importPlans(body: unknown, includePreferences: boolean) {
    const data = parse(importSchema, body);
    return this.mutate((s) => {
      let prefsImported = false;
      if (includePreferences && data.preferences) {
        const cur = s.prefs;
        s.prefs = {
          dailyCalorieTarget: data.preferences.dailyCalorieTarget !== undefined ? data.preferences.dailyCalorieTarget : cur.dailyCalorieTarget,
          adultConfirmed: cur.adultConfirmed,
          planner: data.preferences.planner ? { ...data.preferences.planner, mode: cur.adultConfirmed ? data.preferences.planner.mode : 'general' } : cur.planner,
          updatedAt: this.nowIso(),
        };
        prefsImported = true;
      }
      for (const p of data.plans) {
        const id = this.id();
        const ts = this.nowIso();
        s.plans[id] = { id, weekStart: p.weekStart, status: 'draft', preferences: p.preferences, targetApplied: p.targetApplied && s.prefs.adultConfirmed,
          warnings: ['Imported plan. Nutrition values were taken from the export file.'], createdAt: ts, updatedAt: ts };
        const dates = weekDates(p.weekStart);
        const seen = new Set<string>();
        for (const i of p.items) {
          if (!dates.includes(i.date)) throw new HttpError(400, 'VALIDATION_ERROR', `Plan item date ${i.date} is outside the week of ${p.weekStart}.`);
          if (seen.has(`${i.date}|${i.mealType}`)) continue;
          seen.add(`${i.date}|${i.mealType}`);
          const recipeId = i.recipeId && s.recipes[i.recipeId] ? i.recipeId : null;
          const itemId = this.id();
          s.items[itemId] = { id: itemId, planId: id, date: i.date, mealType: i.mealType, recipeId, foodId: null, name: i.name, servings: i.servings,
            nutrition: scaleValues(i.recipe.nutritionPerServing, i.servings), recipe: { ...i.recipe, recipeId }, notes: i.notes, locked: i.locked,
            flags: ['Imported'], createdAt: ts, updatedAt: ts };
        }
      }
      return { plans: data.plans.length, preferences: prefsImported };
    });
  }
}

function browserTimeZoneSafe(): string {
  try { return browserTimeZone(); } catch { return 'UTC'; }
}
