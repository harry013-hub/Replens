# USDA FoodData Central — what was verified and how it's used

Checked against the official API guide (<https://fdc.nal.usda.gov/api-guide>) in October 2026.

| Question | Finding | How MealBase handles it |
|---|---|---|
| Credentials | Every request needs a data.gov API key (`api_key` parameter). `DEMO_KEY` exists for exploration with much lower limits (30 requests/hour, 50/day per IP). Keys found publicly are deactivated. | Key read from `USDA_API_KEY` on the server only and added to outbound requests there. Missing key → search reports "not configured"; manual entry still works. |
| Endpoints | `GET/POST /foods/search`, `GET /food/{fdcId}`, `GET/POST /foods`, `GET/POST /foods/list`. | Uses `GET /foods/search` (25 per page) and `GET /food/{fdcId}`. |
| Data types | Foundation, SR Legacy, Survey (FNDDS), Branded. | Searches all four and shows the type on every result. |
| Rate limits | 1,000 requests/hour per IP by default; exceeding it returns HTTP 429 and blocks the key for an hour. | 429 → "Search limit reached" with Retry; searches cached 10 min and details 24 h in memory; foods used once are stored locally so logging and recipes don't re-fetch. |
| Units / serving fields | Nutrients per 100 g (Foundation, SR Legacy, FNDDS) and per 100 g or 100 ml of product for Branded (per `servingSizeUnit`). Portion weights in `foodPortions[].gramWeight`; Branded `servingSize` + `servingSizeUnit` + `householdServingFullText`. | Stored as a reference of 100 g or 100 ml. Portions without a gram weight are ignored, never guessed. Branded serving offered only if its unit matches the reference unit. Energy from nutrient 208 (kcal), falling back to Atwater 957/958, or 268 (kJ ÷ 4.184) with a note. |
| Licensing | Public domain under CC0 1.0. USDA asks that FoodData Central is credited. | Attribution shown with search results, on food details and in Settings. |
| Recipes / meal plans | FoodData Central is a food composition database. It has no recipe or meal-plan endpoints. | Recipes come from MealBase's own editable collection; nutrition is computed from linked food records. |

The response field mapping is implemented in `src/services/food-provider/usda.ts` and tested with fixtures shaped like the published schema (`tests/fixtures/`). **Live calls could not be made from the build environment** (outbound access to api.nal.usda.gov was blocked), so run the "real-provider checks" in TESTING.md once with your key.
