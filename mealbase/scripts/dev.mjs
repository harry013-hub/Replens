// Development: rebuilds the UI on change and restarts the API on change. One port.
import { context } from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
import { spawn } from 'node:child_process';

const out = '.dev/public';
mkdirSync(`${out}/assets`, { recursive: true });
cpSync('public', out, { recursive: true });

const ctx = await context({
  entryPoints: { main: 'src/client/main.tsx' },
  outdir: `${out}/assets`,
  bundle: true,
  format: 'esm',
  sourcemap: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'info',
});
await ctx.watch();

const server = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '--watch-path=src', 'src/server/index.ts'],
  { stdio: 'inherit', env: { ...process.env, STATIC_DIR: process.env.STATIC_DIR ?? out } },
);
const stop = () => { server.kill(); ctx.dispose(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
