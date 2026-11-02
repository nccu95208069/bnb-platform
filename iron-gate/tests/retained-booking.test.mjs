import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlitePropertyRepository } from '../src/sqlite-repository.mjs';
import { IronGateService } from '../src/service.ts';
import { createHandler } from '../src/http.ts';
import { MemoryPropertyRepository } from '../src/memory-repository.ts';
import { seedOfflandShadow } from '../scripts/seed-offland-shadow.mjs';
import { importedAmountFixture } from './airbnb-imported-amount-fixture.mjs';
import { checkPropertyIntegrity } from '../src/property-integrity.mjs';
import { key, code, retentionFixture, retain, retainReason, occupancy } from './retained-fixture.mjs';

const previewInput = ({ expectedBookingVersion, expectedInventoryVersion, ...input }) => input;
const commitReschedule = (f, input, requestKey = key()) =>
  f.service.rescheduleBooking(f.owner, f.propertyId, f.bookingId, requestKey, input);

test('Offland retain releases the whole imported Q order and preserves source and immutable money', async () => {
  const f = await retentionFixture();
  const before = await f.read();
  const preview = await f.service.previewRetainBooking(f.owner, f.propertyId, f.bookingId,
    { reason: retainReason });
  assert.deepEqual(await f.read(), before, 'preview must be read-only');
  assert.equal(preview.bookingVersion, 1);
  assert.equal(preview.authorityEpoch, 1);
  assert.equal(preview.channelSyncState, 'not_required');
  assert.equal(preview.externalRoomStatus, 'not_integrated');
  assert.equal(preview.retainedAmountCents, null);
  assert.equal(preview.retainedAmountReviewRequired, true);
  const { requestKey, response } = await retain(f);
  const { state, booking } = await f.read();
  assert.equal(response.status, 'retained');
  assert.equal(response.lifecycleRevision, 1);
  assert.equal(booking.status, 'retained');
  assert.deepEqual(booking.stays, []);
  assert.equal(booking.totalCents, null);
  assert.equal(booking.roomNightPrices, undefined);
  assert.equal(booking.retention.activeRetentionId, requestKey);
  assert.deepEqual(booking.retention.history[0].previousStays, before.booking.stays);
  assert.equal(booking.retention.history[0].previousTotalCents, 1200000);
  assert.deepEqual(booking.retention.history[0].previousRoomNightPrices, before.booking.roomNightPrices);
  assert.equal(booking.source, 'external');
  assert.deepEqual(booking.offlandSnapshot, before.booking.offlandSnapshot);
  assert.deepEqual(booking.paymentEvents, before.booking.paymentEvents);
  assert.deepEqual(state.sourceLinks, before.state.sourceLinks);
  assert.deepEqual(state.operations, before.state.operations);
  assert.deepEqual(state.bookings.find(b => b.id === f.otherBookingId),
    before.state.bookings.find(b => b.id === f.otherBookingId));
  assert.equal(occupancy(state).filter(cell => cell.booking_id === f.bookingId).length, 0);
  assert.equal(checkPropertyIntegrity(state, occupancy(state)).ok, true);
  const events = await f.repository.events(f.propertyId, 0, 10);
  assert.deepEqual(events.map(event => event.type), ['booking.retained']);
  const audit = f.repository.auditRecords(f.propertyId);
  assert.equal(audit[0].retention.retentionId, requestKey);
  assert.equal(audit[0].actorSubjectId, f.owner.subjectId);
});

test('retained list has no stay-date window and all readers accept a zero-stay order', async () => {
  const f = await retentionFixture(); await retain(f);
  const list = await f.service.listBookings(f.owner, f.propertyId,
    { limit: 100, cursor: null, status: 'retained', from: null, to: null });
  assert.equal(list.bookings.length, 1);
  assert.equal(list.bookings[0].id, f.bookingId);
  assert.equal(list.bookings[0].sourceCalendar.sourceOrderRef, 'Q:synthetic-parent');
  assert.equal(list.bookings[0].rescheduleEligible, true);
  assert.equal(list.bookings[0].retentionEligible, false);
  const detail = await f.service.getBooking(f.owner, f.propertyId, f.bookingId);
  assert.equal(detail.totalCents, null);
  assert.equal(detail.roomNightPrices, undefined);
  assert.equal(detail.retention.sourceAliases, undefined);
  assert.equal(detail.retention.sourceReviews, undefined);
  assert.deepEqual(detail.sourceCalendar.retainedSourceAliases,
    ['J:synthetic-child-a', 'J:synthetic-child-b', 'Q:synthetic-parent']);
  const calendar = await f.service.calendarSnapshot(f.owner, f.propertyId, '2027-01-01', '2027-02-28');
  assert.equal(calendar.bookings.some(b => b.id === f.bookingId), false);
  const availability = await f.service.availability(f.owner, f.propertyId, '2027-01-31', '2027-02-02');
  assert.equal(availability.cells.filter(cell => cell.roomId === f.roomId).every(cell => cell.state === 'unsold'), true);
  assert.ok(await f.service.businessReport({ ...f.owner, origin: 'service', fields: [] }, f.propertyId));
  assert.ok(await f.service.occupancySummary(f.owner, f.propertyId, '2027-01-01', '2027-01-31'));
  assert.ok(await f.service.housekeepingTurnovers(f.owner, f.propertyId, '2027-01-01', '2027-01-31'));
});

