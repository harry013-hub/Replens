import { useCallback, useEffect, useRef, useState } from 'react';
import type { MealType } from '../../shared/types/nutrition';
import { browserTimeZone, todayInTimeZone } from '../../shared/lib/dates';
import { ApiError } from './api/client';

export interface AsyncState<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

/** Load data with loading / error / retry states. Ignores stale responses. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    fn().then(
      (d) => { if (mine === seq.current) { setData(d); setLoading(false); } },
      (e) => {
        if (mine !== seq.current) return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL_ERROR', String(e?.message ?? e)));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return 'Something went wrong. Please try again.';
}

export function todayLocal(tz?: string): string {
  return todayInTimeZone(tz || browserTimeZone());
}

/** Sensible default meal for "now", used only to pre-select a choice. */
export function mealForNow(date = new Date()): MealType {
  const h = date.getHours();
  if (h < 11) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

export const MEAL_LABELS: Record<MealType, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks' };
