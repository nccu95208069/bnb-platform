import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createOsMemberProofVerifier } from '../../iron-gate/src/os-member-proof.mjs';
import { offlandIronGateCalendarConfig, readSweetfunIronGateCalendarSnapshot } from
  '../src/lib/booking-sources/iron-gate-calendar.server.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = '22222222-2222-4222-8222-222222222222';
const roomId = '55555555-5555-4555-8555-555555555555';
const bookingId = '66666666-6666-4666-8666-666666666666';
const secret = 'private-test-proof-secret-32-bytes-long';
const grant = { credentialId: '33333333-3333-4333-8333-333333333333',
  clientId: '44444444-4444-4444-8444-444444444444',
  workspaceId, propertyId, token: 'a'.repeat(43) };
const principal = { id: 'synthetic-member', role: 'owner', allProperties: false,
  propertyIds: ['offland'], viewPrices: true };

function config() {
  return offlandIronGateCalendarConfig({
    IRON_GATE_OFFLAND_CALENDAR_ENABLED: 'true',
    IRON_GATE_OFFLAND_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_OFFLAND_ROOM_IDS: JSON.stringify({ '包棟': roomId }),
    IRON_GATE_OFFLAND_OS_PROOF_SECRET: secret,
    IRON_GATE_OFFLAND_BASE_URL: 'https://iron-gate.example/',
    IRON_GATE_OFFLAND_AUTHORITY_EPOCH: '1',
  });
}

function snapshot({ inventoryVersion = 7, cells = null } = {}) {
  return { propertyId, workspaceId, from: '2027-01-02', to: '2027-01-04',
    inventoryVersion, authorityEpoch: 1, readOnly: false,
    cells: cells ?? ['2027-01-02', '2027-01-03'].map(date =>
      ({ roomId, date, state: 'sold' })),
    bookings: [{ id: bookingId, workspaceId, propertyId, version: 1,
      status: 'confirmed', channelSyncState: 'not_required', source: 'external',
      guestName: 'Synthetic Guest', totalCents: 2200000, currency: 'TWD',
      stayAmountsCents: [1000000, 1200000],
      sourceCalendar: { platform: '奧丁丁', sourceOrderRef: 'Q:SYNTHETIC12345',
        bookedAt: '2026-10-25' },
      stays: [{ checkIn: '2027-01-02', checkOut: '2027-01-03', roomIds: [roomId] },
        { checkIn: '2027-01-03', checkOut: '2027-01-04', roomIds: [roomId] }] }] };
}

test('Offland calendar uses its own grant, Q order identity and exact two-night price', async () => {
  const c = config();
  const verify = createOsMemberProofVerifier(c.proofSecret);
  const send = async (url, init) => {
    assert.match(url, new RegExp(`/v1/properties/${propertyId}/calendar-snapshot\\?`));
    assert.equal(init.headers.authorization, `Bearer ${grant.token}`);
    const claim = await verify(new Request(url, init), { ...grant, origin: 'os' });
    assert.equal(claim.subjectId, principal.id);
    assert.deepEqual(claim.fields, ['guest_name', 'payment_status', 'money']);
    return Response.json(snapshot());
  };
  const result = await readSweetfunIronGateCalendarSnapshot(
    '2027-01-02', '2027-01-04', principal, c, send);
  assert.equal(result.soldRoomNights, 2);
  assert.equal(result.bookings.length, 2);
  assert.deepEqual(result.bookings.map(b => b.room_rate), [10000, 12000]);
  assert.ok(result.bookings.every(b => b.property_id === 'offland' &&
    b.room_id === 'offland-villa' && b.room_number === '包棟' &&
    b.platform === 'owljourney' && b.payment_status === 'unknown'));
  const expected = 'SF-' + createHash('sha256').update(
    'offland-operations-sheet-v1:order:SYNTHETIC12345').digest('hex').slice(0, 20);
  assert.ok(result.bookings.every(b => b.payment_order_id === expected));
  assert.ok(result.bookings.every(b => b.owlnest_order_no === null));
});

test('Offland calendar fails closed on missing occupied night and forbids Sweetfun-only access', async () => {
  const c = config();
  await assert.rejects(readSweetfunIronGateCalendarSnapshot(
    '2027-01-02', '2027-01-04', principal, c,
    async () => Response.json(snapshot({ cells: [{ roomId, date: '2027-01-02', state: 'sold' }] }))),
  /IRON_GATE_CALENDAR_INVENTORY_DRIFT/);
  await assert.rejects(readSweetfunIronGateCalendarSnapshot(
    '2027-01-02', '2027-01-04',
    { ...principal, propertyIds: ['sweetfun'] }, c,
    async () => { throw Error('must not fetch'); }),
  /IRON_GATE_CALENDAR_FORBIDDEN/);
});

test('Offland authority flag requires an independent epoch and a single villa room', () => {
  assert.throws(() => offlandIronGateCalendarConfig({}),
    /IRON_GATE_OFFLAND_CALENDAR_CONFIG_INVALID/);
  const good = config();
  assert.equal(good.propertyKey, 'offland');
  assert.deepEqual(Object.keys(good.roomIds), ['包棟']);
});
