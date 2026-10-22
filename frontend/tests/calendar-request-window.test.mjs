import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPeriod, monthReadWindow } from '../src/components/calendar/calendar-utils.ts';
import { calendarReadError } from '../src/lib/booking-sources/calendar-reader.ts';

test('month view reads its visible grid instead of the entire 2025–2027 archive', () => {
  assert.deepEqual(fetchPeriod('2026-10-22', 'month'), {
    start: '2026-09-28', end: '2026-11-02', label: '2026年10月',
  });
  assert.deepEqual(fetchPeriod('2026-11-22', 'month'), {
    start: '2026-10-26', end: '2026-12-07', label: '2026年11月',
  });
});

test('background month reads cover the neighboring panels in one bounded window', () => {
  const october = monthReadWindow('2026-10-01');
  assert.equal(october.start, fetchPeriod('2026-08-01', 'month').start);
  assert.equal(october.end, fetchPeriod('2026-12-01', 'month').end);
  assert.ok(october.start > '2025-01-01');
  assert.ok(october.end < '2027-02-01');
});

test('week and day requests remain bounded to their selected dates', () => {
  assert.deepEqual(fetchPeriod('2026-10-22', 'week'), {
    start: '2026-10-12', end: '2026-11-02', label: 'three-week-window',
  });
  assert.deepEqual(fetchPeriod('2026-10-22', 'day'), {
    start: '2026-10-22', end: '2026-10-23', label: 'single-day-window',
  });
});

test('Iron Gate calendar failures retain a safe diagnostic code', () => {
  assert.equal(calendarReadError(Error('IRON_GATE_CALENDAR_UNAVAILABLE')), 'IRON_GATE_CALENDAR_UNAVAILABLE');
});
