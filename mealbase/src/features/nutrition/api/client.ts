/**
 * Typed browser client for the MealBase API. UI components never call fetch
 * directly; they go through this class. Successful mutations also emit
 * in-page integration events (shared-runtime only).
 */
import type {
  ApiErrorBody, ApiErrorCode, ClientConfig, CreateLogEntryRequest, CreateManualFoodRequest, FoodSearchResponse,
  GeneratePlanRequest, HistoryDay, LogPlanItemRequest, LogPlanItemResponse, Me, UpdateLogEntryRequest, UpdatePlanItemRequest,
  UserPreferences,
} from '../../../shared/types/api';
import type { DailySummary, Food, FoodLogEntry, ServingOption } from '../../../shared/types/nutrition';
import type { GroceryLine, MealPlan, Recipe } from '../../../shared/types/planning';
import { emitNutritionEvent } from '../../../services/integration/events';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: ApiErrorCode | 'NETWORK_ERROR', message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
  get isAuth() {
    return this.code === 'AUTH_REQUIRED' || this.code === 'SESSION_EXPIRED';
  }
}

export interface PlanSummary { id: string; weekStart: string; weekEnd: string; status: MealPlan['status']; updatedAt: string }

export interface RecipeEditorInput {
  name: string;
  description?: string | null;
  mealTypes: Array<'breakfast' | 'lunch' | 'dinner'>;
  prepMinutes: number;
  budgetLevel: 'low' | 'medium' | 'high';
  servings: number;
  instructions: string[];
  ingredients: Array<{ name: string; quantity: number | null; unit: string; foodId: string | null; allergens?: string[] }>;
}

export class NutritionApiClient {
  /** Called on 401 so the app can show the sign-in screen. */
  onAuthError: ((err: ApiError) => void) | null = null;
  private profileId: string | null = null;

  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  setProfileId(id: string | null) {
    this.profileId = id;
  }

