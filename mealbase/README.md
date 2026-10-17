# MealBase

MealBase is the nutrition module of a larger fitness project. It lets someone:

- log breakfast, lunch, dinner and snacks, and see the day's calories before a workout (logging is always optional);
- search the **USDA FoodData Central** database, or add a food by hand;
- generate an editable **Monday–Sunday meal plan** from a small recipe collection;
- swap, lock, resize and regenerate planned meals, see recipes and a grocery list;
- record a planned meal **as eaten** (plans never add calories on their own);
- review history, export CSV/JSON, and delete their data.

It is built as an independent module (TypeScript, React, Node's built-in HTTP server and SQLite) so it can later be imported into, or connected to, the workout application. See [docs/INTEGRATION.md](docs/INTEGRATION.md).

> Nutrition values are estimates. MealBase is a logging and planning tool and does not provide individual medical nutrition advice.

---

## What needs a key or configuration

| Item | Needed for | Where |
|---|---|---|
| **USDA FoodData Central API key** (free) | Live food search | `USDA_API_KEY` in `.env`. Sign up at <https://fdc.nal.usda.gov/api-key-signup>. Without it, manual entry, your own foods and the labelled sample foods still work. `DEMO_KEY` works for a quick try (30 requests/hour). |
| `AUTH_MODE=accounts` | Any deployment used by more than one person | `.env`. The default `local` mode is a single-user demo. |
| `WORKOUT_APP_URL` | The "Workouts" link on Today | `.env`. Optional. |
| `INTEGRATION_SERVICE_TOKEN`, `INTEGRATION_WEBHOOK_URL`, `INTEGRATION_WEBHOOK_SECRET` | Connecting a separately deployed workout app | `.env`. Optional, secret. |

Secrets live only in server-side environment variables. The browser never receives the USDA key or integration secrets.

---

## Run it locally (step by step)

You need **Node.js 22.13 or newer** (it includes the SQLite database MealBase uses). Check with `node --version`; download from <https://nodejs.org> if needed.

```bash
# 1. Get the code and install packages
cd mealbase
npm install

# 2. Create your settings file
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
#    Open .env and paste your USDA key after USDA_API_KEY= (optional but recommended)

# 3. Start in development mode (rebuilds when you edit files)
npm run dev
```

Open <http://localhost:3000>. The database file is created in `./data/` and filled with the starter recipes automatically.

Production-style run on your machine:

```bash
npm run build
npm start
```

Other commands:

| Command | What it does |
|---|---|
| `npm test` | Runs the automated test suite (86 tests). |
| `npm run typecheck` | Checks TypeScript types. |
| `npm run db:migrate` | Applies database migrations (also done automatically at start). |
| `npm run db:seed` | Loads sample foods + starter recipes. `-- --force` overwrites edited seed recipes. |
| `npm run recipes:match-usda` | With a USDA key, proposes USDA records for every starter-recipe ingredient. Add `-- --apply` to re-link them so recipe nutrition comes from USDA instead of sample data. |

### Trying food search without a key

A small fake USDA server is included for offline testing (it only knows "banana"):

```bash
node tests/fixtures/fake-usda-server.mjs 4555
USDA_API_KEY=test USDA_API_BASE_URL=http://127.0.0.1:4555/fdc/v1 npm run dev
```

---

## Editing recipes

The starter collection lives in [`src/database/seed/recipes.json`](src/database/seed/recipes.json) (33 recipes). Each ingredient references a food in [`sample-foods.json`](src/database/seed/sample-foods.json) by key, with a quantity and unit. Nutrition is always calculated from the linked foods — it is never typed into a recipe. After editing, run `npm run db:seed -- --force`.

Users can also create their own recipes in the app (**Meal Plan → My recipes**), linking each ingredient to a USDA, manual or sample food.

**About the sample foods:** they are approximate per-100 g values for common ingredients, included so the planner works on day one. They are stored with `source = 'sample'` and labelled "Sample data" everywhere in the UI. Run `npm run recipes:match-usda -- --apply` with a real key to replace them with live USDA records.

---

## Restyling

All colours, type, spacing and radii are CSS custom properties in [`src/shared/ui/tokens.css`](src/shared/ui/tokens.css) (light and dark). Component styles are in [`components.css`](src/shared/ui/components.css). Every selector is scoped under `.mb-root` and prefixed `mb-`, so MealBase can sit inside another site without style conflicts.

---

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — structure, data model, key decisions
- [docs/API.md](docs/API.md) — versioned REST API reference
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — combining with the workout website (both options), events, identity mapping
- [docs/DATA-FORMATS.md](docs/DATA-FORMATS.md) — CSV and JSON export/import formats
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — deploying to a server or container
- [docs/USDA-PROVIDER.md](docs/USDA-PROVIDER.md) — what was verified about FoodData Central and how it's used
- [docs/TESTING.md](docs/TESTING.md) — what is tested and what still needs real-provider / device testing
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — known limitations

Food data: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central. fdc.nal.usda.gov (public domain, CC0 1.0).

---

## Inside RepLens (static, browser-only mode)

In the RepLens repository MealBase runs as a tab at `/meals/` with **no Node server**:

- `src/client/static-main.tsx` mounts the same UI with `src/local/backend.ts`, an in-browser implementation of the `/api/v1/nutrition` API that stores data in `localStorage` (`mealbase.v1`). It reuses the same portion maths, planner, validation and export formats as the server.
- Food search (`src/local/browser-provider.ts`) uses USDA FoodData Central through the proxy function when the host has it (Netlify, or RepLens's `npm start` with `USDA_API_KEY`; the key stays server-side). On hosts without it, such as GitHub Pages, it searches **Open Food Facts** directly (`src/services/food-provider/openfoodfacts.ts`, via Search-a-licious with a legacy fallback), because USDA's API can't be called from a browser page and Open Food Facts allows it.
- Hash routing (`/meals/#/plan`) works on any static host without rewrite rules.
- Build it with `npm run build:replens` (writes `../meals` and `../netlify/functions/usda.mjs`).

Limits of this mode: one user per browser/device, no sync between devices (move data with Settings → export/import), and without the proxy function food search uses Open Food Facts (mostly packaged grocery foods; restaurant items are generally missing).
