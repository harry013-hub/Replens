import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, startTestApp, type TestApp } from './helpers';

describe('meal plans', () => {
  let t: TestApp;
  let c: Client;
  before(async () => { t = await startTestApp(); c = new Client(t.url); await c.patch('/me', { timezone: 'America/Los_Angeles' }); });
  after(() => t.close());

  it('generates the next calendar week with 21 meals from the starter recipes', async () => {
    const r = await c.post('/plans', { seed: 1 });
    assert.equal(r.status, 201);
    const p = r.body.plan;
    assert.equal(p.items.length, 21);
    assert.equal(new Date(p.weekStart + 'T00:00:00Z').getUTCDay(), 1, 'starts on a Monday');
    assert.equal(p.dayTotals.length, 7);
    assert.equal(p.status, 'draft');
    for (const i of p.items) {
      assert.ok(i.recipe.ingredients.length > 0);
      assert.ok(i.recipe.instructions.length > 0);
      assert.ok(i.nutrition.calories > 0);
      assert.equal(i.recipe.nutritionBasis, 'sample', 'starter recipes are honestly labelled as sample nutrition');
    }
  });

  it('planned meals never add to the food log on their own', async () => {
    const p = (await c.post('/plans', { weekStart: '2026-11-02', seed: 2 })).body.plan;
    const logs = await c.get('/logs?from=2026-11-02&to=2026-11-08');
    assert.equal(logs.body.entries.length, 0);
    const s = await c.get('/summary?date=2026-11-02');
    assert.equal(s.body.totals.itemCount, 0);
    // editing the plan doesn't either
    await c.patch(`/plan-items/${p.items[0].id}`, { servings: 2 });
    assert.equal((await c.get('/logs?from=2026-11-02&to=2026-11-08')).body.entries.length, 0);
  });

  it('logs a planned meal once, blocks accidental duplicates, and keeps logs stable after plan edits', async () => {
    const p = (await c.post('/plans', { weekStart: '2026-11-09', seed: 3 })).body.plan;
    const item = p.items[0];
    const req = { servingsEaten: 1.5, localDate: item.date, mealType: item.mealType, idempotencyKey: 'log-planned-key-1' };

    // Double tap: two identical requests in flight
    const [a, b] = await Promise.all([c.post(`/plan-items/${item.id}/log`, req), c.post(`/plan-items/${item.id}/log`, req)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.entry.id, b.body.entry.id);

    // A different attempt without allowRepeat is refused
    const again = await c.post(`/plan-items/${item.id}/log`, { ...req, idempotencyKey: 'log-planned-key-2' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_LOGGED');

    const entries = (await c.get(`/logs?from=${item.date}&to=${item.date}`)).body.entries;
    assert.equal(entries.length, 1);
    const logged = entries[0];
    assert.equal(logged.sourcePlanItemId, item.id);
    assert.ok(Math.abs(logged.nutrition.calories - item.recipe.nutritionPerServing.calories * 1.5) < 1e-9);

    // Change the plan afterwards: swap, change servings, and regenerate the day
    await c.patch(`/plan-items/${item.id}`, { servings: 3 });
    await c.post(`/plan-items/${item.id}/replace`);
    await c.post(`/plans/${p.id}/regenerate`, { scope: 'day', date: item.date });
    const after = (await c.get(`/logs?from=${item.date}&to=${item.date}`)).body.entries[0];
    assert.deepEqual(after.nutrition, logged.nutrition);
    assert.equal(after.displayName, logged.displayName);

    // Intentional repeat is allowed
    const repeat = await c.post(`/plan-items/${item.id}/log`, { ...req, idempotencyKey: 'log-planned-key-3', allowRepeat: true });
    assert.equal(repeat.status, 201);
  });

  it('locked meals survive week and day regeneration', async () => {
    const p = (await c.post('/plans', { weekStart: '2026-11-16', seed: 4 })).body.plan;
    const keep = p.items[4];
    await c.patch(`/plan-items/${keep.id}`, { locked: true, servings: 1.25 });
    for (let i = 0; i < 4; i++) {
      const w = (await c.post(`/plans/${p.id}/regenerate`, { scope: 'week', seed: 100 + i })).body.plan;
      const same = w.items.find((x: any) => x.id === keep.id);
      assert.equal(same.recipeId, keep.recipeId);
      assert.equal(same.servings, 1.25);
      assert.equal(same.locked, true);
      assert.equal(w.items.length, 21);
    }
    const d = (await c.post(`/plans/${p.id}/regenerate`, { scope: 'day', date: keep.date, seed: 7 })).body.plan;
    assert.equal(d.items.find((x: any) => x.id === keep.id).recipeId, keep.recipeId);
    const swap = await c.post(`/plan-items/${keep.id}/replace`);
    assert.equal(swap.status, 409, 'locked meals cannot be swapped');
  });

  it('respects saved preferences: exclusions and allergies', async () => {
    const r = await c.post('/plans', { weekStart: '2026-11-23', seed: 5, preferences: { excludeIngredients: ['egg'], allergies: ['peanut', 'fish'] } });
    assert.equal(r.status, 201);
    const names = r.body.plan.items.flatMap((i: any) => i.recipe.ingredients.map((x: any) => x.name.toLowerCase()));
    assert.ok(!names.some((n: string) => /\begg\b|peanut|salmon|tuna/.test(n)), names.join(', '));
    assert.ok(r.body.plan.warnings.some((w: string) => /check product labels/i.test(w)));
  });

  it('explains conflicting preferences instead of ignoring them', async () => {
    const r = await c.post('/plans', { weekStart: '2026-11-30', preferences: { diet: 'vegan', allowRepeats: false } });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'PLAN_CONFLICT');
    assert.ok(r.body.error.details.problems.length > 0);
  });

  it('target planning requires adult confirmation and reports differences honestly', async () => {
    const refused = await c.post('/plans', { weekStart: '2026-12-07', preferences: { mode: 'target', calorieTarget: 2200 } });
    assert.equal(refused.status, 400);
    const prefs = (await c.get('/preferences')).body;
    await c.put('/preferences', { ...prefs, adultConfirmed: true, dailyCalorieTarget: 2200, planner: { ...prefs.planner } });
    const ok = await c.post('/plans', { weekStart: '2026-12-07', seed: 9, preferences: { mode: 'target', calorieTarget: 2200, targetTolerancePct: 10 } });
    assert.equal(ok.status, 201);
    const p = ok.body.plan;
    assert.equal(p.targetApplied, true);
    assert.equal(p.items.length, 21);
    for (const d of p.dayTotals) {
      assert.equal(d.target, 2200);
      assert.ok(Math.abs(d.difference - (d.nutrition.calories - 2200)) < 1e-9);
    }
    assert.ok(p.items.every((i: any) => i.servings >= 0.75));
  });

  it('asks before replacing a saved plan for the same week', async () => {
    const a = (await c.post('/plans', { weekStart: '2026-12-14', seed: 1 })).body.plan;
    const b = (await c.post('/plans', { weekStart: '2026-12-14', seed: 2 })).body.plan;
    assert.equal((await c.post(`/plans/${a.id}/save`)).status, 200);
    const clash = await c.post(`/plans/${b.id}/save`);
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'PLAN_EXISTS');
    const replaced = await c.post(`/plans/${b.id}/save`, { overwrite: true });
    assert.equal(replaced.body.plan.status, 'saved');
    assert.equal((await c.get(`/plans/${a.id}`)).body.plan.status, 'replaced');
    assert.ok(t.events.events.some((e) => e.type === 'nutrition:plan-saved'));
  });

  it('custom meals, recipe choice, notes and grocery list', async () => {
    const p = (await c.post('/plans', { weekStart: '2026-12-21', seed: 6, preferences: { people: 2 } })).body.plan;
    const custom = await c.patch(`/plan-items/${p.items[1].id}`, { custom: { name: 'Leftover chili', calories: 550, ingredients: ['Chili'] } });
    const item = custom.body.plan.items.find((i: any) => i.id === p.items[1].id);
    assert.equal(item.name, 'Leftover chili');
    assert.equal(item.nutrition.calories, 550);
    assert.equal(item.nutrition.proteinG, null);
    const recipes = (await c.get('/recipes')).body.recipes;
    const target = recipes.find((r: any) => r.mealTypes.includes('dinner'));
    const chosen = await c.patch(`/plan-items/${p.items[2].id}`, { recipeId: target.id, notes: 'double batch' });
    assert.equal(chosen.body.plan.items.find((i: any) => i.id === p.items[2].id).recipeId, target.id);
    const g = await c.get(`/plans/${p.id}/grocery-list`);
    assert.equal(g.status, 200);
    assert.equal(g.body.people, 2);
    assert.ok(g.body.lines.length > 10);
  });

  it('user recipes link to foods and compute nutrition, reporting gaps', async () => {
    const oats = (await c.get('/foods/search?q=oats')).body.sample[0];
    const r = await c.post('/recipes', {
      name: 'My porridge', mealTypes: ['breakfast'], prepMinutes: 5, budgetLevel: 'low', servings: 1, instructions: ['Cook.'],
      ingredients: [{ name: 'Oats', quantity: 60, unit: 'g', foodId: oats.ref }, { name: 'Mystery topping', quantity: 1, unit: 'tbsp', foodId: null }],
    });
    assert.equal(r.status, 201);
    assert.ok(Math.abs(r.body.recipe.nutrition.perServing.calories - 379 * 0.6) < 1e-9);
    assert.equal(r.body.recipe.nutrition.complete, false);
    assert.ok(r.body.recipe.nutrition.issues.some((x: string) => x.includes('Mystery topping')));
  });
});

describe('access isolation between accounts', () => {
  let t: TestApp;
  const a = () => new Client(t.url);
  before(async () => { t = await startTestApp({ authMode: 'accounts', host: '127.0.0.1' }); });
  after(() => t.close());

  it('requires sign-in and never trusts a client-supplied user id', async () => {
    const anon = a();
    assert.equal((await anon.get('/summary')).status, 401);
    const alice = a();
    const bob = a();
    assert.equal((await alice.post('/auth/register', { email: 'alice@example.com', password: 'correct horse battery' })).status, 201);
    assert.equal((await bob.post('/auth/register', { email: 'bob@example.com', password: 'another long password' })).status, 201);
    assert.equal((await bob.post('/auth/register', { email: 'BOB@example.com', password: 'another long password' })).status, 409);

    const aliceProfile = (await alice.get('/me')).body.profileId;
    const food = (await alice.post('/foods', { name: 'Alice cake', referenceQuantity: 1, referenceUnit: 'piece', calories: 300 })).body.food;
    const entry = (await alice.post('/logs', { localDate: '2026-10-17', mealType: 'snack', foodId: food.id, quantity: 1, unit: 'piece', profileId: 'ignored' })).body;
    assert.ok(entry?.entry, JSON.stringify(entry));
    const plan = (await alice.post('/plans', { weekStart: '2026-10-19', seed: 1 })).body.plan;

    // Bob can't see or touch any of it
    assert.equal((await bob.get('/summary?date=2026-10-17')).body.totals.itemCount, 0);
    assert.equal((await bob.get('/logs?from=2026-10-01&to=2026-10-31')).body.entries.length, 0);
    assert.equal((await bob.patch(`/logs/${entry.entry.id}`, { quantity: 5 })).status, 404);
    assert.equal((await bob.del(`/logs/${entry.entry.id}`)).status, 404);
    assert.equal((await bob.get(`/foods/${food.id}`)).status, 404);
    assert.equal((await bob.get('/foods/search?q=alice')).body.mine.length, 0);
    assert.equal((await bob.post('/logs', { localDate: '2026-10-17', mealType: 'snack', foodId: food.id, quantity: 1, unit: 'piece' })).status, 404);
    assert.equal((await bob.get(`/plans/${plan.id}`)).status, 404);
    assert.equal((await bob.patch(`/plan-items/${plan.items[0].id}`, { servings: 2 })).status, 404);
    assert.equal((await bob.post(`/plan-items/${plan.items[0].id}/log`, { servingsEaten: 1, localDate: '2026-10-19', mealType: 'breakfast', idempotencyKey: 'bob-key-0001' })).status, 404);
    assert.equal((await bob.get('/plans')).body.plans.length, 0);
    const bobCsv = await bob.get('/export/logs.csv?from=2026-01-01&to=2026-12-31');
    assert.ok(!bobCsv.text.includes('Alice cake'));
    // Spoofed headers don't switch users without the service token
    const spoof = await bob.req('GET', '/me', undefined, { 'X-MealBase-User': aliceProfile });
    assert.notEqual(spoof.body.profileId, aliceProfile);
    // Bob deleting "all" his data leaves Alice's intact
    assert.equal((await bob.del('/data/all', { confirm: 'DELETE' })).status, 204);
    assert.equal((await alice.get('/logs?from=2026-10-17&to=2026-10-17')).body.entries.length, 1);
  });

  it('expired sessions are reported as such', async () => {
    const c = a();
    await c.post('/auth/register', { email: 'carol@example.com', password: 'yet another password' });
    t.app.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const r = await c.get('/me');
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'SESSION_EXPIRED');
  });

  it('rejects wrong passwords and signs out', async () => {
    const c = a();
    assert.equal((await c.post('/auth/login', { email: 'alice@example.com', password: 'wrong password!!' })).status, 401);
    assert.equal((await c.post('/auth/login', { email: 'alice@example.com', password: 'correct horse battery' })).status, 200);
    assert.equal((await c.get('/me')).status, 200);
    await c.post('/auth/logout');
    assert.equal((await c.get('/me')).status, 401);
  });
});

