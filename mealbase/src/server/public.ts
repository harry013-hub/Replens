/**
 * MealBase nutrition module — public server API (Node ≥ 22.13).
 *
 *   import { createMealBase, loadConfig } from 'mealbase/server';
 *   const nutrition = createMealBase({ ...loadConfig(), apiBasePath: '/api/v1/nutrition', staticDir: null });
 *   http.createServer(async (req, res) => { if (await nutrition.handle(req, res)) return; host(req, res); });
 *
 * Replace authentication by passing `{ auth }` — any object implementing AuthProvider.
 */
export { createMealBase, type MealBase, type MealBaseOptions } from './app';
export { loadConfig, type ServerConfig } from './config';
export {
  type AuthProvider, LocalAuthProvider, SessionAuthProvider, ServiceTokenProvider, CompositeAuthProvider,
} from './auth/auth';
export type { AuthContext } from './http/router';
export { HttpError } from './http/router';
export { signWebhook, verifyWebhook, WebhookDispatcher } from '../services/integration/webhooks';
export { UsdaFoodProvider, USDA_ATTRIBUTION } from '../services/food-provider/usda';
export type { FoodProvider, ProviderFood, ProviderSearchPage } from '../services/food-provider/types';
export { ProviderError } from '../services/food-provider/types';
export type { EventSink } from './services/events';
export { openDatabase, migrate } from '../database/connection';
export { seedDatabase } from '../database/seed';
