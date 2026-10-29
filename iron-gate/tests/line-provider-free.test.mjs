import test from 'node:test';
import assert from 'node:assert/strict';
import { IronGateService } from '../src/service.ts';
import { createHandler } from '../src/http.ts';
import { MemoryPropertyRepository } from '../src/memory-repository.ts';
import { retentionFixture, retain, key, code, occupancy } from './retained-fixture.mjs';
import { checkPropertyIntegrity } from '../src/property-integrity.mjs';

async function fixture(overrides = {}) {
  const propertyId = key(), workspaceId = key(), roomId = key(), grantId = key();
  const repository = new MemoryPropertyRepository();
  await repository.seed({ propertyId, workspaceId, roomIds: [roomId], version: 1,
    authorityEpoch: 1, readOnly: false,
    channel: { mode: 'none', ready: false, websiteSalesEnabled: false, grantId: null,
      websiteBindingId: null, lineBookingMode: 'provider_free', lineBookingGrantId: grantId },
    sourceGrants: [], bookings: [], sourceLinks: [], operations: [], fences: [], manualBlocks: [],
    receipts: [], ...overrides });
  const service = new IronGateService(repository, 'p'.repeat(43));
  const actor = { clientId: 'synthetic-line', subjectId: 'synthetic-actor', origin: 'line',
    propertyIds: [propertyId], workspaceId, authorityEpoch: 1, grantId, lineProviderFreeEnabled: true,
    actions: ['booking:read', 'booking:create', 'booking:amend', 'booking:cancel', 'booking:manage_all'],
    fields: ['guest_name', 'contact', 'notes', 'money'] };
  const input = { expectedInventoryVersion: 1, source: 'line', channelPolicy: 'provider_free',
    guestName: 'Synthetic Guest', contact: null, notes: null, totalCents: 1200000,
    bookedAt: '2026-10-29', stays: [{ roomIds: [roomId], checkIn: '2027-01-31', checkOut: '2027-02-02' }],
    roomNightPrices: [{ roomId, date: '2027-01-31', amountCents: 600000 },
      { roomId, date: '2027-02-01', amountCents: 600000 }] };
  return { propertyId, workspaceId, roomId, grantId, repository, service, actor, input,
    read: () => repository.read(propertyId) };
}
async function create(f, input = f.input, requestKey = key()) {
  const preview = await f.service.previewLineCreate(f.actor, f.propertyId, input);
  assert.equal(preview.bookingMode, 'provider_free');
  const response = await f.service.createBooking(f.actor, f.propertyId, requestKey, input, preview.previewToken);
  return { response, preview, requestKey, input };
}
function noProviderWork(state) {
  assert.deepEqual(state.operations, []);
  assert.deepEqual(state.fences, []);
  for (const booking of state.bookings) {
    assert.equal(booking.channelSyncState, 'not_required');
    assert.equal(booking.channelOperationKey, null);
    assert.equal(booking.lineChannelPending, undefined);
    assert.equal(booking.lineChannelBaselineNights, undefined);
  }
  assert.equal(checkPropertyIntegrity(state, occupancy(state)).ok, true);
}

