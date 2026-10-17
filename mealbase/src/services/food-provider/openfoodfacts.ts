/**
 * Open Food Facts provider — used by the browser-only build (RepLens on GitHub
 * Pages), because Open Food Facts allows websites to call it directly.
 *
 * Verified against the openfoodfacts-server repository and API docs (October 2026):
 * - No key. Requests are plain GETs with no custom headers, so browsers never need a
 *   CORS preflight. If a browser still can't fetch (privacy settings, CORS trouble),
 *   the legacy endpoints are retried with JSONP (`jsonp=` parameter, supported by
 *   Product Opener's display code), and product details fall back to the search data.
 * - CORS: the API answers any origin with Access-Control-Allow-Origin.
 * - Full-text search: Search-a-licious, GET https://search.openfoodfacts.org/search?q=…
 *   (fast Elasticsearch service; its CORS middleware allows any http(s) origin), falling back to
 *   the older, slower GET /cgi/search.pl?search_terms=…&json=1 if it's unavailable.
 *   Product: GET /api/v2/product/{code}.json
 * - Rate limits per IP: 10 searches/min, 15 product reads/min. Exceeding can lead to a ban,
 *   so results are cached and searches are user-initiated only.
 * - Nutrients: nutriments.{energy-kcal_100g, proteins_100g, carbohydrates_100g, fat_100g},
 *   per 100 g, or per 100 ml when product_quantity_unit is "ml".
 *   Serving: serving_quantity (+ serving_quantity_unit) with serving_size text.
 * - Licence: database ODbL, contents DbCL. Attribution to Open Food Facts is required.
 * - Mostly packaged/branded products; contributor-entered data can be incomplete or wrong.
 */
import type { NutrientValues, ReferenceUnit, ServingOption } from '../../shared/types/nutrition';
import { ProviderError, type FoodProvider, type ProviderFood, type ProviderSearchPage } from './types';

export const OFF_ATTRIBUTION = 'Open Food Facts contributors, openfoodfacts.org (Open Database License).';
const FIELDS = 'code,product_name,product_name_en,generic_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit,product_quantity_unit,quantity';

export interface OffOptions {
  baseUrl?: string;
  searchBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pageSize?: number;
  /** Load a JSONP URL (browser default uses a <script> tag). Pass null to disable. */
  jsonpImpl?: ((url: string) => Promise<unknown>) | null;
}

let jsonpSeq = 0;
/** Minimal JSONP loader for browsers. */
export function browserJsonp(url: string, timeoutMs = 15_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new Error('no document'));
    const name = `__mealbaseJsonp${Date.now()}${jsonpSeq++}`;
    const u = new URL(url);
    u.searchParams.set('jsonp', name);
    const script = document.createElement('script');
    const w = window as unknown as Record<string, unknown>;
    const done = () => { delete w[name]; script.remove(); clearTimeout(timer); };
    const timer = setTimeout(() => { done(); reject(new Error('timeout')); }, timeoutMs);
    w[name] = (data: unknown) => { done(); resolve(data); };
    script.onerror = () => { done(); reject(new Error('script error')); };
    script.src = u.toString();
    document.head.appendChild(script);
  });
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

export function offNutrients(nutriments: unknown): { values: NutrientValues; notes: string[] } {
  const n = (nutriments ?? {}) as Record<string, unknown>;
  const notes: string[] = [];
  let calories = num(n['energy-kcal_100g']);
  if (calories === null) {
    const kj = num(n['energy-kj_100g']) ?? num(n['energy_100g']);
    if (kj !== null) {
      calories = kj / 4.184;
      notes.push('Energy converted from kJ.');
    }
  }
  return {
    values: { calories, proteinG: num(n['proteins_100g']), carbsG: num(n['carbohydrates_100g']), fatG: num(n['fat_100g']) },
    notes,
  };
}

function refUnit(p: Record<string, unknown>): ReferenceUnit {
  const u = String(p.product_quantity_unit ?? '').toLowerCase();
  if (u === 'ml') return 'ml';
  if (!u && /\d\s*(ml|cl|l)\b/i.test(String(p.quantity ?? ''))) return 'ml';
  return 'g';
}

function name(p: Record<string, unknown>): string {
  const n = [p.product_name, p.product_name_en, p.generic_name].find((x) => typeof x === 'string' && x.trim()) as string | undefined;
  return n?.trim() ?? 'Unnamed product';
}

