/**
 * USDA FoodData Central proxy for static deployments.
 *
 * The browser must never see the USDA API key, so static hosting (e.g. RepLens
 * on Netlify) routes food lookups through this small server-side handler. It
 * runs as a Netlify Function (`netlify/functions/usda.mjs`) and inside RepLens's
 * local `npm start` server. It returns already-mapped data, never the raw key.
 *
 *   GET ?op=status                 → { configured, usingDemoKey, attribution }
 *   GET ?op=search&q=banana&page=1 → ProviderSearchPage
 *   GET ?op=food&id=173944         → ProviderFood
 *   errors → { error: { code, message, retryAfterSeconds } } with an HTTP status
 */
import { UsdaFoodProvider } from '../services/food-provider/usda';
import { ProviderError } from '../services/food-provider/types';

export interface ProxyOptions {
  apiKey: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const STATUS: Record<string, number> = { NOT_CONFIGURED: 503, RATE_LIMITED: 429, UNAVAILABLE: 503, BAD_RESPONSE: 502, NOT_FOUND: 404 };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': status === 200 ? 'public, max-age=300' : 'no-store', ...extra },
  });
}

export function createUsdaProxy(opts: ProxyOptions) {
  const provider = new UsdaFoodProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });

  return async function handle(url: URL, method = 'GET'): Promise<Response> {
    if (method !== 'GET') return json({ error: { code: 'VALIDATION_ERROR', message: 'Use GET.' } }, 405);
    const op = url.searchParams.get('op');
    try {
      if (op === 'status') {
        return json({ configured: provider.isConfigured(), usingDemoKey: provider.usingDemoKey, attribution: provider.attribution }, 200, { 'Cache-Control': 'no-store' });
      }
      if (op === 'search') {
        const q = (url.searchParams.get('q') ?? '').trim();
        if (q.length < 2 || q.length > 100) return json({ error: { code: 'VALIDATION_ERROR', message: 'Search text must be 2–100 characters.' } }, 400);
        const page = Math.max(1, Math.min(50, Number(url.searchParams.get('page')) || 1));
        return json(await provider.search(q, page));
      }
      if (op === 'food') {
        const id = url.searchParams.get('id') ?? '';
        if (!/^\d{1,12}$/.test(id)) return json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid food id.' } }, 400);
        return json(await provider.getFood(id));
      }
      return json({ error: { code: 'VALIDATION_ERROR', message: 'Unknown op.' } }, 400);
    } catch (err) {
      if (err instanceof ProviderError) {
        return json({ error: { code: err.code, message: err.message, retryAfterSeconds: err.retryAfterSeconds } }, STATUS[err.code] ?? 503,
          err.retryAfterSeconds ? { 'Retry-After': String(err.retryAfterSeconds) } : {});
      }
      return json({ error: { code: 'UNAVAILABLE', message: 'Food lookup failed. Try again shortly.' } }, 500);
    }
  };
}
