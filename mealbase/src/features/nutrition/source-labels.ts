import type { FoodSource } from '../../shared/types/nutrition';

/** Short badge text for where a food's numbers came from. */
export const SOURCE_BADGE: Record<FoodSource, string> = {
  usda: 'USDA',
  off: 'Open Food Facts',
  manual: 'Yours',
  sample: 'Sample',
};

export const SOURCE_NAME: Record<FoodSource, string> = {
  usda: 'USDA FoodData Central',
  off: 'Open Food Facts',
  manual: 'Entered by you',
  sample: 'Sample data',
};
