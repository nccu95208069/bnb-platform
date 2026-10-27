import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { airbnbIdentitySql, validateAirbnbIdentityManifest } from '../scripts/enrich-airbnb-group-identity.mjs';

function fixture() {
  const propertyId = '95ae9bd1-5e6d-4386-be5b-6af3c5668a16';
  const sourceSystem = 'sweetfun-calendar-sheet', sourceAccount = '1ZU1aJ4mLgysBz1UM84GLzljuWly8saF0p1HaNmAIBWc';
  const targets = Array.from({ length: 5 }, (_, i) => {
    const id = randomUUID(), roomId = randomUUID(), externalOrderId = `J:20270101000${100 + i}`;
    return { booking: { id, propertyId, workspaceId: randomUUID(), guestName: 'Synthetic Guest',
      source: 'external', status: 'confirmed', sourceKey: null, version: 1,
      currency: 'TWD', totalCents: 100000, paymentEvents: [], channelSyncState: 'not_required',
      channelOperationKey: null, stays: [{ checkIn: '2027-01-01', checkOut: '2027-01-02', roomIds: [roomId] }],
      sweetfunSnapshot: { groupKey: externalOrderId, rows: [{ room: String(i), platform: 'Airbnb',
        checkIn: '2027-01-01', checkOut: '2027-01-02', roomFeeCents: 100000,
        values: [String(i), 'Synthetic Guest', 'Airbnb', '2027/1/1', '2027/1/2', '', '1000', 'not_yet', 'OK',
          externalOrderId.slice(2), '', '', '', ''] }] } },
    link: { key: JSON.stringify([sourceSystem, sourceAccount, externalOrderId]), sourceSystem, sourceAccount,
      externalOrderId, bookingId: id, sourceVersion: `sheet-v1:${'a'.repeat(64)}`,
      lastAppliedBookingVersion: 1, diverged: false, tombstoneNights: [] } };
  });
  const manifest = { schema: 1, propertyId, requestKey: randomUUID(), expectedInventoryVersion: 10, targets,
    evidence: { orderId: 'HMTEST1234', cancelledOrderId: 'HMOLDX1234', confirmationMessageId: 'a'.repeat(16),
      cancellationMessageId: 'b'.repeat(16), mailEvidenceSha256: 'c'.repeat(64),
      verifiedAt: '2026-10-27T15:00:00Z', reservationUrl: 'https://www.airbnb.com.tw/hosting/stay/HMTEST1234',
      platformPayoutCents: 510000, internalTotalCents: 500000 } };
  const state = { propertyId, workspaceId: randomUUID(), readOnly: false, authorityEpoch: 1, version: 10,
    bookings: [...targets.map(t => t.booking), { id: randomUUID(), guestName: 'Unrelated', totalCents: 5678 }],
    sourceLinks: targets.map(t => t.link), operations: [], manualBlocks: [], receipts: [],
    roomIds: targets.flatMap(t => t.booking.stays[0].roomIds), channel: { mode: 'owlnest', ready: true } };
  return { manifest, state };
}

test('only a complete, consistently linked five-room evidence manifest is accepted', () => {
  const { manifest } = fixture();
  assert.equal(validateAirbnbIdentityManifest(manifest), manifest);
  for (const change of [m => m.targets.pop(), m => m.targets[1] = m.targets[0],
    m => m.targets[0].booking.sourceCalendar = { platform: 'airbnb', externalOrderNo: 'existing' },
    m => m.targets[0].link.lastAppliedBookingVersion = 2,
    m => m.evidence.internalTotalCents++, m => m.evidence.orderId = m.evidence.cancelledOrderId,
    m => m.targets[0].booking.paymentEvents.push({ amountCents: 1 }),
    m => m.targets[0].booking.sweetfunSnapshot.rows[0].values[13] = 'existing',
    m => m.targets[0].booking.guestName = 'Another Guest', m => m.force = true]) {
    const invalid = structuredClone(manifest); change(invalid);
    assert.throws(() => validateAirbnbIdentityManifest(invalid), /INVALID_AIRBNB_IDENTITY_MANIFEST/);
  }
});

