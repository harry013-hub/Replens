/**
 * Food search, food records and the food log. Framework-free: routes call
 * these methods with an already-authenticated profile id.
 */
import type { Db } from '../../database/connection';
import { nowIso, transaction } from '../../database/connection';
import { FoodRepository } from '../../database/repositories/foods';
import { LogRepository } from '../../database/repositories/logs';
import type { CreateLogEntryRequest, CreateManualFoodRequest, FoodSearchResponse, FoodSearchResult, HistoryDay, UpdateLogEntryRequest } from '../../shared/types/api';
import { MEAL_TYPES, type DailySummary, type Food, type FoodLogEntry, type NutritionSnapshot, type ServingOption } from '../../shared/types/nutrition';
import { computePortion, NutritionError, sumNutrients } from '../../shared/lib/nutrition';
import { dateRange } from '../../shared/lib/dates';
import { ProviderError, type FoodProvider } from '../../services/food-provider/types';
import { HttpError } from '../http/router';
import type { EventSink } from './events';

const SOURCE_LABEL: Record<Food['source'], string> = {
  usda: 'USDA FoodData Central',
  off: 'Open Food Facts',
  manual: 'Entered by you',
  sample: 'Sample data (not from USDA)',
};

export function providerHttpError(err: ProviderError): HttpError {
  switch (err.code) {
    case 'NOT_CONFIGURED': return new HttpError(503, 'PROVIDER_NOT_CONFIGURED', err.message);
    case 'RATE_LIMITED': return new HttpError(429, 'PROVIDER_RATE_LIMITED', err.message, undefined, err.retryAfterSeconds ? { 'Retry-After': String(err.retryAfterSeconds) } : {});
    case 'NOT_FOUND': return new HttpError(404, 'NOT_FOUND', err.message);
    case 'BAD_RESPONSE': return new HttpError(502, 'PROVIDER_BAD_RESPONSE', err.message);
    default: return new HttpError(503, 'PROVIDER_UNAVAILABLE', err.message);
  }
}

function nutritionHttpError(err: NutritionError): HttpError {
  return new HttpError(400, err.code, err.message);
}

export function foodToResult(f: Food): FoodSearchResult {
  return {
    ref: f.id,
    name: f.name,
    brand: f.brand,
    source: f.source,
    sourceLabel: SOURCE_LABEL[f.source],
    dataType: f.dataType,
    preview: { quantity: f.reference.quantity, unit: f.reference.unit, values: f.reference.values },
    isSample: f.isSample,
  };
}

export class NutritionService {
  readonly foods: FoodRepository;
  readonly logs: LogRepository;

  constructor(
    private readonly db: Db,
    private readonly provider: FoodProvider,
    private readonly events: EventSink,
    private readonly opts: { sampleFoodsEnabled: boolean },
  ) {
    this.foods = new FoodRepository(db);
    this.logs = new LogRepository(db);
  }

  // ---------- foods ----------

  async search(profileId: string, query: string, page: number): Promise<FoodSearchResponse> {
    const q = query.trim();
    if (q.length < 2) throw new HttpError(400, 'VALIDATION_ERROR', 'Type at least 2 characters to search.');
    if (q.length > 100) throw new HttpError(400, 'VALIDATION_ERROR', 'Search text is too long.');

    const response: FoodSearchResponse = {
      query: q,
      page,
      totalPages: null,
      provider: { id: 'usda', status: 'ok', message: null, attribution: this.provider.attribution },
      results: [],
      mine: page === 1 ? this.foods.searchManual(profileId, q).map(foodToResult) : [],
      sample: page === 1 && this.opts.sampleFoodsEnabled ? this.foods.searchSample(q).map(foodToResult) : [],
    };

    if (!this.provider.isConfigured()) {
      response.provider.status = 'not_configured';
      response.provider.message = 'Food database search needs a USDA FoodData Central API key. You can still add foods manually.';
      return response;
    }
    try {
      const pageData = await this.provider.search(q, page);
      response.totalPages = pageData.totalPages;
      response.results = pageData.items.map((i) => ({
        ref: `usda:${i.sourceFoodId}`,
        name: i.name,
        brand: i.brand,
        source: 'usda',
        sourceLabel: SOURCE_LABEL.usda + (i.dataType ? ` · ${i.dataType}` : ''),
        dataType: i.dataType,
        preview: i.preview,
        isSample: false,
      }));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      response.provider.status =
        err.code === 'NOT_CONFIGURED' ? 'not_configured' : err.code === 'RATE_LIMITED' ? 'rate_limited' : err.code === 'UNAVAILABLE' ? 'unavailable' : 'error';
      response.provider.message = err.message;
    }
    return response;
  }

