import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractNutrients, mapPortions, UsdaFoodProvider } from '../src/services/food-provider/usda';
import { ProviderError } from '../src/services/food-provider/types';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

function fakeFetch(handler: (url: URL) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request) => handler(new URL(String(input)))) as typeof fetch;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('USDA mapping', () => {
  it('reads search-style and detail-style nutrient rows', () => {
    const search = extractNutrients(fixture('usda-search-banana.json').foods[0].foodNutrients);
    assert.deepEqual(search.values, { calories: 89, proteinG: 1.09, carbsG: 22.84, fatG: 0.33 });
    const detail = extractNutrients(fixture('usda-food-173944.json').foodNutrients);
    assert.deepEqual(detail.values, { calories: 89, proteinG: 1.09, carbsG: 22.84, fatG: 0.33 });
  });

  it('falls back to Atwater energy and leaves missing nutrients null', () => {
    const r = extractNutrients(fixture('usda-search-banana.json').foods[2].foodNutrients);
    assert.equal(r.values.calories, 97);
    assert.equal(r.values.fatG, null);
    assert.equal(r.values.carbsG, null);
    assert.ok(r.notes.some((n) => n.includes('Atwater')));
  });

  it('converts kJ-only energy and never invents a value', () => {
    const r = extractNutrients([{ nutrientNumber: '268', unitName: 'kJ', value: 418.4 }]);
    assert.ok(Math.abs(r.values.calories! - 100) < 1e-9);
    assert.deepEqual(extractNutrients([]).values, { calories: null, proteinG: null, carbsG: null, fatG: null });
  });

  it('keeps only portions that have a gram weight', () => {
    const portions = mapPortions(fixture('usda-food-173944.json').foodPortions);
    assert.equal(portions.length, 2);
    assert.equal(portions[0].label, '1 cup, sliced');
    assert.equal(portions[0].refAmount, 150);
    assert.equal(portions[0].unitKey, 'cup');
    assert.equal(portions[1].unitKey, 'medium');
  });
});

describe('UsdaFoodProvider', () => {
  it('reports missing credentials without calling the network', async () => {
    let called = false;
    const p = new UsdaFoodProvider({ apiKey: null, fetchImpl: fakeFetch(() => { called = true; return json({}); }) });
    assert.equal(p.isConfigured(), false);
    await assert.rejects(p.search('banana', 1), (e: unknown) => e instanceof ProviderError && e.code === 'NOT_CONFIGURED');
    assert.equal(called, false);
  });

  it('sends the key server-side and maps search results', async () => {
    let seen: URL | null = null;
    const p = new UsdaFoodProvider({ apiKey: 'secret-key', fetchImpl: fakeFetch((u) => { seen = u; return json(fixture('usda-search-banana.json')); }) });
    const page = await p.search('banana', 1);
    assert.equal(seen!.searchParams.get('api_key'), 'secret-key');
    assert.equal(seen!.pathname, '/fdc/v1/foods/search');
    assert.equal(page.items.length, 3);
    assert.equal(page.items[1].name, 'Banana Oat Drink');
    assert.equal(page.items[1].brand, 'EXAMPLE');
    assert.equal(page.items[1].preview!.unit, 'ml', 'branded drinks measured in ml stay in ml');
    assert.equal(page.items[1].preview!.values.fatG, null);
  });

  it('maps a branded food serving in its own unit', async () => {
    const p = new UsdaFoodProvider({ apiKey: 'k', fetchImpl: fakeFetch(() => json(fixture('usda-food-2099999.json'))) });
    const f = await p.getFood('2099999');
    assert.equal(f.reference.unit, 'ml');
    assert.equal(f.servings[0].label, '1 serving (1 cup)');
    assert.equal(f.servings[0].refAmount, 240);
  });

  it('maps HTTP failures to provider errors', async () => {
    const cases: Array<[() => Response, string]> = [
      [() => json({}, 429, { 'Retry-After': '120' }), 'RATE_LIMITED'],
      [() => json({}, 403), 'NOT_CONFIGURED'],
      [() => json({}, 503), 'UNAVAILABLE'],
      [() => new Response('<html>', { status: 200 }), 'BAD_RESPONSE'],
      [() => json({ unexpected: true }), 'BAD_RESPONSE'],
    ];
    for (const [res, code] of cases) {
      const p = new UsdaFoodProvider({ apiKey: 'k', searchCacheMs: 0, fetchImpl: fakeFetch(res) });
      await assert.rejects(p.search('x', 1), (e: unknown) => e instanceof ProviderError && e.code === code, code);
    }
    const down = new UsdaFoodProvider({ apiKey: 'k', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await assert.rejects(down.search('x', 1), (e: unknown) => e instanceof ProviderError && e.code === 'UNAVAILABLE');
    const p429 = new UsdaFoodProvider({ apiKey: 'k', fetchImpl: fakeFetch(() => json({}, 429, { 'Retry-After': '120' })) });
    await assert.rejects(p429.search('y', 1), (e: unknown) => e instanceof ProviderError && e.retryAfterSeconds === 120);
  });

  it('caches searches to protect the rate limit', async () => {
    let calls = 0;
    const p = new UsdaFoodProvider({ apiKey: 'k', fetchImpl: fakeFetch(() => { calls++; return json(fixture('usda-search-banana.json')); }) });
    await p.search('Banana', 1);
    await p.search('banana ', 1);
    assert.equal(calls, 1);
  });
});
