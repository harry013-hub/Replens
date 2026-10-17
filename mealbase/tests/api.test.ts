import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, startTestApp, type TestApp } from './helpers';

describe('food log API (local single-user mode)', () => {
  let t: TestApp;
  let c: Client;
  before(async () => { t = await startTestApp(); c = new Client(t.url); });
  after(() => t.close());

  it('creates, reads, edits and deletes an entry; totals follow', async () => {
    const food = await c.get('/foods/usda:173944');
    assert.equal(food.status, 200);
    const f = food.body.food;
    assert.equal(f.source, 'usda');
    assert.equal(f.reference.unit, 'g');

    const created = await c.post('/logs', { localDate: '2026-10-17', mealType: 'breakfast', foodId: f.id, quantity: 150, unit: 'g', idempotencyKey: 'key-create-1' });
    assert.equal(created.status, 201);
    const entry = created.body.entry;
    assert.equal(entry.nutrition.calories, 133.5);
    assert.equal(entry.snapshot.reference.quantity, 100);
    assert.equal(entry.snapshot.sourceFoodId, '173944');

    const cup = f.servings.find((s: any) => s.label === '1 cup, sliced');
    const second = await c.post('/logs', { localDate: '2026-10-17', mealType: 'snack', foodId: f.id, quantity: 1, unit: `serving:${cup.id}` });
    assert.equal(second.body.entry.nutrition.calories, 133.5);
    assert.equal(second.body.entry.unitLabel, '1 cup, sliced');

    let s = await c.get('/summary?date=2026-10-17');
    assert.equal(s.body.totals.calories, 267);
    assert.equal(s.body.meals.find((m: any) => m.mealType === 'breakfast').entries.length, 1);

    const edited = await c.patch(`/logs/${entry.id}`, { quantity: 200, mealType: 'lunch' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.entry.nutrition.calories, 178);
    assert.equal(edited.body.entry.mealType, 'lunch');

    const editServing = await c.patch(`/logs/${second.body.entry.id}`, { quantity: 2 });
    assert.equal(editServing.body.entry.nutrition.calories, 267);

    s = await c.get('/summary?date=2026-10-17');
    assert.equal(s.body.totals.calories, 445);

    assert.equal((await c.del(`/logs/${entry.id}`)).status, 204);
    assert.equal((await c.del(`/logs/${entry.id}`)).status, 404);
    s = await c.get('/summary?date=2026-10-17');
    assert.equal(s.body.totals.calories, 267);
    assert.deepEqual(t.events.events.map((e) => e.type).slice(0, 5), [
      'nutrition:food-logged', 'nutrition:food-logged', 'nutrition:food-updated', 'nutrition:food-updated', 'nutrition:food-deleted',
    ]);
  });

  it('retrying a create with the same idempotency key does not duplicate', async () => {
    const f = (await c.get('/foods/usda:173944')).body.food;
    const body = { localDate: '2026-10-10', mealType: 'dinner', foodId: f.id, quantity: 100, unit: 'g', idempotencyKey: 'retry-key-123' };
    const [a, b] = await Promise.all([c.post('/logs', body), c.post('/logs', body)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.entry.id, b.body.entry.id);
    assert.equal((await c.get('/logs?from=2026-10-10&to=2026-10-10')).body.entries.length, 1);
  });

  it('rejects invalid portions and impossible unit conversions', async () => {
    const f = (await c.get('/foods/usda:173944')).body.food;
    for (const quantity of [0, -1, 'abc', 1e9]) {
      const r = await c.post('/logs', { localDate: '2026-10-11', mealType: 'lunch', foodId: f.id, quantity, unit: 'g' });
      assert.equal(r.status, 400, `quantity ${quantity}`);
    }
    const ml = await c.post('/logs', { localDate: '2026-10-11', mealType: 'lunch', foodId: f.id, quantity: 100, unit: 'ml' });
    assert.equal(ml.status, 400);
    assert.equal(ml.body.error.code, 'UNIT_CONVERSION_UNAVAILABLE');
    const badDate = await c.post('/logs', { localDate: '2026-02-30', mealType: 'lunch', foodId: f.id, quantity: 100, unit: 'g' });
    assert.equal(badDate.status, 400);
    assert.equal((await c.get('/logs?from=2026-10-11&to=2026-10-11')).body.entries.length, 0, 'nothing was saved');
  });

  it('manual foods keep missing nutrients unavailable', async () => {
    const food = await c.post('/foods', { name: 'Grandma soup', referenceQuantity: 1, referenceUnit: 'serving', unitLabel: 'bowl', calories: 320, proteinG: null });
    assert.equal(food.status, 201);
    const e = await c.post('/logs', { localDate: '2026-10-12', mealType: 'dinner', foodId: food.body.food.id, quantity: 1.5, unit: 'serving' });
    assert.equal(e.body.entry.nutrition.calories, 480);
    assert.equal(e.body.entry.nutrition.proteinG, null);
    const s = await c.get('/summary?date=2026-10-12');
    assert.equal(s.body.totals.proteinG, null);
    assert.equal(s.body.totals.missing.proteinG, 1);
    const search = await c.get('/foods/search?q=grandma');
    assert.equal(search.body.mine.length, 1);
  });

  it('log snapshots do not change when provider data changes later', async () => {
    const f = (await c.get('/foods/usda:173944')).body.food;
    const e = (await c.post('/logs', { localDate: '2026-10-13', mealType: 'lunch', foodId: f.id, quantity: 100, unit: 'g' })).body.entry;
    t.app.db.prepare('UPDATE foods SET calories = 999 WHERE id = ?').run(f.id);
    const after = (await c.get('/logs?from=2026-10-13&to=2026-10-13')).body.entries[0];
    assert.equal(after.nutrition.calories, 89);
    const edited = (await c.patch(`/logs/${e.id}`, { quantity: 200 })).body.entry;
    assert.equal(edited.nutrition.calories, 178, 'edits recompute from the snapshot, not the changed food');
  });

  it('requires the client header for state-changing requests', async () => {
    const r = await fetch(t.url + '/logs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
  });

  it('exports CSV and validates imports', async () => {
    const csv = await c.get('/export/logs.csv?from=2026-10-01&to=2026-10-31');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type')!, /text\/csv/);
    const lines = csv.text.trim().split('\r\n');
    assert.equal(lines[0].split(',')[0], 'entry_id');
    assert.ok(lines.length > 3);
    const bad = await c.post('/import/plans', { format: 'something-else', version: 1, plans: [] });
    assert.equal(bad.status, 400);
    const json = await c.get('/export/plans.json');
    assert.equal(json.body.format, 'mealbase.plans');
    assert.equal(json.body.version, 1);
    const reimport = await c.post('/import/plans', json.body);
    assert.equal(reimport.status, 201);
  });
});

describe('food provider failures', () => {
  let t: TestApp;
  let c: Client;
  before(async () => { t = await startTestApp(); c = new Client(t.url); });
  after(() => t.close());

  it('reports rate limiting, outages and empty results without breaking manual entry', async () => {
    t.providerState.mode = '429';
    let r = await c.get('/foods/search?q=banana');
    assert.equal(r.status, 200);
    assert.equal(r.body.provider.status, 'rate_limited');
    t.providerState.mode = 'down';
    r = await c.get('/foods/search?q=banana');
    assert.equal(r.body.provider.status, 'unavailable');
    const detail = await c.get('/foods/usda:173944');
    assert.equal(detail.status, 503);
    assert.equal(detail.body.error.code, 'PROVIDER_UNAVAILABLE');
    const manual = await c.post('/foods', { name: 'Toast', referenceQuantity: 1, referenceUnit: 'piece', calories: 80 });
    assert.equal(manual.status, 201, 'manual entry works while the provider is down');
    t.providerState.mode = 'ok';
    r = await c.get('/foods/search?q=zzzz');
    assert.equal(r.body.provider.status, 'ok');
    assert.equal(r.body.results.length, 0);
    r = await c.get('/foods/search?q=banana');
    assert.equal(r.body.results.length, 3);
    assert.ok(r.body.sample.every((s: any) => s.isSample), 'sample data is kept in its own list');
    assert.ok(r.body.results.every((s: any) => !s.isSample));
  });

  it('serves a cached copy of a food when the provider goes down', async () => {
    t.providerState.mode = 'ok';
    await c.get('/foods/usda:173944');
    t.providerState.mode = '500';
    const r = await c.get('/foods/usda:173944');
    assert.equal(r.status, 200);
    t.providerState.mode = 'ok';
  });
});

describe('missing API key', () => {
  let t: TestApp;
  before(async () => { t = await startTestApp({}, { apiKey: null }); });
  after(() => t.close());
  it('says so and still returns personal and sample foods', async () => {
    const c = new Client(t.url);
    const cfg = await c.get('/config');
    assert.equal(cfg.body.foodProvider.configured, false);
    const r = await c.get('/foods/search?q=banana');
    assert.equal(r.body.provider.status, 'not_configured');
    assert.ok(r.body.sample.length >= 1);
  });
});
