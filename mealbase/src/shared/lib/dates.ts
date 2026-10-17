/**
 * Local calendar date helpers. A "local date" is a `YYYY-MM-DD` string that
 * represents a day in the user's own timezone. Arithmetic on these strings is
 * done in UTC so it never shifts across daylight-saving changes.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Today's calendar date in `timeZone`. */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function toUtc(date: string): Date {
  if (!isLocalDate(date)) throw new RangeError(`Invalid date: ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date: string): number {
  return toUtc(date).getUTCDay();
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  const daysSinceMonday = (dayOfWeek(date) + 6) % 7;
  return addDays(date, -daysSinceMonday);
}

/** Monday of the next calendar week (always after the current week). */
export function nextWeekStart(today: string): string {
  return addDays(startOfWeek(today), 7);
}

export function weekDates(start: string, length = 7): string[] {
  return Array.from({ length }, (_, i) => addDays(start, i));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

export function dateRange(from: string, to: string, maxDays = 366): string[] {
  const n = daysBetween(from, to);
  if (n < 0) return [];
  if (n + 1 > maxDays) throw new RangeError(`Date range is limited to ${maxDays} days.`);
  return weekDates(from, n + 1);
}

/** Human label for a local date, e.g. "Mon 19 Oct". Never shifts the day. */
export function formatLocalDate(
  date: string,
  options: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' },
  locale?: string,
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(toUtc(date));
}
