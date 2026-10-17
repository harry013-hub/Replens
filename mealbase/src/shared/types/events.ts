import type { FoodLogEntry } from './nutrition';

/**
 * Integration events. In a shared runtime (same page) they are dispatched on
 * `window` as CustomEvents and through `subscribeNutritionEvents`.
 * Separately deployed apps receive them as signed webhooks instead.
 */
export interface NutritionEventMap {
  'nutrition:food-logged': { entry: FoodLogEntry };
  'nutrition:food-updated': { entry: FoodLogEntry };
  'nutrition:food-deleted': { entryId: string; localDate: string };
  'nutrition:plan-saved': { planId: string; weekStart: string };
}

export type NutritionEventName = keyof NutritionEventMap;

export const NUTRITION_EVENT_NAMES: NutritionEventName[] = [
  'nutrition:food-logged',
  'nutrition:food-updated',
  'nutrition:food-deleted',
  'nutrition:plan-saved',
];

export interface NutritionEventEnvelope<K extends NutritionEventName = NutritionEventName> {
  type: K;
  version: 1;
  /** Opaque MealBase profile id; map it to your own user via identity links. */
  profileId: string;
  occurredAt: string;
  data: NutritionEventMap[K];
}
