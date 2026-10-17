// Minimal stand-in for api.nal.usda.gov used by tests and offline demos.
// Start: node tests/fixtures/fake-usda-server.mjs 4555
// Then:  USDA_API_BASE_URL=http://127.0.0.1:4555/fdc/v1 USDA_API_KEY=test npm start
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 4555);
let mode = process.env.FAKE_USDA_MODE ?? 'ok'; // ok | 429 | 500

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__mode') { mode = url.searchParams.get('m') ?? 'ok'; res.end(mode); return; }
  if (!url.searchParams.get('api_key')) { res.writeHead(403); res.end('{"error":{"code":"API_KEY_MISSING"}}'); return; }
  if (mode === '429') { res.writeHead(429, { 'Retry-After': '3600' }); res.end('{}'); return; }
  if (mode === '500') { res.writeHead(500); res.end('{}'); return; }
  const send = (file) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(readFileSync(join(dir, file))); };
  if (url.pathname.endsWith('/foods/search')) {
    const q = (url.searchParams.get('query') ?? '').toLowerCase();
    if (q.includes('banana')) return send('usda-search-banana.json');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ totalHits: 0, currentPage: 1, totalPages: 0, foods: [] }));
    return;
  }
  const m = url.pathname.match(/\/food\/(\d+)$/);
  if (m && existsSync(join(dir, `usda-food-${m[1]}.json`))) return send(`usda-food-${m[1]}.json`);
  res.writeHead(404); res.end('{}');
}).listen(port, '127.0.0.1', () => console.log(`fake USDA on http://127.0.0.1:${port}/fdc/v1 (mode ${mode})`));