test('provider-free LINE creates, amends and cancels one canonical booking with exact retries and no channel work', async () => {
  const f = await fixture();
  const capability = await f.service.lineCapabilities(f.actor, f.propertyId);
  assert.equal(capability.bookingMode, 'provider_free');
  for (const field of ['canReadAll', 'canCreate', 'canAmend', 'canCancel']) assert.equal(capability[field], true);
  for (const field of ['channelReady', 'canInventory', 'canManualChannel']) assert.equal(capability[field], false);
  const c = await create(f);
  assert.equal(c.response.operationState, 'not_required'); assert.equal(c.response.operationKey, null);
  assert.deepEqual(await f.service.createBooking(f.actor, f.propertyId, c.requestKey, c.input,
    c.preview.previewToken), c.response);
  const changed = { expectedBookingVersion: 1, expectedInventoryVersion: c.response.inventoryVersion,
    channelPolicy: 'provider_free', changes: { guestName: 'Synthetic Edited',
      stays: [{ roomIds: [f.roomId], checkIn: '2027-03-01', checkOut: '2027-03-02' }], totalCents: 650000,
      roomNightPrices: [{ roomId: f.roomId, date: '2027-03-01', amountCents: 650000 }] } };
  const preview = await f.service.previewLineAction(f.actor, f.propertyId, c.response.bookingId, 'amend', changed);
  assert.equal(preview.bookingMode, 'provider_free');
  const amendKey = key();
  const amended = await f.service.amendBooking(f.actor, f.propertyId, c.response.bookingId, amendKey,
    changed, preview.previewToken);
  assert.equal(amended.operationState, 'not_required');
  assert.deepEqual(await f.service.amendBooking(f.actor, f.propertyId, c.response.bookingId, amendKey,
    changed, preview.previewToken), amended);
  const readback = await f.service.getBooking(f.actor, f.propertyId, c.response.bookingId);
  assert.equal(readback.guestName, changed.changes.guestName);
  assert.deepEqual(readback.stays, changed.changes.stays);
  assert.deepEqual(readback.roomNightPrices, changed.changes.roomNightPrices);
  const cancel = { expectedBookingVersion: amended.bookingVersion,
    expectedInventoryVersion: amended.inventoryVersion, channelPolicy: 'provider_free' };
  const cancelPreview = await f.service.previewLineAction(f.actor, f.propertyId, c.response.bookingId, 'cancel', cancel);
  const cancelKey = key();
  const cancelled = await f.service.cancelBooking(f.actor, f.propertyId, c.response.bookingId, cancelKey,
    cancel.expectedBookingVersion, cancel.expectedInventoryVersion, cancelPreview.previewToken, cancel.channelPolicy);
  assert.equal(cancelled.operationState, 'not_required');
  assert.deepEqual(await f.service.cancelBooking(f.actor, f.propertyId, c.response.bookingId, cancelKey,
    cancel.expectedBookingVersion, cancel.expectedInventoryVersion, cancelPreview.previewToken, cancel.channelPolicy), cancelled);
  assert.equal((await f.service.requestResult(f.actor, f.propertyId, cancelKey)).currentChannelSyncState, 'not_required');
  const state = await f.read(); noProviderWork(state);
  assert.equal(state.bookings.length, 1); assert.equal(state.bookings[0].status, 'cancelled');
  assert.equal(occupancy(state).length, 0);
});

test('provider-free policy remains disabled without exact property/grant configuration and cannot downgrade OwlNest', async () => {
  const f = await fixture();
  for (const change of [
    state => { delete state.channel.lineBookingMode; },
    state => { state.channel.lineBookingGrantId = key(); },
    state => { state.channel.mode = 'owlnest'; state.channel.ready = true;
      state.channel.sourceReadbackEnabled = true; state.channel.grantId = key(); },
    state => { state.readOnly = true; },
    state => { state.authorityEpoch++; },
  ]) {
    const initial = await f.read(); await f.repository.transact(f.propertyId, change);
    await assert.rejects(f.service.previewLineCreate(f.actor, f.propertyId, f.input), code('LINE_CHANNEL_NOT_READY'));
    assert.notEqual((await f.service.lineCapabilities(f.actor, f.propertyId)).bookingMode, 'provider_free');
    await f.repository.transact(f.propertyId, state => Object.assign(state, structuredClone(initial)));
  }
  await assert.rejects(f.service.previewLineCreate(f.actor, f.propertyId, { ...f.input, channelPolicy: undefined }), code('LINE_CHANNEL_NOT_READY'));
  await assert.rejects(f.service.previewLineCreate(f.actor, f.propertyId, { ...f.input, channelPolicy: 'manual' }), code('FORBIDDEN'));
  await assert.rejects(f.service.previewLineCreate({ ...f.actor, actions: ['booking:create'] },
    f.propertyId, f.input), code('FORBIDDEN'));
  await assert.rejects(f.service.previewLineCreate({ ...f.actor, propertyIds: [] },
    f.propertyId, f.input), code('FORBIDDEN'));
  const unconfigured = new IronGateService(f.repository);
  assert.equal((await unconfigured.lineCapabilities(f.actor, f.propertyId)).canCreate, false);
});

