import type { NutritionEventEnvelope, NutritionEventMap, NutritionEventName } from '../../shared/types/events';
import type { WebhookDispatcher } from '../../services/integration/webhooks';

/** Where server-side domain events go (webhooks, logs, tests). */
export interface EventSink {
  emit<K extends NutritionEventName>(type: K, profileId: string, data: NutritionEventMap[K]): void;
}

export class WebhookEventSink implements EventSink {
  constructor(private readonly dispatcher: WebhookDispatcher) {}
  emit<K extends NutritionEventName>(type: K, profileId: string, data: NutritionEventMap[K]): void {
    const envelope: NutritionEventEnvelope<K> = { type, version: 1, profileId, occurredAt: new Date().toISOString(), data };
    this.dispatcher.dispatch(envelope as NutritionEventEnvelope);
  }
}

export class MemoryEventSink implements EventSink {
  readonly events: Array<{ type: NutritionEventName; profileId: string; data: unknown }> = [];
  emit<K extends NutritionEventName>(type: K, profileId: string, data: NutritionEventMap[K]): void {
    this.events.push({ type, profileId, data });
  }
}
