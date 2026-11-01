import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessReport } from '../src/business-report.ts';
import { MemoryPropertyRepository } from '../src/memory-repository.ts';
import { IronGateService } from '../src/service.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = '22222222-2222-4222-8222-222222222222';
const roomId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-11-01T02:00:00.000Z');
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
const booking = (id, dates, amounts, overrides = {}) => ({
  id, workspaceId, propertyId, version: 1, status: 'confirmed',
  channelSyncState: 'not_required', channelOperationKey: null,
  stays: dates.map(day => ({ roomIds: [roomId], checkIn: day, checkOut: nextDay(day) })),
  guestName: 'PRIVATE-GUEST', contact: 'private@example.test', notes: 'PRIVATE-NOTE',
  totalCents: amounts.reduce((sum, amount) => sum + amount, 0), currency: 'TWD',
  bookedAt: '2026-10-31', createdAt: now.toISOString(),
  source: 'external', sourceKey: null, paymentEvents: [],
  roomNightPrices: dates.map((date, i) => ({ roomId, date, amountCents: amounts[i] })),
  offlandSnapshot: { groupKey: `PRIVATE-ORDER-${id}`, rows: dates.map((date, i) => ({
    room: i ? 'OFFLAND(連住)' : 'OFFLAND', checkIn: date, checkOut: nextDay(date), bookedAt: '2026/10/31',
    roomFeeCents: amounts[i],
    values: [i ? 'OFFLAND(連住)' : 'OFFLAND', 'PRIVATE-GUEST', 'Booking', date, nextDay(date), '2026/10/31',
      amounts[i] / 100, 'done', '', 'PRIVATE-SOURCE-ROW', 'PRIVATE-NOTE', '', '', '', '', '', `PRIVATE-ORDER-${id}`],
  })) }, ...overrides,
});
const state = (bookings, overrides = {}) => ({
  workspaceId, propertyId, roomIds: [roomId], version: 42, authorityEpoch: 1, readOnly: false,
  offlandImport: { sourceId: 'synthetic-offland', capturedAt: '2026-10-25T00:00:00.000Z' },
  channel: { mode: 'none', ready: false, websiteSalesEnabled: false, grantId: null, websiteBindingId: null },
  sourceGrants: [], bookings, sourceLinks: [], operations: [], fences: [], manualBlocks: [], receipts: [], ...overrides,
});
const month = (report, year, value) => report.monthly.months.find(m => m.year === year && m.month === value);
const report = (bookings, options = {}, at = now) => createBusinessReport(state(bookings, options), () => false, at);

