/**
 * Builds the MealBase server. Use `createMealBase(config)` and either
 *  - `listen()` for standalone deployment, or
 *  - `handle(req, res)` to mount it inside another Node HTTP server
 *    (returns false when the request is not for MealBase).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { openDatabase, migrate, type Db } from '../database/connection';
import { isSeeded, seedDatabase } from '../database/seed';
import { PreferencesRepository, ProfileRepository } from '../database/repositories/profiles';
import { UsdaFoodProvider } from '../services/food-provider/usda';
import type { FoodProvider } from '../services/food-provider/types';
import { WebhookDispatcher } from '../services/integration/webhooks';
import {
  AttemptLimiter, CompositeAuthProvider, LocalAuthProvider, ServiceTokenProvider, SessionAuthProvider, type AuthProvider,
} from './auth/auth';
import type { ServerConfig } from './config';
import { isLoopback } from './config';
import { HttpError, parseCookies, readJsonBody, sendError, sendJson, type HandlerResult, type RequestContext } from './http/router';
import { buildRouter } from './routes';
import { NutritionService } from './services/nutrition-service';
import { PlanningService } from './services/planning-service';
import { DataService } from './services/data-service';
import { WebhookEventSink, type EventSink } from './services/events';

export interface MealBaseOptions {
  /** Override the food provider (tests, or a different provider). */
  provider?: FoodProvider & { usingDemoKey?: boolean };
  /** Override the event sink (tests). */
  events?: EventSink;
  /**
   * Replace authentication entirely (e.g. verify your workout app's JWT).
   * Pass a factory to receive the ProfileRepository for identity mapping.
   */
  auth?: AuthProvider | ((profiles: ProfileRepository) => AuthProvider);
  /** Use an existing database connection. */
  db?: Db;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

