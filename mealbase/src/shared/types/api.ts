import type { Food, FoodLogEntry, MealType, NutrientValues, PlannedMealType, ReferenceUnit } from './nutrition';
import type { PlannerPreferences } from './planning';

/** Every error response has this shape. `code` is stable; `message` is user-readable. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

export type ApiErrorCode =
  | 'AUTH_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'INVALID_PORTION'
  | 'UNIT_CONVERSION_UNAVAILABLE'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_BAD_RESPONSE'
  | 'PLAN_CONFLICT'
  | 'PLAN_EXISTS'
  | 'ALREADY_LOGGED'
  | 'STORAGE_ERROR'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export interface ClientConfig {
  apiVersion: 'v1';
  authMode: 'local' | 'accounts';
  foodProvider: {
    id: 'usda';
    configured: boolean;
    usingDemoKey: boolean;
    attribution: string;
    /** server = Node server holds the key; proxy = site function holds it; direct = browser calls USDA with the user's own key or DEMO_KEY. */
    mode?: 'server' | 'proxy' | 'direct';
    /** direct mode: the user saved their own key on this device. */
    deviceKeySet?: boolean;
  };
  sampleFoodsEnabled: boolean;
  workout: { configured: boolean; url: string | null; label: string };
  /** Where data is kept: on the server, in this browser, or only in memory (lost on close). */
  persistence?: 'server' | 'device' | 'memory';
}

export interface Me {
  profileId: string;
  displayName: string;
  email: string | null;
  timezone: string;
  authMode: 'local' | 'accounts';
}

export interface UserPreferences {
  /** Optional daily calorie target the user chose (e.g. from a professional). */
  dailyCalorieTarget: number | null;
  /** The user confirmed they are 18 or older. Required for target-based planning. */
  adultConfirmed: boolean;
  timezone: string;
  planner: PlannerPreferences;
  updatedAt: string | null;
}

export interface FoodSearchResult {
  /** Use with GET /foods/:ref. Format `usda:<fdcId>` or a local food id. */
  ref: string;
  name: string;
  brand: string | null;
  source: 'usda' | 'manual' | 'sample';
  sourceLabel: string;
  dataType: string | null;
  /** Preview values for the stated reference, when the provider included them. */
  preview: { quantity: number; unit: ReferenceUnit; values: NutrientValues } | null;
  isSample: boolean;
}

export interface FoodSearchResponse {
  query: string;
  page: number;
  totalPages: number | null;
  provider: {
    id: 'usda';
    status: 'ok' | 'not_configured' | 'rate_limited' | 'unavailable' | 'error';
    message: string | null;
    attribution: string;
  };
  /** Live provider results. */
  results: FoodSearchResult[];
  /** The user's own manual foods matching the query. */
  mine: FoodSearchResult[];
  /** Development sample data, kept separate from real results. Empty unless enabled. */
  sample: FoodSearchResult[];
}

export interface CreateLogEntryRequest {
  localDate: string;
  mealType: MealType;
  /** Log a stored food… */
  foodId?: string;
  quantity?: number;
  unit?: string;
  /** …or a quick entry with values you know. */
  quick?: {
    name: string;
    calories: number | null;
    proteinG?: number | null;
    carbsG?: number | null;
    fatG?: number | null;
  };
  displayName?: string;
  /** Client-generated key; retries with the same key never create duplicates. */
  idempotencyKey?: string;
}

export interface UpdateLogEntryRequest {
  localDate?: string;
  mealType?: MealType;
  quantity?: number;
  unit?: string;
  displayName?: string;
}

export interface CreateManualFoodRequest {
  name: string;
  brand?: string | null;
  referenceQuantity: number;
  referenceUnit: ReferenceUnit;
  unitLabel?: string | null;
  calories: number | null;
  proteinG?: number | null;
  carbsG?: number | null;
  fatG?: number | null;
}

export interface GeneratePlanRequest {
  weekStart?: string;
  preferences?: Partial<PlannerPreferences>;
  seed?: number;
}

export interface UpdatePlanItemRequest {
  servings?: number;
  locked?: boolean;
  notes?: string | null;
  /** Replace with a specific recipe. */
  recipeId?: string;
  /** Replace with a custom meal entered by the user. */
  custom?: {
    name: string;
    calories: number | null;
    proteinG?: number | null;
    carbsG?: number | null;
    fatG?: number | null;
    ingredients?: string[];
    instructions?: string[];
  };
}

export interface LogPlanItemRequest {
  /** Servings actually eaten (planned servings is the default in the UI). */
  servingsEaten: number;
  localDate: string;
  mealType: MealType;
  idempotencyKey: string;
  /** Set true to intentionally log the same planned meal again. */
  allowRepeat?: boolean;
}

export interface LogPlanItemResponse {
  entry: FoodLogEntry;
  duplicate: boolean;
}

export interface HistoryDay {
  localDate: string;
  entryCount: number;
  nutrition: NutrientValues;
  missingCalories: number;
}

export type { Food, PlannedMealType };
