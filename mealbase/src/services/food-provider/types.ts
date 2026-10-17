import type { NutrientValues, NutritionReference, ReferenceUnit, ServingOption } from '../../shared/types/nutrition';

/** A food as returned by an external provider, before it is stored locally. */
export interface ProviderFood {
  providerId: string;
  sourceFoodId: string;
  name: string;
  brand: string | null;
  dataType: string | null;
  reference: NutritionReference;
  servings: Array<Omit<ServingOption, 'id'>>;
  attribution: string;
  /** Notes about how the data was interpreted (e.g. energy converted from kJ). */
  notes: string[];
}

export interface ProviderSearchItem {
  sourceFoodId: string;
  name: string;
  brand: string | null;
  dataType: string | null;
  preview: { quantity: number; unit: ReferenceUnit; values: NutrientValues } | null;
}

export interface ProviderSearchPage {
  items: ProviderSearchItem[];
  page: number;
  totalPages: number | null;
}

export interface FoodProvider {
  readonly id: 'usda';
  readonly label: string;
  readonly attribution: string;
  isConfigured(): boolean;
  search(query: string, page: number): Promise<ProviderSearchPage>;
  getFood(sourceFoodId: string): Promise<ProviderFood>;
}

export type ProviderErrorCode = 'NOT_CONFIGURED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'BAD_RESPONSE' | 'NOT_FOUND';

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