export function createMealBase(config: ServerConfig, opts: MealBaseOptions = {}) {
  if (config.authMode === 'local' && !isLoopback(config.host) && !config.allowPublicSingleUser) {
    throw new Error(
      'AUTH_MODE=local is a single-user demo and would share one food log with everyone who can reach this server. ' +
        'Use AUTH_MODE=accounts for a public deployment, or set ALLOW_PUBLIC_SINGLE_USER=true if this host is private to you.',
    );
  }

  const db = opts.db ?? openDatabase(config.databasePath);
  migrate(db);
  if (config.autoSeed && !isSeeded(db)) seedDatabase(db);

  const profiles = new ProfileRepository(db);
  const prefs = new PreferencesRepository(db);
  const provider = opts.provider ?? new UsdaFoodProvider({ apiKey: config.usdaApiKey, baseUrl: config.usdaBaseUrl });
  const events = opts.events ?? new WebhookEventSink(new WebhookDispatcher({ url: config.integrationWebhookUrl, secret: config.integrationWebhookSecret }));

  const nutrition = new NutritionService(db, provider, events, { sampleFoodsEnabled: config.sampleFoodsEnabled });
  const planning = new PlanningService(db, profiles, prefs, events);
  const data = new DataService(db, profiles, prefs, planning);

  const sessions = config.authMode === 'accounts' ? new SessionAuthProvider(profiles, config.sessionTtlHours) : null;
  const providers: AuthProvider[] = [];
  if (config.integrationServiceToken) providers.push(new ServiceTokenProvider(config.integrationServiceToken, profiles));
  if (sessions) providers.push(sessions);
  else providers.push(new LocalAuthProvider(profiles));
  const auth = typeof opts.auth === 'function' ? opts.auth(profiles) : opts.auth ?? new CompositeAuthProvider(providers);

  const router = buildRouter({ config, profiles, prefs, nutrition, planning, data, provider, sessions, loginLimiter: new AttemptLimiter() });
  const apiBase = config.apiBasePath;
  const appBase = config.appBasePath === '/' ? '' : config.appBasePath;
  const staticDir = config.staticDir ? resolve(config.staticDir) : null;

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const cookies: string[] = [];
    try {
      const matched = router.match(method, path || '/');
      if (matched === null) throw new HttpError(404, 'NOT_FOUND', 'No such API route.');
      if (matched === 'method-not-allowed') throw new HttpError(405, 'NOT_FOUND', 'Method not allowed.');

      const authCtx = auth.resolve(req);
      if (method !== 'GET' && method !== 'HEAD' && authCtx?.via !== 'service' && !req.headers['x-mealbase-client']) {
        // Custom header forces a CORS preflight, which blocks cross-site form/fetch attacks.
        throw new HttpError(403, 'FORBIDDEN', 'Missing X-MealBase-Client header.');
      }
      if (matched.route.requiresAuth && !authCtx) throw new HttpError(401, 'AUTH_REQUIRED', 'Please sign in.');

      const body = method === 'GET' || method === 'HEAD' ? undefined : await readJsonBody(req);
      const ctx: RequestContext = {
        req, res, method, path, params: matched.params, query: url.searchParams, body,
        cookies: parseCookies(req.headers.cookie), auth: authCtx, setCookie: (c) => cookies.push(c),
      };
      const handler = matched.route.handler as (c: RequestContext) => HandlerResult | Promise<HandlerResult>;
      const result = await handler(ctx);
      const headers: Record<string, string> = { ...(result.headers ?? {}) };
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      if (result.raw) {
        res.writeHead(result.status ?? 200, {
          'Content-Type': result.raw.contentType,
          'Cache-Control': 'no-store',
          ...(result.raw.filename ? { 'Content-Disposition': `attachment; filename="${result.raw.filename}"` } : {}),
          ...headers,
        });
        res.end(result.raw.data);
        return;
      }
      if (result.status === 204) {
        res.writeHead(204, headers);
        res.end();
        return;
      }
      sendJson(res, result.status ?? 200, result.body, headers);
    } catch (err) {
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      if (err instanceof HttpError) return sendError(res, err);
      const code = (err as { code?: string })?.code;
      if (typeof code === 'string' && code.startsWith('ERR_SQLITE')) {
        console.error('[mealbase] database error', err);
        return sendError(res, new HttpError(503, 'STORAGE_ERROR', 'The database is unavailable, so nothing was saved. Try again shortly.'));
      }
      console.error('[mealbase] unexpected error', err);
      sendError(res, new HttpError(500, 'INTERNAL_ERROR', 'Something went wrong. Nothing was saved.'));
    }
  }

  function serveStatic(res: ServerResponse, subPath: string): boolean {
    if (!staticDir) return false;
    const safe = normalize(subPath).replace(/^([/\\])+/, '');
    let file = join(staticDir, safe);
    if (!file.startsWith(staticDir)) return false;
    const isAsset = extname(safe) !== '';
    if (!isAsset || !existsSync(file) || !statSync(file).isFile()) {
      if (isAsset) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return true;
      }
      file = join(staticDir, 'index.html'); // SPA fallback
      if (!existsSync(file)) return false;
      const html = readFileSync(file, 'utf8').replace(
        '<!--MEALBASE_CONFIG-->',
        `<script>window.__MEALBASE__=${JSON.stringify({ apiBaseUrl: apiBase, routeBase: appBase || '/' })}</script>`,
      ).replaceAll('%BASE%', appBase);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(html);
      return true;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': /\.[0-9a-z]{8,}\./i.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(readFileSync(file));
    return true;
  }

  /** Returns true when the request was handled by MealBase. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    if (pathname === apiBase || pathname.startsWith(apiBase + '/')) {
      await handleApi(req, res, pathname.slice(apiBase.length), url);
      return true;
    }
    if (staticDir && (appBase === '' || pathname === appBase || pathname.startsWith(appBase + '/'))) {
      return serveStatic(res, pathname.slice(appBase.length) || '/');
    }
    return false;
  }

  function listen(): Promise<Server> {
    const server = createServer((req, res) => {
      handle(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        }
      });
    });
    return new Promise((resolvePromise, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(err.code === 'EADDRINUSE' ? new Error(`Port ${config.port} is already in use. Stop the other process or set PORT to a different number.`) : err);
      });
      server.listen(config.port, config.host, () => resolvePromise(server));
    });
  }

  return { db, handle, listen, services: { nutrition, planning, data, profiles, prefs }, close: () => db.close() };
}

export type MealBase = ReturnType<typeof createMealBase>;
