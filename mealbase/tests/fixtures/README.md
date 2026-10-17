# Test fixtures

These JSON files mimic the **shape** of USDA FoodData Central API responses
(`/foods/search` and `/food/{fdcId}`) as documented in the FDC OpenAPI spec.
They are used only by automated tests and the local fake-USDA server
(`fake-usda-server.mjs`). Nutrient numbers are illustrative test values, not
authoritative data, and must never be shipped as food data.
