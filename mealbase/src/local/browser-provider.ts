/**
 * Food search for the browser-only build.
 *
 * 1. If the site has the USDA proxy function (Netlify, or RepLens's `npm start`),
 *    use it — the key stays on the server.
 * 2. Otherwise (GitHub Pages, any plain static host) call USDA FoodData Central
 *    directly from the browser with either the user's own key, saved only on this
 *    device, or USDA's public DEMO_KEY (about 30 requests/hour per network).
 *    No key is ever written into the site's files.
 */
import { UsdaFoodProvider, USDA_ATTRIBUTION } from '../services/food-provider/usda';
import { ProviderError, type FoodProvider, type ProviderFood, type ProviderSearchPage } from '../services/food-provider/types';
import { RemoteUsdaProvider } from './remote-provider';
import type { StorageLike } from './backend';

export const DEVICE_KEY_STORAGE = 'mealbase.usdaKey';

export type FoodSearchMode = 'proxy' | 'direct';

export class BrowserUsdaProvider implements FoodProvider {
  readonly id = 'usda' as const;
  readonly label = 'USDA FoodData Central';
  readonly attribution = USDA_ATTRIBUTION;
  private proxy: RemoteUsdaProvider | null;
  private resolved: FoodSearchMode | null = null;
  private direct: UsdaFoodProvider | null = null;

  constructor(private readonly opts: {
    proxyUrl: string | null;
    storage: StorageLike | null;
    fetchImpl?: typeof fetch;
    usdaBaseUrl?: string;
  }) {
    this.proxy = opts.proxyUrl ? new RemoteUsdaProvider(opts.proxyUrl, opts.fetchImpl) : null;
  }

  /** The user's own key saved on this device, if any. */
  deviceKey(): string | null {
    try { return this.opts.storage?.getItem(DEVICE_KEY_STORAGE)?.trim() || null; } catch { return null; }
  }

  setDeviceKey(key: string | null): void {
    const k = key?.trim() || null;
    if (k) this.opts.storage?.setItem(DEVICE_KEY_STORAGE, k);
    else this.opts.storage?.removeItem(DEVICE_KEY_STORAGE);
    this.direct = null;
  }

  async probe(): Promise<FoodSearchMode> {
    if (this.resolved) return this.resolved;
    if (this.proxy && (await this.proxy.probe()).configured) this.resolved = 'proxy';
    else this.resolved = 'direct';
    return this.resolved;
  }

  get mode(): FoodSearchMode | null {
    return this.resolved;
  }

  isConfigured(): boolean {
    return this.resolved !== null;
  }

  get usingDemoKey(): boolean {
    if (this.resolved === 'proxy') return this.proxy?.usingDemoKey ?? false;
    return !this.deviceKey();
  }

  private directProvider(): UsdaFoodProvider {
    this.direct ??= new UsdaFoodProvider({ apiKey: this.deviceKey() ?? 'DEMO_KEY', baseUrl: this.opts.usdaBaseUrl, fetchImpl: this.opts.fetchImpl });
    return this.direct;
  }

  private async run<T>(fn: (p: FoodProvider) => Promise<T>): Promise<T> {
    const mode = await this.probe();
    if (mode === 'proxy') return fn(this.proxy!);
    try {
      return await fn(this.directProvider());
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'RATE_LIMITED' && this.usingDemoKey) {
        throw new ProviderError('RATE_LIMITED', 'The shared demo key’s hourly limit was reached. Add your own free USDA key in Settings, or add the food manually.', err.retryAfterSeconds);
      }
      if (err instanceof ProviderError && err.code === 'NOT_CONFIGURED' && !this.usingDemoKey) {
        throw new ProviderError('NOT_CONFIGURED', 'USDA rejected the key saved in Settings. Check it, or remove it to use the demo key.');
      }
      throw err;
    }
  }

  search(query: string, page: number): Promise<ProviderSearchPage> {
    return this.run((p) => p.search(query, page));
  }

  getFood(sourceFoodId: string): Promise<ProviderFood> {
    return this.run((p) => p.getFood(sourceFoodId));
  }
}
