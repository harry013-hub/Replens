# Testing

## Automated tests (`npm test`)

83 tests using Node's built-in test runner. API tests start a real MealBase server on a random port with an in-memory database and a USDA provider whose network is replaced by fixtures.

| Area | File | What is checked |
|---|---|---|
| Portion & calorie maths | `nutrition.test.ts` | 150 g from a per-100 g reference; named servings; precision kept, rounding only for display; zero/negative/NaN/huge quantities rejected; no g↔ml/cup/piece conversion without a supplied serving; missing nutrients stay unavailable. |
| Daily totals | `nutrition.test.ts`, `api.test.ts` | Sums with per-nutrient missing counts; totals update after create/edit/delete. |
| Timezones | `dates.test.ts` | Same instant → different local dates (Los Angeles, London, Tokyo, Honolulu, Kiritimati); midnight boundary; next Monday–Sunday week; DST-safe date arithmetic; strict date validation. |
| Create/edit/delete entries | `api.test.ts` | Full CRUD; edits recompute from the stored snapshot; provider data changes don't alter old logs. |
| Planned vs consumed | `plans.test.ts` | Generating and editing plans never writes to the food log. |
| Duplicate "Log as eaten" | `plans.test.ts`, `api.test.ts` | Concurrent identical requests return one entry; a second attempt returns 409 `ALREADY_LOGGED`; intentional repeat allowed; same for food-log creates. |
| 21 slots / 7 days | `planner.test.ts`, `plans.test.ts` | Breakfast/lunch/dinner each day; reproducible by seed; next-week default starts on Monday. |
| Locked meals | `planner.test.ts`, `plans.test.ts` | Survive week and day regeneration (20 seeds); locked meals can't be swapped. |
| Exclusions & allergies | `planner.test.ts`, `plans.test.ts` | Excluded ingredients and allergens removed; "may contain" produces warnings; conflicts return explanations; vegan/pescatarian rules; no-repeat mode. |
| Calorie target | `planner.test.ts`, `plans.test.ts` | Requires adult confirmation; all 21 meals kept; portions 0.75–2 servings; differences reported honestly, including impossible targets. |
| Grocery list | `planner.test.ts` | g/kg and cup/tbsp combined; mass and volume of the same item kept separate; scaled by people. |
| Missing nutrition values | `nutrition.test.ts`, `usda.test.ts`, `api.test.ts` | Null preserved through mapping, logging and totals. |
| API / provider errors | `usda.test.ts`, `api.test.ts` | Missing key, 403, 429 (with Retry-After), 5xx, network failure, malformed JSON, unexpected shape, empty results; manual entry still works when the provider is down; cached food served during outage. |
| Data isolation | `plans.test.ts` | Second account cannot read, edit, delete, log against, export or plan with the first account's data; client-sent ids ignored; session expiry reported; service-token identity mapping keeps users apart. |
| Integration | `integration.test.ts` | Host `AuthProvider` factory; non-MealBase routes fall through; webhook signing/verification; in-page events. |
| Browser-only mode (RepLens tab) | `local-backend.test.ts` | Same API through the in-browser backend: core flow, reload persistence, failed storage writes not saved, memory fallback, no-proxy mode, validation, export/import/reset; USDA proxy never leaks the key and validates input. |
| Open Food Facts | `openfoodfacts.test.ts` | Nutrient mapping (kcal, kJ fallback, string numbers, bad values rejected), per 100 g vs 100 ml, servings only in the matching unit, identifying header and no key sent, Search-a-licious search with legacy fallback, Costco → Kirkland brand mapping, any-word retry, rate-limit / outage / not-found errors, full static-site flow (search → details → log), USDA function still preferred when present. |
| Core flow | `core-flow.test.ts` | Search → portion → log → total → next week's plan → swap → log as eaten → history & reopened saved plan. |

Mutation check performed during development: disabling the duplicate-log guard or the locked-slot check makes the corresponding tests fail.

## Browser end-to-end check (optional)

`tests/e2e/core_flow.py` drives the built app in headless Chromium at phone size (390×844) and desktop size, against the fake USDA server. It covers the same core flow through the UI, the duplicate-log warning, saving, grocery list, history and settings. It passed in the development environment. Instructions are at the top of the file (needs Python + Playwright and a fresh database).

## Still needs testing with real services and devices

These could not be done in the build environment:

1. **Live USDA FoodData Central** — outbound access to `api.nal.usda.gov` was blocked, so the mapping was verified only against fixtures shaped like the documented schema. With your key, check:
   - search "banana", "greek yogurt", a branded drink measured in ml, and a Foundation food that reports Atwater energy;
   - open each result and confirm calories per 100 g / 100 ml and portion weights match the FDC website;
   - run `npm run recipes:match-usda` (dry run) and review every proposed match before `--apply`;
   - optionally exhaust `DEMO_KEY` to see the rate-limit message.
2. **Physical phones** — iOS Safari and Android Chrome: date inputs, `<dialog>` modals, on-screen keyboard over forms, safe-area padding of the bottom navigation, 48 px touch targets, dark mode.
3. **Screen readers** — VoiceOver / TalkBack pass on Today, Food Search and the plan dialogs (landmarks, labels and live regions are in place but not verified with assistive technology).
4. **Webhook receiver** — a real endpoint verifying signatures, and behaviour when it is down.
5. **Production deployment** — HTTPS + `Secure` cookies, the Dockerfile build, persistent volume, backups.
6. **Different timezones on a device** — change the phone's timezone and confirm Today and "next week" follow it after updating Settings.