test('a dedicated provider-free credential cannot gain provider writes if the property later enables OwlNest', async () => {
  const f = await fixture();
  const c = await create(f);
  await f.repository.transact(f.propertyId, state => {
    state.channel.mode = 'owlnest'; state.channel.ready = true;
    state.channel.sourceReadbackEnabled = true; state.channel.grantId = key();
    state.bookings[0].channelSyncState = 'verified'; state.version++;
  });
  const state = await f.read();
  const capabilities = await f.service.lineCapabilities(f.actor, f.propertyId);
  assert.equal(capabilities.bookingMode, 'unavailable');
  for (const field of ['canCreate', 'canAmend', 'canCancel', 'canInventory', 'canManualChannel'])
    assert.equal(capabilities[field], false);
  await assert.rejects(f.service.previewLineCreate(f.actor, f.propertyId,
    { ...f.input, channelPolicy: undefined, expectedInventoryVersion: state.version }), code('LINE_CHANNEL_NOT_READY'));
  await assert.rejects(f.service.previewLineAction(f.actor, f.propertyId, c.response.bookingId, 'cancel',
    { expectedInventoryVersion: state.version, expectedBookingVersion: 1 }), code('LINE_CHANNEL_NOT_READY'));
  assert.deepEqual((await f.read()).operations, []);
});

test('signed provider-free previews bind policy, operator, versions and recheck server configuration', async () => {
  const f = await fixture();
  const preview = await f.service.previewLineCreate(f.actor, f.propertyId, f.input);
  await assert.rejects(f.service.createBooking(f.actor, f.propertyId, key(), f.input), code('LINE_PREVIEW_REQUIRED'));
  await assert.rejects(f.service.createBooking({ ...f.actor, subjectId: 'different-staff' },
    f.propertyId, key(), f.input, preview.previewToken), code('LINE_PREVIEW_REQUIRED'));
  await assert.rejects(f.service.createBooking(f.actor, f.propertyId, key(), { ...f.input, channelPolicy: undefined },
    preview.previewToken), code('LINE_PREVIEW_REQUIRED'));
  await f.repository.transact(f.propertyId, state => { delete state.channel.lineBookingMode; });
  await assert.rejects(f.service.createBooking(f.actor, f.propertyId, key(), f.input,
    preview.previewToken), code('LINE_CHANNEL_NOT_READY'));
  await f.repository.transact(f.propertyId, state => { state.channel.lineBookingMode = 'provider_free'; state.version++; });
  await assert.rejects(f.service.createBooking(f.actor, f.propertyId, key(), f.input,
    preview.previewToken), code('VERSION_CONFLICT'));
  assert.equal((await f.read()).bookings.length, 0);
});

test('provider-free occupancy checks include native OS bookings, closed nights and source fences', async () => {
  const f = await fixture();
  const os = { ...f.actor, origin: 'os' };
  const input = { ...f.input, source: 'os' }; delete input.channelPolicy;
  await f.service.createBooking(os, f.propertyId, key(), input);
  await assert.rejects(f.service.previewLineCreate(f.actor, f.propertyId,
    { ...f.input, expectedInventoryVersion: 2 }), code('ROOM_CONFLICT'));
  const f2 = await fixture();
  await f2.repository.transact(f2.propertyId, state => { state.manualBlocks = [{ roomId: f2.roomId, date: '2027-01-31' }]; });
  await assert.rejects(f2.service.previewLineCreate(f2.actor, f2.propertyId, f2.input), code('ROOM_CONFLICT'));
  await assert.rejects(f2.service.previewLineCreate(f2.actor, f2.propertyId,
    { ...f2.input, acknowledgedClosedNights: [{ roomId: f2.roomId, date: '2027-01-31' }] }), code('FORBIDDEN'));
  await f2.repository.transact(f2.propertyId, state => {
    state.manualBlocks = []; state.fences = [{ key: 'source-review', reason: 'source_review',
      cells: [{ roomId: f2.roomId, date: '2027-01-31' }] }];
  });
  await assert.rejects(f2.service.previewLineCreate(f2.actor, f2.propertyId, f2.input), code('ROOM_CONFLICT'));
});