  /** Resolve `usda:<fdcId>` (fetch + cache locally) or a local food id. */
  async getFood(profileId: string, ref: string): Promise<Food> {
    if (ref.startsWith('usda:')) {
      const sourceId = ref.slice(5);
      try {
        const pf = await this.provider.getFood(sourceId);
        const id = transaction(this.db, () => this.foods.upsertProviderFood(pf));
        return this.foods.getVisible(id, profileId)!;
      } catch (err) {
        if (err instanceof ProviderError) {
          // Provider down but we cached this food before? Serve the cached copy.
          const cached = this.foods.findShared('usda', sourceId);
          if (cached && err.code !== 'NOT_FOUND') return this.foods.getVisible(cached.id, profileId)!;
          throw providerHttpError(err);
        }
        throw err;
      }
    }
    const food = this.foods.getVisible(ref, profileId);
    if (!food) throw new HttpError(404, 'NOT_FOUND', 'Food not found.');
    return food;
  }

  createManualFood(profileId: string, input: CreateManualFoodRequest): Food {
    const id = this.foods.createManual(profileId, {
      name: input.name,
      brand: input.brand ?? null,
      refQuantity: input.referenceQuantity,
      refUnit: input.referenceUnit,
      unitLabel: input.unitLabel ?? null,
      calories: input.calories,
      proteinG: input.proteinG ?? null,
      carbsG: input.carbsG ?? null,
      fatG: input.fatG ?? null,
    });
    return this.foods.getVisible(id, profileId)!;
  }

  addServing(profileId: string, foodId: string, input: { label: string; refAmount: number; unitKey?: string | null }): ServingOption {
    const food = this.foods.getVisible(foodId, profileId);
    if (!food) throw new HttpError(404, 'NOT_FOUND', 'Food not found.');
    if (food.reference.unit !== 'g' && food.reference.unit !== 'ml') {
      throw new HttpError(400, 'UNIT_CONVERSION_UNAVAILABLE', 'Serving sizes can only be added to foods measured in grams or millilitres.');
    }
    return this.foods.addUserServing(foodId, profileId, input.label, input.refAmount, input.unitKey ?? null);
  }

  recentFoods(profileId: string): Food[] {
    return this.foods.recentForProfile(profileId);
  }

  // ---------- log ----------

  createLog(profileId: string, req: CreateLogEntryRequest): { entry: FoodLogEntry; duplicate: boolean } {
    const result = this.createLogInTransaction(profileId, req);
    if (!result.duplicate) this.events.emit('nutrition:food-logged', profileId, { entry: result.entry });
    return result;
  }

  private createLogInTransaction(profileId: string, req: CreateLogEntryRequest): { entry: FoodLogEntry; duplicate: boolean } {
    return transaction(this.db, () => {
      if (req.idempotencyKey) {
        const existing = this.logs.findByIdempotencyKey(profileId, req.idempotencyKey);
        if (existing) return { entry: existing, duplicate: true };
      }
      let entry: FoodLogEntry;
      if (req.quick) {
        const values = {
          calories: req.quick.calories,
          proteinG: req.quick.proteinG ?? null,
          carbsG: req.quick.carbsG ?? null,
          fatG: req.quick.fatG ?? null,
        };
        const snapshot: NutritionSnapshot = {
          version: 1, source: 'quick', sourceFoodId: null, isSample: false,
          reference: { quantity: 1, unit: 'serving', unitLabel: 'serving', values },
          serving: null, values, computedAt: nowIso(),
        };
        entry = this.logs.create({
          profileId, localDate: req.localDate, mealType: req.mealType, foodId: null, recipeId: null,
          displayName: req.displayName || req.quick.name, quantity: 1, unit: 'serving', unitLabel: 'serving',
          nutrition: values, snapshot, sourcePlanItemId: null, idempotencyKey: req.idempotencyKey ?? null,
        });
      } else {
        const food = this.foods.getVisible(req.foodId!, profileId);
        if (!food) throw new HttpError(404, 'NOT_FOUND', 'Food not found. Search for it again.');
        let portion;
        try {
          portion = computePortion(food, { quantity: req.quantity!, unit: req.unit! });
        } catch (err) {
          if (err instanceof NutritionError) throw nutritionHttpError(err);
          throw err;
        }
        const snapshot: NutritionSnapshot = {
          version: 1, source: food.source, sourceFoodId: food.sourceFoodId, isSample: food.isSample,
          reference: food.reference,
          serving: portion.serving ? { label: portion.serving.label, refAmount: portion.serving.refAmount } : null,
          values: portion.values, computedAt: nowIso(),
        };
        entry = this.logs.create({
          profileId, localDate: req.localDate, mealType: req.mealType, foodId: food.id, recipeId: null,
          displayName: req.displayName || (food.brand ? `${food.name} (${food.brand})` : food.name),
          quantity: req.quantity!, unit: req.unit!, unitLabel: portion.unitLabel,
          nutrition: portion.values, snapshot, sourcePlanItemId: null, idempotencyKey: req.idempotencyKey ?? null,
        });
      }
      return { entry, duplicate: false };
    });
  }

