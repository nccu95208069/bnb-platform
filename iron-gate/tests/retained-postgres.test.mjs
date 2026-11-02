import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PostgresPropertyRepository } from '../src/postgres-repository.mjs';
import { IronGateService } from '../src/service.ts';
import { inspectProperty } from '../scripts/check-property-integrity.mjs';
import { key, code, retentionFixture, retain, retainReason } from './retained-fixture.mjs';

const connectionString = process.env.IRON_GATE_PG_TEST_URL;
function localPool() {
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/iron_gate_test');
  return new Pool({ connectionString, max: 4 });
}

test('Postgres retains the same order and receipt across reconnect and protects rescheduled stays from old source events',
  { skip: !connectionString }, async () => {
    let pool = localPool();
    try {
      const f = await retentionFixture({ repository: new PostgresPropertyRepository(pool) });
      const initial = await f.read(), applied = await retain(f), source = await f.sourceInput();
      let integrity = await inspectProperty(pool, f.propertyId);
      assert.equal(integrity.ok, true);
      assert.equal(integrity.counts.expectedRoomNights, 1);
      await pool.end(); pool = localPool();
      const repository = new PostgresPropertyRepository(pool), service = new IronGateService(repository);
      assert.deepEqual(await service.retainBooking(f.owner, f.propertyId, f.bookingId,
        applied.requestKey, applied.input), applied.response);
      let state = await repository.read(f.propertyId), booking = state.bookings.find(b => b.id === f.bookingId);
      assert.equal(booking.status, 'retained');
      assert.deepEqual(booking.stays, []);
      assert.deepEqual(booking.offlandSnapshot, initial.booking.offlandSnapshot);
      assert.deepEqual(booking.paymentEvents, initial.booking.paymentEvents);
      const input = { expectedBookingVersion: booking.version, expectedInventoryVersion: state.version,
        reason: 'Synthetic database reschedule', totalCents: 1400000,
        stays: [{ checkIn: '2027-04-04', checkOut: '2027-04-06', roomIds: [f.roomId] }] };
      const requestKey = key();
      const result = await service.rescheduleBooking(f.owner, f.propertyId, f.bookingId, requestKey, input);
      assert.deepEqual(await service.rescheduleBooking(f.owner, f.propertyId, f.bookingId, requestKey, input), result);
      state = await repository.read(f.propertyId); booking = state.bookings.find(b => b.id === f.bookingId);
      assert.equal(booking.id, initial.booking.id);
      assert.deepEqual(booking.stays, input.stays);
      assert.deepEqual(state.sourceLinks, initial.state.sourceLinks);
      source.kind = 'cancel'; source.expectedInventoryVersion = state.version;
      assert.equal((await service.applySourceEvent(f.source, key(), source)).reason, 'ORDER_LIFECYCLE_OWNER_MANAGED');
      const afterSource = await repository.read(f.propertyId);
      assert.deepEqual(afterSource.bookings.find(b => b.id === f.bookingId).stays, input.stays);
      assert.deepEqual(afterSource.fences, []);
      assert.deepEqual(afterSource.bookings.find(b => b.id === f.bookingId).paymentEvents, initial.booking.paymentEvents);
      integrity = await inspectProperty(pool, f.propertyId);
      assert.equal(integrity.ok, true);
      assert.equal(integrity.counts.expectedRoomNights, 3);
      assert.deepEqual((await repository.events(f.propertyId, 0, 100)).map(e => e.type),
        ['booking.retained', 'booking.rescheduled', 'source.lifecycle_review_required']);
    } finally { await pool.end(); }
  });

test('Postgres late audit failure rolls back retention state, occupancy, outbox and idempotency receipt together',
  { skip: !connectionString }, async () => {
    const pool = localPool();
    let failAudit = false;
    const faultPool = { connect: async () => {
      const client = await pool.connect();
      return { query: (...args) => {
        if (failAudit && /INSERT INTO iron_gate\.audit_log/.test(args[0])) {
          throw new Error('SYNTHETIC_LATE_AUDIT_FAILURE');
        }
        return client.query(...args);
      }, release: () => client.release() };
    } };
    try {
      const f = await retentionFixture({ repository: new PostgresPropertyRepository(faultPool) });
      const initial = await f.read(), input = await f.retainInput(), requestKey = key();
      failAudit = true;
      await assert.rejects(f.service.retainBooking(f.owner, f.propertyId, f.bookingId, requestKey, input),
        /SYNTHETIC_LATE_AUDIT_FAILURE/);
      assert.deepEqual(await f.read(), initial);
      assert.deepEqual(await f.repository.events(f.propertyId, 0, 100), []);
      let integrity = await inspectProperty(pool, f.propertyId);
      assert.equal(integrity.ok, true);
      assert.equal(integrity.counts.expectedRoomNights, 3);
      failAudit = false;
      await f.service.retainBooking(f.owner, f.propertyId, f.bookingId, requestKey, input);
      const retained = await f.read();
      const rescheduleInput = await f.rescheduleInput(), rescheduleKey = key();
      failAudit = true;
      await assert.rejects(f.service.rescheduleBooking(f.owner, f.propertyId, f.bookingId,
        rescheduleKey, rescheduleInput), /SYNTHETIC_LATE_AUDIT_FAILURE/);
      assert.deepEqual(await f.read(), retained);
      assert.equal((await f.repository.events(f.propertyId, 0, 100)).length, 1);
      integrity = await inspectProperty(pool, f.propertyId);
      assert.equal(integrity.ok, true);
      assert.equal(integrity.counts.expectedRoomNights, 1);
      failAudit = false;
      await f.service.rescheduleBooking(f.owner, f.propertyId, f.bookingId, rescheduleKey, rescheduleInput);
      assert.equal((await f.read()).booking.status, 'confirmed');
      assert.equal((await f.read()).state.receipts.length, 2);
    } finally { await pool.end(); }
  });

test('Postgres concurrent reschedules commit exactly one last-room winner and leave the loser retained',
  { skip: !connectionString }, async () => {
    const pool = localPool();
    try {
      const f = await retentionFixture({ repository: new PostgresPropertyRepository(pool) });
      await retain(f);
      let { state } = await f.read();
      const other = state.bookings.find(b => b.id === f.otherBookingId);
      await f.service.retainBooking(f.owner, f.propertyId, other.id, key(), {
        expectedBookingVersion: other.version, expectedInventoryVersion: state.version, reason: retainReason });
      ({ state } = await f.read());
      const input = await f.rescheduleInput();
      const results = await Promise.allSettled([f.bookingId, f.otherBookingId].map(id =>
        f.service.rescheduleBooking(f.owner, f.propertyId, id, key(), {
          ...input, expectedBookingVersion: state.bookings.find(b => b.id === id).version })));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter(r => r.status === 'rejected' && code('VERSION_CONFLICT')(r.reason)).length, 1);
      ({ state } = await f.read());
      assert.equal(state.bookings.filter(b => b.status === 'retained').length, 1);
      assert.equal(state.bookings.filter(b => b.status === 'confirmed').length, 1);
      assert.equal(state.receipts.length, 3);
      const integrity = await inspectProperty(pool, f.propertyId);
      assert.equal(integrity.ok, true);
      assert.equal(integrity.counts.expectedRoomNights, 2);
    } finally { await pool.end(); }
  });
