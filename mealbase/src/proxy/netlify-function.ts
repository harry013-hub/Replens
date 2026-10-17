/**
 * Netlify Function (v2) wrapping the USDA proxy. Bundled to
 * `netlify/functions/usda.mjs` in the RepLens repo by `npm run build:replens`.
 * Set USDA_API_KEY in Netlify → Site configuration → Environment variables.
 * Served at /.netlify/functions/usda
 */
import { createUsdaProxy } from './usda-proxy';

let handler: ReturnType<typeof createUsdaProxy> | null = null;

export default async function usda(req: Request): Promise<Response> {
  handler ??= createUsdaProxy({ apiKey: process.env.USDA_API_KEY?.trim() || null, baseUrl: process.env.USDA_API_BASE_URL || undefined });
  return handler(new URL(req.url), req.method);
}
