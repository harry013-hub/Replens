/**
 * Browser-side FoodProvider that talks to the USDA proxy (see src/proxy/usda-proxy.ts).
 * If the proxy isn't deployed (e.g. GitHub Pages or a plain static server), food
 * search reports "not configured" and manual entry keeps working.
 */
import { USDA_ATTRIBUTION } from '../services/food-provider/usda';
import { ProviderError, type FoodProvider, type ProviderErrorCode, type ProviderFood, type ProviderSearchPage } from '../services/food-provider/types';

export class RemoteUsdaProvider implements FoodProvider {
  readonly id = 'usda' as const;
  readonly label = 'USDA FoodData Central';
  readonly attribution = USDA_ATTRIBUTION;
  private status: { configured: boolean; usingDemoKey: boolean } | null = null;

  constructor(private readonly proxyUrl: string, private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  /** Ask the proxy whether a key is set. Missing proxy → not configured. */
  async probe(): Promise<{ configured: boolean; usingDemoKey: boolean }> {
    if (this.status) return this.status;
    try {
      const res = await this.fetchImpl(`${this.proxyUrl}?op=status`, { headers: { Accept: 'application/json' } });
      const body = res.ok ? await res.json() : null;
      this.status = body && typeof body.configured === 'boolean'
        ? { configured: body.configured, usingDemoKey: Boolean(body.usingDemoKey) }
        : { configured: false, usingDemoKey: false };
    } catch {
      // Network trouble isn't "not configured"; try again next time.
      return { configured: false, usingDemoKey: false };
    }
    return this.status;
  }

  isConfigured(): boolean {
    return this.status?.configured ?? false;
  }

  get usingDemoKey(): boolean {
    return this.status?.usingDemoKey ?? false;
  }

  private async call<T>(params: Record<string, string>): Promise<T> {
    const s = await this.probe();
    if (!s.configured) throw new ProviderError('NOT_CONFIGURED', 'Food database search isn’t set up on this site yet (the USDA key is added on the host). Manual entry still works.');
    const url = `${this.proxyUrl}?${new URLSearchParams(params)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    } catch {
      throw new ProviderError('UNAVAILABLE', 'The food database could not be reached. Check your connection, or add the food manually.');
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError('BAD_RESPONSE', 'The food database sent a response MealBase could not read.');
    }
    if (!res.ok) {
      const e = body?.error;
      const code: ProviderErrorCode = ['NOT_CONFIGURED', 'RATE_LIMITED', 'UNAVAILABLE', 'BAD_RESPONSE', 'NOT_FOUND'].includes(e?.code) ? e.code : 'UNAVAILABLE';
      throw new ProviderError(code, e?.message ?? `Food lookup failed (${res.status}).`, e?.retryAfterSeconds ?? null);
    }
    return body as T;
  }

  search(query: string, page: number): Promise<ProviderSearchPage> {
    return this.call({ op: 'search', q: query, page: String(page) });
  }

  getFood(sourceFoodId: string): Promise<ProviderFood> {
    return this.call({ op: 'food', id: sourceFoodId });
  }
}
