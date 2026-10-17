# Deployment

MealBase is one Node process with a SQLite file. Any host that runs **Node.js ≥ 22.13** with a persistent disk works (a small VPS, Render/Railway/Fly.io with a volume, a container platform with a volume).

## Before you deploy

1. Set `AUTH_MODE=accounts`. The server refuses to listen on a public interface in `local` mode.
2. Set `HOST=0.0.0.0` and `NODE_ENV=production`.
3. Put it behind **HTTPS** (most platforms do this for you). In production session cookies are `Secure`, so plain HTTP sign-in won't work.
4. Set `USDA_API_KEY` to your own key (not `DEMO_KEY`).
5. Point `DATABASE_PATH` at a **persistent volume**, e.g. `/data/mealbase.sqlite`.
6. Decide whether to show sample foods (`SAMPLE_FOODS_ENABLED`, off by default in production). Starter recipes still use sample ingredient data until you run `npm run recipes:match-usda -- --apply` against the production database.

## Generic Node host

```bash
npm ci
npm run build
NODE_ENV=production AUTH_MODE=accounts HOST=0.0.0.0 PORT=3000 \
DATABASE_PATH=/data/mealbase.sqlite USDA_API_KEY=… \
npm start
```

Run it under a process manager (systemd, pm2) or the platform's start command. `GET /api/v1/nutrition/health` is a health check.

## Container

A `Dockerfile` is included:

```bash
docker build -t mealbase .
docker run -p 3000:3000 -v mealbase-data:/data \
  -e AUTH_MODE=accounts -e USDA_API_KEY=… mealbase
```

The Dockerfile has not been built in the development environment used to write it; build it once and run the core-flow check before relying on it.

## Backups

The whole dataset is the SQLite file (plus `-wal`/`-shm` while running). Back it up with `sqlite3 /data/mealbase.sqlite ".backup /backups/mealbase-$(date +%F).sqlite"` or by snapshotting the volume. Users can also export their own CSV/JSON.

## Scaling notes

SQLite fits one server instance. For several instances, move to Postgres (replace `src/database/connection.ts` and the repositories) and move the in-memory login-attempt limiter and USDA response cache to a shared store.

## Mounting under a sub-path

To serve at `https://example.com/nutrition`: `APP_BASE_PATH=/nutrition` and keep `API_BASE_PATH=/api/v1/nutrition` (or change both). The server injects these paths into the page at runtime; no rebuild needed.
