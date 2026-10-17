/**
 * Food search for the browser-only build.
 *
 * 1. If the site has the USDA proxy function (Netlify, or RepLens's `npm start`),
 *    use USDA FoodData Central through it — the key stays on the server.
 * 2. Otherwise (GitHub Pages, any plain static host) use Open Food Facts, which
 *    allows websites to call it directly and needs no key.
 *    (USDA's API can't be called straight from a browser page.)
 */
import { OpenFoodFactsProvider, type OffOptions } from '../services/food-provider/openfoodfacts';
import type { FoodProvider, ProviderFood, ProviderSearchPage } from '../services/food-provider/types';
import { RemoteUsdaProvider } from './remote-provider';

export class BrowserFoodProvider implements FoodProvider {
  private readonly proxy: RemoteUsdaProvider | null;
  private readonly off: OpenFoodFactsProvider;
  private active: FoodProvider | null = null;

  constructor(opts: { proxyUrl: string | null; fetchImpl?: typeof fetch; off?: OffOptions }) {
    this.proxy = opts.proxyUrl ? new RemoteUsdaProvider(opts.proxyUrl, opts.fetchImpl) : null;
    this.off = new OpenFoodFactsProvider({ fetchImpl: opts.fetchImpl, ...opts.off });
  }

  /** Decide which database to use (once per page load). */
  async probe(): Promise<FoodProvider> {
    if (this.active) return this.active;
    this.active = this.proxy && (await this.proxy.probe()).configured ? this.proxy : this.off;
    return this.active;
  }

  private get current(): FoodProvider {
    return this.active ?? this.off;
  }

  get id() { return this.current.id; }
  get label() { return this.current.label; }
  get attribution() { return this.current.attribution; }
  get mode(): 'proxy' | 'browser' { return this.current === this.proxy ? 'proxy' : 'browser'; }
  get usingDemoKey() { return this.current === this.proxy ? this.proxy!.usingDemoKey : false; }

  isConfigured(): boolean {
    return true;
  }

  async search(query: string, page: number): Promise<ProviderSearchPage> {
    return (await this.probe()).search(query, page);
  }

  async getFood(sourceFoodId: string): Promise<ProviderFood> {
    return (await this.probe()).getFood(sourceFoodId);
  }
}
