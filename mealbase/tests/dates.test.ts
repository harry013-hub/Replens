import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dateRange, isLocalDate, nextWeekStart, startOfWeek, todayInTimeZone, weekDates } from '../src/shared/lib/dates';

describe('local dates across timezones', () => {
  // 2026-10-18 06:30 UTC
  const instant = new Date(Date.UTC(2026, 9, 18, 6, 30));

  it('the same instant is a different calendar day in different zones', () => {
    assert.equal(todayInTimeZone('America/Los_Angeles', instant), '2026-10-17');
    assert.equal(todayInTimeZone('Europe/London', instant), '2026-10-18');
    assert.equal(todayInTimeZone('Asia/Tokyo', instant), '2026-10-18');
    assert.equal(todayInTimeZone('Pacific/Honolulu', instant), '2026-10-17');
    assert.equal(todayInTimeZone('Pacific/Kiritimati', instant), '2026-10-18');
  });

  it('handles the day boundary near midnight', () => {
    const justBefore = new Date(Date.UTC(2026, 9, 18, 6, 59)); // 23:59 in LA (PDT, UTC-7)
    const justAfter = new Date(Date.UTC(2026, 9, 18, 7, 0)); // 00:00 in LA
    assert.equal(todayInTimeZone('America/Los_Angeles', justBefore), '2026-10-17');
    assert.equal(todayInTimeZone('America/Los_Angeles', justAfter), '2026-10-18');
  });

  it('next calendar week runs Monday to Sunday', () => {
    assert.equal(nextWeekStart('2026-10-17'), '2026-10-19'); // Saturday → following Monday
    assert.equal(nextWeekStart('2026-10-18'), '2026-10-19'); // Sunday → next day
    assert.equal(nextWeekStart('2026-10-19'), '2026-10-26'); // Monday → the Monday after
    const week = weekDates('2026-10-19');
    assert.equal(week.length, 7);
    assert.equal(week[0], '2026-10-19');
    assert.equal(week[6], '2026-10-25');
  });

  it('date arithmetic does not drift across daylight-saving changes', () => {
    assert.equal(addDays('2026-03-07', 1), '2026-03-08');
    assert.equal(addDays('2026-03-08', 1), '2026-03-09');
    assert.equal(addDays('2026-11-01', 1), '2026-11-02');
    assert.equal(startOfWeek('2026-03-08'), '2026-03-02');
  });

  it('validates dates strictly', () => {
    assert.ok(isLocalDate('2028-02-29'));
    assert.ok(!isLocalDate('2026-02-29'));
    assert.ok(!isLocalDate('2026-13-01'));
    assert.ok(!isLocalDate('17/10/2026'));
  });

  it('ranges are inclusive and capped', () => {
    assert.deepEqual(dateRange('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    assert.deepEqual(dateRange('2026-11-02', '2026-10-30'), []);
    assert.throws(() => dateRange('2020-01-01', '2026-01-01', 366));
  });
});
