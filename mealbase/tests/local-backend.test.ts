/**
 * The in-browser backend used when MealBase is published inside RepLens as a static site.
 * Runs the same API contract through NutritionApiClient, with a Map standing in for localStorage.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalBackend, STORAGE_KEY, type StorageLike } from '../src/local/backend';
import { RemoteUsdaProvider } from '../src/local/remote-provider';
import { createUsdaProxy } from '../src/proxy/usda-proxy';
import { NutritionApiClient, ApiError } from '../src/features/nutrition/api/client';
import { fixture } from './helpers';

class MapStorage implements StorageLike {
  map = new Map<string, string>();
  failWrites = false;
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError'); this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

/** Fake fetch for api.nal.usda.gov, used by the proxy under test. */
const usdaFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith('/foods/search')) return new Response(fixture('usda-search-banana.json'), { status: 200 });
  const m = url.pathname.match(/\/food\/(\d+)$/);
  if (m && m[1] === '173944') return new Response(fixture('usda-food-173944.json'), { status: 200 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

/** Wires browser provider → proxy handler in-process (what Netlify does over HTTP). */
function providerVia(apiKey: string | null) {
  const proxy = createUsdaProxy({ apiKey, fetchImpl: usdaFetch });
  return new RemoteUsdaProvider('https://site.example/.netlify/functions/usda', (async (input: string | URL | Request) => proxy(new URL(String(input)))) as typeof fetch);
}

function setup(storage: StorageLike | null = new MapStorage(), apiKey: string | null = 'k') {
  const backend = new LocalBackend({ storage, provider: providerVia(apiKey), workout: { url: '../', label: 'RepLens' } });
  return { backend, api: new NutritionApiClient('/api/v1/nutrition', backend.fetch), storage };
}

describe('USDA proxy', () => {
  it('reports status and never leaks the key', async () => {
    const proxy = createUsdaProxy({ apiKey: 'super-secret-key', fetchImpl: usdaFetch });
    const status = await proxy(new URL('https://x/fn?op=status'));
    assert.deepEqual(await status.json(), { configured: true, usingDemoKey: false, attribution: (await (await proxy(new URL('https://x/fn?op=status'))).json()).attribution });
    const search = await proxy(new URL('https://x/fn?op=search&q=banana'));
    const text = await search.text();
    assert.equal(search.status, 200);
    assert.ok(!text.includes('super-secret-key'));
    assert.equal(JSON.parse(text).items.length, 3);
  });

  it('validates input and maps provider errors to statuses', async () => {
    const proxy = createUsdaProxy({ apiKey: null, fetchImpl: usdaFetch });
    assert.equal((await proxy(new URL('https://x/fn?op=search&q=banana'))).status, 503);
    const ok = createUsdaProxy({ apiKey: 'k', fetchImpl: usdaFetch });
    assert.equal((await ok(new URL('https://x/fn?op=search&q=a'))).status, 400);
    assert.equal((await ok(new URL('https://x/fn?op=food&id=../../etc'))).status, 400);
    assert.equal((await ok(new URL('https://x/fn?op=food&id=999'))).status, 404);
    assert.equal((await ok(new URL('https://x/fn?op=search&q=banana'), 'POST')).status, 405);
  });
});

describe('in-browser backend', () => {
  it('runs the core flow and keeps data across reloads', async () => {
    const { api, storage } = setup();
    const cfg = await api.config();
    assert.equal(cfg.foodProvider.configured, true);
    assert.equal(cfg.persistence, 'device');
    assert.equal(cfg.workout.url, '../');

    const search = await api.searchFoods('banana');
    assert.equal(search.results.length, 3);
    assert.ok(search.sample.length >= 1 && search.sample.every((s) => s.isSample));
    const food = await api.food(search.results[0].ref);
    const medium = food.servings.find((s) => s.unitKey === 'medium')!;
    const { entry } = await api.createLog({ localDate: '2026-10-17', mealType: 'breakfast', foodId: food.id, quantity: 1, unit: `serving:${medium.id}`, idempotencyKey: 'k-0000001' });
    assert.ok(Math.abs(entry.nutrition.calories! - 105.02) < 1e-9);
    assert.ok(Math.abs((await api.summary('2026-10-17')).totals.calories! - 105.02) < 1e-9);

    const plan = await api.generatePlan({ weekStart: '2026-10-19', seed: 3 });
    assert.equal(plan.items.length, 21);
    assert.equal((await api.logs('2026-10-19', '2026-10-25')).length, 0, 'plans never log food by themselves');
    const lunch = plan.items.find((i) => i.mealType === 'lunch')!;
    const swapped = (await api.replacePlanItem(lunch.id)).items.find((i) => i.id === lunch.id)!;
    assert.notEqual(swapped.recipeId, lunch.recipeId);
    const req = { servingsEaten: 1, localDate: '2026-10-17', mealType: 'lunch' as const, idempotencyKey: 'k-0000002' };
    const [a, b] = await Promise.all([api.logPlanItem(lunch.id, req), api.logPlanItem(lunch.id, req)]);
    assert.equal(a.entry.id, b.entry.id);
    await assert.rejects(api.logPlanItem(lunch.id, { ...req, idempotencyKey: 'k-0000003' }), (e: unknown) => e instanceof ApiError && e.code === 'ALREADY_LOGGED');
    await api.savePlan(plan.id);

    // "Reload the page": a new backend reading the same storage
    const again = setup(storage);
    assert.equal((await again.api.logs('2026-10-17', '2026-10-17')).length, 2);
    const reopened = await again.api.plan(plan.id);
    assert.equal(reopened.status, 'saved');
    assert.equal(reopened.items.find((i) => i.id === lunch.id)!.loggedCount, 1);
    assert.equal((await again.api.history('2026-10-01', '2026-10-31')).length, 1);
  });

  it('keeps locked meals through regeneration and plan edits never change logs', async () => {
    const { api } = setup();
    const plan = await api.generatePlan({ weekStart: '2026-11-02', seed: 1 });
    const keep = plan.items[3];
    await api.updatePlanItem(keep.id, { locked: true, servings: 1.5 });
    const logged = (await api.logPlanItem(keep.id, { servingsEaten: 1, localDate: keep.date, mealType: keep.mealType, idempotencyKey: 'lock-0001' })).entry;
    for (let i = 0; i < 3; i++) {
      const p = await api.regenerate(plan.id, 'week');
      const same = p.items.find((x) => x.id === keep.id)!;
      assert.equal(same.recipeId, keep.recipeId);
      assert.equal(same.servings, 1.5);
    }
    await api.updatePlanItem(keep.id, { locked: false });
    await api.replacePlanItem(keep.id);
    const after = (await api.logs(keep.date, keep.date))[0];
    assert.deepEqual(after.nutrition, logged.nutrition);
  });

  it('does not pretend to save when storage writes fail', async () => {
    const storage = new MapStorage();
    const { api } = setup(storage);
    const food = (await api.searchFoods('banana')).sample[0];
    storage.failWrites = true;
    await assert.rejects(
      api.createLog({ localDate: '2026-10-17', mealType: 'snack', foodId: food.ref, quantity: 100, unit: 'g' }),
      (e: unknown) => e instanceof ApiError && e.code === 'STORAGE_ERROR',
    );
    assert.equal((await api.logs('2026-10-17', '2026-10-17')).length, 0);
    storage.failWrites = false;
    await api.createLog({ localDate: '2026-10-17', mealType: 'snack', foodId: food.ref, quantity: 100, unit: 'g' });
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)!).logs.length, 1);
  });

  it('falls back to memory when storage is unavailable, and works without the USDA proxy', async () => {
    const { api } = setup(null, null);
    const cfg = await api.config();
    assert.equal(cfg.persistence, 'memory');
    assert.equal(cfg.foodProvider.configured, false);
    const r = await api.searchFoods('banana');
    assert.equal(r.provider.status, 'not_configured');
    const manual = await api.createManualFood({ name: 'Toast', referenceQuantity: 1, referenceUnit: 'piece', calories: 80 });
    const { entry } = await api.createLog({ localDate: '2026-10-17', mealType: 'breakfast', foodId: manual.id, quantity: 2, unit: 'piece' });
    assert.equal(entry.nutrition.calories, 160);
    assert.equal(entry.nutrition.proteinG, null);
  });

  it('validates input the same way as the server', async () => {
    const { api } = setup();
    const food = (await api.searchFoods('oats')).sample[0];
    await assert.rejects(api.createLog({ localDate: '2026-10-17', mealType: 'snack', foodId: food.ref, quantity: -1, unit: 'g' }), (e: unknown) => e instanceof ApiError && e.code === 'VALIDATION_ERROR');
    await assert.rejects(api.createLog({ localDate: '2026-10-17', mealType: 'snack', foodId: food.ref, quantity: 1, unit: 'ml' }), (e: unknown) => e instanceof ApiError && e.code === 'UNIT_CONVERSION_UNAVAILABLE');
    await assert.rejects(api.generatePlan({ weekStart: '2026-11-09', preferences: { mode: 'target', calorieTarget: 2000 } }), /adults/);
    await assert.rejects(api.generatePlan({ weekStart: '2026-11-09', preferences: { diet: 'vegan', allowRepeats: false } }), (e: unknown) => e instanceof ApiError && e.code === 'PLAN_CONFLICT');
  });

  it('exports and re-imports plans, and deletes personal data', async () => {
    const { api, backend } = setup();
    await api.generatePlan({ weekStart: '2026-11-16', seed: 2 });
    const res = await backend.fetch('/api/v1/nutrition/export/plans.json');
    const data = await res.json();
    assert.equal(data.format, 'mealbase.plans');
    assert.equal((await api.importPlans(data, true)).plans, 1);
    assert.equal((await api.plans()).length, 2);
    const csv = await (await backend.fetch('/api/v1/nutrition/export/logs.csv?from=2026-01-01&to=2026-12-31')).text();
    assert.ok(csv.startsWith('entry_id,'));
    await api.deleteAllData();
    assert.equal((await api.plans()).length, 0);
    assert.equal((await api.recipes()).length, 33, 'starter recipes come back after a reset');
  });
});