const connectionString = process.env.IRON_GATE_IDENTITY_TEST_URL;
test('Postgres applies exactly five identities atomically and refuses drift, collisions and replay',
  { skip: !connectionString }, async () => {
    const url = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    assert.equal(url.pathname, '/iron_gate_identity_test');
    const pool = new Pool({ connectionString, max: 1 }), client = await pool.connect();
    const { manifest, state } = fixture();
    try {
      await client.query(`CREATE SCHEMA iron_gate;
        CREATE TABLE iron_gate.property_state(property_id uuid PRIMARY KEY,authority_epoch integer,
          inventory_version integer,state_json jsonb,updated_at timestamptz);
        CREATE TABLE iron_gate.outbox(event_id uuid PRIMARY KEY,property_id uuid,event_json jsonb);
        CREATE TABLE iron_gate.audit_log(audit_id uuid PRIMARY KEY,property_id uuid,audit_json jsonb);`);
      const reset = async s => {
        await client.query('ROLLBACK');
        await client.query('TRUNCATE iron_gate.property_state,iron_gate.outbox,iron_gate.audit_log');
        await client.query('INSERT INTO iron_gate.property_state VALUES ($1,1,10,$2,now())', [manifest.propertyId, s]);
      };
      const read = async () => (await client.query('SELECT state_json FROM iron_gate.property_state')).rows[0].state_json;
      await reset(state);
      await client.query(airbnbIdentitySql(manifest));
      assert.deepEqual(await read(), state, 'dry run must roll back every field');
      for (const change of [s => s.bookings[4].totalCents++, s => s.sourceLinks[4].sourceVersion += 'x',
        s => s.sourceLinks.push(s.sourceLinks[0]),
        s => s.bookings[5].sourceCalendar = { platform: 'airbnb', externalOrderNo: manifest.evidence.orderId },
        s => s.readOnly = true]) {
        const drift = structuredClone(state); change(drift); await reset(drift);
        await assert.rejects(client.query(airbnbIdentitySql(manifest, false)));
        await client.query('ROLLBACK');
        assert.deepEqual(await read(), drift, 'late failure must roll back earlier targets');
        assert.equal((await client.query('SELECT count(*)::int n FROM iron_gate.audit_log')).rows[0].n, 0);
      }
      await reset(state);
      await client.query(airbnbIdentitySql(manifest, false));
      const expected = structuredClone(state); expected.version++;
      for (const b of expected.bookings.slice(0, 5)) { b.version++;
        b.sourceCalendar = { platform: 'airbnb', externalOrderNo: manifest.evidence.orderId }; }
      for (const l of expected.sourceLinks) l.lastAppliedBookingVersion++;
      assert.deepEqual(await read(), expected, 'money, occupancy, immutable import and other orders must stay identical');
      for (const table of ['outbox', 'audit_log'])
        assert.equal((await client.query(`SELECT count(*)::int n FROM iron_gate.${table}`)).rows[0].n, 5);
      const audit = (await client.query('SELECT audit_json FROM iron_gate.audit_log')).rows[0].audit_json;
      assert.equal(audit.amountDifferenceCents, 10000); assert.equal(audit.financialChangeApplied, false);
      await assert.rejects(client.query(airbnbIdentitySql(manifest, false)));
      await client.query('ROLLBACK'); assert.deepEqual(await read(), expected);
      assert.equal((await client.query('SELECT count(*)::int n FROM iron_gate.audit_log')).rows[0].n, 5);
    } finally {
      await client.query('ROLLBACK'); await client.query('DROP SCHEMA IF EXISTS iron_gate CASCADE');
      client.release(); await pool.end();
    }
  });
