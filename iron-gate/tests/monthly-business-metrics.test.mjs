import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMonthlyBusinessMetrics, priorYearDay } from '../src/monthly-business-metrics.ts';
import { computeBusinessMetrics } from '../src/business-metrics.ts';
const now = new Date('2026-10-24T02:00:00Z');
const b = (id, stays, rest = {}) => ({ id, stays, status: 'confirmed', totalCents: 100000,
  bookedAt: '2026-10-23', platform: 'Booking', paid: false, ...rest });
const stay = (room, checkIn, checkOut, amountCents) => ({ room, checkIn, checkOut,
  ...(amountCents === undefined ? {} : { amountCents }) });
const report = (rows, more = {}) => computeMonthlyBusinessMetrics(rows, { now, roomCount: 6, ...more });
const month = (r, y = 2026, m = 10) => r.months.find(v => v.year === y && v.month === m);

test('multi-room, multi-night and cross-month amounts are conserved to a cent', () => {
  const r = report([b('one', [stay('101', '2026-10-31', '2026-11-02'), stay('102', '2026-10-31', '2026-11-02')], { totalCents: 400001 })]);
  const oct = month(r), nov = month(r, 2026, 11);
  assert.equal(oct.confirmedRoomNights, 2); assert.equal(nov.confirmedRoomNights, 2);
  assert.equal(oct.bookingsWithStay, 1); assert.equal(nov.bookingsWithStay, 1);
  assert.equal(oct.roomFeeCents, 200001); assert.equal(nov.roomFeeCents, 200000);
  assert.equal(oct.roomFeeCents + nov.roomFeeCents, 400001);
  assert.equal(oct.estimatedAllocationOrders, 1);
});

test('exact nightly amounts, no checkout night, no private identifiers in monthly response', () => {
  const r = report([b('PRIVATE-ID', [stay('101', '2026-10-31', '2026-11-01', 120000), stay('101', '2026-11-01', '2026-11-02', 180000)], { totalCents: 300000, guestName: 'PRIVATE-GUEST' })]);
  assert.equal(month(r).roomFeeCents, 120000);
  assert.equal(month(r, 2026, 11).roomFeeCents, 180000);
  assert.equal(month(r).estimatedAllocationOrders, 0);
  assert.equal(month(r).estimatedNetProfit, 816);
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false);
});

test('identical replay is counted once; conflicting duplicates fail', () => {
  const order = b('one', [stay('101', '2026-10-23', '2026-10-25')]);
  assert.equal(month(report([order, structuredClone(order)])).bookingsWithStay, 1);
  assert.equal(month(report([order, structuredClone(order)])).confirmedRoomNights, 2);
  assert.throws(() => report([order, { ...order, status: 'cancelled' }]));
});

test('zero fees, unknown fees, held and cancelled remain distinct', () => {
  const r = report([
    b('free', [stay('101', '2026-10-24', '2026-10-25')], { totalCents: 0 }),
    b('unknown', [stay('102', '2026-10-24', '2026-10-25')], { totalCents: null }),
    b('held', [stay('201', '2026-10-24', '2026-10-25')], { status: 'held' }),
    b('cancelled', [stay('202', '2026-10-24', '2026-10-25')], { status: 'cancelled' }),
  ]);
  const oct = month(r);
  assert.equal(oct.confirmedRoomNights, 2); assert.equal(oct.bookingsWithStay, 2);
  assert.equal(oct.zeroPriceRoomNights, 1); assert.equal(oct.unknownPriceRoomNights, 1);
  assert.equal(oct.paidRoomNights, 0); assert.equal(oct.averagePaidNightFee, null);
  assert.equal(oct.unpricedOrders, 1); assert.equal(oct.roomFeeCents, 0);
});

