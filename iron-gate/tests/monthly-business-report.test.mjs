import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessReport } from '../src/business-report.ts';
const now = new Date('2026-10-24T02:00:00Z');
const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = '22222222-2222-4222-8222-222222222222';
const roomId = '33333333-3333-4333-8333-333333333333';
const booking = (id) => ({ id, workspaceId, propertyId, version: 1, status: 'confirmed',
  channelSyncState: 'not_required', channelOperationKey: null,
  stays: [{ roomIds: [roomId], checkIn: '2026-10-24', checkOut: '2026-10-25' }],
  guestName: 'PRIVATE-GUEST', contact: 'private@example.test', notes: 'PRIVATE-NOTE',
  totalCents: 100000, currency: 'TWD', bookedAt: '2026-10-23', createdAt: now.toISOString(),
  source: 'external', sourceKey: null, paymentEvents: [],
  sourceCalendar: { platform: 'Booking', externalOrderNo: null } });
const state = (bookings) => ({ workspaceId, propertyId, roomIds: [roomId], version: 42, authorityEpoch: 7,
  readOnly: false, channel: { mode: 'none', ready: false, websiteSalesEnabled: false, grantId: null, websiteBindingId: null },
  sourceGrants: [], bookings, sourceLinks: [], operations: [], fences: [], manualBlocks: [], receipts: [] });

test('monthly shares the same report snapshot and does not leak identifiers or guest data', () => {
  const snapshot = state([booking('PRIVATE-ID')]);
  const before = structuredClone(snapshot);
  const report = createBusinessReport(snapshot, () => false, now);
  assert.equal(report.monthly.schemaVersion, 1);
  assert.equal(report.monthly.generatedAt, report.generatedAt);
  const october = report.monthly.months.find(m => m.year === 2026 && m.month === 10);
  assert.equal(october.confirmedRoomNights, 1);
  assert.equal(october.bookingsWithStay, 1);
  assert.equal(october.roomFeeCents, 100000);
  assert.equal(report.meta.inventoryVersion, 42);
  for (const value of [workspaceId, propertyId, roomId, 'PRIVATE', 'private@example.test'])
    assert.equal(JSON.stringify(report.monthly).includes(value), false);
  assert.deepEqual(snapshot, before);
});

test('monthly-only invalid data cannot take the working daily report down', () => {
  const report = createBusinessReport(state([booking('a'), booking('b')]), () => false, now);
  assert.equal(report.monthly, null);
  assert.equal(report.yesterday.orders, 2);
});
