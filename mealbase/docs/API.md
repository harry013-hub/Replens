# API reference (v1)

Base path: `API_BASE_PATH` (default `/api/v1/nutrition`). JSON in and out. Dates are local calendar dates `YYYY-MM-DD`; timestamps are ISO-8601 UTC. Nutrient values are numbers or `null` (= not available).

## Authentication

The current user is always resolved on the server from:

- **local mode** — the single local profile;
- **accounts mode** — the `mealbase_session` httpOnly cookie set by `/auth/login` or `/auth/register`;
- **service token** — `Authorization: Bearer <INTEGRATION_SERVICE_TOKEN>` plus `X-MealBase-User: <host user id>` (server-to-server only).

A user id in a request body or query is never used for authorization.

Browser requests that change data (`POST`, `PUT`, `PATCH`, `DELETE`) must send `X-MealBase-Client: 1`. This custom header forces a CORS preflight and blocks cross-site request forgery. Service-token calls are exempt.

## Errors

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Human-readable text", "details": {} } }
```

| Status | Codes |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_PORTION`, `UNIT_CONVERSION_UNAVAILABLE` |
| 401 | `AUTH_REQUIRED`, `SESSION_EXPIRED`, `INVALID_CREDENTIALS` |
| 403 | `FORBIDDEN` (missing client header) |
| 404 | `NOT_FOUND` (also returned for other users' records) |
| 409 | `ALREADY_LOGGED`, `PLAN_EXISTS`, `CONFLICT` |
| 422 | `PLAN_CONFLICT` (`details.problems[]` explains which preferences can't be met) |
| 429 | `RATE_LIMITED`, `PROVIDER_RATE_LIMITED` |
| 502/503 | `PROVIDER_BAD_RESPONSE`, `PROVIDER_UNAVAILABLE`, `PROVIDER_NOT_CONFIGURED`, `STORAGE_ERROR` |

A failed request never saves partial data.

## Endpoints

### Public
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ ok: true }` |
| GET | `/config` | Auth mode, whether the food provider is configured, workout link (public values only). |
| POST | `/auth/register` | `{ email, password, timezone? }` (accounts mode) |
| POST | `/auth/login` | `{ email, password }` — rate limited |
| POST | `/auth/logout` | |

### Profile & preferences
| Method | Path | Body / query |
|---|---|---|
| GET | `/me` | |
| PATCH | `/me` | `{ displayName?, timezone? }` |
| GET / PUT | `/preferences` | `{ dailyCalorieTarget: number\|null, adultConfirmed, timezone, planner: PlannerPreferences }` |

### Daily log
| Method | Path | Body / query |
|---|---|---|
| GET | `/summary?date=YYYY-MM-DD` | Daily totals, per-meal entries, missing-data counts, optional target. Defaults to today in the profile timezone. |
| GET | `/logs?from=&to=` | Entries in a date range (≤ 370 days). |
| POST | `/logs` | `{ localDate, mealType, foodId, quantity, unit, idempotencyKey? }` or `{ localDate, mealType, quick: { name, calories, proteinG?, carbsG?, fatG? } }`. `unit` is the food's reference unit (`g`, `ml`, `piece`, `serving`) or `serving:<servingId>`. Returns 201, or 200 with `duplicate: true` for a repeated idempotency key. |
| PATCH | `/logs/:id` | `{ quantity?, unit?, mealType?, localDate?, displayName? }` — recomputed from the entry's snapshot. |
| DELETE | `/logs/:id` | |
| GET | `/history?from=&to=` | Per-day totals for days with entries. |

### Foods
| Method | Path | Notes |
|---|---|---|
| GET | `/foods/search?q=&page=` | `{ provider: { status, message }, results: [...USDA], mine: [...], sample: [...] }`. Provider failures are reported in `provider.status` (`not_configured`, `rate_limited`, `unavailable`, `error`) with HTTP 200 so personal/manual results still show. |
| GET | `/foods/recent` | Recently logged foods. |
| GET | `/foods/:ref` | `ref` = `usda:<fdcId>` (fetched, cached locally) or a local food id. Returns nutrients per reference amount and serving options. |
| POST | `/foods` | Manual food: `{ name, brand?, referenceQuantity, referenceUnit, unitLabel?, calories, proteinG?, carbsG?, fatG? }`. |
| POST | `/foods/:id/servings` | `{ label, refAmount }` — a serving with its measured weight/volume in the food's unit. |

### Recipes
`GET /recipes`, `POST /recipes`, `GET /recipes/:id`, `PUT /recipes/:id`, `DELETE /recipes/:id` (own recipes only). Body: `{ name, mealTypes[], prepMinutes, budgetLevel, servings, instructions[], ingredients: [{ name, quantity|null, unit, foodId|null }] }`. Responses include computed `nutrition: { perServing, complete, issues[], basis }`.

### Meal plans
| Method | Path | Notes |
|---|---|---|
| GET | `/plans` | Summaries. |
| POST | `/plans` | `{ weekStart?, preferences?, seed? }`. Default week = next Monday–Sunday in the profile timezone. 201 with the full plan (21 items) or 422 `PLAN_CONFLICT`. |
| GET | `/plans/:id` | Items, day totals (with target difference when applied), warnings. |
| DELETE | `/plans/:id` | Logged entries are kept. |
| POST | `/plans/:id/regenerate` | `{ scope: "week" \| "day", date? }` — locked items are kept. |
| POST | `/plans/:id/save` | `{ overwrite?: boolean }` — 409 `PLAN_EXISTS` if another saved plan covers the same week. |
| GET | `/plans/:id/grocery-list?from=&to=` | Combined quantities; incompatible units listed separately. |
| PATCH | `/plan-items/:id` | `{ servings?, locked?, notes?, recipeId? , custom? }` |
| POST | `/plan-items/:id/replace` | Swap for another suitable recipe. |
| POST | `/plan-items/:id/log` | `{ servingsEaten, localDate, mealType, idempotencyKey, allowRepeat? }` — creates a food-log entry. 409 `ALREADY_LOGGED` if this item was logged before and `allowRepeat` is not set. |

### Data
| Method | Path | Notes |
|---|---|---|
| GET | `/export/logs.csv?from=&to=` | See DATA-FORMATS.md |
| GET | `/export/plans.json` | Versioned JSON |
| POST | `/import/plans?includePreferences=true` | Validated; plans are imported as drafts. |
| DELETE | `/data/history` | `{ "confirm": "DELETE" }` — removes food-log entries. |
| DELETE | `/data/all` | `{ "confirm": "DELETE" }` — removes all personal nutrition data. |

## Examples

```bash
B=http://localhost:3000/api/v1/nutrition
curl "$B/summary?date=2026-10-19"
curl -X POST "$B/logs" -H 'Content-Type: application/json' -H 'X-MealBase-Client: 1' \
  -d '{"localDate":"2026-10-19","mealType":"snack","quick":{"name":"Apple","calories":95}}'

# Server-to-server from the workout app
curl "$B/summary?date=2026-10-19" -H "Authorization: Bearer $INTEGRATION_SERVICE_TOKEN" -H "X-MealBase-User: user-123"
```
