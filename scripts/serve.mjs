// Tiny zero-dependency static server for LOCAL testing on your computer.
//   npm start   →  http://localhost:8080
// Camera works at http://localhost on the same computer only. A phone cannot
// use this address — see README "Testing on your phone" (needs HTTPS).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const port = Number(process.env.PORT) || 8080;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
  '.task': 'application/octet-stream', '.md': 'text/plain; charset=utf-8',
};

// MealBase food search goes through the same function Netlify runs, so the
// USDA key stays on the server:  USDA_API_KEY=your-key npm start
let usda = null;
async function usdaFunction(req, res) {
  usda ??= (await import('../netlify/functions/usda.mjs')).default;
  const r = await usda(new Request(new URL(req.url, `http://localhost:${port}`), { method: req.method }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}

http.createServer(async (req, res) => {
  try {
    if (new URL(req.url, 'http://x').pathname === '/.netlify/functions/usda') return await usdaFunction(req, res);
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Permissions-Policy': 'camera=(self), microphone=()',
      'Cache-Control': 'no-cache',
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, () => {
  console.log(`RepLens running at http://localhost:${port}  ·  MealBase at http://localhost:${port}/meals/`);
  console.log(process.env.USDA_API_KEY ? 'USDA food search: on' : 'USDA food search: off (start with USDA_API_KEY=your-key npm start). Manual entry still works.');
});
