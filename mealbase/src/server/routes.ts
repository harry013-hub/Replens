/**
 * Versioned REST API (mounted at API_BASE_PATH, default /api/v1/nutrition).
 * The current user always comes from AuthContext — never from the request body or query.
 */
import type { ClientConfig, Me } from '../shared/types/api';
import { addDays, isLocalDate, todayInTimeZone } from '../shared/lib/dates';
import { HttpError, Router, type RequestContext } from './http/router';
import {
  createLogSchema, generatePlanSchema, logPlanItemSchema, loginSchema, manualFoodSchema, parse, preferencesSchema,
  profileSchema, recipeSchema, regenerateSchema, registerSchema, servingSchema, updateLogSchema, updatePlanItemSchema,
} from './validation';
import { hashPassword, hashToken, SESSION_COOKIE, verifyPassword, type AttemptLimiter, type SessionAuthProvider } from './auth/auth';
import type { ServerConfig } from './config';
import type { NutritionService } from './services/nutrition-service';
import type { PlanningService } from './services/planning-service';
import type { DataService } from './services/data-service';
import type { PreferencesRepository, ProfileRepository } from '../database/repositories/profiles';
import type { FoodProvider } from '../services/food-provider/types';

export interface RouteDeps {
  config: ServerConfig;
  profiles: ProfileRepository;
  prefs: PreferencesRepository;
  nutrition: NutritionService;
  planning: PlanningService;
  data: DataService;
  provider: FoodProvider & { usingDemoKey?: boolean };
  sessions: SessionAuthProvider | null;
  loginLimiter: AttemptLimiter;
}

function q(ctx: RequestContext, name: string): string | null {
  const v = ctx.query.get(name);
  return v === null ? null : v.trim();
}

function dateParam(ctx: RequestContext, name: string, fallback?: string): string {
  const v = q(ctx, name) ?? fallback;
  if (!v || !isLocalDate(v)) throw new HttpError(400, 'VALIDATION_ERROR', `Query parameter "${name}" must be a date (YYYY-MM-DD).`);
  return v;
}