describe('server-to-server integration token', () => {
  let t: TestApp;
  before(async () => { t = await startTestApp({ authMode: 'accounts', integrationServiceToken: 'svc-token-abcdefghijklmnop' }); });
  after(() => t.close());

  it('maps host-app user ids to separate profiles', async () => {
    const as = (id: string, token = 'svc-token-abcdefghijklmnop') => new Client(t.url, { Authorization: `Bearer ${token}`, 'X-MealBase-User': id });
    const u1 = as('workout-user-1');
    const u2 = as('workout-user-2');
    await u1.post('/logs', { localDate: '2026-10-17', mealType: 'lunch', quick: { name: 'Sandwich', calories: 450 } });
    assert.equal((await u1.get('/summary?date=2026-10-17')).body.totals.calories, 450);
    assert.equal((await u2.get('/summary?date=2026-10-17')).body.totals.itemCount, 0);
    assert.equal((await u1.get('/me')).body.profileId, (await u1.get('/me')).body.profileId, 'stable identity mapping');
    assert.equal((await as('workout-user-1', 'wrong-token-xxxxxxxxxxxx').get('/me')).status, 401);
  });
});

describe('local mode safety', () => {
  it('refuses to start a single-user server on a public interface', async () => {
    await assert.rejects(startTestApp({ authMode: 'local', host: '0.0.0.0' }), /single-user demo/);
  });
});
