import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryPropertyRepository } from '../../iron-gate/src/memory-repository.ts';
import { IronGateService } from '../../iron-gate/src/service.ts';
import { createHandler } from '../../iron-gate/src/http.ts';
import { createChannelWorker } from '../../iron-gate/src/channel-worker.mjs';
import { manualError } from '../src/lib/booking-sources/iron-gate-manual-route.server.ts';
import { createOsMemberProofVerifier } from '../../iron-gate/src/os-member-proof.mjs';
import { ironGateManualConfig, previewManualBooking, previewManualAmend, createManualBooking,
  amendManualBooking, cancelManualBooking, manualRequestResult, startManualRoomSync } from
  '../src/lib/booking-sources/iron-gate-manual.server.ts';
import { ironGateManualPaymentConfig, readManualPayment, recordManualPayment,
  manualPaymentRequestResult } from
  '../src/lib/booking-sources/iron-gate-manual-payment.server.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = '22222222-2222-4222-8222-222222222222';
const credentialId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const channelGrantId = '66666666-6666-4666-8666-666666666666';
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

function setup(channel = 'none') {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId, propertyId, roomIds: Object.values(roomIds),
    version: 1, authorityEpoch: 1, readOnly: false,
    channel: { mode: channel, ready: channel === 'owlnest', websiteSalesEnabled: false,
      grantId: channel === 'owlnest' ? channelGrantId : null, websiteBindingId: null,
      sourceReadbackEnabled: channel === 'owlnest',
      stockObservedFrom: channel === 'owlnest' ? '2026-11-01' : null,
      stockObservedThrough: channel === 'owlnest' ? '2026-12-31' : null },
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

test('OS direct lifecycle verifies every OwlNest transition before the next write', async () => {
  const { repository, service, send } = setup('owlnest'), c = config();
  const stock = new Map(), writes = [], reviews = [];
  const provider = {
    observe: async (_propertyId, cells) => ({ observedAt: new Date().toISOString(),
      providerVersion: key(), cells: cells.map(cell => ({ roomId: cell.roomId,
        date: cell.date, ...(stock.get(`${cell.roomId}:${cell.date}`) ??
          { count: 1, isLock: false }) })) }),
    setNight: async (_propertyId, cell) => {
      writes.push({ date: cell.date, desired: cell.desired });
      stock.set(`${cell.roomId}:${cell.date}`, cell.desired === 'closed' ?
        { count: 0, isLock: true } : { count: 1, isLock: false });
    },
  };
  const worker = createChannelWorker({ repository, service, provider,
    propertyConfigs: {}, getAuthorization: async () => '',
    onReview: async review => { reviews.push(review); } });
  const channel = { clientId: 'synthetic-channel', subjectId: 'synthetic-worker',
    origin: 'channel', workspaceId, propertyIds: [propertyId], authorityEpoch: 1,
    actions: ['channel:verify'], fields: [], grantId: channelGrantId };
  const created = await createManualBooking(owner, c, {
    expectedInventoryVersion: 1, stays: stay(), guestName: 'Synthetic Guest',
    contact: null, notes: null, totalCents: 100000, bookedAt: null,
  }, key(), send);
  assert.equal(created.channelSyncState, 'awaiting_manual_sync');
  assert.equal((await repository.read(propertyId)).fences.length, 0);
  assert.equal((await worker.runOne(channel, propertyId)).state, 'idle');
  const requested = await startManualRoomSync(owner, c, created.bookingId, {
    expectedBookingVersion: created.bookingVersion,
    expectedInventoryVersion: created.inventoryVersion,
  }, key(), send);
  assert.equal(requested.channelSyncState, 'pending');
  assert.equal((await repository.read(propertyId)).fences.length, 1);
  assert.equal((await worker.runOne(channel, propertyId)).state, 'sync_verified');
  let state = await repository.read(propertyId);
  assert.equal(state.fences.length, 0);
  assert.equal(state.bookings[0].channelSyncState, 'verified');

  const move = await amendManualBooking(owner, c, created.bookingId, {
    expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version, reason: 'Synthetic move',
    changes: { stays: stay('2026-11-12', '2026-11-13') },
  }, key(), send);
  assert.equal(move.channelSyncState, 'pending');
  const beforeMoveWrites = writes.length;
  assert.equal((await worker.runOne(channel, propertyId)).state, 'sync_verified');
  assert.deepEqual(writes.slice(beforeMoveWrites).map(item => item.desired),
    ['closed', 'open', 'open']);
  state = await repository.read(propertyId);
  assert.equal(state.fences.length, 0);

  const received = await recordManualPayment(owner, c, created.bookingId, {
    expectedBookingVersion: state.bookings[0].version, kind: 'received',
    amountCents: 40000, evidenceRef: 'synthetic received',
    occurredAt: '2026-10-24T00:00:00.000Z',
  }, key(), send);
  const refunded = await recordManualPayment(owner, c, created.bookingId, {
    expectedBookingVersion: received.bookingVersion, kind: 'refunded',
    amountCents: 40000, evidenceRef: 'synthetic refunded',
    occurredAt: '2026-10-24T00:00:00.000Z',
  }, key(), send);
  assert.equal(refunded.netReceivedCents, 0);
  state = await repository.read(propertyId);
  const cancelled = await cancelManualBooking(owner, c, created.bookingId, {
    expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version, reason: 'Synthetic cancellation',
  }, key(), send);
  assert.equal(cancelled.channelSyncState, 'pending');
  assert.equal((await worker.runOne(channel, propertyId)).state, 'sync_verified');
  state = await repository.read(propertyId);
  assert.equal(state.bookings[0].status, 'cancelled');
  assert.equal(state.fences.length, 0);
  assert.equal(state.bookings[0].paymentEvents.length, 2);
  assert.equal(reviews.length, 0);
});

test('selected external booking accepts a local name correction without changing room nights', async () => {
  const { repository, service, send } = setup(), c = config();
  const sourceGrantId = key();
  await repository.transact(propertyId, state => {
    state.sourceGrants.push({ grantId: sourceGrantId, sourceSystem: 'ota',
      sourceAccount: 'synthetic-account', active: true });
  });
  const source = { clientId: 'synthetic-source-client', subjectId: 'synthetic-source',
    origin: 'source', workspaceId, propertyIds: [propertyId], authorityEpoch: 1,
    actions: ['source:write'], fields: [], grantId: sourceGrantId,
    sourceSystem: 'ota', sourceAccount: 'synthetic-account' };
  const imported = await service.applySourceEvent(source, key(), {
    propertyId, sourceSystem: 'ota', sourceAccount: 'synthetic-account',
    externalOrderId: 'synthetic-external-order', sourceVersion: 'v1',
    previousSourceVersion: null, kind: 'upsert', expectedInventoryVersion: 1,
    stays: [{ checkIn: '2026-11-10', checkOut: '2026-11-12',
      roomIds: [roomIds['101']] }], guestName: 'Original Guest',
    bookedAt: '2026-10-24', totalCents: null,
  });
  const before = await repository.read(propertyId);
  await assert.rejects(amendManualBooking(owner, c, imported.bookingId, {
    expectedBookingVersion: 1, expectedInventoryVersion: before.version,
    reason: 'Synthetic correction', changes: { contact: 'new contact' },
  }, key(), send), /SOURCE_AMEND_REQUIRES_REVIEW/);
  const result = await amendManualBooking(owner, c, imported.bookingId, {
    expectedBookingVersion: 1, expectedInventoryVersion: before.version,
    reason: 'Synthetic correction', changes: { guestName: 'Corrected Guest' },
  }, key(), send);
  assert.equal(result.bookingVersion, 2);
  const after = await repository.read(propertyId);
  assert.equal(after.bookings[0].guestName, 'Corrected Guest');
  assert.equal(after.bookings[0].lineOverridePending, true);
  assert.equal(after.sourceLinks[0].diverged, true);
  assert.deepEqual(after.bookings[0].stays, before.bookings[0].stays);
  assert.equal(after.operations.length, 0);
  assert.equal(after.fences.length, 0);
});

test('manual gateway stays closed without both explicit switches', () => {
  assert.throws(() => ironGateManualConfig({}), /MANUAL_CONFIG_UNAVAILABLE/);
  assert.throws(() => ironGateManualPaymentConfig({}), /MANUAL_CONFIG_UNAVAILABLE/);
  assert.throws(() => config({ IRON_GATE_SWEETFUN_MANUAL_PAYMENTS_ENABLED: 'false' }),
    /MANUAL_CONFIG_UNAVAILABLE/);
  const c = config();
  assert.equal(c.grant.propertyId, propertyId);
});

test('manual create requires guest name and price before writing', async () => {
  const { repository, send } = setup('owlnest'), c = config();
  const input = { expectedInventoryVersion: 1, stays: stay(),
    guestName: 'Synthetic Guest', contact: null, notes: null,
    totalCents: 100000, bookedAt: null };
  await assert.rejects(createManualBooking(owner, c,
    { ...input, guestName: ' ' }, key(), send), /MANUAL_GUEST_NAME_REQUIRED/);
  await assert.rejects(createManualBooking(owner, c,
    { ...input, totalCents: null }, key(), send), /MANUAL_PRICE_REQUIRED/);
  assert.equal((await repository.read(propertyId)).bookings.length, 0);
});

test('lost sync response is recoverable and does not dispatch another close', async () => {
  const { repository, send } = setup('owlnest'), c = config();
  const created = await createManualBooking(owner, c, {
    expectedInventoryVersion: 1, stays: stay(), guestName: 'Synthetic Guest',
    contact: null, notes: null, totalCents: 100000, bookedAt: null,
  }, key(), send);
  const syncKey = key();
  const loseResponse = async (url, init) => {
    const response = await send(url, init);
    if (init.method === 'POST' && new URL(url).pathname.endsWith('/sync-room-status'))
      throw Error('synthetic connection reset after commit');
    return response;
  };
  await assert.rejects(startManualRoomSync(owner, c, created.bookingId, {
    expectedBookingVersion: created.bookingVersion,
    expectedInventoryVersion: created.inventoryVersion,
  }, syncKey, loseResponse), /MANUAL_RESULT_UNKNOWN/);
  const receipt = await manualRequestResult(owner, c, syncKey, send);
  assert.equal(receipt.operationState, 'sync_pending');
  const state = await repository.read(propertyId);
  assert.equal(state.operations.length, 1);
  assert.equal(state.bookings[0].channelSyncState, 'pending');
});

test('unobserved stock is a definitive conflict, while a lost write stays unknown', async () => {
  const rejected = manualError(Error('CHANNEL_STOCK_NOT_OBSERVED'), key());
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, 'CHANNEL_STOCK_NOT_OBSERVED');
  const requestKey = key();
  const unknown = manualError(Error('MANUAL_RESULT_UNKNOWN'), requestKey);
  assert.equal(unknown.status, 202);
  assert.equal((await unknown.json()).request_key, requestKey);
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
  await assert.rejects(recordManualPayment(owner, c, created.bookingId,
    { ...receivedInput, expectedBookingVersion: 2, amountCents: 1000,
      evidenceRef: 'SYNTHETIC BANK RECEIPT 1' }, key(), send),
  /PAYMENT_EVIDENCE_EXISTS/);
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
    contact: null, notes: null, totalCents: 100000, bookedAt: null,
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
    contact: null, notes: null, totalCents: 100000, bookedAt: null,
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
    contact: null, notes: null, totalCents: 100000, bookedAt: null,
  }, requestKey, serverErrorAfterCommit), /MANUAL_RESULT_UNKNOWN/);
  const recovered = await manualRequestResult(owner, c, requestKey, send);
  assert.equal(recovered.bookingId, (await repository.read(propertyId)).bookings[0].id);
});

test('a successful create response cannot confirm mismatched booking facts on readback', async () => {
  const submitted = { expectedInventoryVersion: 1, stays: stay(),
    guestName: 'Synthetic Guest', contact: 'synthetic-contact', notes: 'synthetic note',
    totalCents: 100000, bookedAt: '2026-10-24' };
  for (const [field, changed] of Object.entries({ guestName: 'Another Guest',
    contact: 'different-contact', notes: 'different note', totalCents: 1,
    bookedAt: '2026-10-23', version: 2 })) {
    const { repository, send } = setup(), c = config(), requestKey = key();
    const alteredReadback = async (url, init) => {
      const response = await send(url, init);
      if (init.method !== 'GET' || !/\/bookings\/[0-9a-f-]{36}$/.test(new URL(url).pathname))
        return response;
      const booking = await response.json();
      return Response.json({ ...booking, [field]: changed });
    };
    await assert.rejects(createManualBooking(owner, c, submitted, requestKey,
      alteredReadback), /MANUAL_READBACK_MISMATCH/, field);
    assert.equal((await repository.read(propertyId)).bookings.length, 1);
    assert.equal((await manualRequestResult(owner, c, requestKey, send)).bookingVersion, 1);
  }
});
