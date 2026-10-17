import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenFoodFactsProvider, offNutrients } from '../src/services/food-provider/openfoodfacts';
import { ProviderError } from '../src/services/food-provider/types';
import { BrowserFoodProvider } from '../src/local/browser-provider';
import { LocalBackend } from '../src/local/backend';
import { NutritionApiClient } from '../src/features/nutrition/api/client';
import { fixture } from './helpers';

const seen: Array<{ url: URL; headers: Headers }> = [];
let mode: 'ok' | '429' | 'down' = 'ok';
const offFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  seen.push({ url, headers: new Headers(init?.headers) });
  if (url.pathname.includes('/.netlify/functions/')) return new Response('Not found', { status: 404 });
  if (mode === 'down') throw new TypeError('Failed to fetch');
  if (mode === '429') return new Response('', { status: 429 });
  if (url.pathname === '/cgi/search.pl') return new Response(fixture('off-search-oat.json'), { status: 200 });
  const m = url.pathname.match(/^\/api\/v2\/product\/(\d+)\.json$/);
  if (m && m[1] === '0000000000017') return new Response(fixture('off-product-0000000000017.json'), { status: 200 });
  return new Response(JSON.stringify({ status: 0, status_verbose: 'product not found' }), { status: 404 });
}) as typeof fetch;

describe('Open Food Facts provider', () => {
  it('maps nutrients per 100 g / 100 ml and keeps missing values unavailable', () => {
    assert.deepEqual(offNutrients({ 'energy-kcal_100g': 375, proteins_100g: 12.5, carbohydrates_100g: 67.5, fat_100g: '7' }).values, { calories: 375, proteinG: 12.5, carbsG: 67.5, fatG: 7 });
    const kj = offNutrients({ 'energy-kj_100g': 418.4 });
    assert.ok(Math.abs(kj.values.calories! - 100) < 1e-9);
    assert.equal(kj.values.fatG, null);
    assert.deepEqual(offNutrients({}).values, { calories: null, proteinG: null, carbsG: null, fatG: null });
    assert.equal(offNutrients({ fat_100g: -3 }).values.fatG, null, 'bad values are not trusted');
  });

  it('searches with an identifying header, no key, and ranks products with data first', async () => {
    mode = 'ok';
    const p = new OpenFoodFactsProvider({ fetchImpl: offFetch });
    const page = await p.search('oat', 1);
    const last = seen.at(-1)!;
    assert.equal(last.url.origin, 'https://world.openfoodfacts.org');
    assert.equal(last.url.searchParams.get('search_terms'), 'oat');
    assert.match(last.headers.get('x-user-agent')!, /RepLens-MealBase/);
    assert.equal(last.url.searchParams.get('api_key'), null);
    assert.deepEqual(page.items.map((i) => i.name), ['Rolled Oats', 'Oat Drink', 'Oat thing with no data']);
    assert.equal(page.items[0].brand, 'Example Mills');
    assert.equal(page.items[1].preview!.unit, 'ml');
    assert.equal(page.items[2].preview, null);
  });

  it('maps product details and servings in the matching unit', async () => {
    const f = await new OpenFoodFactsProvider({ fetchImpl: offFetch }).getFood('0000000000017');
    assert.equal(f.providerId, 'off');
    assert.deepEqual(f.reference, { quantity: 100, unit: 'g', values: { calories: 375, proteinG: 12.5, carbsG: 67.5, fatG: 7 } });
    assert.deepEqual(f.servings, [{ label: '1 serving (1/2 cup (40 g))', unitKey: 'serving', refAmount: 40, source: 'provider' }]);
  });

  it('reports rate limits, outages and missing products', async () => {
    mode = '429';
    await assert.rejects(new OpenFoodFactsProvider({ fetchImpl: offFetch }).search('rice', 1), (e: unknown) => e instanceof ProviderError && e.code === 'RATE_LIMITED');
    mode = 'down';
    await assert.rejects(new OpenFoodFactsProvider({ fetchImpl: offFetch }).search('rice', 1), (e: unknown) => e instanceof ProviderError && e.code === 'UNAVAILABLE');
    mode = 'ok';
    await assert.rejects(new OpenFoodFactsProvider({ fetchImpl: offFetch }).getFood('999'), (e: unknown) => e instanceof ProviderError && e.code === 'NOT_FOUND');
  });
});

