// Production build: client bundle -> dist/public, server bundle -> dist/server.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/public/assets', { recursive: true });
cpSync('public', 'dist/public', { recursive: true });

await build({
  entryPoints: { main: 'src/client/main.tsx' },
  outdir: 'dist/public/assets',
  bundle: true,
  format: 'esm',
  splitting: false,
  minify: true,
  sourcemap: true,
  target: ['es2020', 'safari15'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
console.log('\nBuilt. Start with: npm start');
