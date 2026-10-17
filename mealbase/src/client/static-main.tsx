/**
 * Static-site entry: MealBase running entirely in the browser (no Node server).
 * Used when MealBase is published inside RepLens (Netlify, GitHub Pages, any static host).
 *
 * Optional page config before this script:
 *   window.__MEALBASE_STATIC__ = { usdaProxyUrl, workoutUrl, workoutLabel, appLinks }
 */
import { createRoot } from 'react-dom/client';
import { NutritionApp } from '../features/nutrition/NutritionApp';
import { NutritionApiClient } from '../features/nutrition/api/client';
import { LocalBackend } from '../local/backend';
import { BrowserUsdaProvider } from '../local/browser-provider';
import type { AppLink } from '../features/nutrition/app-context';
import '../shared/ui/tokens.css';
import '../shared/ui/components.css';

declare global {
  interface Window {
    __MEALBASE_STATIC__?: { usdaProxyUrl?: string | null; workoutUrl?: string | null; workoutLabel?: string; appLinks?: AppLink[]; sampleFoodsEnabled?: boolean; theme?: 'light' | 'dark' };
  }
}

const cfg = window.__MEALBASE_STATIC__ ?? {};
const proxyUrl = cfg.usdaProxyUrl === undefined ? '/.netlify/functions/usda' : cfg.usdaProxyUrl;
let storage: Storage | null = null;
try { storage = window.localStorage; } catch { storage = null; }
const backend = new LocalBackend({
  provider: new BrowserUsdaProvider({ proxyUrl, storage }),
  workout: { url: cfg.workoutUrl === undefined ? '../' : cfg.workoutUrl, label: cfg.workoutLabel ?? 'RepLens' },
  sampleFoodsEnabled: cfg.sampleFoodsEnabled ?? true,
});
const client = new NutritionApiClient('/api/v1/nutrition', backend.fetch);
const appLinks = cfg.appLinks ?? [{ label: 'RepLens', href: '../' }, { label: 'MealBase', href: './', current: true }];

const el = document.getElementById('mealbase');
if (el) createRoot(el).render(<NutritionApp client={client} routeBase="#" appLinks={appLinks} theme={cfg.theme} />);
