/** Standalone browser entry. The server injects window.__MEALBASE__ with runtime paths. */
import { createRoot } from 'react-dom/client';
import { NutritionApp } from '../features/nutrition/NutritionApp';
import '../shared/ui/tokens.css';
import '../shared/ui/components.css';

declare global {
  interface Window {
    __MEALBASE__?: { apiBaseUrl?: string; routeBase?: string };
  }
}

const cfg = window.__MEALBASE__ ?? {};
const el = document.getElementById('mealbase');
if (el) {
  createRoot(el).render(<NutritionApp apiBaseUrl={cfg.apiBaseUrl ?? '/api/v1/nutrition'} routeBase={cfg.routeBase ?? '/'} />);
}
