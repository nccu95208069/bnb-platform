import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPeriod, sweetfunMonthWindow } from '../src/components/calendar/calendar-utils.ts';
import { calendarReadError } from '../src/lib/booking-sources/calendar-reader.ts';

test('live month view reads its visible grid instead of the entire 2025–2027 archive', () => {
  assert.deepEqual(fetchPeriod('2026-10-22', 'month', true), {
    start: '2026-09-28', end: '2026-11-02', label: '2026年10月',
  });
  assert.deepEqual(fetchPeriod('2026-11-22', 'month', true), {
    start: '2026-10-26', end: '2026-12-07', label: '2026年11月',
  });
});

test('week and day requests remain bounded to their selected dates', () => {
  assert.deepEqual(fetchPeriod('2026-10-22', 'week'), {
    start: '2026-10-12', end: '2026-11-02', label: 'three-week-window',
  });
  assert.deepEqual(fetchPeriod('2026-10-22', 'day'), {
    start: '2026-10-22', end: '2026-10-23', label: 'single-day-window',
  });
});

test('Sweetfun October and November reuse one yearly read', () => {
  const october = sweetfunMonthWindow('2026-10-01');
  const november = sweetfunMonthWindow('2026-11-01');
  assert.equal(october.start, november.start);
  assert.equal(october.end, november.end);
  assert.ok(october.start <= fetchPeriod('2026-10-01', 'month', true).start);
  assert.ok(october.end >= fetchPeriod('2026-11-01', 'month', true).end);
  assert.ok((Date.parse(october.end) - Date.parse(october.start)) / 86_400_000 <= 410);
  assert.notEqual(sweetfunMonthWindow('2027-01-01').start, october.start);
});

test('Iron Gate calendar failures retain a safe diagnostic code', () => {
  assert.equal(calendarReadError(Error('IRON_GATE_CALENDAR_UNAVAILABLE')), 'IRON_GATE_CALENDAR_UNAVAILABLE');
});
