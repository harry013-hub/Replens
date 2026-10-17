// Build MealBase as a static, browser-only site (data in localStorage) plus the
// USDA proxy as a Netlify Function.
//
//   node scripts/build-static.mjs --out ../meals --function ../netlify/functions/usda.mjs
//
// Defaults: --out dist-static, --function dist-static-function/usda.mjs
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
const out = resolve(arg('--out', 'dist-static'));
const fn = resolve(arg('--function', 'dist-static-function/usda.mjs'));
const theme = arg('--theme', null);

rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/assets`, { recursive: true });
let html = readFileSync('public/static.html', 'utf8');
if (theme) {
  html = html.replace('</head>', `    <script>window.__MEALBASE_STATIC__ = Object.assign(window.__MEALBASE_STATIC__ || {}, { theme: ${JSON.stringify(theme)} });</script>\n  </head>`);
}
writeFileSync(`${out}/index.html`, html);
cpSync('public/favicon.svg', `${out}/favicon.svg`);

await build({
  entryPoints: { mealbase: 'src/client/static-main.tsx' },
  outdir: `${out}/assets`,
  bundle: true, format: 'esm', minify: true, sourcemap: false, target: ['es2020', 'safari15'], jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

mkdirSync(dirname(fn), { recursive: true });
await build({
  entryPoints: ['src/proxy/netlify-function.ts'],
  outfile: fn,
  bundle: true, platform: 'node', format: 'esm', target: 'node18',
  banner: { js: '// Generated from mealbase/src/proxy by `npm run build:replens`. Do not edit by hand.' },
  logLevel: 'info',
});
