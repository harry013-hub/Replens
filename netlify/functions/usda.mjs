// Generated from mealbase/src/proxy by `npm run build:replens`. Do not edit by hand.

// src/shared/lib/units.ts
var ALIASES = {
  gram: "g",
  grams: "g",
  gr: "g",
  kilogram: "kg",
  kilograms: "kg",
  milliliter: "ml",
  millilitre: "ml",
  milliliters: "ml",
  millilitres: "ml",
  mL: "ml",
  liter: "l",
  litre: "l",
  liters: "l",
  litres: "l",
  L: "l",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  tbs: "tbsp",
  cups: "cup",
  ounce: "oz",
  ounces: "oz",
  pound: "lb",
  pounds: "lb",
  lbs: "lb",
  pieces: "piece",
  pc: "piece",
  pcs: "piece"
};
function normalizeUnit(unit) {
  const u = unit.trim();
  return ALIASES[u] ?? ALIASES[u.toLowerCase()] ?? u.toLowerCase();
}

// src/services/food-provider/types.ts
var ProviderError = class extends Error {
  constructor(code, message, retryAfterSeconds = null) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "ProviderError";
  }
  code;
  retryAfterSeconds;
};

// src/services/food-provider/usda.ts
var USDA_ATTRIBUTION = "U.S. Department of Agriculture, Agricultural Research Service. FoodData Central. fdc.nal.usda.gov (public domain, CC0 1.0).";
var USDA_DATA_TYPES = ["Foundation", "SR Legacy", "Survey (FNDDS)", "Branded"];
var N = {
  energyKcal: "208",
  energyKj: "268",
  atwaterGeneral: "957",
  atwaterSpecific: "958",
  protein: "203",
  fat: "204",
  carbs: "205"
};
function readNutrientRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const nested = r?.nutrient ?? null;
    const number = String(nested?.number ?? r?.nutrientNumber ?? r?.number ?? "") || null;
    const unit = nested?.unitName ?? r?.unitName ?? null;
    const valueRaw = r?.amount ?? r?.value;
    const value = typeof valueRaw === "number" && Number.isFinite(valueRaw) ? valueRaw : null;
    return { number, unit, value };
  });
}
function extractNutrients(raw) {
  const rows = readNutrientRows(raw);
  const notes = [];
  const find = (num) => rows.find((r) => r.number === num && r.value !== null);
  let calories = null;
  const kcal = find(N.energyKcal) ?? find(N.atwaterGeneral) ?? find(N.atwaterSpecific);
  if (kcal) {
    if (kcal.unit && kcal.unit.toLowerCase() === "kj") {
      calories = kcal.value / 4.184;
      notes.push("Energy converted from kJ.");
    } else {
      calories = kcal.value;
    }
    if (kcal.number !== N.energyKcal) notes.push("Energy from Atwater factors.");
  } else {
    const kj = find(N.energyKj);
    if (kj) {
      calories = kj.value / 4.184;
      notes.push("Energy converted from kJ.");
    }
  }
  const grams = (num) => {
    const r = find(num);
    if (!r) return null;
    if (r.unit && r.unit.toLowerCase() === "mg") return r.value / 1e3;
    return r.value;
  };
  return {
    values: { calories, proteinG: grams(N.protein), carbsG: grams(N.carbs), fatG: grams(N.fat) },
    notes
  };
}
function brandedReferenceUnit(servingSizeUnit) {
  const u = String(servingSizeUnit ?? "").trim().toLowerCase();
  return u === "ml" || u === "mlt" ? "ml" : "g";
}
var KNOWN_PORTION_KEYS = /* @__PURE__ */ new Set(["cup", "tbsp", "tsp", "fl oz", "oz", "large", "medium", "small", "slice", "piece", "extra large"]);
function portionKey(measureName, modifier) {
  const candidates = [measureName, modifier?.split(/[ ,(]/)[0] ?? null];
  for (const c of candidates) {
    if (!c || c === "undetermined") continue;
    const n = normalizeUnit(c);
    if (KNOWN_PORTION_KEYS.has(n)) return n;
  }
  return null;
}
function mapPortions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    const gramWeight = typeof p?.gramWeight === "number" ? p.gramWeight : null;
    if (!gramWeight || gramWeight <= 0) continue;
    const amount = typeof p?.amount === "number" && p.amount > 0 ? p.amount : 1;
    const measureName = p?.measureUnit?.name ?? null;
    const modifier = typeof p?.modifier === "string" && p.modifier.trim() ? p.modifier.trim() : null;
    const description = typeof p?.portionDescription === "string" && p.portionDescription.trim() && p.portionDescription !== "Quantity not specified" ? p.portionDescription.trim() : null;
    const unitKey = portionKey(measureName, modifier);
    let label;
    let refAmount = gramWeight;
    if (description) {
      label = description;
    } else {
      const parts = [measureName && measureName !== "undetermined" ? measureName : null, modifier].filter(Boolean).join(", ");
      if (unitKey && amount !== 1) {
        label = `1 ${parts || unitKey}`;
        refAmount = gramWeight / amount;
      } else {
        label = `${amount} ${parts || "portion"}`.trim();
      }
    }
    if (out.some((o) => o.label === label)) continue;
    out.push({ label, unitKey, refAmount, source: "provider" });
  }
  return out;
}
var TtlCache = class {
  constructor(ttl, max = 500) {
    this.ttl = ttl;
    this.max = max;
  }
  ttl;
  max;
  map = /* @__PURE__ */ new Map();
  get(k) {
    const hit = this.map.get(k);
    if (!hit) return void 0;
    if (hit.exp < Date.now()) {
      this.map.delete(k);
      return void 0;
    }
    return hit.v;
  }
  set(k, v) {
    if (this.ttl <= 0) return;
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(k, { v, exp: Date.now() + this.ttl });
  }
};
var UsdaFoodProvider = class {
  constructor(opts) {
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? "https://api.nal.usda.gov/fdc/v1").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.searchCache = new TtlCache(opts.searchCacheMs ?? 10 * 6e4);
    this.detailCache = new TtlCache(opts.detailCacheMs ?? 24 * 60 * 6e4);
  }
  opts;
  id = "usda";
  label = "USDA FoodData Central";
  attribution = USDA_ATTRIBUTION;
  baseUrl;
  fetchImpl;
  searchCache;
  detailCache;
  isConfigured() {
    return Boolean(this.opts.apiKey);
  }
  get usingDemoKey() {
    return this.opts.apiKey === "DEMO_KEY";
  }
  async request(path, params) {
    if (!this.opts.apiKey) {
      throw new ProviderError("NOT_CONFIGURED", "Food search needs a USDA FoodData Central API key (USDA_API_KEY). Manual entry still works.");
    }
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("api_key", this.opts.apiKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 8e3);
    let res;
    try {
      res = await this.fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    } catch {
      throw new ProviderError("UNAVAILABLE", "USDA FoodData Central could not be reached. Try again, or add the food manually.");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      throw new ProviderError("RATE_LIMITED", "The USDA food search limit was reached. Try again later, or add the food manually.", Number.isFinite(retry) && retry > 0 ? retry : 3600);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError("NOT_CONFIGURED", "The USDA API key was rejected. Check USDA_API_KEY.");
    }
    if (res.status === 404) throw new ProviderError("NOT_FOUND", "That food was not found in USDA FoodData Central.");
    if (!res.ok) throw new ProviderError("UNAVAILABLE", `USDA FoodData Central returned an error (${res.status}). Try again shortly.`);
    try {
      return await res.json();
    } catch {
      throw new ProviderError("BAD_RESPONSE", "USDA FoodData Central sent a response MealBase could not read.");
    }
  }
  async search(query, page) {
    const q = query.trim();
    const cacheKey = `${q.toLowerCase()}|${page}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cached;
    const body = await this.request("/foods/search", {
      query: q,
      pageSize: String(this.opts.pageSize ?? 25),
      pageNumber: String(page),
      dataType: USDA_DATA_TYPES.join(",")
    });
    if (!body || !Array.isArray(body.foods)) {
      throw new ProviderError("BAD_RESPONSE", "USDA search response had an unexpected format.");
    }
    const result = {
      page,
      totalPages: typeof body.totalPages === "number" ? body.totalPages : null,
      items: body.foods.filter((f) => f && (typeof f.fdcId === "number" || typeof f.fdcId === "string") && typeof f.description === "string").map((f) => {
        const { values } = extractNutrients(f.foodNutrients);
        const unit = f.dataType === "Branded" ? brandedReferenceUnit(f.servingSizeUnit) : "g";
        const hasAny = Object.values(values).some((v) => v !== null);
        return {
          sourceFoodId: String(f.fdcId),
          name: titleCase(f.description),
          brand: f.brandName || f.brandOwner || null,
          dataType: f.dataType ?? null,
          preview: hasAny ? { quantity: 100, unit, values } : null
        };
      })
    };
    this.searchCache.set(cacheKey, result);
    return result;
  }
  async getFood(sourceFoodId) {
    if (!/^\d+$/.test(sourceFoodId)) throw new ProviderError("NOT_FOUND", "Invalid USDA food id.");
    const cached = this.detailCache.get(sourceFoodId);
    if (cached) return cached;
    const f = await this.request(`/food/${sourceFoodId}`, {});
    if (!f || typeof f.description !== "string") {
      throw new ProviderError("BAD_RESPONSE", "USDA food details had an unexpected format.");
    }
    const { values, notes } = extractNutrients(f.foodNutrients);
    const isBranded = f.dataType === "Branded";
    const refUnit = isBranded ? brandedReferenceUnit(f.servingSizeUnit) : "g";
    const servings = mapPortions(f.foodPortions);
    if (isBranded && typeof f.servingSize === "number" && f.servingSize > 0) {
      const servingUnit = brandedReferenceUnit(f.servingSizeUnit);
      if (servingUnit === refUnit) {
        const household = typeof f.householdServingFullText === "string" && f.householdServingFullText.trim() ? ` (${f.householdServingFullText.trim()})` : "";
        servings.unshift({ label: `1 serving${household}`, unitKey: "serving", refAmount: f.servingSize, source: "provider" });
      }
    }
    const food = {
      providerId: "usda",
      sourceFoodId: String(f.fdcId ?? sourceFoodId),
      name: titleCase(f.description),
      brand: f.brandName || f.brandOwner || null,
      dataType: f.dataType ?? null,
      reference: { quantity: 100, unit: refUnit, values },
      servings,
      attribution: USDA_ATTRIBUTION,
      notes
    };
    this.detailCache.set(sourceFoodId, food);
    return food;
  }
};
function titleCase(s) {
  const t = s.trim();
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s,(/-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

// src/proxy/usda-proxy.ts
var STATUS = { NOT_CONFIGURED: 503, RATE_LIMITED: 429, UNAVAILABLE: 503, BAD_RESPONSE: 502, NOT_FOUND: 404 };
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": status === 200 ? "public, max-age=300" : "no-store", ...extra }
  });
}
function createUsdaProxy(opts) {
  const provider = new UsdaFoodProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
  return async function handle(url, method = "GET") {
    if (method !== "GET") return json({ error: { code: "VALIDATION_ERROR", message: "Use GET." } }, 405);
    const op = url.searchParams.get("op");
    try {
      if (op === "status") {
        return json({ configured: provider.isConfigured(), usingDemoKey: provider.usingDemoKey, attribution: provider.attribution }, 200, { "Cache-Control": "no-store" });
      }
      if (op === "search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (q.length < 2 || q.length > 100) return json({ error: { code: "VALIDATION_ERROR", message: "Search text must be 2\u2013100 characters." } }, 400);
        const page = Math.max(1, Math.min(50, Number(url.searchParams.get("page")) || 1));
        return json(await provider.search(q, page));
      }
      if (op === "food") {
        const id = url.searchParams.get("id") ?? "";
        if (!/^\d{1,12}$/.test(id)) return json({ error: { code: "VALIDATION_ERROR", message: "Invalid food id." } }, 400);
        return json(await provider.getFood(id));
      }
      return json({ error: { code: "VALIDATION_ERROR", message: "Unknown op." } }, 400);
    } catch (err) {
      if (err instanceof ProviderError) {
        return json(
          { error: { code: err.code, message: err.message, retryAfterSeconds: err.retryAfterSeconds } },
          STATUS[err.code] ?? 503,
          err.retryAfterSeconds ? { "Retry-After": String(err.retryAfterSeconds) } : {}
        );
      }
      return json({ error: { code: "UNAVAILABLE", message: "Food lookup failed. Try again shortly." } }, 500);
    }
  };
}

// src/proxy/netlify-function.ts
var handler = null;
async function usda(req) {
  handler ??= createUsdaProxy({ apiKey: process.env.USDA_API_KEY?.trim() || null, baseUrl: process.env.USDA_API_BASE_URL || void 0 });
  return handler(new URL(req.url), req.method);
}
export {
  usda as default
};
