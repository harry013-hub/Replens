/**
 * Open Food Facts provider — used by the browser-only build (RepLens on GitHub
 * Pages), because Open Food Facts allows websites to call it directly.
 *
 * Verified against the openfoodfacts-server repository and API docs (October 2026):
 * - No key. Reads need only an identifying User-Agent; browsers can't set that,
 *   so we send X-User-Agent, which the server's CORS rules explicitly allow.
 * - CORS: the API answers any origin with Access-Control-Allow-Origin.
 * - Full-text search: GET /cgi/search.pl?search_terms=…&json=1 (v1; v2 search has no full text).
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
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pageSize?: number;
  appId?: string;
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

function brand(p: Record<string, unknown>): string | null {
  const b = typeof p.brands === 'string' ? p.brands.split(',')[0]?.trim() : '';
  return b || null;
}

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
  private readonly f: typeof fetch;
  private readonly searches = new Cache<ProviderSearchPage>(15 * 60_000);
  private readonly details = new Cache<ProviderFood>(24 * 60 * 60_000);

  constructor(private readonly opts: OffOptions = {}) {
    this.base = (opts.baseUrl ?? 'https://world.openfoodfacts.org').replace(/\/+$/, '');
    this.f = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  isConfigured() { return true; }

  private async get(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await this.f(url, {
        headers: { Accept: 'application/json', 'X-User-Agent': this.opts.appId ?? 'RepLens-MealBase/1.0 (https://github.com/harry013-hub/Replens)' },
        signal: controller.signal,
      });
    } catch {
      throw new ProviderError('UNAVAILABLE', 'Open Food Facts could not be reached. Check your connection and try again, or add the food manually.');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 || res.status === 503) {
      throw new ProviderError('RATE_LIMITED', 'Open Food Facts is busy or the search limit (about 10 searches a minute) was reached. Wait a minute and try again, or add the food manually.', 60);
    }
    if (res.status === 404) throw new ProviderError('NOT_FOUND', 'That product was not found in Open Food Facts.');
    if (!res.ok) throw new ProviderError('UNAVAILABLE', `Open Food Facts returned an error (${res.status}). Try again shortly.`);
    try {
      return await res.json();
    } catch {
      throw new ProviderError('BAD_RESPONSE', 'Open Food Facts sent a response MealBase could not read.');
    }
  }

  async search(query: string, page: number): Promise<ProviderSearchPage> {
    const q = query.trim();
    const key = `${q.toLowerCase()}|${page}`;
    const hit = this.searches.get(key);
    if (hit) return hit;
    const pageSize = this.opts.pageSize ?? 24;
    const body = await this.get('/cgi/search.pl', {
      search_terms: q, search_simple: '1', action: 'process', json: '1',
      page_size: String(pageSize), page: String(page), fields: FIELDS,
    });
    if (!body || !Array.isArray(body.products)) throw new ProviderError('BAD_RESPONSE', 'Open Food Facts search response had an unexpected format.');
    const items = (body.products as Array<Record<string, unknown>>)
      .filter((p) => typeof p.code === 'string' && p.code)
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
    const count = num(body.count);
    const result: ProviderSearchPage = { page, totalPages: count === null ? null : Math.max(1, Math.ceil(count / pageSize)), items };
    this.searches.set(key, result);
    return result;
  }

  async getFood(code: string): Promise<ProviderFood> {
    if (!/^[0-9A-Za-z-]{1,40}$/.test(code)) throw new ProviderError('NOT_FOUND', 'Invalid product code.');
    const hit = this.details.get(code);
    if (hit) return hit;
    const body = await this.get(`/api/v2/product/${encodeURIComponent(code)}.json`, { fields: FIELDS });
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