  url(path: string): string {
    return this.baseUrl.replace(/\/+$/, '') + path;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(method !== 'GET' ? { 'X-MealBase-Client': '1' } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach MealBase. Check your connection and try again.');
    }
    if (res.status === 204) return undefined as T;
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      if (!res.ok) throw new ApiError(res.status, 'INTERNAL_ERROR', `The server returned an error (${res.status}).`);
    }
    if (!res.ok) {
      const e = (data as ApiErrorBody | null)?.error;
      const err = new ApiError(res.status, e?.code ?? 'INTERNAL_ERROR', e?.message ?? `Request failed (${res.status}).`, e?.details);
      if (err.isAuth) this.onAuthError?.(err);
      throw err;
    }
    return data as T;
  }

  // auth & profile
  config() { return this.request<ClientConfig>('GET', '/config'); }
  me() { return this.request<Me>('GET', '/me'); }
  updateMe(patch: { displayName?: string; timezone?: string }) { return this.request<Me>('PATCH', '/me', patch); }
  login(email: string, password: string) { return this.request<{ profileId: string }>('POST', '/auth/login', { email, password }); }
  register(email: string, password: string, timezone: string) { return this.request<{ profileId: string }>('POST', '/auth/register', { email, password, timezone }); }
  logout() { return this.request<void>('POST', '/auth/logout', {}); }
  preferences() { return this.request<UserPreferences>('GET', '/preferences'); }
  savePreferences(p: Omit<UserPreferences, 'updatedAt'>) { return this.request<UserPreferences>('PUT', '/preferences', p); }

  // log
  summary(date: string) { return this.request<DailySummary>('GET', `/summary?date=${encodeURIComponent(date)}`); }
  logs(from: string, to: string) { return this.request<{ entries: FoodLogEntry[] }>('GET', `/logs?from=${from}&to=${to}`).then((r) => r.entries); }
  history(from: string, to: string) { return this.request<{ days: HistoryDay[] }>('GET', `/history?from=${from}&to=${to}`).then((r) => r.days); }

  async createLog(req: CreateLogEntryRequest) {
    const r = await this.request<{ entry: FoodLogEntry; duplicate: boolean }>('POST', '/logs', req);
    if (!r.duplicate) this.emit('nutrition:food-logged', { entry: r.entry });
    return r;
  }
  async updateLog(id: string, patch: UpdateLogEntryRequest) {
    const r = await this.request<{ entry: FoodLogEntry }>('PATCH', `/logs/${encodeURIComponent(id)}`, patch);
    this.emit('nutrition:food-updated', { entry: r.entry });
    return r.entry;
  }
  async deleteLog(entry: Pick<FoodLogEntry, 'id' | 'localDate'>) {
    await this.request<void>('DELETE', `/logs/${encodeURIComponent(entry.id)}`);
    this.emit('nutrition:food-deleted', { entryId: entry.id, localDate: entry.localDate });
  }

  // foods
  searchFoods(q: string, page = 1) { return this.request<FoodSearchResponse>('GET', `/foods/search?q=${encodeURIComponent(q)}&page=${page}`); }
  recentFoods() { return this.request<{ foods: Food[] }>('GET', '/foods/recent').then((r) => r.foods); }
  food(ref: string) { return this.request<{ food: Food }>('GET', `/foods/${encodeURIComponent(ref)}`).then((r) => r.food); }
  createManualFood(req: CreateManualFoodRequest) { return this.request<{ food: Food }>('POST', '/foods', req).then((r) => r.food); }
  addServing(foodId: string, label: string, refAmount: number) {
    return this.request<{ serving: ServingOption }>('POST', `/foods/${encodeURIComponent(foodId)}/servings`, { label, refAmount }).then((r) => r.serving);
  }

  // recipes
  recipes() { return this.request<{ recipes: Recipe[] }>('GET', '/recipes').then((r) => r.recipes); }
  createRecipe(input: RecipeEditorInput) { return this.request<{ recipe: Recipe }>('POST', '/recipes', input).then((r) => r.recipe); }
  updateRecipe(id: string, input: RecipeEditorInput) { return this.request<{ recipe: Recipe }>('PUT', `/recipes/${id}`, input).then((r) => r.recipe); }
  deleteRecipe(id: string) { return this.request<void>('DELETE', `/recipes/${id}`); }

  // plans
  plans() { return this.request<{ plans: PlanSummary[] }>('GET', '/plans').then((r) => r.plans); }
  plan(id: string) { return this.request<{ plan: MealPlan }>('GET', `/plans/${id}`).then((r) => r.plan); }
  generatePlan(req: GeneratePlanRequest) { return this.request<{ plan: MealPlan }>('POST', '/plans', req).then((r) => r.plan); }
  deletePlan(id: string) { return this.request<void>('DELETE', `/plans/${id}`); }
  regenerate(id: string, scope: 'week' | 'day', date?: string) { return this.request<{ plan: MealPlan }>('POST', `/plans/${id}/regenerate`, { scope, date }).then((r) => r.plan); }
  async savePlan(id: string, overwrite = false) {
    const plan = await this.request<{ plan: MealPlan }>('POST', `/plans/${id}/save`, { overwrite }).then((r) => r.plan);
    this.emit('nutrition:plan-saved', { planId: plan.id, weekStart: plan.weekStart });
    return plan;
  }
  groceryList(id: string) { return this.request<{ people: number; lines: GroceryLine[] }>('GET', `/plans/${id}/grocery-list`); }
  updatePlanItem(id: string, patch: UpdatePlanItemRequest) { return this.request<{ plan: MealPlan }>('PATCH', `/plan-items/${id}`, patch).then((r) => r.plan); }
  replacePlanItem(id: string) { return this.request<{ plan: MealPlan }>('POST', `/plan-items/${id}/replace`, {}).then((r) => r.plan); }
  async logPlanItem(id: string, req: LogPlanItemRequest) {
    const r = await this.request<LogPlanItemResponse>('POST', `/plan-items/${id}/log`, req);
    if (!r.duplicate) this.emit('nutrition:food-logged', { entry: r.entry });
    return r;
  }

  // data
  /** Fetch an export and hand it to the browser as a download. Works with the server and the in-browser backend. */
  async download(path: string, fallbackName: string) {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), { credentials: 'include', headers: { Accept: '*/*' } });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach MealBase. Check your connection and try again.');
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => null) as ApiErrorBody | null)?.error;
      throw new ApiError(res.status, e?.code ?? 'INTERNAL_ERROR', e?.message ?? `Export failed (${res.status}).`);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  downloadLogsCsv(from: string, to: string) { return this.download(`/export/logs.csv?from=${from}&to=${to}`, `mealbase-food-log-${from}-to-${to}.csv`); }
  downloadPlansJson() { return this.download('/export/plans.json', 'mealbase-plans.json'); }
  importPlans(data: unknown, includePreferences: boolean) {
    return this.request<{ plans: number; preferences: boolean }>('POST', `/import/plans?includePreferences=${includePreferences}`, data);
  }
  deleteHistory() { return this.request<{ deletedEntries: number }>('DELETE', '/data/history', { confirm: 'DELETE' }); }
  deleteAllData() { return this.request<void>('DELETE', '/data/all', { confirm: 'DELETE' }); }

  private emit<K extends Parameters<typeof emitNutritionEvent>[0]>(type: K, data: Parameters<typeof emitNutritionEvent<K>>[2]) {
    emitNutritionEvent(type, this.profileId ?? 'unknown', data);
  }
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
