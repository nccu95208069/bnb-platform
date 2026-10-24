import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryPropertyRepository } from '../../iron-gate/src/memory-repository.ts';
import { IronGateService } from '../../iron-gate/src/service.ts';
import { createHandler } from '../../iron-gate/src/http.ts';
import { createOsMemberProofVerifier } from '../../iron-gate/src/os-member-proof.mjs';
import { ironGateManualConfig, previewManualBooking, previewManualAmend, createManualBooking,
  amendManualBooking, cancelManualBooking, manualRequestResult } from
  '../src/lib/booking-sources/iron-gate-manual.server.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = '22222222-2222-4222-8222-222222222222';
const credentialId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const roomIds = Object.fromEntries(['101', '102', '201', '202', '301', '302']
  .map((number, index) => [number, `55555555-5555-4555-8555-55555555555${index}`]));
const secret = 'synthetic-manual-proof-secret-32-bytes';
const grant = { credentialId, clientId, workspaceId, propertyId, token: 'x'.repeat(43) };
const owner = { id: 'synthetic-owner', role: 'owner', allProperties: true,
  propertyIds: ['sweetfun'], viewPrices: true };
const key = () => crypto.randomUUID();
const stay = (checkIn = '2026-11-10', checkOut = '2026-11-12') => [
  { checkIn, checkOut, roomNumbers: ['101'] },
];

function config() {
  return ironGateManualConfig({
    CALENDAR_SOURCE: 'sheet_snapshot', IRON_GATE_SWEETFUN_MANUAL_ENABLED: 'true',
    IRON_GATE_SWEETFUN_CALENDAR_ENABLED: 'true',
    IRON_GATE_SWEETFUN_BASE_URL: 'https://iron-gate.example/',
    IRON_GATE_SWEETFUN_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_MANUAL_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_ROOM_IDS: JSON.stringify(roomIds),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET: secret,
    IRON_GATE_SWEETFUN_AUTHORITY_EPOCH: '1',
  });
}

function setup() {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId, propertyId, roomIds: Object.values(roomIds),
    version: 1, authorityEpoch: 1, readOnly: false,
    channel: { mode: 'none', ready: false, websiteSalesEnabled: false,
      grantId: null, websiteBindingId: null },
    sourceGrants: [], bookings: [], sourceLinks: [], operations: [], fences: [],
    manualBlocks: [], receipts: [] });
  const verifier = createOsMemberProofVerifier(secret);
  const service = new IronGateService(repository);
  const handle = createHandler(service, async request => {
    const claims = await verifier(request, { ...grant, origin: 'os' });
    return claims && { clientId, subjectId: claims.subjectId, origin: 'os',
      workspaceId, propertyIds: claims.propertyIds, authorityEpoch: 1,
      actions: claims.actions, fields: claims.fields };
  });
  const send = async (url, init) => handle(new Request(url, init));
  return { repository, service, send };
}

test('manual gateway stays closed without both explicit switches', () => {
  assert.throws(() => ironGateManualConfig({}), /MANUAL_CONFIG_UNAVAILABLE/);
  const c = config();
  assert.equal(c.grant.propertyId, propertyId);
});

