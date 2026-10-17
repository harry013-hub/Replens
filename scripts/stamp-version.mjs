// Cache-busting for static hosting (GitHub Pages caches files for ~10 minutes).
// Stamps one version string onto every local script/stylesheet URL and every
// relative ES-module import, so a phone can never mix a new page with old
// cached code.   node scripts/stamp-version.mjs [version]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const v = process.argv[2] || new Date().toISOString().replace(/\D/g, '').slice(0, 12);

const stamp = (s, re) => s.replace(re, (_m, pre, path, post) => `${pre}${path}?v=${v}${post}`);
let changed = 0;
function rewrite(file, ...patterns) {
  const p = resolve(root, file);
  const before = readFileSync(p, 'utf8');
  let s = before.replace(/\?v=[\w.-]+/g, '');
  for (const re of patterns) s = stamp(s, re);
  if (s !== before) { writeFileSync(p, s); changed++; }
}

// <script src="js/…"> and <link href="css/…"> in the pages
rewrite('index.html', /(src=")(js\/[\w./-]+\.js)(")/g, /(href=")(css\/[\w./-]+\.css)(")/g);
rewrite('meals/index.html', /(href=")(\.\.\/css\/[\w./-]+\.css)(")/g);
rewrite('mealbase/public/static.html', /(href=")(\.\.\/css\/[\w./-]+\.css)(")/g);
// relative imports inside the app's modules
for (const f of readdirSync(resolve(root, 'js'))) {
  if (f.endsWith('.js')) rewrite(`js/${f}`, /(from ')(\.\/[\w-]+\.js)(')/g);
}
console.log(`Stamped version ${v} (${changed} files changed)`);