test('provider-free paid, imported unknown-balance and retained bookings require their existing review paths', async () => {
  const f = await fixture(); const c = await create(f);
  const input = { expectedInventoryVersion: c.response.inventoryVersion, expectedBookingVersion: 1,
    channelPolicy: 'provider_free' };
  for (const change of [
    booking => { booking.paymentEvents = [{ id: key(), kind: 'received', amountCents: 100,
      currency: 'TWD', evidenceRef: 'synthetic', occurredAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(), actorId: 'synthetic' }]; },
    booking => { booking.source = 'external'; },
  ]) {
    const initial = await f.read();
    await f.repository.transact(f.propertyId, state => change(state.bookings[0]));
    await assert.rejects(f.service.previewLineAction(f.actor, f.propertyId,
      c.response.bookingId, 'cancel', input), code('LINE_PAYMENT_REQUIRES_REVIEW'));
    await f.repository.transact(f.propertyId, state => Object.assign(state, structuredClone(initial)));
  }
  const r = await retentionFixture(); await retain(r);
  const actor = { ...f.actor, workspaceId: r.workspaceId, propertyIds: [r.propertyId] };
  await r.repository.transact(r.propertyId, state => {
    state.channel.lineBookingMode = 'provider_free'; state.channel.lineBookingGrantId = actor.grantId;
  });
  const service = new IronGateService(r.repository, 'p'.repeat(43));
  const { state, booking } = await r.read();
  await assert.rejects(service.previewLineAction(actor, r.propertyId, r.bookingId, 'cancel',
    { ...input, expectedInventoryVersion: state.version, expectedBookingVersion: booking.version }),
  code('RETAINED_ORDER_REQUIRES_RESCHEDULE'));
  const aliasesBefore = structuredClone(booking.retention.sourceAliases);
  const source = await service.applySourceEvent(r.source, key(), await r.sourceInput({ externalOrderId: 'J:synthetic-child-a' }));
  assert.equal(source.reason, 'ORDER_LIFECYCLE_OWNER_MANAGED');
  assert.equal((await r.read()).state.bookings.length, 2);
  assert.deepEqual((await r.read()).booking.retention.sourceAliases, aliasesBefore);
});

test('provider-free bulk cancel is atomic, idempotent, and emits no provider operations', async () => {
  const f = await fixture(); const a = await create(f);
  const second = { ...f.input, expectedInventoryVersion: a.response.inventoryVersion,
    stays: [{ roomIds: [f.roomId], checkIn: '2027-03-01', checkOut: '2027-03-02' }],
    roomNightPrices: [{ roomId: f.roomId, date: '2027-03-01', amountCents: 1200000 }] };
  const b = await create(f, second);
  const input = { expectedInventoryVersion: b.response.inventoryVersion, channelPolicy: 'provider_free',
    bookings: [a, b].map(x => ({ bookingId: x.response.bookingId, expectedBookingVersion: 1 }))
      .sort((a, b) => a.bookingId.localeCompare(b.bookingId)) };
  const preview = await f.service.previewLineBulkCancel(f.actor, f.propertyId, input);
  assert.equal(preview.bookingMode, 'provider_free');
  const requestKey = key();
  const response = await f.service.bulkCancelLineBookings(f.actor, f.propertyId, requestKey, input, preview.previewToken);
  assert.equal(response.operationState, 'not_required'); assert.deepEqual(response.operationKeys, [null, null]);
  assert.deepEqual(await f.service.bulkCancelLineBookings(f.actor, f.propertyId, requestKey, input,
    preview.previewToken), response);
  const state = await f.read(); noProviderWork(state);
  assert.equal(state.bookings.every(b => b.status === 'cancelled'), true);
  const events = await f.repository.events(f.propertyId, 0, 10);
  assert.equal(events.filter(e => e.type === 'booking.cancelled').every(e =>
    e.inventoryVersion === response.inventoryVersion), true);
});

test('provider-free HTTP route accepts explicit policy and returns canonical readback', async () => {
  const f = await fixture(); const handler = createHandler(f.service, async () => f.actor);
  const url = `https://iron.invalid/v1/properties/${f.propertyId}`;
  const previewResponse = await handler(new Request(`${url}/line-create-previews`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(f.input) }));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json(); const requestKey = key();
  const response = await handler(new Request(`${url}/bookings`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': requestKey,
      'x-iron-gate-line-preview': preview.previewToken }, body: JSON.stringify(f.input) }));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).operationState, 'not_required');
  const detail = await handler(new Request(`${url}/bookings/${requestKey}`));
  assert.equal(detail.status, 200); assert.equal((await detail.json()).channelSyncState, 'not_required');
});
