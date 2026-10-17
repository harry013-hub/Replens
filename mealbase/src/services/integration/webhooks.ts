/**
 * Server-side outbound webhooks for a SEPARATELY DEPLOYED workout app.
 *
 * Each POST carries the event envelope as JSON and these headers:
 *   X-MealBase-Event:     event name
 *   X-MealBase-Timestamp: unix seconds
 *   X-MealBase-Signature: v1=<hex HMAC-SHA256 of `${timestamp}.${rawBody}` using INTEGRATION_WEBHOOK_SECRET>
 *
 * Receivers must verify the signature and reject timestamps older than ~5 minutes.
 * Delivery is best-effort (a few retries, no persistent queue) — see docs/INTEGRATION.md.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NutritionEventEnvelope } from '../../shared/types/events';

export interface WebhookConfig {
  url: string | null;
  secret: string | null;
  fetchImpl?: typeof fetch;
  retries?: number;
}

export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifyWebhook(secret: string, timestamp: number, rawBody: string, signature: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): boolean {
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class WebhookDispatcher {
  constructor(private readonly config: WebhookConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.url && this.config.secret);
  }

  /** Fire-and-forget. Never throws into request handling. */
  dispatch(envelope: NutritionEventEnvelope): void {
    if (!this.enabled) return;
    void this.deliver(envelope).catch((err) => console.error('[mealbase] webhook delivery failed', err));
  }

  async deliver(envelope: NutritionEventEnvelope): Promise<boolean> {
    if (!this.enabled) return false;
    const body = JSON.stringify(envelope);
    const f = this.config.fetchImpl ?? fetch;
    const attempts = (this.config.retries ?? 2) + 1;
    for (let i = 0; i < attempts; i++) {
      const ts = Math.floor(Date.now() / 1000);
      try {
        const res = await f(this.config.url!, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-MealBase-Event': envelope.type,
            'X-MealBase-Timestamp': String(ts),
            'X-MealBase-Signature': signWebhook(this.config.secret!, ts, body),
          },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return true;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) return false;
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
    return false;
  }
}
