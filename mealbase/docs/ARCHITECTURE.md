# Architecture overview

MealBase is one Node process that serves a versioned JSON API and a React single-page UI. It has three runtime dependencies (`react`, `react-dom`, `zod`) and uses Node's built-in `node:http` and `node:sqlite`.

```
Browser (React UI, scoped .mb-root)
   │  fetch, httpOnly session cookie, X-MealBase-Client header
   ▼
src/server/app.ts ── auth (AuthProvider) ── routes.ts ── validation.ts (zod)
                                              │
                         ┌────────────────────┼─────────────────────┐
                 NutritionService       PlanningService         DataService
                 (foods, food log)      (recipes, plans,        (export, import,
                         │               grocery, log-as-eaten)   delete)
                         │                    │
            services/food-provider     services/meal-planner (pure functions)
            (USDA FoodData Central)    shared/lib (nutrition, units, dates, allergens)
                         │
                   database/ (SQLite, migrations, repositories)
```

## Folder layout

| Folder | Contents |
|---|---|
| `src/shared/types/` | Data contracts shared by server, UI and host apps (`FoodLogEntry`, `MealPlan`, API request/response types, event types). |
| `src/shared/lib/` | Pure, reusable functions: portion and calorie maths (`nutrition.ts`), unit conversion (`units.ts`), local-date handling (`dates.ts`), allergen/diet matching (`allergens.ts`). |
| `src/shared/ui/` | Design tokens, component CSS and small React primitives. |
| `src/services/food-provider/` | `FoodProvider` interface and the USDA implementation. No UI or DB code. |
| `src/services/meal-planner/` | Recipe nutrition, recipe filtering, the seeded planner, grocery list. Pure functions. |
| `src/services/integration/` | In-page events (shared runtime) and signed outbound webhooks (separate deployment). |
| `src/database/` | SQLite connection, migrations, seed data, repositories. Every query that touches personal data takes a `profileId`. |
| `src/server/` | HTTP routing, authentication, validation, services that combine repositories and pure logic. |
| `src/features/nutrition/` | The UI: API client, pages (Today, Food Search, Weekly Meal Plan, History, Settings), feature components. |
| `src/components/` | App shell / navigation. |
| `src/index.ts`, `src/server/public.ts` | Public exports for a host application. |

UI components never call `fetch` directly — they use `NutritionApiClient`. Nutrition maths lives only in `shared/lib` and `services/meal-planner`, so the browser preview and the server use the same functions.

## Data model

Tables (see `src/database/migrations.ts`):

- **profiles** — one per user. `id` is an opaque UUID. Holds display name, optional email/password hash, timezone.
- **sessions** — hashed session tokens with expiry (accounts mode).
- **identity_links** — maps a host app's user id (`provider`, `external_id`) to a MealBase profile.
- **user_preferences** — optional daily calorie target, adult confirmation, planner preferences (JSON).
- **foods** — cached USDA foods (shared, `owner_profile_id` NULL), users' manual foods (owned), and sample foods. Nutrients are stored **with their reference amount and unit** (`ref_quantity`, `ref_unit`), `NULL` = unavailable.
- **food_servings** — named portions with their size in the food's reference unit (e.g. "1 cup, sliced" = 150 g). Provider-supplied or user-added; never guessed.
- **recipes**, **recipe_ingredients** — the editable collection; ingredients link to foods, nutrition is computed.
- **meal_plans**, **meal_plan_items** — one row per (plan, date, meal). Each item stores a frozen recipe snapshot (name, ingredients, instructions, per-serving nutrition) so later recipe edits don't rewrite plans.
- **food_log_entries** — what was actually eaten. Each entry stores the consumed portion, a full **nutrition snapshot** (reference, serving used, computed values, source) and optional `source_plan_item_id`. Unique `(profile_id, idempotency_key)` prevents duplicates.

Planned food and eaten food are separate tables. Nothing writes to `food_log_entries` except an explicit log request.

## Key decisions

- **Portion maths** (`computePortion`): a portion is either the food's reference unit or a named serving with a known size. Grams, millilitres, pieces and servings are never converted into each other unless a serving supplies the conversion. Values keep full precision; rounding happens only in `format*` helpers.
- **Snapshots**: log entries are edited by recomputing from their own snapshot, so provider updates never change past logs.
- **Planner**: a deterministic (seeded) recipe-based planner. In target mode it searches recipe combinations and serving multipliers between 0.75 and 2 to approach the target, never omits a meal, and reports each day's actual total and difference. No LLM is used.
- **Allergies**: recipes are excluded when an ingredient's tags or name match a known allergen; "may contain" tags produce visible warnings; unknown allergy words are name-matched and a warning explains the limits.
- **Auth**: `AuthProvider` interface. Built-ins: local single-user, email/password sessions, and a service-token provider for server-to-server calls. The server refuses to run local mode on a public interface unless explicitly allowed.
- **Idempotency**: create-log and log-as-eaten accept a client-generated key; the UI generates one per attempt so double taps and retries return the same entry.
- **Database**: SQLite via `node:sqlite` for zero native dependencies. All SQL is in `src/database/repositories/`; moving to Postgres means reimplementing those classes and the migrations, not the services.
