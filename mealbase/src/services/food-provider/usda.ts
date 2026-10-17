/**
 * USDA FoodData Central provider.
 *
 * Verified against https://fdc.nal.usda.gov/api-guide (October 2026):
 * - Base URL: https://api.nal.usda.gov/fdc/v1
 * - Every request needs a data.gov API key (`api_key` query parameter).
 *   DEMO_KEY works for trying things out (30 requests/hour, 50/day per IP).
 * - Default limit: 1,000 requests/hour per IP; exceeding it returns HTTP 429
 *   and blocks the key for an hour.
 * - Endpoints used: GET /foods/search, GET /food/{fdcId}
 * - Data is public domain (CC0 1.0). USDA asks that FoodData Central is credited.
 * - It is a food composition database. It does NOT provide recipes or meal plans.
 *
 * Nutrient values are reported per 100 g (Foundation, SR Legacy, FNDDS) and per
 * 100 g or 100 ml of product for Branded foods (following `servingSizeUnit`).
 * Portion weights come from `foodPortions[].gramWeight` or Branded `servingSize`.
 */
import type { NutrientValues, ReferenceUnit, ServingOption } from '../../shared/types/nutrition';
import { normalizeUnit } from '../../shared/lib/units';
import { ProviderError, type FoodProvider, type ProviderFood, type ProviderSearchPage } from './types';

export const USDA_ATTRIBUTION =
  'U.S. Department of Agriculture, Agricultural Research Service. FoodData Central. fdc.nal.usda.gov (public domain, CC0 1.0).';

export const USDA_DATA_TYPES = ['Foundation', 'SR Legacy', 'Survey (FNDDS)', 'Branded'];

export interface UsdaOptions {
  apiKey: string | null;
  baseUrl?: string;
  timeoutMs?: number;
  pageSize?: number;
  fetchImpl?: typeof fetch;
  /** Cache lifetimes in ms. Set 0 to disable. */
  searchCacheMs?: number;
  detailCacheMs?: number;
}

// FDC nutrient numbers
const N = {
  energyKcal: '208',
  energyKj: '268',
  atwaterGeneral: '957',
  atwaterSpecific: '958',
  protein: '203',
  fat: '204',
  carbs: '205',
};

interface NutrientRow {
  number: string | null;
  unit: string | null;
  value: number | null;
}

/** Normalise both search-style and detail-style nutrient rows. */
function readNutrientRows(raw: unknown): NutrientRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: any) => {
    const nested = r?.nutrient ?? null;
    const number = String(nested?.number ?? r?.nutrientNumber ?? r?.number ?? '') || null;
    const unit = (nested?.unitName ?? r?.unitName ?? null) as string | null;
    const valueRaw = r?.amount ?? r?.value;
    const value = typeof valueRaw === 'number' && Number.isFinite(valueRaw) ? valueRaw : null;
    return { number, unit, value };
  });
}

export function extractNutrients(raw: unknown): { values: NutrientValues; notes: string[] } {
  const rows = readNutrientRows(raw);
  const notes: string[] = [];
  const find = (num: string) => rows.find((r) => r.number === num && r.value !== null);

  let calories: number | null = null;
  const kcal = find(N.energyKcal) ?? find(N.atwaterGeneral) ?? find(N.atwaterSpecific);
  if (kcal) {
    if (kcal.unit && kcal.unit.toLowerCase() === 'kj') {
      calories = kcal.value! / 4.184;
      notes.push('Energy converted from kJ.');
    } else {
      calories = kcal.value!;
    }
    if (kcal.number !== N.energyKcal) notes.push('Energy from Atwater factors.');
  } else {
    const kj = find(N.energyKj);
    if (kj) {
      calories = kj.value! / 4.184;
      notes.push('Energy converted from kJ.');
    }
  }
  const grams = (num: string) => {
    const r = find(num);
    if (!r) return null;
    if (r.unit && r.unit.toLowerCase() === 'mg') return r.value! / 1000;
    return r.value;
  };
  return {
    values: { calories, proteinG: grams(N.protein), carbsG: grams(N.carbs), fatG: grams(N.fat) },
    notes,
  };
}