test('public retained aliases expose only proven Offland row identities to members with money access', async () => {
  const f = await retentionFixture(); await retain(f);
  await f.repository.transact(f.propertyId, state => {
    const aliases = state.bookings.find(b => b.id === f.bookingId).retention.sourceAliases;
    aliases.push({ sourceSystem: 'offland-calendar-sheet', sourceAccount: 'synthetic-other-account',
      externalOrderId: 'J:synthetic-foreign-account' },
    { sourceSystem: 'synthetic-other-system', sourceAccount: 'synthetic-offland-sheet',
      externalOrderId: 'J:synthetic-foreign-system' },
    { sourceSystem: 'offland-calendar-sheet', sourceAccount: 'synthetic-offland-sheet',
      externalOrderId: 'L:synthetic-wrong-kind' });
  });
  const detail = await f.service.getBooking(f.owner, f.propertyId, f.bookingId);
  assert.deepEqual(detail.sourceCalendar.retainedSourceAliases,
    ['J:synthetic-child-a', 'J:synthetic-child-b', 'Q:synthetic-parent']);
  assert.equal(JSON.stringify(detail).includes('synthetic-offland-sheet'), false);
  const noMoney = { ...f.owner, fields: f.owner.fields.filter(field => field !== 'money') };
  const redacted = await f.service.getBooking(noMoney, f.propertyId, f.bookingId);
  assert.equal(redacted.sourceCalendar.retainedSourceAliases, undefined);
  assert.equal(redacted.retention.sourceAliases, undefined);
});

test('reschedule uses the same booking and source identity, replaces price, and supports another retention cycle', async () => {
  const f = await retentionFixture(); const initial = await f.read(); await retain(f);
  const input = await f.rescheduleInput(), rescheduledKey = key();
  const beforePreview = await f.read();
  const preview = await f.service.previewRescheduleBooking(f.owner, f.propertyId, f.bookingId, previewInput(input));
  assert.deepEqual(await f.read(), beforePreview);
  assert.deepEqual(preview.previousStays, initial.booking.stays);
  assert.deepEqual(preview.proposedStays, input.stays);
  const response = await commitReschedule(f, input, rescheduledKey);
  assert.equal(response.status, 'confirmed'); assert.equal(response.lifecycleRevision, 2);
  let { state, booking } = await f.read();
  assert.equal(state.bookings.length, 2);
  assert.deepEqual(booking.stays, input.stays);
  assert.equal(booking.totalCents, input.totalCents);
  assert.deepEqual(booking.roomNightPrices, input.roomNightPrices);
  assert.equal(booking.retention.activeRetentionId, null);
  assert.equal(booking.retention.history[0].rescheduledRequestKey, rescheduledKey);
  assert.deepEqual(booking.paymentEvents, initial.booking.paymentEvents);
  const detail = await f.service.getBooking(f.owner, f.propertyId, f.bookingId);
  assert.equal(detail.sourceCalendar.sourceOrderRef, 'Q:synthetic-parent');
  assert.equal(detail.retentionEligible, true);
  assert.equal(checkPropertyIntegrity(state, occupancy(state)).ok, true);
  await retain(f);
  ({ state, booking } = await f.read());
  assert.equal(booking.retention.history.length, 2);
  assert.equal(booking.retention.lifecycleRevision, 3);
  assert.deepEqual(booking.retention.history[0].previousStays, initial.booking.stays);
  assert.deepEqual(booking.retention.history[1].previousStays, input.stays);
  assert.equal(checkPropertyIntegrity(state, occupancy(state)).ok, true);
});

test('paid native orders retain and reschedule without inserting, refunding, or consuming payments', async () => {
  const f = await retentionFixture({ native: true });
  const current = await f.read();
  await f.service.recordPaymentEvent(f.owner, f.propertyId, f.bookingId, key(), {
    expectedBookingVersion: current.booking.version, eventId: key(), kind: 'received',
    amountCents: 300000, currency: 'TWD', method: 'bank_transfer',
    evidenceRef: 'synthetic-payment', occurredAt: '2026-10-01T00:00:00.000Z' });
  const before = await f.read();
  await assert.rejects(f.service.cancelBooking(f.owner, f.propertyId, f.bookingId, key(),
    before.booking.version, before.state.version), code('CANCELLATION_REQUIRES_SETTLEMENT'));
  await retain(f);
  assert.deepEqual((await f.read()).booking.paymentEvents, before.booking.paymentEvents);
  await commitReschedule(f, await f.rescheduleInput({ totalCents: 250000, roomNightPrices: [
    { roomId: f.roomId, date: '2027-04-04', amountCents: 100000 },
    { roomId: f.roomId, date: '2027-04-05', amountCents: 150000 }] }));
  const after = await f.read();
  assert.deepEqual(after.booking.paymentEvents, before.booking.paymentEvents);
  assert.equal((await f.service.getBooking(f.owner, f.propertyId, f.bookingId)).paymentSummary.netReceivedCents, 300000);
  assert.equal((await f.repository.events(f.propertyId, 0, 100)).filter(event => event.type === 'payment.recorded').length, 1);
});