test('approximate last-year pace prefers original date and tolerates missing dates without hiding results', () => {
  const r = report([
    b('old-early', [stay('101', '2025-10-01', '2025-10-02')], { bookedAt: '2025-09-01' }),
    b('old-original', [stay('102', '2025-10-31', '2025-11-01')], { bookedAt: '2025-10-24', firstNotificationAt: '2025-10-25T01:00:00Z' }),
    b('old-late', [stay('201', '2025-10-31', '2025-11-01')], { bookedAt: '2025-10-25' }),
    b('old-unknown', [stay('202', '2025-10-31', '2025-11-01')], { bookedAt: null }),
    b('old-notification', [stay('301', '2025-10-31', '2025-11-01')], { bookedAt: null, firstNotificationAt: '2025-10-23T16:00:00Z' }),
    b('new', [stay('101', '2026-10-24', '2026-10-25')]),
  ]);
  assert.equal(month(r).lyByToday, 3); assert.equal(month(r).lyTotal, 5);
  assert.equal(month(r).lyUnknownDateOrders, 1);
  assert.equal(month(r).comparisonMode, 'prior-year-cutoff-estimate');
});

test('completed months compare full same-month totals, not a global cutoff', () => {
  const r = report([
    b('old', [stay('101', '2025-07-01', '2025-07-03')], { bookedAt: null }),
    b('new', [stay('101', '2026-07-01', '2026-07-04')]),
  ]);
  assert.equal(month(r, 2026, 7).lyByToday, 2);
  assert.equal(month(r, 2026, 7).lyTotal, 2);
  assert.equal(month(r, 2026, 7).comparisonMode, 'prior-month-total-estimate');
});

test('missing history is null, while an empty month within observed history is zero', () => {
  const r = report([b('history', [stay('101', '2025-10-01', '2025-10-02')], { bookedAt: '2025-09-01' })]);
  assert.equal(month(r, 2026, 9).lyByToday, null);
  assert.equal(month(r, 2026, 9).comparisonMode, 'history-unavailable');
  assert.equal(month(r, 2026, 11).lyByToday, 0);
  assert.equal(month(r, 2026, 11).lyTotal, 0);
  assert.equal(r.firstObservedStayDate, '2025-10-01');
  assert.equal(r.months.some(m => m.year === 2024), false);
});

test('Taipei boundary and leap day use calendar dates', () => {
  const r = report([], { now: new Date('2026-10-31T16:00:00Z') });
  assert.equal(r.date, '2026-11-01'); assert.equal(r.comparisonCutoff, '2025-11-01');
  assert.equal(r.months[0].month, 11);
  assert.equal(priorYearDay('2024-02-29'), '2023-02-28');
  assert.throws(() => priorYearDay('2024-02-30'));
});

test('all allocations equal existing daily allocation, including incomplete explicit allocations', () => {
  const orders = [b('p', [stay('101', '2026-10-23', '2026-10-24', 123401), stay('102', '2026-10-23', '2026-10-25')], { totalCents: 300002 })];
  const daily = computeBusinessMetrics(orders, { now });
  const monthly = month(report(orders));
  assert.equal(monthly.roomFeeCents, 300002);
  assert.equal(monthly.confirmedRoomNights, daily.yesterday.nights);
  assert.equal(monthly.roomFeeCents / 100, daily.yesterday.amount);
});

test('active room-night conflicts never become an apparently valid occupancy rate', () => {
  assert.throws(() => report([b('a', [stay('101', '2026-10-24', '2026-10-25')]), b('b', [stay('101', '2026-10-24', '2026-10-25')])]));
});

test('invalid amounts or options are rejected; cancellation does not shift observed history forward', () => {
  assert.throws(() => report([], { roomCount: 0 }));
  assert.throws(() => report([], { netProfitRatio: 2 }));
  assert.throws(() => report([b('bad', [stay('101', '2026-10-24', '2026-10-25')], { totalCents: -1 })]));
  const r = report([b('old-cancelled', [stay('101', '2025-10-01', '2025-10-02')], { status: 'cancelled' })]);
  assert.equal(r.firstObservedStayDate, '2025-10-01'); assert.equal(month(r).lyByToday, 0);
});

test('an empty source does not assert complete historical coverage', () => {
  const r = report([]);
  assert.equal(r.months.length, 7); assert.equal(r.firstObservedStayDate, null);
  assert.equal(month(r).lyByToday, null); assert.equal(month(r).roomFeeCents, 0);
});