function brandedReferenceUnit(servingSizeUnit: unknown): ReferenceUnit {
  const u = String(servingSizeUnit ?? '').trim().toLowerCase();
  return u === 'ml' || u === 'mlt' ? 'ml' : 'g';
}

const KNOWN_PORTION_KEYS = new Set(['cup', 'tbsp', 'tsp', 'fl oz', 'oz', 'large', 'medium', 'small', 'slice', 'piece', 'extra large']);

function portionKey(measureName: string | null, modifier: string | null): string | null {
  const candidates = [measureName, modifier?.split(/[ ,(]/)[0] ?? null];
  for (const c of candidates) {
    if (!c || c === 'undetermined') continue;
    const n = normalizeUnit(c);
    if (KNOWN_PORTION_KEYS.has(n)) return n;
  }
  return null;
}

export function mapPortions(raw: unknown): Array<Omit<ServingOption, 'id'>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Omit<ServingOption, 'id'>> = [];
  for (const p of raw as any[]) {
    const gramWeight = typeof p?.gramWeight === 'number' ? p.gramWeight : null;
    if (!gramWeight || gramWeight <= 0) continue; // a portion without a weight is unusable
    const amount = typeof p?.amount === 'number' && p.amount > 0 ? p.amount : 1;
    const measureName: string | null = p?.measureUnit?.name ?? null;
    const modifier: string | null = typeof p?.modifier === 'string' && p.modifier.trim() ? p.modifier.trim() : null;
    const description: string | null =
      typeof p?.portionDescription === 'string' && p.portionDescription.trim() && p.portionDescription !== 'Quantity not specified'
        ? p.portionDescription.trim()
        : null;
    const unitKey = portionKey(measureName, modifier);

    let label: string;
    let refAmount = gramWeight;
    if (description) {
      label = description;
    } else {
      const parts = [measureName && measureName !== 'undetermined' ? measureName : null, modifier].filter(Boolean).join(', ');
      if (unitKey && amount !== 1) {
        label = `1 ${parts || unitKey}`;
        refAmount = gramWeight / amount;
      } else {
        label = `${amount} ${parts || 'portion'}`.trim();
      }
    }
    if (out.some((o) => o.label === label)) continue;
    out.push({ label, unitKey, refAmount, source: 'provider' });
  }
  return out;
}

class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(private ttl: number, private max = 500) {}
  get(k: string): V | undefined {
    const hit = this.map.get(k);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) { this.map.delete(k); return undefined; }
    return hit.v;
  }
  set(k: string, v: V) {
    if (this.ttl <= 0) return;
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(k, { v, exp: Date.now() + this.ttl });
  }
}

export class UsdaFoodProvider implements FoodProvider {
  readonly id = 'usda' as const;
  readonly label = 'USDA FoodData Central';
  readonly attribution = USDA_ATTRIBUTION;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly searchCache: TtlCache<ProviderSearchPage>;
  private readonly detailCache: TtlCache<ProviderFood>;

  constructor(private readonly opts: UsdaOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.nal.usda.gov/fdc/v1').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.searchCache = new TtlCache(opts.searchCacheMs ?? 10 * 60_000);
    this.detailCache = new TtlCache(opts.detailCacheMs ?? 24 * 60 * 60_000);
  }

  isConfigured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  get usingDemoKey(): boolean {
    return this.opts.apiKey === 'DEMO_KEY';
  }

  private async request(path: string, params: Record<string, string>): Promise<any> {
    if (!this.opts.apiKey) {
      throw new ProviderError('NOT_CONFIGURED', 'Food search needs a USDA FoodData Central API key (USDA_API_KEY). Manual entry still works.');
    }
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('api_key', this.opts.apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 8000);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    } catch {
      throw new ProviderError('UNAVAILABLE', 'USDA FoodData Central could not be reached. Try again, or add the food manually.');
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after'));
      throw new ProviderError('RATE_LIMITED', 'The USDA food search limit was reached. Try again later, or add the food manually.', Number.isFinite(retry) && retry > 0 ? retry : 3600);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('NOT_CONFIGURED', 'The USDA API key was rejected. Check USDA_API_KEY.');
    }
    if (res.status === 404) throw new ProviderError('NOT_FOUND', 'That food was not found in USDA FoodData Central.');
    if (!res.ok) throw new ProviderError('UNAVAILABLE', `USDA FoodData Central returned an error (${res.status}). Try again shortly.`);