function prettyTag(tag: string): string {
  // Search-a-licious returns taxonomy tags like "kirkland-signature" or "xx:kirkland-signature".
  return tag.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function brand(p: Record<string, unknown>): string | null {
  const raw = p.brands;
  if (Array.isArray(raw)) {
    const first = raw.find((x) => typeof x === 'string' && x.trim()) as string | undefined;
    return first ? (/[A-Z ]/.test(first) ? first.trim() : prettyTag(first)) : null;
  }
  const b = typeof raw === 'string' ? raw.split(',')[0]?.trim() : '';
  return b || null;
}

/** Store names people type that appear on labels as a brand instead. */
const STORE_BRANDS: Array<[RegExp, string]> = [
  [/\bcostco\b/i, 'kirkland'],
  [/\btrader joe'?s\b/i, "trader joe's"],
  [/\bwalmart\b/i, 'great value'],
  [/\btarget\b/i, 'good & gather'],
  [/\bwhole foods\b/i, '365'],
  [/\bkroger\b/i, 'kroger'],
  [/\baldi\b/i, 'aldi'],
];

export function offServings(p: Record<string, unknown>, unit: ReferenceUnit): Array<Omit<ServingOption, 'id'>> {
  const q = num(p.serving_quantity);
  if (!q) return [];
  const su = String(p.serving_quantity_unit ?? '').toLowerCase();
  // Only offer the serving when it's measured in the same unit as the nutrients.
  if (su && su !== unit) return [];
  if (!su && unit === 'ml') return [];
  const text = typeof p.serving_size === 'string' && p.serving_size.trim() ? ` (${p.serving_size.trim()})` : '';
  return [{ label: `1 serving${text}`, unitKey: 'serving', refAmount: q, source: 'provider' }];
}

class Cache<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(private ttl: number) {}
  get(k: string) { const h = this.m.get(k); if (!h || h.exp < Date.now()) { this.m.delete(k); return undefined; } return h.v; }
  set(k: string, v: V) { if (this.m.size > 300) this.m.delete(this.m.keys().next().value as string); this.m.set(k, { v, exp: Date.now() + this.ttl }); }
}

export class OpenFoodFactsProvider implements FoodProvider {
  readonly id = 'off' as const;
  readonly label = 'Open Food Facts';
  readonly attribution = OFF_ATTRIBUTION;
  private readonly base: string;
  private readonly searchBase: string;
  private readonly f: typeof fetch;
  private readonly searches = new Cache<ProviderSearchPage>(15 * 60_000);
  private readonly details = new Cache<ProviderFood>(24 * 60 * 60_000);
  /** Raw products seen in search results, used if the details request fails. */
  private readonly seen = new Cache<Record<string, unknown>>(24 * 60 * 60_000);
  private readonly jsonp: ((url: string) => Promise<unknown>) | null;

  constructor(private readonly opts: OffOptions = {}) {
    this.base = (opts.baseUrl ?? 'https://world.openfoodfacts.org').replace(/\/+$/, '');
    this.searchBase = (opts.searchBaseUrl ?? 'https://search.openfoodfacts.org').replace(/\/+$/, '');
    this.f = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.jsonp = opts.jsonpImpl === undefined ? (typeof document !== 'undefined' ? (u) => browserJsonp(u, opts.timeoutMs ?? 15_000) : null) : opts.jsonpImpl;
  }

  isConfigured() { return true; }

  private async get(path: string, params: Record<string, string>, base = this.base): Promise<any> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await this.f(url, { signal: controller.signal });
    } catch (err) {
      // Network/CORS failure or timeout. The legacy endpoints also speak JSONP.
      if (this.jsonp && base === this.base) {
        try {
          return await this.jsonp(url.toString());
        } catch {
          // fall through to the error below
        }
      }
      const timedOut = (err as { name?: string })?.name === 'AbortError';
      throw new ProviderError('UNAVAILABLE', timedOut
        ? 'Open Food Facts took too long to answer. Try again in a moment, or add the food manually.'
        : 'Open Food Facts could not be reached from this browser. If you use an ad or tracker blocker, allow openfoodfacts.org; otherwise try again, or add the food manually.');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      throw new ProviderError('RATE_LIMITED', 'The Open Food Facts search limit was reached. Wait a minute and try again, or add the food manually.', 60);
    }
    if (res.status === 503) {
      throw new ProviderError('UNAVAILABLE', 'Open Food Facts is busy right now. Wait a moment and try again, or add the food manually.');
    }
    if (res.status === 404) throw new ProviderError('NOT_FOUND', 'That product was not found in Open Food Facts.');
    if (!res.ok) throw new ProviderError('UNAVAILABLE', `Open Food Facts returned an error (${res.status}). Try again shortly.`);
    try {
      return await res.json();
    } catch {
      throw new ProviderError('BAD_RESPONSE', 'Open Food Facts sent a response MealBase could not read.');
    }
  }

  /** One Search-a-licious query; falls back to the legacy endpoint if the service is down. */
  private async searchOnce(q: string, page: number, pageSize: number): Promise<{ products: Array<Record<string, unknown>>; count: number | null }> {
    try {
      const body = await this.get('/search', { q, page: String(page), page_size: String(pageSize), langs: 'en', fields: FIELDS }, this.searchBase);
      if (body && Array.isArray(body.hits)) return { products: body.hits, count: num(body.count) };
      throw new ProviderError('BAD_RESPONSE', 'Open Food Facts search response had an unexpected format.');
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'RATE_LIMITED') throw err;
      // Search-a-licious unavailable or rejected the query: use the older full-text search.
      const body = await this.get('/cgi/search.pl', {
        search_terms: q, search_simple: '1', action: 'process', json: '1', page_size: String(pageSize), page: String(page), fields: FIELDS,
      });
      if (!body || !Array.isArray(body.products)) throw new ProviderError('BAD_RESPONSE', 'Open Food Facts search response had an unexpected format.');
      return { products: body.products, count: num(body.count) };
    }
  }

  async search(query: string, page: number): Promise<ProviderSearchPage> {
    const q = query.trim().replace(/[:"\\()[\]{}^~*?]/g, ' ').replace(/\s+/g, ' ').trim();
    const key = `${q.toLowerCase()}|${page}`;
    const hit = this.searches.get(key);
    if (hit) return hit;
    const pageSize = this.opts.pageSize ?? 24;

    // Store names ("costco pizza") are usually printed as a house brand ("Kirkland").
    const queries = [q];
    for (const [re, brandName] of STORE_BRANDS) if (re.test(q)) queries.push(q.replace(re, brandName).trim());

    const seen = new Set<string>();
    const products: Array<Record<string, unknown>> = [];
    let count: number | null = 0;
    let lastError: unknown = null;
    for (const query of queries) {
      try {
        let r = await this.searchOnce(query, page, pageSize);
        // All words must match by default; if nothing matches, accept any of the words.
        const words = query.split(' ').filter(Boolean);
        if (r.products.length === 0 && words.length > 1 && page === 1) r = await this.searchOnce(words.join(' OR '), page, pageSize);
        for (const p of r.products) {
          const code = typeof p.code === 'string' ? p.code : null;
          if (code && !seen.has(code)) { seen.add(code); products.push(p); this.seen.set(code, p); }
        }
        count = Math.max(count ?? 0, r.count ?? 0);
      } catch (err) {
        lastError = err;
      }
    }
    if (!products.length && lastError) throw lastError;

    const items = products
      .map((p) => {
        const { values } = offNutrients(p.nutriments);
        const unit = refUnit(p);
        return {
          sourceFoodId: String(p.code), name: name(p), brand: brand(p), dataType: 'Product',
          preview: Object.values(values).some((v) => v !== null) ? { quantity: 100, unit, values } : null,
        };
      })
      // Products with no nutrition at all aren't useful for logging; list them last.
      .sort((a, b) => Number(b.preview !== null) - Number(a.preview !== null));
    const result: ProviderSearchPage = { page, totalPages: count ? Math.max(1, Math.ceil(count / pageSize)) : null, items };
    this.searches.set(key, result);
    return result;
  }

  async getFood(code: string): Promise<ProviderFood> {
    if (!/^[0-9A-Za-z-]{1,40}$/.test(code)) throw new ProviderError('NOT_FOUND', 'Invalid product code.');
    const hit = this.details.get(code);
    if (hit) return hit;
    let body: any;
    try {
      body = await this.get(`/api/v2/product/${encodeURIComponent(code)}.json`, { fields: FIELDS });
    } catch (err) {
      const fromSearch = this.seen.get(code);
      if (fromSearch && err instanceof ProviderError && err.code !== 'NOT_FOUND') body = { status: 1, product: fromSearch };
      else throw err;
    }
    if (!body || body.status === 0 || !body.product) throw new ProviderError('NOT_FOUND', 'That product was not found in Open Food Facts.');
    const p = body.product as Record<string, unknown>;
    const { values, notes } = offNutrients(p.nutriments);
    const unit = refUnit(p);
    if (!Object.values(values).some((v) => v !== null)) notes.push('No nutrition facts entered for this product yet.');
    const food: ProviderFood = {
      providerId: 'off', sourceFoodId: String(p.code ?? code), name: name(p), brand: brand(p), dataType: 'Product',
      reference: { quantity: 100, unit, values }, servings: offServings(p, unit), attribution: OFF_ATTRIBUTION, notes,
    };
    this.details.set(code, food);
    return food;
  }
}
