import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createMealBase } from '../src/server/app';
import { loadConfig, type ServerConfig } from '../src/server/config';
import { MemoryEventSink } from '../src/server/services/events';
import { UsdaFoodProvider } from '../src/services/food-provider/usda';

export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** A USDA provider whose network is replaced by fixtures. `mode` can be switched mid-test. */
export function fixtureProvider(state: { mode: 'ok' | '429' | '500' | 'down' }, apiKey: string | null = 'test-key') {
  return new UsdaFoodProvider({
    apiKey,
    searchCacheMs: 0,
    detailCacheMs: 0,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (state.mode === 'down') throw new TypeError('fetch failed');
      if (state.mode === '429') return new Response('{}', { status: 429, headers: { 'Retry-After': '3600' } });
      if (state.mode === '500') return new Response('{}', { status: 500 });
      if (url.pathname.endsWith('/foods/search')) {
        const q = url.searchParams.get('query') ?? '';
        const body = q.includes('banana') ? fixture('usda-search-banana.json') : JSON.stringify({ totalHits: 0, currentPage: 1, totalPages: 0, foods: [] });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const m = url.pathname.match(/\/food\/(\d+)$/);
      if (m && ['173944', '2099999'].includes(m[1])) return new Response(fixture(`usda-food-${m[1]}.json`), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch,
  });
}

export interface TestApp {
  url: string;
  server: Server;
  events: MemoryEventSink;
  providerState: { mode: 'ok' | '429' | '500' | 'down' };
  app: ReturnType<typeof createMealBase>;
  close: () => Promise<void>;
}

export async function startTestApp(overrides: Partial<ServerConfig> = {}, opts: { apiKey?: string | null } = {}): Promise<TestApp> {
  const config = { ...loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), databasePath: ':memory:', staticDir: null, ...overrides };
  const events = new MemoryEventSink();
  const providerState: TestApp['providerState'] = { mode: 'ok' };
  const app = createMealBase(config, { provider: fixtureProvider(providerState, opts.apiKey === undefined ? 'test-key' : opts.apiKey), events });
  const server = createServer((req, res) => {
    app.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${config.apiBasePath}`,
    server, events, providerState, app,
    close: () => new Promise((r) => server.close(() => { app.close(); r(); })),
  };
}

/** Tiny API client with a cookie jar, mimicking the browser client headers. */
export class Client {
  cookie = '';
  constructor(private readonly base: string, private readonly extraHeaders: Record<string, string> = {}) {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(method !== 'GET' ? { 'X-MealBase-Client': '1' } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...this.extraHeaders,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const [pair] = c.split(';');
      const [name, value] = pair.split('=');
      if (name === 'mealbase_session') this.cookie = value ? `${name}=${value}` : '';
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  get(path: string) { return this.req('GET', path); }
  post(path: string, body: unknown = {}) { return this.req('POST', path, body); }
  patch(path: string, body: unknown) { return this.req('PATCH', path, body); }
  put(path: string, body: unknown) { return this.req('PUT', path, body); }
  del(path: string, body?: unknown) { return this.req('DELETE', path, body); }
}