    try {
      return await res.json();
    } catch {
      throw new ProviderError('BAD_RESPONSE', 'USDA FoodData Central sent a response MealBase could not read.');
    }
  }

  async search(query: string, page: number): Promise<ProviderSearchPage> {
    const q = query.trim();
    const cacheKey = `${q.toLowerCase()}|${page}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cached;

    const body = await this.request('/foods/search', {
      query: q,
      pageSize: String(this.opts.pageSize ?? 25),
      pageNumber: String(page),
      dataType: USDA_DATA_TYPES.join(','),
    });
    if (!body || !Array.isArray(body.foods)) {
      throw new ProviderError('BAD_RESPONSE', 'USDA search response had an unexpected format.');
    }
    const result: ProviderSearchPage = {
      page,
      totalPages: typeof body.totalPages === 'number' ? body.totalPages : null,
      items: body.foods
        .filter((f: any) => f && (typeof f.fdcId === 'number' || typeof f.fdcId === 'string') && typeof f.description === 'string')
        .map((f: any) => {
          const { values } = extractNutrients(f.foodNutrients);
          const unit: ReferenceUnit = f.dataType === 'Branded' ? brandedReferenceUnit(f.servingSizeUnit) : 'g';
          const hasAny = Object.values(values).some((v) => v !== null);
          return {
            sourceFoodId: String(f.fdcId),
            name: titleCase(f.description),
            brand: (f.brandName || f.brandOwner || null) as string | null,
            dataType: (f.dataType ?? null) as string | null,
            preview: hasAny ? { quantity: 100, unit, values } : null,
          };
        }),
    };
    this.searchCache.set(cacheKey, result);
    return result;
  }

  async getFood(sourceFoodId: string): Promise<ProviderFood> {
    if (!/^\d+$/.test(sourceFoodId)) throw new ProviderError('NOT_FOUND', 'Invalid USDA food id.');
    const cached = this.detailCache.get(sourceFoodId);
    if (cached) return cached;

    const f = await this.request(`/food/${sourceFoodId}`, {});
    if (!f || typeof f.description !== 'string') {
      throw new ProviderError('BAD_RESPONSE', 'USDA food details had an unexpected format.');
    }
    const { values, notes } = extractNutrients(f.foodNutrients);
    const isBranded = f.dataType === 'Branded';
    const refUnit: ReferenceUnit = isBranded ? brandedReferenceUnit(f.servingSizeUnit) : 'g';
    const servings = mapPortions(f.foodPortions);

    if (isBranded && typeof f.servingSize === 'number' && f.servingSize > 0) {
      const servingUnit = brandedReferenceUnit(f.servingSizeUnit);
      if (servingUnit === refUnit) {
        const household = typeof f.householdServingFullText === 'string' && f.householdServingFullText.trim()
          ? ` (${f.householdServingFullText.trim()})`
          : '';
        servings.unshift({ label: `1 serving${household}`, unitKey: 'serving', refAmount: f.servingSize, source: 'provider' });
      }
    }

    const food: ProviderFood = {
      providerId: 'usda',
      sourceFoodId: String(f.fdcId ?? sourceFoodId),
      name: titleCase(f.description),
      brand: f.brandName || f.brandOwner || null,
      dataType: f.dataType ?? null,
      reference: { quantity: 100, unit: refUnit, values },
      servings,
      attribution: USDA_ATTRIBUTION,
      notes,
    };
    this.detailCache.set(sourceFoodId, food);
    return food;
  }
}

/** USDA descriptions are often ALL CAPS for branded items; make them readable. */
function titleCase(s: string): string {
  const t = s.trim();
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s,(/-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}