test('OS direct booking previews, writes, amends, cancels and reads back with audit reasons', async () => {
  const { repository, send } = setup(), c = config();
  const preview = await previewManualBooking(owner, c,
    { expectedInventoryVersion: 1, stays: stay() }, send);
  assert.equal(preview.roomNights, 2);
  assert.equal(preview.externalStockVerified, false);
  const createKey = key();
  const created = await createManualBooking(owner, c, {
    expectedInventoryVersion: 1, stays: stay(), guestName: 'Synthetic Guest',
    contact: null, notes: null, totalCents: 100000, bookedAt: '2026-10-24',
  }, createKey, send);
  assert.equal(created.operationState, 'local_only');
  assert.equal(created.bookingVersion, 1);
  const receipt = await manualRequestResult(owner, c, createKey, send);
  assert.equal(receipt.bookingId, created.bookingId);
  await assert.rejects(createManualBooking(owner, c, {
    expectedInventoryVersion: 1, stays: stay(), guestName: 'Synthetic Guest',
    contact: null, notes: null, totalCents: 100000, bookedAt: '2026-10-24',
  }, key(), send), /MANUAL_VERSION_CONFLICT/);
  const movePreview = await previewManualAmend(owner, c, created.bookingId, {
    expectedBookingVersion: 1, expectedInventoryVersion: 2,
    stays: stay('2026-11-11', '2026-11-13'),
  }, send);
  assert.equal(movePreview.localRoomNightsAvailable, true);
  const amended = await amendManualBooking(owner, c, created.bookingId, {
    expectedBookingVersion: 1, expectedInventoryVersion: 2,
    reason: 'Synthetic date correction', changes: { stays: stay('2026-11-12', '2026-11-13') },
  }, key(), send);
  assert.equal(amended.bookingVersion, 2);
  const cancelled = await cancelManualBooking(owner, c, created.bookingId, {
    expectedBookingVersion: 2, expectedInventoryVersion: 3,
    reason: 'Synthetic guest requested cancellation',
  }, key(), send);
  assert.equal(cancelled.bookingVersion, 3);
  const state = await repository.read(propertyId);
  assert.equal(state.bookings[0].status, 'cancelled');
  assert.deepEqual(repository.auditRecords(propertyId).map(event => event.reason ?? null),
    [null, 'Synthetic date correction', 'Synthetic guest requested cancellation']);
});

test('manual gateway refuses viewer and cross-property principals before network access', async () => {
  const c = config();
  let calls = 0;
  const send = async () => { calls++; throw Error('must not send'); };
  for (const principal of [{ ...owner, role: 'viewer' },
    { ...owner, allProperties: false, propertyIds: ['offland'] }]) {
    await assert.rejects(previewManualBooking(principal, c,
      { expectedInventoryVersion: 1, stays: stay() }, send), /MANUAL_FORBIDDEN/);
  }
  assert.equal(calls, 0);
});

test('a lost create response is recovered by its original key without a second write', async () => {
  const { repository, send } = setup(), c = config(), requestKey = key();
  const loseResponse = async (url, init) => {
    const response = await send(url, init);
    if (init.method === 'POST' && new URL(url).pathname.endsWith('/bookings'))
      throw Error('synthetic connection reset after commit');
    return response;
  };
  await assert.rejects(createManualBooking(owner, c, {
    expectedInventoryVersion: 1, stays: stay(), guestName: 'Synthetic Guest',
    contact: null, notes: null, totalCents: null, bookedAt: null,
  }, requestKey, loseResponse), /MANUAL_RESULT_UNKNOWN/);
  const recovered = await manualRequestResult(owner, c, requestKey, send);
  assert.equal(recovered.bookingId, (await repository.read(propertyId)).bookings[0].id);
  assert.equal((await repository.read(propertyId)).bookings.length, 1);
});

test('a server error after commit remains an unknown result recoverable by the original key', async () => {
  const { repository, send } = setup(), c = config(), requestKey = key();
  const serverErrorAfterCommit = async (url, init) => {
    const response = await send(url, init);
    if (init.method === 'POST' && new URL(url).pathname.endsWith('/bookings'))
      return Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 });
    return response;
  };
  await assert.rejects(createManualBooking(owner, c, {
    expectedInventoryVersion: 1, stays: stay(), guestName: 'Synthetic Guest',
    contact: null, notes: null, totalCents: null, bookedAt: null,
  }, requestKey, serverErrorAfterCommit), /MANUAL_RESULT_UNKNOWN/);
  const recovered = await manualRequestResult(owner, c, requestKey, send);
  assert.equal(recovered.bookingId, (await repository.read(propertyId)).bookings[0].id);
});