test('retention and reschedule receipts are idempotent, payload bound, and recoverable after later changes', async () => {
  const f = await retentionFixture();
  const retained = await retain(f);
  assert.deepEqual(await f.service.retainBooking(f.owner, f.propertyId, f.bookingId,
    retained.requestKey, retained.input), retained.response);
  await assert.rejects(f.service.retainBooking(f.owner, f.propertyId, f.bookingId,
    retained.requestKey, { ...retained.input, reason: 'different reason' }), code('IDEMPOTENCY_CONFLICT'));
  const input = await f.rescheduleInput(), requestKey = key();
  const rescheduled = await commitReschedule(f, input, requestKey);
  assert.deepEqual(await commitReschedule(f, input, requestKey), rescheduled);
  const receipt = await f.service.requestResult(f.owner, f.propertyId, retained.requestKey);
  assert.equal(receipt.status, 'retained');
  assert.equal(receipt.currentBookingVersion, rescheduled.bookingVersion);
  assert.equal((await f.read()).booking.retention.history.length, 1);
  await assert.rejects(f.service.requestResult({ ...f.owner, subjectId: 'different-owner' },
    f.propertyId, retained.requestKey), code('REQUEST_NOT_FOUND'));
});

test('version, duplicate-night, wrong-room, invalid-price and blocked-night failures leave the order retained', async () => {
  const f = await retentionFixture(); await retain(f);
  const initial = await f.read(), input = await f.rescheduleInput();
  await assert.rejects(commitReschedule(f, { ...input, expectedBookingVersion: 1 }), code('VERSION_CONFLICT'));
  await assert.rejects(commitReschedule(f, { ...input, expectedInventoryVersion: 0 }), code('VERSION_CONFLICT'));
  await assert.rejects(commitReschedule(f, { ...input, totalCents: 1 }), code('INVALID_NIGHT_PRICES'));
  await assert.rejects(commitReschedule(f, { ...input, stays: [...input.stays, ...input.stays] }), code('DUPLICATE_ROOM_NIGHT'));
  await assert.rejects(commitReschedule(f, { ...input, stays: [{ ...input.stays[0], roomIds: [key()] }] }), code('ROOM_NOT_FOUND'));
  assert.deepEqual(await f.read(), initial);
  await f.repository.transact(f.propertyId, state => state.manualBlocks.push({ roomId: f.roomId, date: '2027-04-04' }));
  const blocked = await f.read();
  await assert.rejects(commitReschedule(f, await f.rescheduleInput()), code('ROOM_CONFLICT'));
  assert.deepEqual(await f.read(), blocked);
  assert.equal((await f.read()).booking.status, 'retained');
});

