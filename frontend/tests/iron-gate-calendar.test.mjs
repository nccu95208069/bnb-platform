import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOsMemberProofVerifier } from '../../iron-gate/src/os-member-proof.mjs';
import { ironGateCalendarConfig, readSweetfunIronGateCalendar } from
  '../src/lib/booking-sources/iron-gate-calendar.server.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = '22222222-2222-4222-8222-222222222222';
const credentialId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const roomIds = Object.fromEntries(['101', '102', '201', '202', '301', '302']
  .map((room, i) => [room, `55555555-5555-4555-8555-55555555555${i}`]));
const secret = 'private-test-proof-secret-32-bytes-long';
const grant = { credentialId, clientId, workspaceId, propertyId,
  token: 'a'.repeat(43) };
const principal = { id: 'current-os-member', role: 'owner', allProperties: true,
  propertyIds: ['sweetfun'], viewPrices: true };

function config() {
  return ironGateCalendarConfig({
    IRON_GATE_SWEETFUN_CALENDAR_ENABLED: 'true',
    IRON_GATE_SWEETFUN_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_ROOM_IDS: JSON.stringify(roomIds),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET: secret,
    IRON_GATE_SWEETFUN_BASE_URL: 'https://iron-gate.example/',
    IRON_GATE_SWEETFUN_AUTHORITY_EPOCH: '1',
  });
}

function fixture({ version = 7, sold = true, blocked = true } = {}) {
  const booking = { id: '66666666-6666-4666-8666-666666666666',
    workspaceId, propertyId, version: 1, status: 'confirmed',
    stays: [{ checkIn: '2026-10-25', checkOut: '2026-10-26', roomIds: [roomIds['101']] }],
    guestName: 'Sample Guest' };
  const page = { propertyId, inventoryVersion: version, authorityEpoch: 1,
    readOnly: false, bookings: [booking], nextCursor: null };
  const cells = Object.entries(roomIds).map(([room, roomId]) => ({ roomId,
    date: '2026-10-25', state: room === '101' && sold ? 'sold' :
      room === '102' && blocked ? 'blocked' : 'unsold', saleReady: false }));
  const availability = { propertyId, inventoryVersion: version,
    authorityEpoch: 1, cells };
  return { page, availability };
}

function sender(data, configValue, mutate = () => {}) {
  const verify = createOsMemberProofVerifier(configValue.proofSecret);
  let calls = 0;
  return async (url, init) => {
    const request = new Request(url, init);
    const proof = await verify(request, { ...configValue.grant, origin: 'os' });
    assert.equal(proof?.subjectId, principal.id);
    assert.deepEqual(proof?.actions, ['booking:read']);
    assert.deepEqual(proof?.fields, ['guest_name']);
    assert.equal(request.headers.get('authorization'), `Bearer ${grant.token}`);
    calls++;
    const value = url.includes('/availability?') ?
      structuredClone(data.availability) : structuredClone(data.page);
    mutate(value, calls);
    return Response.json(value);
  };
}

test('Iron Gate calendar needs explicit authority epoch and separate closed switch', () => {
  assert.throws(() => ironGateCalendarConfig({}), /IRON_GATE_CALENDAR_CONFIG_INVALID/);
  assert.throws(() => ironGateCalendarConfig({
    IRON_GATE_SWEETFUN_CALENDAR_ENABLED: 'true',
    IRON_GATE_SWEETFUN_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_ROOM_IDS: JSON.stringify(roomIds),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET: secret,
    IRON_GATE_SWEETFUN_BASE_URL: 'https://iron-gate.example/',
    IRON_GATE_SWEETFUN_AUTHORITY_EPOCH: '0',
  }), /IRON_GATE_CALENDAR_CONFIG_INVALID/);
});

test('calendar reads signed booking plus inventory, preserving blocked room nights', async () => {
  const c = config();
  const data = fixture();
  const result = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c));
  assert.equal(result.inventoryVersion, 7);
  assert.equal(result.authorityEpoch, 1);
  assert.equal(result.blockedRoomNights, 1);
  assert.equal(result.soldRoomNights, 1);
  assert.equal(result.bookings.length, 2);
  assert.equal(result.bookings[0].room_number, '101');
  assert.equal(result.bookings[0].guest_name, 'Sample Guest');
  assert.equal(result.bookings[0].price_hidden, true);
  assert.equal(result.bookings[0].payment_status, 'unknown');
  assert.equal(result.bookings[1].room_number, '102');
  assert.equal(result.bookings[1].source_conflict, true);
});

test('calendar rejects inventory that omits a confirmed sold night', async () => {
  const c = config();
  await assert.rejects(readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(fixture({ sold: false }), c)),
  /IRON_GATE_CALENDAR_INVENTORY_DRIFT/);
});

test('calendar excludes a stay that checks out on the first requested day', async () => {
  const c = config();
  const data = fixture({ sold: false, blocked: false });
  data.page.bookings[0].stays[0] = {
    checkIn: '2026-10-24', checkOut: '2026-10-25', roomIds: [roomIds['101']],
  };
  const result = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c));
  assert.equal(result.bookings.length, 0);
  assert.equal(result.soldRoomNights, 0);
});

test('calendar rejects a version change before the final readback', async () => {
  const c = config();
  await assert.rejects(readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(fixture(), c, (value, calls) => {
      if (calls === 3) value.inventoryVersion++;
    })), /IRON_GATE_CALENDAR_VERSION_DRIFT/);
});

test('calendar refuses a still read-only shadow even when it has bookings', async () => {
  const c = config();
  const data = fixture();
  data.page.readOnly = true;
  await assert.rejects(readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c)), /IRON_GATE_CALENDAR_VERSION_DRIFT/);
});
