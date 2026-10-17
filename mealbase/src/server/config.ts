/**
 * Server configuration from environment variables. See .env.example.
 * Secrets (USDA_API_KEY, INTEGRATION_*) are read here and never sent to the browser.
 */
export interface ServerConfig {
  nodeEnv: string;
  host: string;
  port: number;
  databasePath: string;
  /** Mount path for the versioned API, e.g. /api/v1/nutrition */
  apiBasePath: string;
  /** Mount path for the UI, e.g. / or /nutrition */
  appBasePath: string;
  authMode: 'local' | 'accounts';
  allowPublicSingleUser: boolean;
  sessionTtlHours: number;
  secureCookies: boolean;
  usdaApiKey: string | null;
  usdaBaseUrl: string;
  sampleFoodsEnabled: boolean;
  autoSeed: boolean;
  workoutAppUrl: string | null;
  workoutAppLabel: string;
  integrationServiceToken: string | null;
  integrationWebhookUrl: string | null;
  integrationWebhookSecret: string | null;
  staticDir: string | null;
}

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function path(v: string | undefined, d: string): string {
  const p = (v ?? d).trim() || d;
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

function nonEmpty(v: string | undefined): string | null {
  return v && v.trim() ? v.trim() : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const authMode = env.AUTH_MODE === 'accounts' ? 'accounts' : 'local';
  return {
    nodeEnv,
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? './data/mealbase.sqlite',
    apiBasePath: path(env.API_BASE_PATH, '/api/v1/nutrition'),
    appBasePath: path(env.APP_BASE_PATH, '/'),
    authMode,
    allowPublicSingleUser: bool(env.ALLOW_PUBLIC_SINGLE_USER, false),
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 24 * 14),
    secureCookies: bool(env.SECURE_COOKIES, nodeEnv === 'production'),
    usdaApiKey: nonEmpty(env.USDA_API_KEY),
    usdaBaseUrl: env.USDA_API_BASE_URL ?? 'https://api.nal.usda.gov/fdc/v1',
    sampleFoodsEnabled: bool(env.SAMPLE_FOODS_ENABLED, nodeEnv !== 'production'),
    autoSeed: bool(env.AUTO_SEED, true),
    workoutAppUrl: nonEmpty(env.WORKOUT_APP_URL),
    workoutAppLabel: env.WORKOUT_APP_LABEL ?? 'Workouts',
    integrationServiceToken: nonEmpty(env.INTEGRATION_SERVICE_TOKEN),
    integrationWebhookUrl: nonEmpty(env.INTEGRATION_WEBHOOK_URL),
    integrationWebhookSecret: nonEmpty(env.INTEGRATION_WEBHOOK_SECRET),
    staticDir: env.STATIC_DIR ?? null,
  };
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
