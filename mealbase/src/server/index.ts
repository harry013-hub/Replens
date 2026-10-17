import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMealBase } from './app';
import { loadConfig } from './config';

const config = loadConfig();
// The production bundle lives in dist/server; serve the UI from dist/public by default.
if (!config.staticDir) {
  const built = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
  if (existsSync(resolve(built, 'index.html'))) config.staticDir = built;
}
try {
  const app = createMealBase(config);
  const server = await app.listen();
  const where = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}${config.appBasePath}`;
  console.log(`MealBase is running at ${where}`);
  console.log(`API: ${config.apiBasePath} · auth: ${config.authMode} · USDA key: ${config.usdaApiKey ? (config.usdaApiKey === 'DEMO_KEY' ? 'DEMO_KEY (low limits)' : 'set') : 'NOT SET – food search disabled, manual entry works'}`);
  if (!config.staticDir) console.log('UI not served by this process (STATIC_DIR not set). In development, `npm run dev` serves it.');
  const shutdown = () => server.close(() => { app.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  console.error(`MealBase could not start: ${(err as Error).message}`);
  process.exit(1);
}
