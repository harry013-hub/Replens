# Combining MealBase with the workout website

MealBase supports two ways of joining the workout app. Both use the same data model and API, so you can start with one and move to the other.

Design rules that hold in both:

- Logging food is optional. Nothing in MealBase gates access to workouts.
- The workout app may show calories logged next to workouts completed. MealBase does **not** subtract exercise calories, and nothing should reward eating below a target.
- MealBase never trusts a user id sent by a browser. Identity always comes from an authenticated context.

---

## Option 1 — Import into a shared application

Use this if the workout site is (or can be) a Node + React app.

The package exports TypeScript source (`src/index.ts`, `src/server/public.ts`); the host's bundler (Vite, esbuild, Next.js with `transpilePackages`) or `tsx` compiles it.

### UI

```tsx
import { NutritionApp, subscribeNutritionEvents } from 'mealbase';           // package entry: src/index.ts
import 'mealbase/styles/tokens.css';
import 'mealbase/styles/components.css';

<NutritionApp apiBaseUrl="/api/v1/nutrition" routeBase="/nutrition" />
```

- All markup renders inside `.mb-root`; every class is prefixed `mb-`; tokens are `--mb-*` custom properties. Override tokens on `.mb-root` to match the workout app's brand.
- `routeBase` lets the module own a sub-path (`/nutrition`, `/nutrition/search`, …). The router uses the History API and does not assume any framework router; if the host uses React Router, mount `<NutritionApp>` on a `/nutrition/*` route.
- Smaller pieces are exported too: `NutritionApiClient`, the data types, and pure functions such as `computePortion`, `sumNutrients`, `todayInTimeZone`.

### Server

```ts
import http from 'node:http';
import { createMealBase, loadConfig } from 'mealbase/server';

const nutrition = createMealBase(
  { ...loadConfig(), apiBasePath: '/api/v1/nutrition', staticDir: null },
  { auth: workoutJwtAuth },             // see "Identity" below (optional)
);
http.createServer(async (req, res) => {
  if (await nutrition.handle(req, res)) return;   // MealBase handled it
  workoutApp(req, res);
}).listen(3000);
```

For Express: `app.use((req, res, next) => nutrition.handle(req, res).then((h) => h || next()))`.

### In-page events (shared runtime only)

When both UIs run in the same page, successful changes emit events on `window` and through `subscribeNutritionEvents`:

| Event | `detail.data` |
|---|---|
| `nutrition:food-logged` | `{ entry: FoodLogEntry }` |
| `nutrition:food-updated` | `{ entry: FoodLogEntry }` |
| `nutrition:food-deleted` | `{ entryId, localDate }` |
| `nutrition:plan-saved` | `{ planId, weekStart }` |

```ts
window.addEventListener('nutrition:food-logged', (e) => refreshCalorieWidget((e as CustomEvent).detail.data.entry.localDate));
// or
const off = subscribeNutritionEvents('nutrition:food-logged', (ev) => …);
```

These events exist only inside one browser tab. They do not reach other tabs, devices, or a separately hosted app — use webhooks or polling for that.

---

## Option 2 — Separate deployment, connected over authenticated APIs

Keep MealBase on its own host (e.g. `nutrition.example.com`) and connect from the workout app's **server**.

### Calling the API

Set `INTEGRATION_SERVICE_TOKEN` to a long random secret in MealBase and in the workout app's server environment. The workout server calls:

```http
GET /api/v1/nutrition/summary?date=2026-10-19
Authorization: Bearer <INTEGRATION_SERVICE_TOKEN>
X-MealBase-User: <workout app's user id>
X-MealBase-User-Name: Sam            (optional, used when the profile is first created)
```

MealBase maps `X-MealBase-User` to its own profile through the `identity_links` table (provider `integration`), creating the profile the first time. Never expose the service token to browser code; only the workout app's backend may hold it.

Useful calls for the workout app: `GET /summary?date=` (calories before a workout), `GET /logs?from=&to=`, `GET /history?from=&to=`.

### Receiving events (webhooks)

Set `INTEGRATION_WEBHOOK_URL` and `INTEGRATION_WEBHOOK_SECRET`. MealBase POSTs each event:

```http
POST <your url>
Content-Type: application/json
X-MealBase-Event: nutrition:food-logged
X-MealBase-Timestamp: 1792261877
X-MealBase-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the secret>

{ "type": "nutrition:food-logged", "version": 1, "profileId": "…", "occurredAt": "…", "data": { "entry": { … } } }
```

Verify the signature over the **raw** body and reject timestamps older than five minutes (`verifyWebhook` in `src/services/integration/webhooks.ts` does both). `profileId` is MealBase's id — map it back using the identity link you created. Delivery is best-effort (three attempts, no persistent queue); treat webhooks as hints and re-fetch `/summary` for the authoritative numbers.

### Linking the UI

Set `WORKOUT_APP_URL` so Today shows an "Open Workouts" link (it appends `?date=YYYY-MM-DD`). Without it, Today shows "Workout connection not configured". The workout app can link back to `https://nutrition.example.com/` or `/?date=YYYY-MM-DD`.

For a single sign-on experience across two hosts, implement an `AuthProvider` that verifies the workout app's token (for example a JWT in a shared-domain cookie) — see below.

---

## Identity mapping

`AuthProvider` (in `src/server/auth/auth.ts`) is the only place identity is decided:

```ts
import { HttpError, type AuthProvider } from 'mealbase/server';

const workoutJwtAuth = (profiles): AuthProvider => ({
  resolve(req) {
    const claims = verifyWorkoutJwt(req.headers.cookie);   // your code; throw HttpError(401,'SESSION_EXPIRED',…) when expired
    if (!claims) return null;
    const profile = profiles.resolveIdentity('workout', claims.sub, claims.name);
    return { profileId: profile.id, via: 'session' };
  },
});
```

Pass it as `createMealBase(config, { auth: workoutJwtAuth })`; MealBase calls the factory with its profile repository.

`resolveIdentity(provider, externalId, displayName)` creates or finds a profile and stores the link, so MealBase ids stay internal and stable even if the workout app changes its user ids format later (add a new provider name and re-link).

## Database ownership & migrations

- MealBase **owns** its tables. The workout app must not write to them directly; use the API or service functions.
- Tables have no name prefix. If you share one SQLite file or one Postgres database, put MealBase in its own file/schema (e.g. `DATABASE_PATH=./data/nutrition.sqlite` or a `nutrition` schema) to avoid collisions.
- Migrations are in `src/database/migrations.ts`, recorded in `schema_migrations`, and run automatically at start (`npm run db:migrate` to run them alone). Append new migrations; never edit applied ones.
- To move to Postgres, re-implement `src/database/connection.ts` and the repositories; services and routes don't contain SQL.
- Export/import formats (DATA-FORMATS.md) are versioned so records survive a UI or app merge.

## Checklist before merging

1. Choose option 1 or 2.
2. Decide the identity source and implement/configure the `AuthProvider` (or service token).
3. Set `API_BASE_PATH` / `APP_BASE_PATH` to avoid route clashes.
4. Set `WORKOUT_APP_URL` (option 2) or route links (option 1).
5. Run `npm test` and the core-flow check in docs/TESTING.md against the combined app.