test('OFFLAND combines imported and new source bookings into 16 confirmed nights at 60 percent', () => {
  const dates = Array.from({ length: 16 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
  const imported = [1, 1, 1, 1, 2, 2, 2, 2];
  let offset = 0;
  const orders = imported.map((count, i) => {
    const stay = dates.slice(offset, offset += count);
    return booking(`import-${i}`, stay, stay.map(() => 100000));
  });
  orders.push(booking('new-booking', dates.slice(12, 13), [100000], {
    offlandSnapshot: undefined, sourceCalendar: { platform: 'Booking', externalOrderNo: 'PRIVATE-NEW-REF' },
  }));
  orders.push(booking('new-airbnb', dates.slice(13), [100000, 100000, 100000], {
    offlandSnapshot: undefined, sourceCalendar: { platform: 'Airbnb', externalOrderNo: 'PRIVATE-NEW-REF' },
  }));
  const result = report(orders), december = month(result, 2026, 12);
  assert.equal(december.confirmedRoomNights, 16);
  assert.equal(december.paidRoomNights, 16);
  assert.equal(december.bookingsWithStay, 10);
  assert.equal(december.capacityRoomNights, 31);
  assert.equal(december.occupancyPct, 51.6);
  assert.equal(december.roomFeeCents, 1600000);
  assert.equal(december.estimatedNetProfit, 9600);
  assert.equal(result.monthly.netProfitRatio, 0.6);
  assert.equal(result.yesterday.orders, 10);
  assert.equal(result.yesterday.nights, 16);
  assert.equal(result.meta.unknownPlatformBookings, 0);
  assert.equal(result.yesterday.detail.every(row => row.room === '包棟'), true);
});

test('OFFLAND exact imported prices split across months and preserve original date fallback without exposing evidence', () => {
  const first = booking('PRIVATE-ID', ['2026-11-30', '2026-12-01'], [100001, 299999], { bookedAt: null });
  const snapshot = state([first]), before = structuredClone(snapshot);
  const result = createBusinessReport(snapshot, () => false, now);
  assert.equal(month(result, 2026, 11).roomFeeCents, 100001);
  assert.equal(month(result, 2026, 12).roomFeeCents, 299999);
  assert.equal(result.yesterday.orders, 1);
  assert.equal(result.yesterday.amount, 4000);
  assert.equal(result.meta.unknownBookingDateOrders, 0);
  assert.equal(result.meta.estimatedNightRevenueOrders, 0);
  assert.deepEqual(result.grids.next7Nights.rooms.map(row => row.room), ['包棟']);
  for (const secret of [workspaceId, propertyId, roomId, 'PRIVATE', 'private@example.test', 'synthetic-offland'])
    assert.equal(JSON.stringify(result).includes(secret), false, secret);
  assert.deepEqual(snapshot, before);
});

test('OFFLAND separates zero and unknown prices from confirmed nights and excludes held or cancelled orders', () => {
  const result = report([
    booking('paid', ['2026-12-01'], [100000]),
    booking('zero', ['2026-12-02'], [0]),
    booking('unknown', ['2026-12-03'], [0], { totalCents: null, roomNightPrices: undefined }),
    booking('cancelled', ['2026-12-04'], [100000], { status: 'cancelled' }),
    booking('held', ['2026-12-05'], [100000], { status: 'held' }),
  ]);
  const december = month(result, 2026, 12);
  assert.equal(december.confirmedRoomNights, 3);
  assert.equal(december.paidRoomNights, 1);
  assert.equal(december.zeroPriceRoomNights, 1);
  assert.equal(december.unknownPriceRoomNights, 1);
  assert.equal(december.roomFeeCents, 100000);
  assert.equal(december.estimatedNetProfit, 600);
  assert.equal(result.meta.excludedUnconfirmedOrders, 2);
});

test('current source metadata never reuses stale OFFLAND snapshot dates, platforms or unequal night prices', () => {
  const changed = booking('changed', ['2026-10-31', '2026-11-01'], [100000, 300000], {
    version: 2, bookedAt: null, roomNightPrices: undefined,
    sourceCalendar: { platform: null, externalOrderNo: 'PRIVATE-NEW-REF' },
  });
  const result = report([changed]);
  assert.equal(result.meta.unknownBookingDateOrders, 1);
  assert.equal(result.meta.unknownPlatformBookings, 1);
  assert.equal(result.meta.estimatedNightRevenueOrders, 1);
  assert.equal(result.yesterday.lastNight.revenue, 2000);
  assert.equal(result.yesterday.orders, 0);
  assert.deepEqual(result.today.tonight.occupied, ['包棟']);
});

test('Sweetfun and generic property ratios remain 68 percent and do not inherit the OFFLAND room label', () => {
  const item = booking('sweetfun', ['2026-12-01'], [100000], { offlandSnapshot: undefined });
  for (const extra of [{}, { sweetfunImport: { sourceId: 'synthetic-sweetfun' } }]) {
    const result = report([item], { offlandImport: undefined, ...extra });
    assert.equal(result.monthly.netProfitRatio, 0.68);
    assert.equal(month(result, 2026, 12).estimatedNetProfit, 680);
    assert.equal(result.yesterday.detail[0].room, '房間 1');
  }
});

test('contradictory property import markers cannot choose a reporting profile', () => {
  assert.throws(() => report([], { sweetfunImport: { sourceId: 'synthetic-sweetfun' } }),
    error => error?.code === 'REPORT_DATA_INVALID');
});

test('aggregate service supports OFFLAND exact room-night amounts without adding permissions or writes', async () => {
  const repository = new MemoryPropertyRepository();
  repository.seed(state([booking('scoped', ['2026-12-01', '2026-12-02'], [100001, 299999])]));
  const before = await repository.read(propertyId);
  const actor = { clientId: 'dashboard-reporter', subjectId: 'dashboard-reporter', origin: 'service',
    workspaceId, propertyIds: [propertyId], authorityEpoch: 1, actions: ['booking:aggregate'], fields: [] };
  const service = new IronGateService(repository);
  const result = await service.businessReport(actor, propertyId);
  const december = month(result, 2026, 12);
  assert.equal(december.roomFeeCents, 400000);
  assert.equal(december.confirmedRoomNights, 2);
  assert.equal(december.estimatedNetProfit, 2400);
  assert.equal(result.meta.unknownPlatformBookings, 0);
  await assert.rejects(service.businessReport({ ...actor, propertyIds: ['44444444-4444-4444-8444-444444444444'] }, propertyId),
    error => error?.code === 'FORBIDDEN');
  assert.deepEqual(await repository.read(propertyId), before);
});