test('two retained orders competing for the last room have one atomic winner', async () => {
  const f = await retentionFixture(); await retain(f);
  let state = (await f.read()).state;
  const other = state.bookings.find(booking => booking.id === f.otherBookingId);
  await f.service.retainBooking(f.owner, f.propertyId, other.id, key(), {
    expectedBookingVersion: other.version, expectedInventoryVersion: state.version, reason: retainReason });
  state = (await f.read()).state;
  const input = await f.rescheduleInput();
  const results = await Promise.allSettled([
    commitReschedule(f, input),
    f.service.rescheduleBooking(f.owner, f.propertyId, other.id, key(), {
      ...input, expectedBookingVersion: state.bookings.find(b => b.id === other.id).version }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const after = (await f.read()).state;
  assert.equal(after.bookings.filter(booking => booking.status === 'retained').length, 1);
  assert.equal(after.bookings.filter(booking => booking.status === 'confirmed').length, 1);
  assert.equal(occupancy(after).length, 2);
  assert.equal(checkPropertyIntegrity(after, occupancy(after)).ok, true);
});

test('source upserts, cancellations and regrouped J children never resurrect released room nights', async () => {
  const f = await retentionFixture(); await retain(f);
  const before = await f.read();
  const payloads = [{}, { kind: 'cancel' }, { externalOrderId: 'J:synthetic-child-a', previousSourceVersion: null },
    { externalOrderId: 'J:synthetic-child-b', previousSourceVersion: null }];
  for (const overrides of payloads) {
    const requestKey = key(), input = await f.sourceInput(overrides);
    const result = await f.service.applySourceEvent(f.source, requestKey, input);
    assert.equal(result.reason, 'ORDER_LIFECYCLE_OWNER_MANAGED');
    assert.equal(result.nonBlocking, true);
    assert.equal(result.bookingId, f.bookingId);
    assert.deepEqual(await f.service.applySourceEvent(f.source, requestKey, input), result);
  }
  const after = await f.read();
  assert.equal(after.state.bookings.length, before.state.bookings.length);
  assert.equal(after.booking.status, 'retained');
  assert.deepEqual(after.booking.stays, []);
  assert.equal(after.booking.totalCents, null);
  assert.deepEqual(after.state.fences, before.state.fences);
  assert.deepEqual(after.state.sourceLinks, before.state.sourceLinks);
  assert.deepEqual(after.booking.paymentEvents, before.booking.paymentEvents);
  assert.equal(after.booking.retention.sourceReviews.length, 4);
  const lookup = await f.service.sourceOrderLookup(f.source, {
    propertyId: f.propertyId, sourceSystem: f.source.sourceSystem,
    sourceAccount: f.source.sourceAccount, externalOrderId: 'J:synthetic-child-a' });
  assert.equal(lookup.bookingId, f.bookingId); assert.equal(lookup.ownerManagedLifecycle, true);
  assert.equal(lookup.bookingStatus, 'retained');
});

test('owner lifecycle protection persists after reschedule and includes exact imported platform identity', async () => {
  const f = await retentionFixture({ platform: 'Booking' }); await retain(f);
  await commitReschedule(f, await f.rescheduleInput());
  const before = await f.read();
  for (const overrides of [{ kind: 'cancel' }, { kind: 'upsert' },
    { externalOrderId: 'new-source-key', previousSourceVersion: null, platform: 'booking', externalOrderNo: 'synthetic-parent' }]) {
    const result = await f.service.applySourceEvent(f.source, key(), await f.sourceInput(overrides));
    assert.equal(result.reason, 'ORDER_LIFECYCLE_OWNER_MANAGED');
  }
  const after = await f.read();
  assert.equal(after.booking.status, 'confirmed');
  assert.deepEqual(after.booking.stays, before.booking.stays);
  assert.equal(after.booking.totalCents, before.booking.totalCents);
  assert.equal(after.booking.version, before.booking.version);
  assert.deepEqual(after.state.fences, before.state.fences);
  assert.deepEqual(after.state.sourceLinks, before.state.sourceLinks);
  const sourceInput = await f.sourceInput();
  await assert.rejects(f.service.enrichSourceFacts(f.source, key(), {
    propertyId: f.propertyId, sourceSystem: f.source.sourceSystem, sourceAccount: f.source.sourceAccount,
    externalOrderId: sourceInput.externalOrderId, sourceVersion: sourceInput.previousSourceVersion,
    expectedInventoryVersion: after.state.version, expectedBookingVersion: after.booking.version,
    totalCents: 1200000, currency: 'TWD', platform: 'booking', externalOrderNo: 'synthetic-parent',
  }), code('SOURCE_LIFECYCLE_OWNER_MANAGED'));
});

test('an unrelated new source order can use released OS nights while old source evidence remains quarantined', async () => {
  const f = await retentionFixture(); await retain(f);
  const result = await f.service.applySourceEvent(f.source, key(), await f.sourceInput({
    externalOrderId: 'unrelated-new-order', previousSourceVersion: null, guestName: 'Different Synthetic Guest' }));
  assert.equal(result.state, 'applied'); assert.notEqual(result.bookingId, f.bookingId);
  assert.equal((await f.read()).booking.status, 'retained');
  const old = await f.service.applySourceEvent(f.source, key(), await f.sourceInput());
  assert.equal(old.nonBlocking, true);
  const state = (await f.read()).state;
  assert.equal(checkPropertyIntegrity(state, occupancy(state)).ok, true);
  assert.equal(state.fences.length, 0);
});

test('retention eligibility is independent of direct-edit mode and refuses unproven imported identities', async () => {
  const f = await retentionFixture();
  const detail = await f.service.getBooking(f.owner, f.propertyId, f.bookingId);
  assert.equal(detail.osEditMode, 'guest_name'); assert.equal(detail.retentionEligible, true);
  const initial = await f.read();
  await f.repository.transact(f.propertyId, state => { state.sourceLinks.find(link => link.bookingId === f.bookingId).diverged = true; });
  await assert.rejects(retain(f), code('RETENTION_SOURCE_REQUIRES_REVIEW'));
  await f.repository.transact(f.propertyId, state => { Object.assign(state, structuredClone(initial.state));
    state.bookings.find(booking => booking.id === f.bookingId).offlandSnapshot.groupKey = 'Q:wrong-order'; });
  await assert.rejects(retain(f), code('RETENTION_SOURCE_REQUIRES_REVIEW'));
  await f.repository.transact(f.propertyId, state => { Object.assign(state, structuredClone(initial.state));
    delete state.bookings.find(booking => booking.id === f.bookingId).offlandSnapshot; });
  await assert.rejects(retain(f), code('RETENTION_SOURCE_REQUIRES_REVIEW'));
});

test('property, authority, origin and field permissions guard preview and commit; no-price reads are redacted', async () => {
  const f = await retentionFixture();
  const input = await f.retainInput();
  for (const owner of [{ ...f.owner, propertyIds: [] }, { ...f.owner, workspaceId: key() },
    { ...f.owner, actions: ['booking:read'] }, { ...f.owner, fields: ['guest_name'] },
    { ...f.owner, origin: 'line', grantId: key() }]) {
    await assert.rejects(f.service.previewRetainBooking(owner, f.propertyId, f.bookingId,
      { reason: retainReason }), code('FORBIDDEN'));
    await assert.rejects(f.service.retainBooking(owner, f.propertyId, f.bookingId, key(), input), code('FORBIDDEN'));
  }
  await assert.rejects(f.service.retainBooking({ ...f.owner, authorityEpoch: 0 },
    f.propertyId, f.bookingId, key(), input), code('AUTHORITY_MOVED'));
  await f.repository.transact(f.propertyId, state => { state.readOnly = true; });
  await assert.rejects(retain(f), code('PROPERTY_READ_ONLY'));
  await f.repository.transact(f.propertyId, state => { state.readOnly = false; });
  await retain(f);
  const redacted = await f.service.getBooking({ ...f.owner, fields: ['guest_name'] }, f.propertyId, f.bookingId);
  assert.equal(redacted.retainedAmountCents, undefined);
  assert.equal(redacted.paymentEvents, undefined);
  assert.equal(redacted.retention.history[0].previousTotalCents, undefined);
  assert.equal(redacted.retention.history[0].previousRoomNightPrices, undefined);
  assert.equal(redacted.retention.history[0].reason, undefined);
  assert.equal(redacted.sourceCalendar.sourceOrderRef, undefined);
  assert.equal(redacted.rescheduleEligible, false);
});

test('retained orders cannot use generic cancel or amend to bypass the lifecycle', async () => {
  const f = await retentionFixture({ native: true }); await retain(f);
  const { state, booking } = await f.read();
  await assert.rejects(f.service.cancelBooking(f.owner, f.propertyId, f.bookingId, key(),
    booking.version, state.version), code('RETAINED_ORDER_REQUIRES_RESCHEDULE'));
  await assert.rejects(f.service.amendBooking(f.owner, f.propertyId, f.bookingId, key(), {
    expectedBookingVersion: booking.version, expectedInventoryVersion: state.version,
    changes: { stays: [{ checkIn: '2027-04-04', checkOut: '2027-04-05', roomIds: [f.roomId] }] },
  }), code('RETAINED_ORDER_REQUIRES_RESCHEDULE'));
});

test('retention never opens provider stock and preserves other manual blocks and independent dispatch claims', async () => {
  const f = await retentionFixture({ native: true, mode: 'owlnest' });
  await f.repository.transact(f.propertyId, state => {
    state.bookings[0].channelSyncState = 'verified';
    state.manualBlocks.push({ roomId: f.secondRoomId, date: '2027-01-31' });
    const operationKey = key(), lineGrantId = key();
    state.operations.push({ key: operationKey, bookingId: null, bookingVersion: 0,
      controlMode: 'provider_only', state: 'sync_pending', lineGrantId,
      lineActorId: 'synthetic-line-actor', cells: [{ roomId: f.roomId, date: '2027-01-31', desired: 'closed' }],
      createdAt: new Date().toISOString(), verifiedAt: null, providerVersion: null });
    state.channelDispatch = { claimId: key(), operationKey, state: 'active', claimedAt: new Date().toISOString() };
  });
  const before = await f.read();
  const result = await retain(f);
  const after = await f.read();
  assert.equal(result.response.externalRoomActionRequired, true);
  assert.equal(result.response.operationState, 'awaiting_manual_sync');
  assert.deepEqual(after.state.operations, before.state.operations);
  assert.deepEqual(after.state.channelDispatch, before.state.channelDispatch);
  assert.deepEqual(after.state.manualBlocks, before.state.manualBlocks);
  assert.deepEqual(after.booking.stays, []);
  assert.deepEqual(after.booking.osManualRoomChange.baseline,
    [{ roomId: f.roomId, date: '2027-01-31' }, { roomId: f.roomId, date: '2027-02-01' }]);
  assert.equal(after.state.fences.length, 1, 'only exact old provider closures remain fenced');
  assert.equal(checkPropertyIntegrity(after.state, occupancy(after.state)).ok, true);
});

test('previous unresolved booking-bound provider work prevents a retention conversion', async () => {
  const f = await retentionFixture({ native: true, mode: 'owlnest' });
  await f.repository.transact(f.propertyId, state => {
    const operationKey = key();
    state.bookings[0].channelSyncState = 'pending'; state.bookings[0].channelOperationKey = operationKey;
    state.operations.push({ key: operationKey, bookingId: f.bookingId, bookingVersion: state.bookings[0].version,
      state: 'sync_pending', cells: [{ roomId: f.roomId, date: '2027-01-31', desired: 'closed' }],
      createdAt: new Date().toISOString(), verifiedAt: null, providerVersion: null });
  });
  const before = await f.read();
  await assert.rejects(retain(f), code('CHANNEL_PREVIOUS_OPERATION_UNRESOLVED'));
  assert.deepEqual(await f.read(), before);
});

test('existing manual room acknowledgement can finish a retained native release without provider writes', async () => {
  const f = await retentionFixture({ native: true, mode: 'owlnest' });
  let current = await f.read();
  await f.service.confirmManualRoomHandling(f.owner, f.propertyId, f.bookingId, key(), {
    expectedBookingVersion: current.booking.version, expectedInventoryVersion: current.state.version,
    confirmed: true, reason: 'Synthetic owner closed rooms manually' });
  await retain(f); current = await f.read();
  assert.equal(current.booking.channelSyncState, 'action_required');
  assert.equal((await f.service.getBooking(f.owner, f.propertyId, f.bookingId)).manualRoomConfirmationAvailable, true);
  await f.service.confirmManualRoomHandling(f.owner, f.propertyId, f.bookingId, key(), {
    expectedBookingVersion: current.booking.version, expectedInventoryVersion: current.state.version,
    confirmed: true, reason: 'Synthetic owner reopened original nights' });
  current = await f.read();
  assert.equal(current.booking.status, 'retained');
  assert.equal(current.booking.channelSyncState, 'manually_confirmed');
  assert.equal(current.state.operations.length, 0);
  assert.equal(current.state.fences.length, 0);
  await commitReschedule(f, await f.rescheduleInput());
  current = await f.read();
  assert.equal(current.booking.channelSyncState, 'action_required');
  assert.equal(current.state.operations.length, 0);
});

test('abandoning a not-yet-accepted request permanently prevents its delayed commit', async () => {
  const f = await retentionFixture(), input = await f.retainInput(), requestKey = key();
  const before = await f.read();
  const abandoned = await f.service.abandonRetainedRequest(f.owner, f.propertyId, f.bookingId,
    requestKey, 'retain', input);
  assert.equal(abandoned.outcome, 'not_applied'); assert.equal(abandoned.operationState, 'not_applied');
  const after = await f.read();
  assert.deepEqual(after.booking, before.booking);
  assert.equal(after.state.version, before.state.version);
  assert.deepEqual(await f.service.retainBooking(f.owner, f.propertyId, f.bookingId, requestKey, input), abandoned);
  assert.equal((await f.service.requestResult(f.owner, f.propertyId, requestKey)).outcome, 'not_applied');
  await assert.rejects(f.service.abandonRetainedRequest(f.owner, f.propertyId, f.bookingId,
    requestKey, 'retain', { ...input, reason: 'different' }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.service.abandonRetainedRequest({ ...f.owner, subjectId: 'other-owner' },
    f.propertyId, f.bookingId, requestKey, 'retain', input), code('FORBIDDEN'));
});

test('commit versus abandon serializes in both orders without undoing an accepted conversion', async () => {
  for (const abandonFirst of [true, false]) {
    const f = await retentionFixture(), input = await f.retainInput(), requestKey = key();
    const apply = () => f.service.retainBooking(f.owner, f.propertyId, f.bookingId, requestKey, input);
    const abandon = () => f.service.abandonRetainedRequest(f.owner, f.propertyId, f.bookingId, requestKey, 'retain', input);
    const results = await Promise.all(abandonFirst ? [abandon(), apply()] : [apply(), abandon()]);
    assert.deepEqual(results[0], results[1]);
    assert.equal((await f.read()).booking.status, abandonFirst ? 'confirmed' : 'retained');
    assert.equal((await f.read()).state.receipts.length, 1);
  }
});

test('abandon resolves a stale reschedule without changing its retained order or requiring old versions', async () => {
  const f = await retentionFixture(); await retain(f);
  const input = await f.rescheduleInput(), requestKey = key();
  await f.repository.transact(f.propertyId, state => { state.version++; });
  const before = await f.read();
  await assert.rejects(commitReschedule(f, input, requestKey), code('VERSION_CONFLICT'));
  const abandoned = await f.service.abandonRetainedRequest(f.owner, f.propertyId, f.bookingId,
    requestKey, 'reschedule', input);
  assert.equal(abandoned.outcome, 'not_applied');
  assert.deepEqual((await f.read()).booking, before.booking);
  assert.deepEqual(await commitReschedule(f, input, requestKey), abandoned);
  await commitReschedule(f, await f.rescheduleInput());
  assert.equal((await f.read()).booking.status, 'confirmed');
});

test('SQLite restart retains zero occupancy, exact receipts and source protection', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'iron-gate-retained-'));
  const filename = join(folder, 'retained.sqlite');
  let repository = new SqlitePropertyRepository(filename);
  try {
    const f = await retentionFixture({ repository }); const applied = await retain(f);
    const source = await f.sourceInput();
    repository.close(); repository = new SqlitePropertyRepository(filename);
    const service = new IronGateService(repository);
    assert.deepEqual(await service.retainBooking(f.owner, f.propertyId, f.bookingId,
      applied.requestKey, applied.input), applied.response);
    const state = await repository.read(f.propertyId);
    assert.equal(state.bookings.find(b => b.id === f.bookingId).stays.length, 0);
    assert.equal(checkPropertyIntegrity(state, occupancy(state)).ok, true);
    source.expectedInventoryVersion = state.version;
    const result = await service.applySourceEvent(f.source, key(), source);
    assert.equal(result.reason, 'ORDER_LIFECYCLE_OWNER_MANAGED');
  } finally { repository.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('integrity rejects retained occupancy, missing history and forged active lifecycle pointers', async () => {
  const f = await retentionFixture(); await retain(f);
  const { state } = await f.read();
  for (const mutate of [booking => { delete booking.retention; },
    booking => { booking.retention.activeRetentionId = key(); },
    booking => { booking.stays = booking.retention.history[0].previousStays; },
    booking => { booking.totalCents = 1200000; }]) {
    const bad = structuredClone(state); mutate(bad.bookings.find(b => b.id === f.bookingId));
    assert.equal(checkPropertyIntegrity(bad, occupancy(bad)).issues.includes('INVALID_BOOKING_RETENTION'), true);
  }
  const rows = occupancy(state);
  rows.push({ booking_id: f.bookingId, room_id: f.roomId, night: '2027-01-31' });
  assert.equal(checkPropertyIntegrity(state, rows).issues.includes('OCCUPANCY_DRIFT'), true);
});

test('HTTP lifecycle endpoints require exact bodies and matching abandon request identity', async () => {
  const f = await retentionFixture(), handle = createHandler(f.service, async () => f.owner);
  const request = (action, body, requestKey = key()) => handle(new Request(
    `https://synthetic.invalid/v1/properties/${f.propertyId}/bookings/${f.bookingId}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': requestKey },
      body: JSON.stringify(body) }));
  assert.equal((await request('retain-preview', { reason: retainReason })).status, 200);
  assert.equal((await request('retain-preview', { reason: retainReason, source: 'os' })).status, 400);
  assert.equal((await request('retain', { reason: retainReason })).status, 400);
  const input = await f.retainInput(), requestKey = key();
  assert.equal((await request('retained-request-abandon', { requestKey, action: 'retain', input }, key())).status, 400);
  const abandoned = await request('retained-request-abandon', { requestKey, action: 'retain', input }, requestKey);
  assert.equal(abandoned.status, 200); assert.equal((await abandoned.json()).outcome, 'not_applied');
  assert.equal((await (await request('retain', input, requestKey)).json()).outcome, 'not_applied');
});

test('the complete Offland snapshot importer refuses to overwrite an authoritative retained property', async () => {
  const f = await retentionFixture(); await retain(f);
  const { state } = await f.read(), statements = [];
  const client = { release() {}, async query(sql) {
    statements.push(sql);
    if (sql.includes('SELECT state_json')) return { rows: [{ state_json: structuredClone(state) }] };
    if (sql.includes('SELECT room_id')) return { rows: occupancy(state) };
    if (/^(BEGIN|ROLLBACK|COMMIT|SELECT set_config)/.test(sql)) return { rows: [] };
    throw Error('Unexpected write in shadow replay');
  } };
  const pool = { async connect() { return client; }, async query(sql) {
    if (sql.includes('FROM pg_roles')) return { rows: [{ login: 'iron_gate_shadow_import',
      rolsuper: false, rolbypassrls: false, runtime_member: true, schema_ready: true,
      property_rls: true, occupancy_rls: true, outbox_rls: true,
      can_change_schema: false, can_change_credentials: false,
      can_read_or_change_audit: false, can_change_events: false }] };
    return { rows: [{ login: 'iron_gate_shadow_import', database_name: 'iron_gate_test' }] };
  } };
  await assert.rejects(seedOfflandShadow(pool, f.snapshot, f.importConfig,
    { expectedDatabaseName: 'iron_gate_test' }), /OFFLAND_SHADOW_TARGET_CONFLICT/);
  assert.equal(statements.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.deepEqual((await f.read()).state, state);
});

test('an old imported paid flag is preserved as evidence without marking the new price paid', async () => {
  const f = await retentionFixture();
  await f.repository.transact(f.propertyId, state => {
    for (const row of state.bookings.find(b => b.id === f.bookingId).offlandSnapshot.rows) {
      row.values[7] = 'done'; row.values[13] = '3000'; row.values[15] = 'synthetic-old-payment-id';
    }
  });
  const before = await f.read(); await retain(f);
  await commitReschedule(f, await f.rescheduleInput());
  const detail = await f.service.getBooking(f.owner, f.propertyId, f.bookingId);
  assert.equal(detail.paymentReview.status, 'unknown');
  assert.equal(detail.retainedAmountCents, null);
  assert.deepEqual((await f.read()).booking.offlandSnapshot, before.booking.offlandSnapshot);
  assert.deepEqual((await f.read()).booking.paymentEvents, before.booking.paymentEvents);
});

test('corrected Airbnb imports retain immutable amount cohorts as historical evidence after rescheduling', async () => {
  const { corrected } = importedAmountFixture({ property: 'offland', nights: 2, rooms: 1 });
  const repository = new MemoryPropertyRepository(); repository.seed(corrected);
  const service = new IronGateService(repository), booking = corrected.bookings[0];
  const owner = { clientId: 'synthetic-os', subjectId: 'synthetic-owner', origin: 'os',
    workspaceId: corrected.workspaceId, propertyIds: [corrected.propertyId], authorityEpoch: 1,
    actions: ['booking:read', 'booking:amend'], fields: ['guest_name', 'money', 'notes', 'payment_status'] };
  const initialMarker = structuredClone(booking.sourceAmountReconciliation);
  await service.retainBooking(owner, corrected.propertyId, booking.id, key(), {
    expectedBookingVersion: booking.version, expectedInventoryVersion: corrected.version, reason: retainReason });
  let detail = await service.getBooking(owner, corrected.propertyId, booking.id);
  assert.equal(detail.status, 'retained');
  assert.equal(detail.sourceAmountReconciliation, undefined);
  assert.equal(detail.sourceCalendar.sourceOrderRef, initialMarker.sourceOrderRef);
  let amounts = (await service.sourceAmountSnapshot(owner, corrected.propertyId)).sourceAmountReconciliations;
  assert.equal(amounts.length, corrected.bookings.length);
  assert.equal(amounts.find(row => row.bookingId === booking.id).historicalOnly, true);
  assert.equal(amounts.find(row => row.bookingId !== booking.id).historicalOnly, undefined);
  const state = await repository.read(corrected.propertyId);
  await service.rescheduleBooking(owner, corrected.propertyId, booking.id, key(), {
    expectedBookingVersion: detail.version, expectedInventoryVersion: state.version,
    reason: 'Synthetic reschedule', totalCents: 120000,
    stays: [{ checkIn: '2027-04-04', checkOut: '2027-04-05', roomIds: [corrected.roomIds[0]] }],
  });
  detail = await service.getBooking(owner, corrected.propertyId, booking.id);
  assert.equal(detail.totalCents, 120000);
  assert.equal(detail.sourceAmountReconciliation, undefined);
  assert.equal(detail.sourceCalendar.sourceOrderRef, initialMarker.sourceOrderRef);
  amounts = (await service.sourceAmountSnapshot(owner, corrected.propertyId)).sourceAmountReconciliations;
  const historical = amounts.find(row => row.bookingId === booking.id);
  assert.equal(historical.status, 'confirmed'); assert.equal(historical.historicalOnly, true);
  assert.equal(historical.checkIn, initialMarker.checkIn);
  assert.equal(historical.netCents, initialMarker.netCents);
  assert.deepEqual((await repository.read(corrected.propertyId)).bookings[0].sourceAmountReconciliation, initialMarker);
  const rescheduled = await repository.read(corrected.propertyId);
  await service.retainBooking(owner, corrected.propertyId, booking.id, key(), {
    expectedBookingVersion: detail.version, expectedInventoryVersion: rescheduled.version, reason: retainReason });
  amounts = (await service.sourceAmountSnapshot(owner, corrected.propertyId)).sourceAmountReconciliations;
  assert.equal(amounts.find(row => row.bookingId === booking.id).netCents, initialMarker.netCents,
    'a later retention period must not replace the original correction provenance');
  const valid = await repository.read(corrected.propertyId);
  for (const corrupt of [
    b => { b.retention.history[0].previousTotalCents++; },
    b => { b.sourceAmountReconciliation.bookingVersion = b.version; },
  ]) {
    const bad = structuredClone(valid); corrupt(bad.bookings.find(b => b.id === booking.id));
    const badRepository = new MemoryPropertyRepository(); badRepository.seed(bad);
    const badService = new IronGateService(badRepository);
    await assert.rejects(badService.getBooking(owner, corrected.propertyId, booking.id),
      code('SOURCE_AMOUNT_RECONCILIATION_CONFLICT'));
    await assert.rejects(badService.sourceAmountSnapshot(owner, corrected.propertyId),
      code('SOURCE_AMOUNT_RECONCILIATION_CONFLICT'));
  }
});