  /**
   * Edits recompute nutrition from the entry's own snapshot reference, so an
   * old entry never silently picks up changed provider data.
   */
  updateLog(profileId: string, id: string, patch: UpdateLogEntryRequest): FoodLogEntry {
    const cur = this.logs.get(profileId, id);
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Entry not found.');

    let nutritionPatch = {};
    if (patch.quantity !== undefined || patch.unit !== undefined) {
      const quantity = patch.quantity ?? cur.quantity;
      const unit = patch.unit ?? cur.unit;
      const snap = cur.snapshot;
      const servings: ServingOption[] = snap.serving
        ? [{ id: 'snapshot', label: snap.serving.label, unitKey: null, refAmount: snap.serving.refAmount, source: 'provider' }]
        : [];
      // Units of an existing entry: its reference unit, or the serving it was logged with.
      const effectiveUnit = unit === cur.unit && cur.unit.startsWith('serving:') ? 'serving:snapshot' : unit;
      if (effectiveUnit !== snap.reference.unit && effectiveUnit !== 'serving:snapshot') {
        throw new HttpError(400, 'UNIT_CONVERSION_UNAVAILABLE', 'To change the unit, delete this entry and add the food again.');
      }
      let portion;
      try {
        portion = computePortion({ reference: snap.reference, servings }, { quantity, unit: effectiveUnit });
      } catch (err) {
        if (err instanceof NutritionError) throw nutritionHttpError(err);
        throw err;
      }
      nutritionPatch = {
        quantity,
        unit,
        unitLabel: snap.serving && effectiveUnit === 'serving:snapshot' ? snap.serving.label : portion.unitLabel,
        nutrition: portion.values,
        snapshot: {
          ...snap,
          serving: effectiveUnit === 'serving:snapshot' ? snap.serving : null,
          values: portion.values,
          computedAt: nowIso(),
        },
      };
    }
    const entry = this.logs.update(profileId, id, {
      localDate: patch.localDate,
      mealType: patch.mealType,
      displayName: patch.displayName,
      ...nutritionPatch,
    })!;
    this.events.emit('nutrition:food-updated', profileId, { entry });
    return entry;
  }

  deleteLog(profileId: string, id: string): void {
    const removed = this.logs.delete(profileId, id);
    if (!removed) throw new HttpError(404, 'NOT_FOUND', 'Entry not found.');
    this.events.emit('nutrition:food-deleted', profileId, { entryId: id, localDate: removed.localDate });
  }

  listLogs(profileId: string, from: string, to: string): FoodLogEntry[] {
    try {
      dateRange(from, to, 370);
    } catch (e) {
      throw new HttpError(400, 'VALIDATION_ERROR', (e as Error).message);
    }
    return this.logs.listRange(profileId, from, to);
  }

  summary(profileId: string, localDate: string, dailyCalorieTarget: number | null): DailySummary {
    const entries = this.logs.listRange(profileId, localDate, localDate);
    return {
      localDate,
      totals: sumNutrients(entries.map((e) => e.nutrition)),
      meals: MEAL_TYPES.map((mealType) => {
        const list = entries.filter((e) => e.mealType === mealType);
        return { mealType, entries: list, totals: sumNutrients(list.map((e) => e.nutrition)) };
      }),
      dailyCalorieTarget,
    };
  }

  history(profileId: string, from: string, to: string): HistoryDay[] {
    return this.logs.dailyTotals(profileId, from, to).map((r) => ({
      localDate: r.local_date,
      entryCount: Number(r.entry_count),
      nutrition: { calories: r.calories, proteinG: r.protein_g, carbsG: r.carbs_g, fatG: r.fat_g },
      missingCalories: Number(r.missing_calories),
    }));
  }
}