describe('static site without the USDA function (GitHub Pages)', () => {
  it('uses Open Food Facts end to end: search, details, log', async () => {
    mode = 'ok';
    const backend = new LocalBackend({ storage: null, provider: new BrowserFoodProvider({ proxyUrl: '/.netlify/functions/usda', fetchImpl: offFetch }) });
    const api = new NutritionApiClient('/api/v1/nutrition', backend.fetch);
    const cfg = await api.config();
    assert.equal(cfg.foodProvider.id, 'off');
    assert.equal(cfg.foodProvider.label, 'Open Food Facts');
    assert.equal(cfg.foodProvider.mode, 'browser');
    assert.equal(cfg.foodProvider.configured, true);

    const r = await api.searchFoods('oat');
    assert.equal(r.provider.status, 'ok');
    assert.equal(r.provider.label, 'Open Food Facts');
    assert.equal(r.results[0].ref, 'off:0000000000017');
    assert.ok(r.sample.length > 0, 'generic sample foods still listed separately');

    const food = await api.food('off:0000000000017');
    assert.equal(food.source, 'off');
    const serving = food.servings[0];
    const { entry } = await api.createLog({ localDate: '2026-10-17', mealType: 'breakfast', foodId: food.id, quantity: 1, unit: `serving:${serving.id}` });
    assert.equal(entry.nutrition.calories, 150);
    assert.equal(entry.snapshot.source, 'off');

    mode = '429';
    const limited = await api.searchFoods('rice');
    assert.equal(limited.provider.status, 'rate_limited');
    assert.ok(limited.sample.length > 0);
    // Cached details still work during an outage.
    mode = 'down';
    assert.equal((await api.food('off:0000000000017')).name, 'Rolled Oats');
    mode = 'ok';
  });

  it('still prefers the USDA function when the site has one', async () => {
    const proxyFetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), 'https://site.example');
      if (url.searchParams.get('op') === 'status') return new Response(JSON.stringify({ configured: true, usingDemoKey: false }), { status: 200 });
      return new Response(JSON.stringify({ page: 1, totalPages: 1, items: [] }), { status: 200 });
    }) as typeof fetch;
    const p = new BrowserFoodProvider({ proxyUrl: 'https://site.example/.netlify/functions/usda', fetchImpl: proxyFetch });
    await p.probe();
    assert.equal(p.id, 'usda');
    assert.equal(p.mode, 'proxy');
  });
});

describe('Open Food Facts search (Search-a-licious)', () => {
  it('maps store names to house brands, merges results and tidies brand tags', async () => {
    const calls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.host + url.pathname + ' q=' + (url.searchParams.get('q') ?? ''));
      if (url.host === 'search.openfoodfacts.org' && url.pathname === '/search') {
        const q = url.searchParams.get('q') ?? '';
        if (q === 'kirkland pizza') return new Response(fixture('sal-search-kirkland-pizza.json'), { status: 200 });
        return new Response(JSON.stringify({ hits: [], page: 1, page_size: 24, page_count: 0, took: 1, timed_out: false, count: 0, is_count_exact: true }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const page = await new OpenFoodFactsProvider({ fetchImpl: f }).search('Costco pizza', 1);
    assert.ok(calls.some((c) => c === 'search.openfoodfacts.org/search q=Costco pizza'));
    assert.ok(calls.some((c) => c === 'search.openfoodfacts.org/search q=kirkland pizza'));
    assert.ok(calls.some((c) => c.endsWith('q=Costco OR pizza')), 'retries with any-word matching when nothing matches');
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].name, 'Pepperoni Pizza');
    assert.equal(page.items[0].brand, 'Kirkland Signature');
    assert.equal(page.items[0].preview!.values.calories, 268);
  });

  it('falls back to the legacy search when Search-a-licious is down', async () => {
    const f = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.host === 'search.openfoodfacts.org') throw new TypeError('Failed to fetch');
      if (url.pathname === '/cgi/search.pl') return new Response(fixture('off-search-oat.json'), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const page = await new OpenFoodFactsProvider({ fetchImpl: f }).search('oat', 1);
    assert.equal(page.items[0].name, 'Rolled Oats');
  });

  it('strips search syntax characters from what the user typed', async () => {
    let q = '';
    const f = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      q = url.searchParams.get('q') ?? q;
      return new Response(JSON.stringify({ hits: [{ code: '1', product_name: 'X', nutriments: {} }], count: 1 }), { status: 200 });
    }) as typeof fetch;
    await new OpenFoodFactsProvider({ fetchImpl: f }).search('pizza: "large" (cheese)*', 1);
    assert.equal(q, 'pizza large cheese');
  });
});
