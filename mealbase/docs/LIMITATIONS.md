# Known limitations

## Data
- **Starter recipe nutrition uses development sample data.** The 52 sample ingredients are approximate per-100 g values so the planner works without a key. They're labelled "Sample data" / "Sample nutrition data" everywhere. Run `npm run recipes:match-usda -- --apply` with a real key to re-link them to USDA records, and review the matches.
- **USDA integration not exercised live** from the build environment (network blocked). It is implemented to the documented schema and tested with fixtures. See TESTING.md for the checks to run.
- **Branded foods** are stored per 100 g or 100 ml as USDA reports them. Label values (`labelNutrients`) are not used; if a product's serving is listed in a different unit from its nutrient basis, that serving isn't offered.
- **No g ↔ ml conversion** (by design). A food measured in grams can only be logged in grams or its provider/user-supplied servings.
- **Calorie, protein, carbohydrate and fat only.** Fibre, sugar, sodium and micronutrients are not shown yet (the provider mapping is the place to add them).
- **No barcode scanning.**

## Planning
- The starter collection is small (33 recipes). Strict combinations (e.g. vegan + no repeats) can't fill a week; the app explains the conflict. Add recipes in the app or in `recipes.json`.
- Snacks are logged but not planned.
- **Allergy filtering is name- and tag-based.** It can't see product labels, hidden ingredients or cross-contact, and user-created recipes rely on ingredient-name detection only. Nothing is labelled allergen-free.
- Budget is a rough per-recipe tag; there are no prices.
- In target mode, portions are limited to 0.75–2 servings and every meal is kept, so some targets can't be met; the plan shows the difference instead.
- No personalised calorie estimation (BMR/TDEE). Users enter a target they already have. Adding estimation should be a separate module with eligibility checks.
- Copying a starter recipe re-detects allergens from ingredient names; explicit seed tags such as "may contain" aren't copied.

## Accounts & security
- `AUTH_MODE=local` is a single-user demo: one shared log for anyone who can reach the server. The server refuses to listen publicly in this mode unless `ALLOW_PUBLIC_SINGLE_USER=true`.
- Accounts mode has email + password only: no email verification, password reset, or account deletion endpoint (users can delete all their nutrition data from Settings; removing the profile row is an admin task).
- Login rate limiting and the USDA cache are in memory (per process).
- Webhooks are best-effort (3 attempts, no persistent queue).

## Platform
- Requires Node ≥ 22.13 for the built-in `node:sqlite` module, which Node still marks experimental (the warning is suppressed in npm scripts).
- SQLite suits a single server instance. Multi-instance deployments need Postgres (repositories are the only SQL layer).
- The package exports TypeScript source; a host app needs a bundler or `tsx` to consume it.
- No offline mode / service worker. If the server or database is unavailable, the UI shows an error and nothing is saved.
- The Dockerfile was written but not built in the development environment.
- Physical-device and screen-reader testing has not been done yet (see TESTING.md).

## Static mode inside RepLens
- Data is stored per browser/device in `localStorage` (≈5 MB limit). Clearing site data removes it; there is no sync between devices.
- On GitHub Pages (no proxy function) the browser calls USDA directly: with the public DEMO_KEY (about 30 searches/hour per network) or the user's own key saved in that browser. Direct browser calls rely on USDA allowing cross-origin requests; this couldn't be verified from the build environment. If it's blocked, search shows "couldn't be reached" and manual entry still works.
- The function has no rate limiting of its own; heavy public traffic could use up the USDA key's hourly limit (1,000 requests/hour).
