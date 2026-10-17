import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMealBase, loadConfig, signWebhook, verifyWebhook, WebhookDispatcher } from '../src/server/public';
import { emitNutritionEvent, subscribeNutritionEvents } from '../src/services/integration/events';
import { fixtureProvider } from './helpers';

describe('integration points', () => {
  it('accepts a host-app AuthProvider factory and maps identities', async () => {
    const app = createMealBase(
      { ...loadConfig({} as NodeJS.ProcessEnv), databasePath: ':memory:', staticDir: null, apiBasePath: '/nutrition-api' },
      {
        provider: fixtureProvider({ mode: 'ok' }),
        auth: (profiles) => ({
          resolve(req) {
            const id = req.headers['x-host-user'];
            if (typeof id !== 'string') return null;
            return { profileId: profiles.resolveIdentity('workout', id, 'Host user').id, via: 'session' };
          },
        }),
      },
    );
    const server = createServer((req, res) => {
      app.handle(req, res).then((h) => { if (!h) { res.writeHead(418); res.end('host app'); } });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.equal((await fetch(`${base}/somewhere-else`)).status, 418, 'non-MealBase routes fall through to the host');
      assert.equal((await fetch(`${base}/nutrition-api/me`)).status, 401);
      const me1 = await (await fetch(`${base}/nutrition-api/me`, { headers: { 'x-host-user': 'u-1' } })).json();
      const me1b = await (await fetch(`${base}/nutrition-api/me`, { headers: { 'x-host-user': 'u-1' } })).json();
      const me2 = await (await fetch(`${base}/nutrition-api/me`, { headers: { 'x-host-user': 'u-2' } })).json();
      assert.equal(me1.profileId, me1b.profileId);
      assert.notEqual(me1.profileId, me2.profileId);
    } finally {
      await new Promise((r) => server.close(r));
      app.close();
    }
  });

  it('signs webhooks so receivers can verify them', async () => {
    const ts = 1_800_000_000;
    const body = JSON.stringify({ type: 'nutrition:food-logged' });
    const sig = signWebhook('s3cret', ts, body);
    assert.ok(verifyWebhook('s3cret', ts, body, sig, ts + 10));
    assert.ok(!verifyWebhook('s3cret', ts, body + ' ', sig, ts + 10), 'tampered body');
    assert.ok(!verifyWebhook('other', ts, body, sig, ts + 10), 'wrong secret');
    assert.ok(!verifyWebhook('s3cret', ts, body, sig, ts + 3600), 'stale timestamp');

    const received: Array<{ headers: Headers; body: string }> = [];
    const d = new WebhookDispatcher({
      url: 'https://workout.example/hooks', secret: 's3cret', retries: 0,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        received.push({ headers: new Headers(init.headers), body: String(init.body) });
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    const ok = await d.deliver({ type: 'nutrition:plan-saved', version: 1, profileId: 'p', occurredAt: new Date().toISOString(), data: { planId: 'x', weekStart: '2026-10-19' } });
    assert.ok(ok);
    const h = received[0].headers;
    assert.equal(h.get('x-mealbase-event'), 'nutrition:plan-saved');
    assert.ok(verifyWebhook('s3cret', Number(h.get('x-mealbase-timestamp')), received[0].body, h.get('x-mealbase-signature')!));
  });

  it('delivers in-page events to subscribers', () => {
    const seen: string[] = [];
    const off = subscribeNutritionEvents('nutrition:food-deleted', (e) => seen.push(e.data.entryId));
    emitNutritionEvent('nutrition:food-deleted', 'p1', { entryId: 'e1', localDate: '2026-10-17' });
    off();
    emitNutritionEvent('nutrition:food-deleted', 'p1', { entryId: 'e2', localDate: '2026-10-17' });
    assert.deepEqual(seen, ['e1']);
  });
});
