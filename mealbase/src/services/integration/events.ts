/**
 * In-page integration events for a SHARED RUNTIME (the nutrition UI and the
 * workout UI loaded in the same page). They do not cross browser tabs, devices
 * or separately hosted apps — use the signed webhooks for that.
 */
import type { NutritionEventEnvelope, NutritionEventMap, NutritionEventName } from '../../shared/types/events';

type Listener<K extends NutritionEventName> = (event: NutritionEventEnvelope<K>) => void;

const listeners = new Map<NutritionEventName, Set<Listener<any>>>();

export function emitNutritionEvent<K extends NutritionEventName>(
  type: K,
  profileId: string,
  data: NutritionEventMap[K],
): NutritionEventEnvelope<K> {
  const envelope: NutritionEventEnvelope<K> = { type, version: 1, profileId, occurredAt: new Date().toISOString(), data };
  for (const l of listeners.get(type) ?? []) {
    try {
      l(envelope);
    } catch (err) {
      console.error(`[mealbase] listener for ${type} failed`, err);
    }
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(type, { detail: envelope }));
  }
  return envelope;
}

/** Subscribe to a nutrition event. Returns an unsubscribe function. */
export function subscribeNutritionEvents<K extends NutritionEventName>(type: K, listener: Listener<K>): () => void {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(listener);
  return () => listeners.get(type)?.delete(listener);
}
