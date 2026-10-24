import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryPropertyRepository } from '../../iron-gate/src/memory-repository.ts';
import { IronGateService } from '../../iron-gate/src/service.ts';
import { createHandler } from '../../iron-gate/src/http.ts';
import { createOsMemberProofVerifier } from '../../iron-gate/src/os-member-proof.mjs';
import { ironGateManualConfig, previewManualBooking, previewManualAmend, createManualBooking,
  amendManualBooking, cancelManualBooking, manualRequestResult } from
  '../src/lib/booking-sources/iron-gate-manual.server.ts';
import { ironGateManualPaymentConfig, readManualPayment, recordManualPayment,
  manualPaymentRequestResult } from
  '../src/lib/booking-sources/iron-gate-manual-payment.server.ts';

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

function config(overrides = {}) {
  return ironGateManualPaymentConfig({
    CALENDAR_SOURCE: 'sheet_snapshot', IRON_GATE_SWEETFUN_MANUAL_ENABLED: 'true',
    IRON_GATE_SWEETFUN_CALENDAR_ENABLED: 'true',
    IRON_GATE_SWEETFUN_BASE_URL: 'https://iron-gate.example/',
    IRON_GATE_SWEETFUN_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_MANUAL_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_MANUAL_PAYMENTS_ENABLED: 'true',
    IRON_GATE_SWEETFUN_MANUAL_PAYMENT_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_ROOM_IDS: JSON.stringify(roomIds),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET: secret,
    IRON_GATE_SWEETFUN_AUTHORITY_EPOCH: '1',
    ...overrides,
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
  assert.throws(() => ironGateManualPaymentConfig({}), /MANUAL_CONFIG_UNAVAILABLE/);
  assert.throws(() => config({ IRON_GATE_SWEETFUN_MANUAL_PAYMENTS_ENABLED: 'false' }),
    /MANUAL_CONFIG_UNAVAILABLE/);
  const c = config();
  assert.equal(c.grant.propertyId, propertyId);
});

test('manual direct receipts and refunds use Iron Gate exactly once and read back', async () => {
  const { repository, send } = setup(), c = config();
  const created = await createManualBooking(owner, c, {
    expectedInventoryVersion: 1, stays: stay(), guestName: 'Synthetic Guest',
    contact: null, notes: null, totalCents: 100000, bookedAt: null,
  }, key(), send);
  const before = await readManualPayment(owner, c, created.bookingId, send);
  assert.equal(before.netReceivedCents, 0);
  const receivedKey = key();
  const receivedInput = { expectedBookingVersion: before.version, kind: 'received',
    amountCents: 40000, evidenceRef: 'synthetic bank receipt 1',
    occurredAt: '2026-10-24T00:00:00.000Z' };
  const received = await recordManualPayment(owner, c, created.bookingId,
    receivedInput, receivedKey, send);
  assert.equal(received.netReceivedCents, 40000);
  assert.deepEqual(await recordManualPayment(owner, c, created.bookingId,
    receivedInput, receivedKey, send), received);
  await assert.rejects(recordManualPayment(owner, c, created.bookingId,
    { ...receivedInput, amountCents: 41000 }, receivedKey, send),
  /IDEMPOTENCY_CONFLICT/);
  assert.equal((await manualPaymentRequestResult(owner, c, receivedKey, send)).paymentEventId,
    receivedKey);
  await assert.rejects(recordManualPayment(owner, c, created.bookingId, {
    ...receivedInput, expectedBookingVersion: 2, kind: 'refunded', amountCents: 50000,
  }, key(), send), /REFUND_EXCEEDS_RECEIVED/);
  const refunded = await recordManualPayment(owner, c, created.bookingId, {
    ...receivedInput, expectedBookingVersion: 2, kind: 'refunded', amountCents: 15000,
    evidenceRef: 'synthetic refund 1',
  }, key(), send);
  assert.equal(refunded.netReceivedCents, 25000);
  const after = await readManualPayment(owner, c, created.bookingId, send);
  assert.equal(after.events.length, 2);
  assert.equal((await repository.read(propertyId)).bookings[0].paymentEvents.length, 2);
});

test('manual payment gateway blocks another property and preserves ambiguous writes', async () => {
  const { repository, send } = setup(), c = config();
  const created = await createManualBooking(owner, c, {
    expectedInventoryVersion: 1, stays: stay(), guestName: 'Synthetic Guest',
    contact: null, notes: null, totalCents: null, bookedAt: null,
  }, key(), send);
  let calls = 0;
  await assert.rejects(readManualPayment({ ...owner, allProperties: false,
    propertyIds: ['offland'] }, c, created.bookingId,
  async () => { calls++; throw Error('must not send'); }), /MANUAL_FORBIDDEN/);
  assert.equal(calls, 0);
  const requestKey = key();
  const input = { expectedBookingVersion: 1, kind: 'received', amountCents: 10000,
    evidenceRef: 'synthetic cash receipt', occurredAt: '2026-10-24T00:00:00.000Z' };
  const serverErrorAfterCommit = async (url, init) => {
    const response = await send(url, init);
    if (init.method === 'POST' && new URL(url).pathname.endsWith('/payment-events'))
      return Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 });
    return response;
  };
  await assert.rejects(recordManualPayment(owner, c, created.bookingId,
    input, requestKey, serverErrorAfterCommit), /MANUAL_RESULT_UNKNOWN/);
  const recovered = await manualPaymentRequestResult(owner, c, requestKey, send);
  assert.equal(recovered.netReceivedCents, 10000);
  assert.equal((await repository.read(propertyId)).bookings[0].paymentEvents.length, 1);
  await repository.transact(propertyId, state => {
    state.bookings[0].source = 'external';
  });
  await assert.rejects(readManualPayment(owner, c, created.bookingId, send),
    /MANUAL_READBACK_MISMATCH/);
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
