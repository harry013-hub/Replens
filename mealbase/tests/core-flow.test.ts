/**
 * The core user journey through the public API:
 * search food → choose portion → log meal → daily total updates → generate next week
 * → swap a meal → log it as eaten → reopen saved history.
 */
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, startTestApp, type TestApp } from './helpers';

let t: TestApp;
before(async () => { t = await startTestApp(); });
after(() => t.close());

it('core flow', async () => {
  const c = new Client(t.url);
  await c.patch('/me', { timezone: 'Europe/London' });

  // 1. search
  const search = await c.get('/foods/search?q=banana');
  assert.equal(search.body.provider.status, 'ok');
  const hit = search.body.results.find((r: any) => r.name === 'Bananas, raw');
  assert.ok(hit);

  // 2. choose portion (detail → servings)
  const food = (await c.get(`/foods/${hit.ref}`)).body.food;
  const medium = food.servings.find((s: any) => s.unitKey === 'medium');
  assert.ok(medium, 'provider portions available');

  // 3. log meal
  const today = '2026-10-17';
  const logged = await c.post('/logs', { localDate: today, mealType: 'breakfast', foodId: food.id, quantity: 1, unit: `serving:${medium.id}`, idempotencyKey: 'core-flow-1' });
  assert.equal(logged.status, 201);
  assert.ok(Math.abs(logged.body.entry.nutrition.calories - 89 * 1.18) < 1e-9);

  // 4. daily total
  const s1 = (await c.get(`/summary?date=${today}`)).body;
  assert.ok(Math.abs(s1.totals.calories - 105.02) < 1e-9);

  // 5. generate next week (default = next calendar week in profile timezone)
  const plan = (await c.post('/plans', { seed: 99 })).body.plan;
  assert.equal(plan.items.length, 21);
  assert.equal((await c.post(`/plans/${plan.id}/save`)).body.plan.status, 'saved');

  // 6. swap a meal
  const target = plan.items.find((i: any) => i.mealType === 'lunch');
  const swapped = (await c.post(`/plan-items/${target.id}/replace`)).body.plan;
  const after = swapped.items.find((i: any) => i.id === target.id);
  assert.notEqual(after.recipeId, target.recipeId);

  // 7. log it as eaten (adjusting the amount)
  const ate = await c.post(`/plan-items/${target.id}/log`, { servingsEaten: 0.75, localDate: after.date, mealType: 'lunch', idempotencyKey: 'core-flow-2' });
  assert.equal(ate.status, 201);
  assert.equal(ate.body.entry.displayName, after.name);

  // 8. reopen saved history
  const history = (await c.get(`/history?from=${today}&to=${after.date}`)).body.days;
  assert.deepEqual(history.map((d: any) => d.localDate).sort(), [today, after.date].sort());
  const reopened = (await c.get(`/plans/${plan.id}`)).body.plan;
  assert.equal(reopened.status, 'saved');
  assert.equal(reopened.items.find((i: any) => i.id === target.id).loggedCount, 1);
  const day = (await c.get(`/summary?date=${after.date}`)).body;
  assert.ok(Math.abs(day.totals.calories - after.recipe.nutritionPerServing.calories * 0.75) < 1e-9);
});