function sessionCookie(config: ServerConfig, value: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    config.secureCookies ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export function buildRouter(d: RouteDeps): Router {
  const r = new Router();
  const { config } = d;

  const profileTz = (profileId: string) => d.profiles.get(profileId)?.timezone ?? 'UTC';

  // ---------- public ----------
  r.add('GET', '/health', () => ({ body: { ok: true } }), { public: true });

  r.add('GET', '/config', () => {
    const body: ClientConfig = {
      apiVersion: 'v1',
      authMode: config.authMode,
      foodProvider: {
        id: 'usda',
        configured: d.provider.isConfigured(),
        usingDemoKey: Boolean(d.provider.usingDemoKey),
        attribution: d.provider.attribution,
      },
      sampleFoodsEnabled: config.sampleFoodsEnabled,
      workout: { configured: Boolean(config.workoutAppUrl), url: config.workoutAppUrl, label: config.workoutAppLabel },
      persistence: 'server',
    };
    return { body };
  }, { public: true });

  r.add('POST', '/auth/register', async (ctx) => {
    if (config.authMode !== 'accounts' || !d.sessions) throw new HttpError(404, 'NOT_FOUND', 'Accounts are not enabled.');
    const input = parse(registerSchema, ctx.body);
    d.loginLimiter.check(`register:${ctx.req.socket.remoteAddress}`);
    if (d.profiles.findByEmail(input.email)) throw new HttpError(409, 'CONFLICT', 'An account with that email already exists. Sign in instead.');
    const profile = d.profiles.create({
      displayName: input.displayName || input.email.split('@')[0],
      email: input.email,
      passwordHash: await hashPassword(input.password),
      timezone: input.timezone ?? 'UTC',
    });
    const s = d.sessions.createSession(profile.id);
    ctx.setCookie(sessionCookie(config, s.token, config.sessionTtlHours * 3600));
    return { status: 201, body: { profileId: profile.id } };
  }, { public: true });

  r.add('POST', '/auth/login', async (ctx) => {
    if (config.authMode !== 'accounts' || !d.sessions) throw new HttpError(404, 'NOT_FOUND', 'Accounts are not enabled.');
    const input = parse(loginSchema, ctx.body);
    const key = `login:${input.email.toLowerCase()}`;
    d.loginLimiter.check(key);
    const profile = d.profiles.findByEmail(input.email);
    const ok = await verifyPassword(input.password, profile?.password_hash ?? null);
    if (!profile || !ok) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    d.loginLimiter.reset(key);
    const s = d.sessions.createSession(profile.id);
    ctx.setCookie(sessionCookie(config, s.token, config.sessionTtlHours * 3600));
    return { body: { profileId: profile.id } };
  }, { public: true });

  r.add('POST', '/auth/logout', (ctx) => {
    const token = ctx.cookies[SESSION_COOKIE];
    if (token) d.profiles.deleteSession(hashToken(token));
    ctx.setCookie(sessionCookie(config, '', 0));
    return { status: 204 };
  }, { public: true });

  // ---------- profile & preferences ----------
  r.add('GET', '/me', ({ auth }) => {
    const p = d.profiles.get(auth.profileId)!;
    const body: Me = { profileId: p.id, displayName: p.display_name, email: p.email, timezone: p.timezone, authMode: config.authMode };
    return { body };
  });

  r.add('PATCH', '/me', ({ auth, body }) => {
    const input = parse(profileSchema, body);
    d.profiles.update(auth.profileId, input);
    const p = d.profiles.get(auth.profileId)!;
    return { body: { profileId: p.id, displayName: p.display_name, email: p.email, timezone: p.timezone, authMode: config.authMode } };
  });

  r.add('GET', '/preferences', ({ auth }) => ({ body: d.prefs.get(auth.profileId, profileTz(auth.profileId)) }));

  r.add('PUT', '/preferences', ({ auth, body }) => {
    const input = parse(preferencesSchema, body);
    if (!input.adultConfirmed && input.planner.mode === 'target') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Planning around a calorie target is for adults. Confirm you are 18 or older, or use general planning.');
    }
    d.profiles.update(auth.profileId, { timezone: input.timezone });
    d.prefs.save(auth.profileId, input);
    return { body: d.prefs.get(auth.profileId, input.timezone) };
  });

  // ---------- daily log ----------
  r.add('GET', '/summary', (ctx) => {
    const date = dateParam(ctx, 'date', todayInTimeZone(profileTz(ctx.auth.profileId)));
    const prefs = d.prefs.get(ctx.auth.profileId, profileTz(ctx.auth.profileId));
    return { body: d.nutrition.summary(ctx.auth.profileId, date, prefs.dailyCalorieTarget) };
  });

  r.add('GET', '/logs', (ctx) => {
    const from = dateParam(ctx, 'from');
    const to = dateParam(ctx, 'to', from);
    return { body: { entries: d.nutrition.listLogs(ctx.auth.profileId, from, to) } };
  });

  r.add('POST', '/logs', ({ auth, body }) => {
    const res = d.nutrition.createLog(auth.profileId, parse(createLogSchema, body));
    return { status: res.duplicate ? 200 : 201, body: res };
  });

  r.add('PATCH', '/logs/:id', ({ auth, params, body }) => ({ body: { entry: d.nutrition.updateLog(auth.profileId, params.id, parse(updateLogSchema, body)) } }));

  r.add('DELETE', '/logs/:id', ({ auth, params }) => {
    d.nutrition.deleteLog(auth.profileId, params.id);
    return { status: 204 };
  });

  r.add('GET', '/history', (ctx) => {
    const today = todayInTimeZone(profileTz(ctx.auth.profileId));
    const to = dateParam(ctx, 'to', today);
    const from = dateParam(ctx, 'from', addDays(to, -29));
    return { body: { days: d.nutrition.history(ctx.auth.profileId, from, to) } };
  });

  // ---------- foods ----------
  r.add('GET', '/foods/search', async (ctx) => {
    const page = Math.max(1, Math.min(50, Number(q(ctx, 'page') ?? 1) || 1));
    return { body: await d.nutrition.search(ctx.auth.profileId, q(ctx, 'q') ?? '', page) };
  });

  r.add('GET', '/foods/recent', ({ auth }) => ({ body: { foods: d.nutrition.recentFoods(auth.profileId) } }));

  r.add('POST', '/foods', ({ auth, body }) => ({ status: 201, body: { food: d.nutrition.createManualFood(auth.profileId, parse(manualFoodSchema, body)) } }));

  r.add('GET', '/foods/:ref', async ({ auth, params }) => ({ body: { food: await d.nutrition.getFood(auth.profileId, params.ref) } }));

  r.add('POST', '/foods/:id/servings', ({ auth, params, body }) => ({
    status: 201,
    body: { serving: d.nutrition.addServing(auth.profileId, params.id, parse(servingSchema, body)) },
  }));

  // ---------- recipes ----------
  r.add('GET', '/recipes', ({ auth }) => ({ body: { recipes: d.planning.listRecipes(auth.profileId) } }));
  r.add('POST', '/recipes', ({ auth, body }) => ({ status: 201, body: { recipe: d.planning.createRecipe(auth.profileId, parse(recipeSchema, body)) } }));
  r.add('GET', '/recipes/:id', ({ auth, params }) => ({ body: { recipe: d.planning.getRecipe(auth.profileId, params.id) } }));
  r.add('PUT', '/recipes/:id', ({ auth, params, body }) => ({ body: { recipe: d.planning.updateRecipe(auth.profileId, params.id, parse(recipeSchema, body)) } }));
  r.add('DELETE', '/recipes/:id', ({ auth, params }) => {
    d.planning.deleteRecipe(auth.profileId, params.id);
    return { status: 204 };
  });

  // ---------- plans ----------
  r.add('GET', '/plans', ({ auth }) => ({ body: { plans: d.planning.listPlans(auth.profileId) } }));
  r.add('POST', '/plans', ({ auth, body }) => ({ status: 201, body: { plan: d.planning.generatePlan(auth.profileId, parse(generatePlanSchema, body)) } }));
  r.add('GET', '/plans/:id', ({ auth, params }) => ({ body: { plan: d.planning.getPlan(auth.profileId, params.id) } }));
  r.add('DELETE', '/plans/:id', ({ auth, params }) => {
    d.planning.deletePlan(auth.profileId, params.id);
    return { status: 204 };
  });
  r.add('POST', '/plans/:id/regenerate', ({ auth, params, body }) => {
    const input = parse(regenerateSchema, body);
    return { body: { plan: d.planning.regenerate(auth.profileId, params.id, input.scope, input.date, input.seed) } };
  });
  r.add('POST', '/plans/:id/save', ({ auth, params, body }) => {
    const overwrite = Boolean((body as { overwrite?: unknown } | undefined)?.overwrite === true);
    return { body: { plan: d.planning.savePlan(auth.profileId, params.id, overwrite) } };
  });
  r.add('GET', '/plans/:id/grocery-list', (ctx) => {
    const from = q(ctx, 'from');
    const to = q(ctx, 'to');
    return { body: d.planning.groceryList(ctx.auth.profileId, ctx.params.id, from ?? undefined, to ?? undefined) };
  });

  r.add('PATCH', '/plan-items/:id', ({ auth, params, body }) => ({ body: { plan: d.planning.updateItem(auth.profileId, params.id, parse(updatePlanItemSchema, body)) } }));
  r.add('POST', '/plan-items/:id/replace', ({ auth, params }) => ({ body: { plan: d.planning.replaceItem(auth.profileId, params.id) } }));
  r.add('POST', '/plan-items/:id/log', ({ auth, params, body }) => {
    const res = d.planning.logItem(auth.profileId, params.id, parse(logPlanItemSchema, body));
    return { status: res.duplicate ? 200 : 201, body: res };
  });

  // ---------- export / import / delete ----------
  r.add('GET', '/export/logs.csv', (ctx) => {
    const today = todayInTimeZone(profileTz(ctx.auth.profileId));
    const to = dateParam(ctx, 'to', today);
    const from = dateParam(ctx, 'from', addDays(to, -365));
    return { raw: { contentType: 'text/csv; charset=utf-8', data: d.data.exportLogsCsv(ctx.auth.profileId, from, to), filename: `mealbase-food-log-${from}-to-${to}.csv` } };
  });

  r.add('GET', '/export/plans.json', ({ auth }) => {
    const data = d.data.exportPlansJson(auth.profileId);
    return { raw: { contentType: 'application/json; charset=utf-8', data: JSON.stringify(data, null, 2), filename: `mealbase-plans-${data.exportedAt.slice(0, 10)}.json` } };
  });

  r.add('POST', '/import/plans', (ctx) => {
    const includePreferences = q(ctx, 'includePreferences') !== 'false';
    return { status: 201, body: d.data.importPlansJson(ctx.auth.profileId, ctx.body, { includePreferences }) };
  });

  const requireConfirm = (body: unknown) => {
    if ((body as { confirm?: unknown } | undefined)?.confirm !== 'DELETE') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Send { "confirm": "DELETE" } to confirm.');
    }
  };
  r.add('DELETE', '/data/history', ({ auth, body }) => {
    requireConfirm(body);
    return { body: { deletedEntries: d.data.deleteHistory(auth.profileId) } };
  });
  r.add('DELETE', '/data/all', ({ auth, body }) => {
    requireConfirm(body);
    d.data.deleteAll(auth.profileId);
    return { status: 204 };
  });

  return r;
}
