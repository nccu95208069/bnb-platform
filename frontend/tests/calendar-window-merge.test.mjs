import test from 'node:test';
import assert from 'node:assert/strict';
import { combinedCalendarWindows, hasCalendarCoverage } from '../src/components/calendar/calendar-retention.ts';

const window = (start, end, version = '17') => ({
  period_start: start, period_end: end,
  source: { private_snapshot_version: version },
  properties: [], rooms: [],
  bookings: [{ id: `${start}:${end}`, order_id: start, property_id: 'sweetfun', room_id: '301', check_in: start, check_out: end }],
});

test('month windows join only when their dates and inventory versions agree', () => {
  const october = window('2026-09-28', '2026-11-02');
  const november = window('2026-10-26', '2026-12-07');
  const distant = window('2027-03-01', '2027-04-01');
  const merged = combinedCalendarWindows([october, november, distant], october.period_start, october.period_end);
  assert.equal(merged.period_start, october.period_start);
  assert.equal(merged.period_end, november.period_end);
  assert.equal(merged.bookings.length, 2);
  assert.equal(hasCalendarCoverage(merged, distant.period_start, distant.period_end), false);
  const newer = combinedCalendarWindows([october, window(november.period_start, november.period_end, '18')], october.period_start, october.period_end);
  assert.equal(newer.period_end, october.period_end);
});

test('overlapping cached windows cover a newly centered month without another read', () => {
  const first = window('2026-08-31', '2027-01-04');
  const next = window('2026-11-30', '2027-04-05');
  const merged = combinedCalendarWindows([first, next], '2026-09-28', '2027-02-01');
  assert.equal(merged?.period_start, '2026-08-31');
  assert.equal(merged?.period_end, '2027-04-05');
  assert.equal(combinedCalendarWindows([first], '2026-09-28', '2027-02-01'), null);
  assert.equal(combinedCalendarWindows([first, window(next.period_start, next.period_end, '18')], '2026-09-28', '2027-02-01'), null);
});
