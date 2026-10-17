# Export and import formats

## Food log CSV (`GET /export/logs.csv?from=&to=`)

UTF-8, comma-separated, CRLF line endings, header row, RFC 4180 quoting. Text cells that begin with `= + - @` are prefixed with `'` to prevent spreadsheet formula injection. Numbers keep up to 4 decimal places; empty cell = not available.

| Column | Meaning |
|---|---|
| `entry_id` | Stable entry id |
| `local_date` | Calendar date in the user's timezone (`YYYY-MM-DD`) |
| `meal_type` | `breakfast`, `lunch`, `dinner`, `snack` |
| `name` | Display name |
| `quantity`, `unit` | Portion eaten (e.g. `150`, `g` or `1`, `1 cup, sliced`) |
| `calories_kcal`, `protein_g`, `carbohydrate_g`, `fat_g` | Estimated values for that portion (empty = unavailable) |
| `nutrition_source` | `usda`, `manual`, `sample`, `plan`, `quick` |
| `sample_data` | `yes` if derived from development sample data |
| `source_plan_item_id` | Planned meal it came from, if any |
| `created_at`, `updated_at` | ISO-8601 UTC |

## Meal plans and preferences JSON (`GET /export/plans.json`)

```json
{
  "format": "mealbase.plans",
  "version": 1,
  "exportedAt": "2026-10-17T19:00:00.000Z",
  "timezone": "Europe/London",
  "preferences": {
    "dailyCalorieTarget": null,
    "planner": { "diet": "none", "excludeIngredients": [], "allergies": [], "maxPrepMinutes": null,
                 "budget": "any", "people": 1, "mode": "general", "calorieTarget": null,
                 "targetTolerancePct": 10, "allowRepeats": true }
  },
  "plans": [
    {
      "weekStart": "2026-10-19",
      "status": "saved",
      "preferences": { "...": "as above" },
      "targetApplied": false,
      "items": [
        {
          "date": "2026-10-19", "mealType": "breakfast", "recipeId": "…", "name": "Overnight oats with blueberries",
          "servings": 1, "notes": null, "locked": false,
          "nutrition": { "calories": 382.1, "proteinG": 15.2, "carbsG": 59.3, "fatG": 10.1 },
          "recipe": {
            "recipeId": "…", "name": "…", "servings": 1, "prepMinutes": 5,
            "instructions": ["…"], "ingredients": [{ "name": "Rolled oats, dry", "quantity": 50, "unit": "g" }],
            "nutritionPerServing": { "calories": 382.1, "proteinG": 15.2, "carbsG": 59.3, "fatG": 10.1 },
            "nutritionBasis": "sample", "nutritionComplete": true
          }
        }
      ]
    }
  ]
}
```

### Import rules (`POST /import/plans`)

- `format` must be `mealbase.plans` and `version` must be `1`; every field is validated (dates, meal types, ranges, ≤ 21 items per plan, ≤ 104 plans).
- Plans are created as **drafts** with new ids; saved plans are never overwritten.
- Item nutrition is recomputed from `recipe.nutritionPerServing × servings`.
- `recipeId` is kept only if that recipe exists for the importing user.
- Preferences are imported when `includePreferences=true`, but **adult confirmation is never imported** — the user confirms it in Settings. Without it, target mode is switched to general.
- Invalid files are rejected with `400 VALIDATION_ERROR`; nothing is partially saved.

Future versions will add a new `version` number and keep reading `1`.
