import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";
import { createHandler } from "../src/http.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const otherPropertyId = "44444444-4444-4444-8444-444444444444";
const channelGrantId = "55555555-5555-4555-8555-555555555555";
const sourceGrantId = "66666666-6666-4666-8666-666666666666";
const websiteBindingId = "77777777-7777-4777-8777-777777777777";
const key = () => crypto.randomUUID();
const observed = (cells) => cells.map(({ roomId, date, desired }) => ({ roomId, date,
  count: desired === "closed" ? 0 : 1, isLock: desired === "closed" }));

function setup(channel = "none") {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId, propertyId, roomIds: [roomId], version: 1, authorityEpoch: 7,
    channel: { mode: channel, ready: channel === "owlnest", websiteSalesEnabled: channel === "none",
      grantId: channel === "owlnest" ? channelGrantId : null, websiteBindingId,
      sourceReadbackEnabled: channel === "owlnest",
      stockObservedFrom: channel === "owlnest" ? "2026-11-01" : null,
      stockObservedThrough: channel === "owlnest" ? "2026-12-31" : null },
    sourceGrants: [{ grantId: sourceGrantId, sourceSystem: "ota", sourceAccount: "synthetic-account", active: true }],
    bookings: [], sourceLinks: [], operations: [], fences: [], manualBlocks: [], receipts: [] });
  return { repository, service: new IronGateService(repository) };
}
function principal(origin = "os", overrides = {}) {
  return { clientId: `${origin}-client`, subjectId: `${origin}-subject`, origin, workspaceId,
    propertyIds: [propertyId], authorityEpoch: 7,
    actions: ["booking:read", "booking:create", "booking:cancel", "source:write", "channel:verify"],
    fields: origin === "os" ? ["guest_name", "contact", "notes", "money"] : [],
    grantId: origin === "channel" ? channelGrantId : origin === "source" ? sourceGrantId : undefined,
    bindingId: origin === "website" ? websiteBindingId : undefined,
    sourceSystem: origin === "source" ? "ota" : undefined,
    sourceAccount: origin === "source" ? "synthetic-account" : undefined,
    ...overrides };
}
function bookingInput(version = 1, overrides = {}) {
  return { expectedInventoryVersion: version,
    stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-12", roomIds: [roomId] }],
    guestName: "Synthetic Guest", contact: null, notes: null, totalCents: 1200000,
    bookedAt: "2026-10-13", source: "os", ...overrides };
}
function holdInput(version = 1, overrides = {}) {
  const { source: _source, ...input } = bookingInput(version, overrides);
  void _source;
  return input;
}
function sourceInput(version = 1, overrides = {}) {
  return { propertyId, sourceSystem: "ota", sourceAccount: "synthetic-account",
    externalOrderId: "external-1", sourceVersion: "v1", previousSourceVersion: null,
    kind: "upsert", expectedInventoryVersion: version,
    stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-12", roomIds: [roomId] }],
    guestName: "External Guest", bookedAt: "2026-10-12", ...overrides };
}
const errorCode = (code) => (error) => error?.code === code;

test('OS nightly prices require money scope, exact dates and totals, and remain redacted from no-price readers', async () => {
  const { service, repository } = setup();
  const input = bookingInput(1, { roomNightPrices: [
    { roomId, date: '2026-11-10', amountCents: 500000 },
    { roomId, date: '2026-11-11', amountCents: 700000 },
  ] });
  await assert.rejects(service.createBooking(principal('os', { fields: ['guest_name'] }),
    propertyId, key(), input), errorCode('FORBIDDEN'));
  await assert.rejects(service.createBooking(principal(), propertyId, key(), {
    ...input, roomNightPrices: [{ roomId, date: '2026-11-10', amountCents: 1200000 }],
  }), errorCode('INVALID_NIGHT_PRICES'));
  assert.equal((await repository.read(propertyId)).bookings.length, 0);
  const receipt = await service.createBooking(principal(), propertyId, key(), input);
  const detail = await service.getBooking(principal(), propertyId, receipt.bookingId);
  assert.deepEqual(detail.roomNightPrices, input.roomNightPrices);
  const redacted = await service.getBooking(principal('os', { fields: ['guest_name'] }), propertyId, receipt.bookingId);
  assert.equal(redacted.roomNightPrices, undefined);
  assert.equal(redacted.totalCents, undefined);
});

async function requestSync(service, repository, created, actor = principal()) {
  const state = await repository.read(propertyId);
  const booking = state.bookings.find((item) => item.id === created.bookingId);
  return service.requestManualChannelSync({ ...actor,
    actions: [...new Set([...actor.actions, "booking:amend"]) ] },
  propertyId, created.bookingId, key(), booking.version, state.version);
}

async function verifyManualSync(service, repository, requested) {
  const channel = principal("channel");
  const operation = await service.channelOperation(channel, propertyId, requested.operationKey);
  const claimId = key();
  await repository.transact(propertyId, (state) => {
    state.channelDispatch = { claimId, operationKey: requested.operationKey,
      state: "active", claimedAt: new Date().toISOString() };
  });
  await service.recordManualChannelPreflight(channel, { propertyId,
    operationKey: requested.operationKey, providerVersion: "synthetic-open",
    observedAt: new Date().toISOString(), cells: operation.cells.map(({ roomId, date }) =>
      ({ roomId, date, count: 1, isLock: false })) });
  const verified = await service.recordChannelReadback(channel, { propertyId,
    operationKey: requested.operationKey, providerVersion: "synthetic-closed",
    observedAt: new Date().toISOString(), cells: observed(operation.cells),
    appliedClosedCells: operation.cells.map(({ roomId, date }) => ({ roomId, date })) });
  await repository.transact(propertyId, (state) => { state.channelDispatch = null; });
  return verified;
}

test("last room accepts exactly one of two concurrent requests", async () => {
  const { service, repository } = setup();
  const actor = principal();
  const results = await Promise.allSettled([
    service.createBooking(actor, propertyId, key(), bookingInput()),
    service.createBooking(actor, propertyId, key(), bookingInput()),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal((await repository.read(propertyId)).bookings.length, 1);
});

test("same key replays the original order; changed body conflicts", async () => {
  const { service, repository } = setup();
  const actor = principal(), requestKey = key(), input = bookingInput();
  const first = await service.createBooking(actor, propertyId, requestKey, input);
  const replay = await service.createBooking(actor, propertyId, requestKey, input);
  assert.deepEqual(replay, first);
  assert.equal((await repository.read(propertyId)).bookings.length, 1);
  await assert.rejects(service.createBooking(actor, propertyId, requestKey,
    bookingInput(1, { totalCents: 1 })), errorCode("IDEMPOTENCY_CONFLICT"));
  const recovered = await service.requestResult(actor, propertyId, requestKey);
  assert.equal(recovered.bookingId, first.bookingId);
  assert.equal(recovered.currentBookingVersion, 1);
});

test("request receipts stay with the verified member behind a shared OS client", async () => {
  const { service, repository } = setup();
  const owner = principal("os", { subjectId: "member-one" });
  const coworker = principal("os", { subjectId: "member-two" });
  const requestKey = key();
  await service.createBooking(owner, propertyId, requestKey, bookingInput());
  await assert.rejects(service.requestResult(coworker, propertyId, requestKey),
    errorCode("REQUEST_NOT_FOUND"));
  await assert.rejects(service.createBooking(coworker, propertyId, requestKey,
    bookingInput()), errorCode("VERSION_CONFLICT"));
  const receipts = (await repository.read(propertyId)).receipts;
  assert.equal(receipts[0].subjectId, "member-one");
});

test("payment receipts need current money scope as well as payment action", async () => {
  const { service } = setup();
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  const requestKey = key();
  const writer = principal("os", { actions: ["payment:write"], fields: ["money"] });
  const noMoney = principal("os", { actions: ["payment:write"], fields: [] });
  const payment = { expectedBookingVersion: 1, eventId: key(), kind: "received",
    amountCents: 1000, currency: "TWD", evidenceRef: "synthetic-proof",
    occurredAt: new Date().toISOString() };
  await assert.rejects(service.recordPaymentEvent(noMoney, propertyId, created.bookingId,
    key(), payment), errorCode("FORBIDDEN"));
  await service.recordPaymentEvent(writer, propertyId, created.bookingId, requestKey, payment);
  const moneyReader = principal("os", { actions: ["booking:read"], fields: ["money"] });
  const blindReader = principal("os", { actions: ["booking:read"], fields: [] });
  assert.equal((await service.getBooking(moneyReader, propertyId,
    created.bookingId)).paymentEvents[0].evidenceRef, "synthetic-proof");
  assert.equal((await service.getBooking(blindReader, propertyId,
    created.bookingId)).paymentEvents, undefined);
  await assert.rejects(service.requestResult(noMoney, propertyId, requestKey),
    errorCode("FORBIDDEN"));
  assert.equal((await service.requestResult(writer, propertyId, requestKey)).netReceivedCents, 1000);
});

test("payment history stays bounded for an OS booking detail read", async () => {
  const { service, repository } = setup();
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  await repository.transact(propertyId, state => {
    state.bookings[0].paymentEvents = Array.from({ length: 500 }, (_, index) => ({
      id: key(), kind: "received", amountCents: 1, currency: "TWD",
      evidenceRef: `synthetic-${index}`, occurredAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(), actorId: "synthetic" }));
  });
  const actor = principal("os", { actions: ["payment:write"], fields: ["money"] });
  await assert.rejects(service.recordPaymentEvent(actor, propertyId, created.bookingId,
    key(), { expectedBookingVersion: 1, eventId: key(), kind: "received",
      amountCents: 1, currency: "TWD", evidenceRef: "synthetic-extra",
      occurredAt: new Date().toISOString() }), errorCode("PAYMENT_EVENT_LIMIT"));
  assert.equal((await repository.read(propertyId)).bookings[0].paymentEvents.length, 500);
});

test("tenant, property, guest order, and route generation stay scoped", async () => {
  const { service } = setup();
  const receipt = await service.createBooking(principal(), propertyId, key(), bookingInput());
  await assert.rejects(service.getBooking(principal("os", { workspaceId: key() }), propertyId,
    receipt.bookingId), errorCode("FORBIDDEN"));
  await assert.rejects(service.getBooking(principal("os", { propertyIds: [otherPropertyId] }), propertyId,
    receipt.bookingId), errorCode("FORBIDDEN"));
  await assert.rejects(service.getBooking(principal("os", { propertyIds: propertyId }), propertyId,
    receipt.bookingId), errorCode("FORBIDDEN"));
  await assert.rejects(service.getBooking(principal("os", { actions: "booking:read" }), propertyId,
    receipt.bookingId), errorCode("FORBIDDEN"));
  await assert.rejects(service.getBooking(principal("os", { fields: "money" }), propertyId,
    receipt.bookingId), errorCode("FORBIDDEN"));
  await assert.rejects(service.getBooking(principal("guest", { bookingIdScope: key() }), propertyId,
    receipt.bookingId), errorCode("FORBIDDEN"));
  const own = await service.getBooking(principal("guest", { bookingIdScope: receipt.bookingId }),
    propertyId, receipt.bookingId);
  assert.equal(own.id, receipt.bookingId);
  assert.equal("contact" in own, false);
  await assert.rejects(service.cancelBooking(principal("os", { authorityEpoch: 6 }), propertyId,
    receipt.bookingId, key(), 1, 2), errorCode("AUTHORITY_MOVED"));
});

test("cancellation retains the order and frees local-only inventory", async () => {
  const { service, repository } = setup();
  const actor = principal();
  const created = await service.createBooking(actor, propertyId, key(), bookingInput());
  const cancelled = await service.cancelBooking(actor, propertyId, created.bookingId, key(), 1, 2,
    null, "Synthetic owner correction");
  assert.equal(cancelled.operationState, "local_only");
  const state = await repository.read(propertyId);
  assert.equal(state.bookings.length, 1);
  assert.equal(state.bookings[0].status, "cancelled");
  const audit = repository.auditRecords(propertyId);
  assert.deepEqual(audit.map((record) => record.type), ["booking.created", "booking.cancelled"]);
  assert.equal(audit[1].bookingStatus, "cancelled");
  assert.equal(audit[1].actorSubjectId, actor.subjectId);
  assert.equal(audit[1].reason, "Synthetic owner correction");
  const availability = await service.availability(actor, propertyId, "2026-11-10", "2026-11-11");
  assert.equal(availability.cells[0].state, "unsold");
});

test("calendar snapshot reads booking and sparse room nights in one authorized state", async () => {
  const { service } = setup();
  await service.createBooking(principal(), propertyId, key(), bookingInput());
  const actor = principal("os", { actions: ["booking:read"], fields: ["guest_name"] });
  const result = await service.calendarSnapshot(actor, propertyId, "2026-11-01", "2026-12-01");
  assert.equal(result.inventoryVersion, 2);
  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0].guestName, "Synthetic Guest");
  assert.equal(result.bookings[0].source, "os");
  assert.equal(result.bookings[0].bookedAt, "2026-10-13");
  assert.equal(result.bookings[0].channelSyncState, "not_required");
  assert.equal(result.bookings[0].sourceReviewRequired, false);
  assert.equal(result.bookings[0].contact, undefined);
  assert.deepEqual(result.bookings[0].stayAmountsCents, undefined);
  assert.equal(result.bookings[0].totalCents, undefined);
  const priced = await service.calendarSnapshot(principal("os", {
    actions: ["booking:read"], fields: ["guest_name", "money"],
  }), propertyId, "2026-11-01", "2026-12-01");
  assert.deepEqual(priced.bookings[0].stayAmountsCents, [1200000]);
  assert.equal(priced.bookings[0].totalCents, 1200000);
  const withoutNames = await service.calendarSnapshot(principal("os", {
    actions: ["booking:read"], fields: [],
  }), propertyId, "2026-11-01", "2026-12-01");
  assert.equal(withoutNames.bookings[0].guestName, undefined);
  assert.deepEqual(result.cells.map(cell => [cell.date, cell.state]),
    [["2026-11-10", "sold"], ["2026-11-11", "sold"]]);
  const handle = createHandler(service, async () => actor);
  const response = await handle(new Request(`https://example.test/v1/properties/${propertyId}/calendar-snapshot?from=2026-11-01&to=2026-12-01`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cells.length, 2);
  await assert.rejects(service.calendarSnapshot(principal("website"), propertyId,
    "2026-11-01", "2026-12-01"), errorCode("FORBIDDEN"));
  await assert.rejects(service.calendarSnapshot(actor, propertyId,
    "2026-01-01", "2027-03-01"), errorCode("INVALID_DATE_RANGE"));
});

test("calendar money grant uses reconciled source night amounts only", async () => {
  const { service, repository } = setup();
  await service.createBooking(principal(), propertyId, key(), bookingInput());
  await repository.transact(propertyId, (state) => {
    state.bookings[0].stays = [
      { checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] },
      { checkIn: "2026-11-11", checkOut: "2026-11-12", roomIds: [roomId] },
    ];
    state.bookings[0].sweetfunSnapshot = { rows: [
      { values: ["101", "Guest", "Booking", "2026/11/10", "2026/11/11", "", "5800"] },
      { values: ["101", "Guest", "Booking", "2026/11/11", "2026/11/12", "", "6200"] },
    ] };
  });
  const actor = principal("os", { actions: ["booking:read"], fields: ["money"] });
  const first = await service.calendarSnapshot(actor, propertyId, "2026-11-01", "2026-12-01");
  assert.deepEqual(first.bookings[0].stayAmountsCents, [580000, 620000]);
  await repository.transact(propertyId, (state) => {
    state.bookings[0].sourceCalendar = { platform: "booking", externalOrderNo: null };
  });
  const amended = await service.calendarSnapshot(actor, propertyId, "2026-11-01", "2026-12-01");
  assert.equal(amended.bookings[0].totalCents, 1200000);
  assert.equal(amended.bookings[0].stayAmountsCents, null);
  await repository.transact(propertyId, (state) => {
    state.bookings[0].sweetfunSnapshot.rows[1].values[6] = "6201";
  });
  const drifted = await service.calendarSnapshot(actor, propertyId, "2026-11-01", "2026-12-01");
  assert.equal(drifted.bookings[0].stayAmountsCents, null);
});

test("unchanged imported order exposes a scoped legacy payment link and booking date", async () => {
  const { service, repository } = setup();
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  await repository.transact(propertyId, (state) => {
    const booking = state.bookings.find(item => item.id === created.bookingId);
    booking.source = "external";
    booking.sweetfunSnapshot = { groupKey: "L:OBE12345678901234567890", rows: [{
      roomFeeCents: 1200000,
      values: ["101", "Guest", "Booking", "2026/11/10", "2026/11/12",
        "2026/10/13", "12000", "not_yet", "OK", "uid-12345678", "",
        "OBE12345678901234567890", "", "OTA123"] }] };
  });
  const owner = principal("os", { fields: ["guest_name", "money", "payment_status"] });
  const result = await service.getBooking(owner, propertyId, created.bookingId);
  assert.equal(result.sourceCalendar.bookedAt, "2026-10-13");
  assert.equal(result.sourceCalendar.sourceOrderRef, "L:OBE12345678901234567890");
  assert.deepEqual(result.paymentReview, { status: "unknown", source: "unknown" });
  const line = principal("line", { grantId: key(),
    actions: ["booking:read", "booking:manage_all"], fields: ["guest_name", "money"] });
  const lineView = await service.getBooking(line, propertyId, created.bookingId);
  assert.equal(lineView.sourcePaymentFlag, "unknown");
  assert.equal(lineView.roomNightPrices, undefined);
  assert.equal(lineView.sourceCalendar.sourceOrderRef, "L:OBE12345678901234567890");
  const snapshot = await service.calendarSnapshot(owner, propertyId,
    "2026-11-01", "2026-12-01");
  assert.equal(snapshot.bookings[0].version, 1);
  assert.equal(snapshot.bookings[0].sourceCalendar.sourceOrderRef,
    "L:OBE12345678901234567890");
  const noMoney = await service.getBooking(principal("os", { fields: ["guest_name"] }),
    propertyId, created.bookingId);
  assert.equal("sourceOrderRef" in noMoney.sourceCalendar, false);
  await repository.transact(propertyId, (state) => { state.bookings[0].version++; });
  const changed = await service.getBooking(owner, propertyId, created.bookingId);
  assert.equal("sourceOrderRef" in changed.sourceCalendar, false);
});

test("LINE receives only verified imported one-night payment evidence", async () => {
  const { service, repository } = setup();
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  await repository.transact(propertyId, (state) => {
    const booking = state.bookings[0];
    booking.source = "external";
    booking.stays = [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }];
    booking.sweetfunSnapshot = { rows: [{ roomFeeCents: 1200000,
      values: ["101", "Synthetic Guest", "Booking", "2026/11/10", "2026/11/11",
        "2026/10/13", "12000", "not_yet"] }] };
  });
  const actor = principal("line", { grantId: key(),
    actions: ["booking:read", "booking:manage_all"], fields: ["guest_name", "money"] });
  const unpaid = await service.getBooking(actor, propertyId, created.bookingId);
  assert.equal(unpaid.sourcePaymentFlag, "unpaid");
  assert.deepEqual(unpaid.roomNightPrices,
    [{ roomId, date: "2026-11-10", amountCents: 1200000 }]);
  await repository.transact(propertyId, (state) => {
    state.bookings[0].sweetfunSnapshot.rows[0].values[7] = "done";
  });
  const paid = await service.getBooking(actor, propertyId, created.bookingId);
  assert.equal(paid.sourcePaymentFlag, "paid");
});

test("manual OwlNest close requires an open preflight and cannot recover from a partial readback", async () => {
  const { service, repository } = setup("owlnest");
  const actor = principal();
  const connector = principal("channel");
  const created = await service.createBooking(actor, propertyId, key(), bookingInput());
  assert.equal(created.operationState, "awaiting_manual_sync");
  assert.equal(created.operationKey, null);
  assert.equal((await repository.read(propertyId)).operations.length, 0);
  const requested = await requestSync(service, repository, created, actor);
  const operation = await service.channelOperation(connector, propertyId, requested.operationKey);
  await repository.transact(propertyId, (state) => {
    state.channelDispatch = { claimId: key(), operationKey: requested.operationKey,
      state: "active", claimedAt: new Date().toISOString() };
  });
  await assert.rejects(service.recordChannelReadback(connector, { propertyId,
    operationKey: requested.operationKey, providerVersion: "stale-before-write",
    observedAt: new Date(Date.parse((await repository.read(propertyId)).operations[0].createdAt) - 1000).toISOString(),
    cells: observed(operation.cells) }), errorCode("STALE_READBACK"));
  await service.recordManualChannelPreflight(connector, { propertyId,
    operationKey: requested.operationKey, providerVersion: "synthetic-open",
    observedAt: new Date().toISOString(), cells: operation.cells.map(({ roomId, date }) =>
      ({ roomId, date, count: 1, isLock: false })) });
  const partial = await service.recordChannelReadback(connector, { propertyId,
    operationKey: requested.operationKey, providerVersion: "provider-v1",
    observedAt: new Date().toISOString(), cells: observed(operation.cells.slice(0, 1)) });
  assert.equal(partial.state, "review_required");
  assert.equal((await repository.read(propertyId)).fences.length, 1);
  const stillOpen = await service.recordChannelReadback(connector, { propertyId,
    operationKey: requested.operationKey, providerVersion: "provider-still-open",
    observedAt: new Date().toISOString(), cells: operation.cells.map(({ roomId, date }) =>
      ({ roomId, date, count: 1, isLock: false })) });
  assert.equal(stillOpen.state, "review_required");
  assert.equal((await repository.read(propertyId)).fences.length, 1);
  const blocked = await service.recordChannelReadback(connector, { propertyId,
    operationKey: requested.operationKey, providerVersion: "provider-v2",
    observedAt: new Date().toISOString(), cells: observed(operation.cells) });
  assert.equal(blocked.state, "review_required");
  assert.equal((await repository.read(propertyId)).fences.length, 1);
  assert.deepEqual((await repository.read(propertyId)).operations[0].observations.map((item) => item.accepted),
    [false, false, false]);
});

test("verified manual close can later cancel and reopen its nights", async () => {
  const { service, repository } = setup("owlnest");
  const actor = principal();
  const connector = principal("channel");
  const created = await service.createBooking(actor, propertyId, key(), bookingInput());
  const requested = await requestSync(service, repository, created, actor);
  assert.equal((await verifyManualSync(service, repository, requested)).state, "sync_verified");
  const current = await repository.read(propertyId);
  const cancelled = await service.cancelBooking(actor, propertyId, created.bookingId, key(),
    current.bookings[0].version, current.version);
  assert.equal(cancelled.operationState, "sync_pending");
  assert.equal((await repository.read(propertyId)).fences.length, 1);
  const opening = await service.channelOperation(connector, propertyId, cancelled.operationKey);
  assert.ok(opening.cells.every((cell) => cell.desired === "open"));
  await service.recordChannelReadback(connector, { propertyId, operationKey: cancelled.operationKey,
    providerVersion: "provider-v3", observedAt: new Date().toISOString(), cells: observed(opening.cells) });
  assert.equal((await repository.read(propertyId)).fences.length, 0);
});

test("payment recorded while OwlNest close is pending does not invalidate exact room readback", async () => {
  const { service, repository } = setup("owlnest");
  const actor = principal("os", { actions: [...principal().actions, "payment:write"] });
  const created = await service.createBooking(actor, propertyId, key(), bookingInput());
  const requested = await requestSync(service, repository, created, actor);
  await service.recordPaymentEvent(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 1, eventId: key(), kind: "received", amountCents: 10000,
    currency: "TWD", evidenceRef: "synthetic-payment", occurredAt: new Date().toISOString(),
  });
  const verified = await verifyManualSync(service, repository, requested);
  assert.equal(verified.state, "sync_verified");
  assert.equal((await repository.read(propertyId)).fences.length, 0);
});

test("website + OwlNest sale and generic LINE commands stay closed", async () => {
  const { service, repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => { state.channel.websiteSalesEnabled = true; });
  await assert.rejects(service.createBooking(principal("website"), propertyId, key(),
    bookingInput(1, { source: "website" })), errorCode("WEBSITE_QUOTE_REQUIRED"));
  await assert.rejects(service.createBooking(principal("line", { grantId: key() }), propertyId, key(),
    bookingInput(1, { source: "line" })), errorCode("LINE_PREVIEW_REQUIRED"));
  assert.equal((await repository.read(propertyId)).bookings.length, 0);
  const local = setup();
  await assert.rejects(local.service.createBooking(principal("website"), propertyId, key(),
    bookingInput(1, { source: "website" })), errorCode("WEBSITE_QUOTE_REQUIRED"));
});

test("LINE booking reads stay within the verified grant and its field scope", async () => {
  const { service, repository } = setup();
  const ownedId = key(), otherId = key(), otaId = key();
  const ownedGrant = key(), otherGrant = key();
  const base = { workspaceId, propertyId, version: 1, status: "confirmed",
    channelSyncState: "not_required", channelOperationKey: null,
    stays: bookingInput().stays, guestName: "Synthetic Guest",
    contact: "synthetic@example.invalid", notes: "Synthetic note", totalCents: 1200000,
    currency: "TWD", bookedAt: null, createdAt: "2026-10-22T00:00:00.000Z",
    paymentEvents: [] };
  await repository.transact(propertyId, (state) => {
    state.bookings.push(
      { ...base, id: ownedId, source: "line", sourceKey: `line:${ownedGrant}` },
      { ...base, id: otherId, source: "line", sourceKey: `line:${otherGrant}`,
        stays: [{ checkIn: "2026-11-12", checkOut: "2026-11-14", roomIds: [roomId] }] },
      { ...base, id: otaId, source: "external", sourceKey: null,
        stays: [{ checkIn: "2026-11-14", checkOut: "2026-11-15", roomIds: [roomId] }] });
  });
  const scope = principal("line", { grantId: ownedGrant, fields: ["guest_name", "notes"] });
  const options = { limit: 20, cursor: null, status: null, from: null, to: null };
  const listed = await service.listBookings(scope, propertyId, options);
  assert.deepEqual(listed.bookings.map((booking) => booking.id), [ownedId]);
  const booking = await service.getBooking(scope, propertyId, ownedId);
  assert.equal(booking.propertyId, propertyId);
  assert.equal(booking.authorityEpoch, 7);
  assert.equal(booking.readOnly, false);
  assert.equal(booking.inventoryVersion, listed.inventoryVersion);
  assert.deepEqual(booking.lineScope, { grantId: ownedGrant });
  assert.equal(booking.guestName, "Synthetic Guest");
  assert.equal(booking.notes, "Synthetic note");
  assert.equal(Object.hasOwn(booking, "contact"), false);
  assert.equal(Object.hasOwn(booking, "totalCents"), false);
  await assert.rejects(service.getBooking(scope, propertyId, otherId), errorCode("BOOKING_NOT_FOUND"));
  await assert.rejects(service.getBooking(scope, propertyId, otaId), errorCode("BOOKING_NOT_FOUND"));
  await assert.rejects(service.listBookings(principal("line"), propertyId, options), errorCode("FORBIDDEN"));
  const full = await service.getBooking(principal("line", { grantId: ownedGrant,
    fields: ["guest_name", "contact", "notes", "money"] }), propertyId, ownedId);
  assert.equal(full.totalCents, 1200000);
  assert.equal(full.contact, "synthetic@example.invalid");
  assert.equal(Object.hasOwn(full, "paymentSummary"), false);
});

test("LINE direct create requires a fresh actor-bound preview and one inventory version", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), subjectId: "synthetic-staff",
    actions: ["booking:read", "booking:create"] });
  const input = bookingInput(1, { source: "line" });
  const preview = await service.previewLineCreate(actor, propertyId, input);
  assert.equal(preview.inventoryVersion, 1);
  assert.equal(preview.channelSyncState, "preview_only");
  assert.equal(JSON.stringify(preview).includes("Synthetic Guest"), false);
  const requestKey = key();
  const created = await service.createBooking(actor, propertyId, requestKey, input,
    preview.previewToken);
  assert.equal(created.bookingId, requestKey);
  assert.equal(created.operationState, "sync_pending");
  assert.equal((await repository.read(propertyId)).bookings[0].sourceKey,
    `line:${actor.grantId}`);
  assert.deepEqual(await service.createBooking(actor, propertyId, requestKey, input,
    preview.previewToken), created);
  await assert.rejects(service.createBooking(actor, propertyId, key(), input,
    preview.previewToken), errorCode("VERSION_CONFLICT"));
  await assert.rejects(service.createBooking({ ...actor, subjectId: "other-staff" },
    propertyId, key(), input, preview.previewToken), errorCode("LINE_PREVIEW_REQUIRED"));
});

test("LINE room-night prices must exactly cover the booking and survive readback", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read", "booking:create"],
    fields: ["guest_name", "money"] });
  const input = bookingInput(1, { source: "line", roomNightPrices: [
    { roomId, date: "2026-11-10", amountCents: 500000 },
    { roomId, date: "2026-11-11", amountCents: 700000 },
  ] });
  const preview = await service.previewLineCreate(actor, propertyId, input);
  const requestKey = key();
  const receipt = await service.createBooking(actor, propertyId, requestKey, input,
    preview.previewToken);
  assert.equal(receipt.bookingId, requestKey);
  const found = await service.getBooking(actor, propertyId, requestKey);
  assert.deepEqual(found.roomNightPrices, input.roomNightPrices);
  await assert.rejects(service.previewLineCreate(actor, propertyId, {
    ...input, expectedInventoryVersion: 2,
    roomNightPrices: [{ roomId, date: "2026-11-10", amountCents: 1200000 }],
  }), errorCode("INVALID_NIGHT_PRICES"));
});

test("LINE accepts the existing assistant's sixty explicit room-night entries", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
    state.channel.stockObservedThrough = "2027-01-31";
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(),
    actions: ["booking:read", "booking:create"] });
  const day = (index) => new Date(Date.UTC(2026, 10, 10 + index)).toISOString().slice(0, 10);
  const input = bookingInput(1, { source: "line", totalCents: 6000,
    stays: Array.from({ length: 60 }, (_, index) => ({
      checkIn: day(index), checkOut: day(index + 1), roomIds: [roomId] })),
    roomNightPrices: Array.from({ length: 60 }, (_, index) => ({
      roomId, date: day(index), amountCents: 100 })) });
  const preview = await service.previewLineCreate(actor, propertyId, input);
  const receipt = await service.createBooking(actor, propertyId, key(), input,
    preview.previewToken);
  assert.equal(receipt.operationState, "sync_pending");
  assert.equal((await repository.read(propertyId)).operations[0].cells.length, 60);
});

test("LINE cannot create nights beyond the last complete OwlNest stock observation", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
    state.channel.stockObservedThrough = "2026-11-10";
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(),
    actions: ["booking:read", "booking:create"] });
  await assert.rejects(service.previewLineCreate(actor, propertyId,
    bookingInput(1, { source: "line" })), errorCode("LINE_STOCK_NOT_OBSERVED"));
  assert.equal((await repository.read(propertyId)).bookings.length, 0);
});

test("LINE preview rejects altered payload, stale authority, and a disabled channel", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read", "booking:create"] });
  const input = bookingInput(1, { source: "line" });
  const preview = await service.previewLineCreate(actor, propertyId, input);
  await assert.rejects(service.createBooking(actor, propertyId, key(),
    { ...input, totalCents: 1 }, preview.previewToken), errorCode("LINE_PREVIEW_REQUIRED"));
  await assert.rejects(service.createBooking(actor, propertyId, key(), input,
    preview.previewToken + "x"), errorCode("LINE_PREVIEW_REQUIRED"));
  await repository.transact(propertyId, (state) => {
    state.channel.sourceReadbackEnabled = false;
  });
  await assert.rejects(service.createBooking(actor, propertyId, key(), input,
    preview.previewToken), errorCode("LINE_CHANNEL_NOT_READY"));
  await assert.rejects(service.previewLineCreate(actor, propertyId, input),
    errorCode("LINE_CHANNEL_NOT_READY"));
  await assert.rejects(service.previewLineCreate({ ...actor, authorityEpoch: 8 },
    propertyId, input), errorCode("LINE_CHANNEL_NOT_READY"));
  assert.equal((await repository.read(propertyId)).bookings.length, 0);
});

test("LINE preview expires before a booking can be committed", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read", "booking:create"] });
  const input = bookingInput(1, { source: "line" });
  const originalNow = Date.now;
  let now = originalNow();
  try {
    Date.now = () => now;
    const preview = await service.previewLineCreate(actor, propertyId, input);
    now += 15 * 60_000 + 1;
    await assert.rejects(service.createBooking(actor, propertyId, key(), input,
      preview.previewToken), errorCode("LINE_PREVIEW_REQUIRED"));
  } finally { Date.now = originalNow; }
  assert.equal((await repository.read(propertyId)).bookings.length, 0);
});

test("LINE can amend and cancel only its verified direct booking with exact previews", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), subjectId: "staff",
    actions: ["booking:read", "booking:create", "booking:amend", "booking:cancel", "booking:manage_all"],
    fields: ["guest_name", "contact", "notes", "money"] });
  const channel = principal("channel");
  const input = bookingInput(1, { source: "line" });
  const createPreview = await service.previewLineCreate(actor, propertyId, input);
  const created = await service.createBooking(actor, propertyId, key(), input, createPreview.previewToken);
  const createOp = (await repository.read(propertyId)).operations[0];
  await assert.rejects(service.previewLineAction(actor, propertyId, created.bookingId,
    "cancel", { expectedBookingVersion: 1, expectedInventoryVersion: 2 }),
  errorCode("LINE_BOOKING_NOT_READY"));
  await service.recordChannelReadback(channel, { propertyId, operationKey: createOp.key,
    observedAt: new Date().toISOString(), providerVersion: "synthetic-1", cells: observed(createOp.cells) });
  let state = await repository.read(propertyId);
  const booking = state.bookings[0];
  const amended = { expectedBookingVersion: booking.version, expectedInventoryVersion: state.version,
    changes: { stays: [{ checkIn: "2026-11-11", checkOut: "2026-11-13", roomIds: [roomId] }],
      guestName: "Changed Guest" } };
  const preview = await service.previewLineAction(actor, propertyId, booking.id, "amend", amended);
  assert.equal(preview.action, "amend");
  await assert.rejects(service.amendBooking({ ...actor, subjectId: "other-staff" },
    propertyId, booking.id, key(), amended, preview.previewToken), errorCode("LINE_PREVIEW_REQUIRED"));
  await assert.rejects(service.amendBooking(actor, propertyId, booking.id, key(),
    { ...amended, changes: { guestName: "Tampered" } }, preview.previewToken),
  errorCode("LINE_PREVIEW_REQUIRED"));
  const amendKey = key();
  const result = await service.amendBooking(actor, propertyId, booking.id, amendKey,
    amended, preview.previewToken);
  assert.equal(result.operationState, "sync_pending");
  assert.deepEqual(await service.amendBooking(actor, propertyId, booking.id, amendKey,
    amended, preview.previewToken), result);
  state = await repository.read(propertyId);
  const amendOp = state.operations.find((op) => op.key === result.operationKey);
  assert.deepEqual(amendOp.cells.map((cell) => [cell.date, cell.desired]).sort(),
    [["2026-11-10", "open"], ["2026-11-12", "closed"]]);
  await assert.rejects(service.previewLineAction({ ...actor,
    actions: actor.actions.filter((action) => action !== "booking:manage_all") }, propertyId,
    booking.id, "cancel", { expectedBookingVersion: state.bookings[0].version,
      expectedInventoryVersion: state.version }), errorCode("FORBIDDEN"));
  await service.recordChannelReadback(channel, { propertyId, operationKey: amendOp.key,
    observedAt: new Date().toISOString(), providerVersion: "synthetic-2", cells: observed(amendOp.cells) });
  state = await repository.read(propertyId);
  const cancelInput = { expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version };
  const cancelPreview = await service.previewLineAction(actor, propertyId, booking.id,
    "cancel", cancelInput);
  await assert.rejects(service.cancelBooking(actor, propertyId, booking.id, key(),
    cancelInput.expectedBookingVersion, cancelInput.expectedInventoryVersion, preview.previewToken),
  errorCode("LINE_PREVIEW_REQUIRED"));
  const cancel = await service.cancelBooking(actor, propertyId, booking.id, key(),
    cancelInput.expectedBookingVersion, cancelInput.expectedInventoryVersion,
    cancelPreview.previewToken);
  assert.equal(cancel.operationState, "sync_pending");
  state = await repository.read(propertyId);
  assert.equal(state.bookings[0].status, "cancelled");
  assert.deepEqual(state.operations.find((op) => op.key === cancel.operationKey)
    .cells.map((cell) => cell.desired), ["open", "open"]);
});

test("LINE mutation blocks paid bookings and requires the money grant for price edits", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read", "booking:create",
    "booking:amend", "booking:cancel", "booking:manage_all"] });
  const input = bookingInput(1, { source: "line" });
  const preview = await service.previewLineCreate(actor, propertyId, input);
  const created = await service.createBooking(actor, propertyId, key(), input, preview.previewToken);
  const operation = (await repository.read(propertyId)).operations[0];
  await service.recordChannelReadback(principal("channel"), { propertyId, operationKey: operation.key,
    observedAt: new Date().toISOString(), providerVersion: "synthetic", cells: observed(operation.cells) });
  let state = await repository.read(propertyId);
  await assert.rejects(service.previewLineAction(actor, propertyId, created.bookingId, "amend",
    { expectedBookingVersion: state.bookings[0].version, expectedInventoryVersion: state.version,
      changes: { totalCents: 100 } }), errorCode("FORBIDDEN"));
  await repository.transact(propertyId, (draft) => {
    draft.bookings[0].paymentEvents = [{ id: key(), kind: "received", amountCents: 100,
      currency: "TWD", evidenceRef: "synthetic", occurredAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(), actorId: "os" }];
  });
  state = await repository.read(propertyId);
  await assert.rejects(service.previewLineAction(actor, propertyId, created.bookingId, "cancel",
    { expectedBookingVersion: state.bookings[0].version, expectedInventoryVersion: state.version }),
  errorCode("LINE_PAYMENT_REQUIRES_REVIEW"));
});

test("HTTP LINE cancel route commits only the signed versioned preview", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read",
    "booking:create", "booking:cancel", "booking:amend", "booking:manage_all"] });
  const input = bookingInput(1, { source: "line" });
  const createPreview = await service.previewLineCreate(actor, propertyId, input);
  const created = await service.createBooking(actor, propertyId, key(), input,
    createPreview.previewToken);
  const operation = (await repository.read(propertyId)).operations[0];
  await service.recordChannelReadback(principal("channel"), { propertyId,
    operationKey: operation.key, observedAt: new Date().toISOString(),
    providerVersion: "verified", cells: observed(operation.cells) });
  const state = await repository.read(propertyId);
  const cancel = { expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version };
  const base = `https://iron.invalid/v1/properties/${propertyId}/bookings/${created.bookingId}`;
  const handle = createHandler(service, async () => actor);
  const prepare = await handle(new Request(base + "/line-action-previews", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "cancel", input: cancel }) }));
  assert.equal(prepare.status, 200);
  const preview = await prepare.json();
  const withoutToken = await handle(new Request(base + "/cancel", {
    method: "POST", headers: { "content-type": "application/json",
      "idempotency-key": key() }, body: JSON.stringify(cancel) }));
  assert.equal(withoutToken.status, 409);
  const submitted = await handle(new Request(base + "/cancel", {
    method: "POST", headers: { "content-type": "application/json",
      "idempotency-key": key(), "x-iron-gate-line-preview": preview.previewToken },
    body: JSON.stringify(cancel) }));
  assert.equal(submitted.status, 202);
  assert.equal((await submitted.json()).operationState, "sync_pending");
});

test("LINE date batch cancellation is atomic, versioned, and replays one receipt", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read",
    "booking:create", "booking:cancel", "booking:manage_all"] });
  const channel = principal("channel");
  const ids = [];
  for (const [checkIn, checkOut] of [["2026-11-10", "2026-11-12"],
    ["2026-11-13", "2026-11-15"]]) {
    const state = await repository.read(propertyId);
    const input = bookingInput(state.version, { source: "line",
      stays: [{ checkIn, checkOut, roomIds: [roomId] }] });
    const preview = await service.previewLineCreate(actor, propertyId, input);
    const created = await service.createBooking(actor, propertyId, key(), input,
      preview.previewToken);
    ids.push(created.bookingId);
    const operation = (await repository.read(propertyId)).operations.at(-1);
    await service.recordChannelReadback(channel, { propertyId, operationKey: operation.key,
      observedAt: new Date().toISOString(), providerVersion: "synthetic",
      cells: observed(operation.cells) });
  }
  const state = await repository.read(propertyId);
  const bookings = state.bookings.filter((booking) => ids.includes(booking.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const input = { expectedInventoryVersion: state.version,
    bookings: bookings.map((booking) => ({ bookingId: booking.id,
      expectedBookingVersion: booking.version })) };
  const preview = await service.previewLineBulkCancel(actor, propertyId, input);
  assert.deepEqual(preview.bookingIds, input.bookings.map((item) => item.bookingId));
  await assert.rejects(service.bulkCancelLineBookings({ ...actor, subjectId: "other" },
    propertyId, key(), input, preview.previewToken), errorCode("LINE_PREVIEW_REQUIRED"));
  const stale = { ...input, bookings: input.bookings.map((item, i) => i === 1 ?
    { ...item, expectedBookingVersion: item.expectedBookingVersion + 1 } : item) };
  await assert.rejects(service.previewLineBulkCancel(actor, propertyId, stale),
    errorCode("VERSION_CONFLICT"));
  assert.equal((await repository.read(propertyId)).bookings.filter((booking) =>
    booking.status === "confirmed").length, 2);
  await repository.transact(propertyId, (current) => {
    current.bookings.find((booking) => booking.id === bookings[1].id).version++;
  });
  await assert.rejects(service.bulkCancelLineBookings(actor, propertyId, key(),
    input, preview.previewToken), errorCode("VERSION_CONFLICT"));
  assert.equal((await repository.read(propertyId)).bookings.filter((booking) =>
    booking.status === "confirmed").length, 2);
  await repository.transact(propertyId, (current) => {
    current.bookings.find((booking) => booking.id === bookings[1].id).version--;
  });
  const requestKey = key();
  const result = await service.bulkCancelLineBookings(actor, propertyId, requestKey,
    input, preview.previewToken);
  assert.deepEqual(result.bookingIds, preview.bookingIds);
  assert.equal(result.operationState, "sync_pending");
  assert.deepEqual(await service.bulkCancelLineBookings(actor, propertyId, requestKey,
    input, preview.previewToken), result);
  const after = await repository.read(propertyId);
  assert.equal(after.bookings.filter((booking) => booking.status === "cancelled").length, 2);
  assert.equal(after.operations.filter((operation) =>
    result.operationKeys.includes(operation.key)).length, 2);
  assert.deepEqual((await service.requestResult(actor, propertyId, requestKey)).bookingIds,
    result.bookingIds);
});

test("LINE manual close and open pass through canonical blocks and exact OwlNest readback", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(),
    actions: ["booking:read", "booking:manage_all", "inventory:write"] });
  const cell = { roomId, date: "2026-11-10" };
  const closeInput = { expectedInventoryVersion: 1, ...cell, desired: "closed" };
  const handle = createHandler(service, async () => actor);
  const capability = await handle(new Request(
    `https://iron.invalid/v1/properties/${propertyId}/line-capabilities`));
  assert.equal(capability.status, 200);
  assert.equal((await capability.json()).canInventory, true);
  const closePreviewResponse = await handle(new Request(
    `https://iron.invalid/v1/properties/${propertyId}/inventory-previews`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(closeInput) }));
  assert.equal(closePreviewResponse.status, 200);
  const closePreview = await closePreviewResponse.json();
  const closeKey = key();
  await assert.rejects(service.setLineInventory({ ...actor, subjectId: "other" },
    propertyId, key(), closeInput, closePreview.previewToken), errorCode("LINE_PREVIEW_REQUIRED"));
  const closeResponse = await handle(new Request(
    `https://iron.invalid/v1/properties/${propertyId}/inventory`, {
      method: "POST", headers: { "content-type": "application/json",
        "idempotency-key": closeKey,
        "x-iron-gate-line-preview": closePreview.previewToken },
      body: JSON.stringify(closeInput) }));
  assert.equal(closeResponse.status, 202);
  const close = await closeResponse.json();
  assert.equal(close.operationState, "sync_pending");
  assert.deepEqual(await service.setLineInventory(actor, propertyId, closeKey,
    closeInput, closePreview.previewToken), close);
  let state = await repository.read(propertyId);
  assert.deepEqual(state.manualBlocks, [cell]);
  const channel = principal("channel");
  const closeOperation = state.operations.find((item) => item.key === close.operationKey);
  assert.equal(closeOperation.bookingId, null);
  assert.deepEqual(closeOperation.cells, [{ ...cell, desired: "closed" }]);
  await service.recordChannelReadback(channel, { propertyId, operationKey: close.operationKey,
    observedAt: new Date().toISOString(), providerVersion: "manual-closed",
    cells: observed(closeOperation.cells) });
  state = await repository.read(propertyId);
  const availability = await service.availability(actor, propertyId, cell.date, "2026-11-11");
  assert.equal(availability.cells[0].state, "blocked");
  assert.equal(availability.cells[0].manualBlocked, true);
  const openInput = { ...closeInput, expectedInventoryVersion: state.version, desired: "open" };
  const openPreview = await service.previewLineInventory(actor, propertyId, openInput);
  const opened = await service.setLineInventory(actor, propertyId, key(), openInput,
    openPreview.previewToken);
  state = await repository.read(propertyId);
  assert.equal(state.manualBlocks.length, 0);
  assert.equal((await service.availability(actor, propertyId, cell.date,
    "2026-11-11")).cells[0].manualBlocked, false);
  const openOperation = state.operations.find((item) => item.key === opened.operationKey);
  await service.recordChannelReadback(channel, { propertyId, operationKey: opened.operationKey,
    observedAt: new Date().toISOString(), providerVersion: "manual-opened",
    cells: observed(openOperation.cells) });
  const after = await repository.read(propertyId);
  assert.equal(after.fences.length, 0);
  assert.equal((await service.availability(actor, propertyId, cell.date,
    "2026-11-11")).cells[0].state, "unsold");
});

test("LINE booking manual close needs staff action and own provider write proof", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), subjectId: "staff-one",
    actions: ["booking:read", "booking:create", "booking:manage_all", "inventory:write"] });
  const input = bookingInput(1, { source: "line", channelPolicy: "manual" });
  const preview = await service.previewLineCreate(actor, propertyId, input);
  await repository.transact(propertyId, (state) => { state.version++; });
  const created = await service.createBooking(actor, propertyId, key(), input,
    preview.previewToken);
  let state = await repository.read(propertyId);
  assert.equal(created.operationState, "action_required");
  assert.equal(state.operations.length, 0);
  assert.equal(state.bookings[0].channelSyncState, "action_required");
  assert.equal(state.bookings[0].lineChannelActionRequiredAt, state.bookings[0].createdAt);
  const cells = state.bookings[0].lineChannelPending.map(({ roomId, date }) => ({ roomId, date }));
  const request = { expectedBookingVersion: 1, expectedInventoryVersion: state.version,
    desired: "closed", cells };
  const action = await service.previewLineChannelAction(actor, propertyId, created.bookingId, request);
  await repository.transact(propertyId, (unrelated) => { unrelated.version++; });
  await assert.rejects(service.requestLineChannelAction({ ...actor, subjectId: "staff-two" },
    propertyId, created.bookingId, key(), request, action.previewToken),
  errorCode("LINE_PREVIEW_REQUIRED"));
  const operationKey = key();
  const submitted = await service.requestLineChannelAction(actor, propertyId,
    created.bookingId, operationKey, request, action.previewToken);
  assert.equal(submitted.operationKey, operationKey);
  assert.deepEqual(await service.requestLineChannelAction(actor, propertyId,
    created.bookingId, operationKey, request, action.previewToken), submitted);
  state = await repository.read(propertyId);
  assert.equal(state.operations.length, 1);
  await service.recordChannelReadback(principal("channel"), { propertyId, operationKey,
    observedAt: new Date().toISOString(), providerVersion: "synthetic-closed",
    cells: observed(state.operations[0].cells), appliedClosedCells: cells });
  state = await repository.read(propertyId);
  assert.equal(state.bookings[0].channelSyncState, "verified");
  assert.equal(state.bookings[0].lineChannelActionRequiredAt, null);
  assert.equal(state.fences.length, 0);
});

test("LINE cancelled booking holds former nights until staff verifies manual open", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read", "booking:create",
    "booking:cancel", "booking:manage_all", "inventory:write"] });
  const input = bookingInput(1, { source: "line", channelPolicy: "manual" });
  const preview = await service.previewLineCreate(actor, propertyId, input);
  const created = await service.createBooking(actor, propertyId, key(), input, preview.previewToken);
  let state = await repository.read(propertyId);
  const cells = state.bookings[0].lineChannelPending.map(({ roomId, date }) => ({ roomId, date }));
  const close = { expectedBookingVersion: 1, expectedInventoryVersion: state.version,
    desired: "closed", cells };
  const closePreview = await service.previewLineChannelAction(actor, propertyId,
    created.bookingId, close);
  const closeKey = key();
  await service.requestLineChannelAction(actor, propertyId, created.bookingId,
    closeKey, close, closePreview.previewToken);
  state = await repository.read(propertyId);
  await service.recordChannelReadback(principal("channel"), { propertyId, operationKey: closeKey,
    observedAt: new Date().toISOString(), providerVersion: "closed",
    cells: observed(state.operations[0].cells), appliedClosedCells: cells });
  state = await repository.read(propertyId);
  const cancel = { expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version, channelPolicy: "manual" };
  const cancelPreview = await service.previewLineAction(actor, propertyId,
    created.bookingId, "cancel", cancel);
  await service.cancelBooking(actor, propertyId, created.bookingId, key(),
    cancel.expectedBookingVersion, cancel.expectedInventoryVersion,
    cancelPreview.previewToken, cancel.channelPolicy);
  state = await repository.read(propertyId);
  assert.equal(state.bookings[0].channelSyncState, "action_required");
  assert.equal(state.operations.length, 1);
  assert.equal(state.fences.find((fence) => fence.reason === "line_action_required")?.cells.length, 2);
  assert.equal((await service.availability(actor, propertyId, "2026-11-10", "2026-11-11"))
    .cells[0].state, "blocked");
  await assert.rejects(service.createBooking(principal(), propertyId, key(),
    bookingInput(state.version)), errorCode("ROOM_CONFLICT"));
  const opening = { expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version, desired: "open", cells };
  const openingPreview = await service.previewLineChannelAction(actor, propertyId,
    created.bookingId, opening);
  const openKey = key();
  await service.requestLineChannelAction(actor, propertyId, created.bookingId,
    openKey, opening, openingPreview.previewToken);
  state = await repository.read(propertyId);
  assert.equal(state.fences.some((fence) => fence.reason === "line_action_required"), false);
  assert.equal(state.fences.some((fence) => fence.key === openKey), true);
  await service.recordChannelReadback(principal("channel"), { propertyId, operationKey: openKey,
    observedAt: new Date().toISOString(), providerVersion: "opened",
    cells: observed(state.operations[1].cells) });
  state = await repository.read(propertyId);
  assert.equal(state.fences.length, 0);
  assert.equal(state.bookings[0].channelSyncState, "not_required");
});

test("cancelling an unclosed manual LINE booking needs no OwlNest open", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read", "booking:create",
    "booking:cancel", "booking:manage_all", "inventory:write"] });
  const input = bookingInput(1, { source: "line", channelPolicy: "manual" });
  const preview = await service.previewLineCreate(actor, propertyId, input);
  const created = await service.createBooking(actor, propertyId, key(), input, preview.previewToken);
  const state = await repository.read(propertyId);
  const cancel = { expectedBookingVersion: 1, expectedInventoryVersion: state.version,
    channelPolicy: "manual" };
  const signed = await service.previewLineAction(actor, propertyId,
    created.bookingId, "cancel", cancel);
  const receipt = await service.cancelBooking(actor, propertyId, created.bookingId, key(),
    1, state.version, signed.previewToken, "manual");
  assert.equal(receipt.operationState, "not_required");
  const after = await repository.read(propertyId);
  assert.equal(after.operations.length, 0);
  assert.equal(after.fences.length, 0);
  assert.equal(after.bookings[0].channelSyncState, "not_required");
});

test("manual LINE close refuses pre-closed stock without its own write evidence", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read", "booking:create",
    "booking:manage_all", "inventory:write"] });
  const input = bookingInput(1, { source: "line", channelPolicy: "manual" });
  const preview = await service.previewLineCreate(actor, propertyId, input);
  const receipt = await service.createBooking(actor, propertyId, key(), input, preview.previewToken);
  const state = await repository.read(propertyId);
  const cells = state.bookings[0].lineChannelPending.map(({ roomId, date }) => ({ roomId, date }));
  const action = { expectedBookingVersion: 1, expectedInventoryVersion: state.version,
    desired: "closed", cells };
  const signed = await service.previewLineChannelAction(actor, propertyId, receipt.bookingId, action);
  const operationKey = key();
  await service.requestLineChannelAction(actor, propertyId, receipt.bookingId,
    operationKey, action, signed.previewToken);
  const readback = await service.recordChannelReadback(principal("channel"), { propertyId,
    operationKey, observedAt: new Date().toISOString(), providerVersion: "preclosed",
    cells: observed(cells.map((cell) => ({ ...cell, desired: "closed" }))),
    appliedClosedCells: [] });
  assert.equal(readback.state, "review_required");
  const after = await repository.read(propertyId);
  assert.equal(after.bookings[0].channelSyncState, "review_required");
  assert.equal(after.fences.length, 1);
});

test("manual LINE close cannot verify against a replacement booking", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read", "booking:create",
    "booking:manage_all", "inventory:write"] });
  const input = bookingInput(1, { source: "line", channelPolicy: "manual" });
  const preview = await service.previewLineCreate(actor, propertyId, input);
  const receipt = await service.createBooking(actor, propertyId, key(), input, preview.previewToken);
  let state = await repository.read(propertyId);
  const cells = state.bookings[0].lineChannelPending.map(({ roomId, date }) => ({ roomId, date }));
  const action = { expectedBookingVersion: 1, expectedInventoryVersion: state.version,
    desired: "closed", cells };
  const signed = await service.previewLineChannelAction(actor, propertyId, receipt.bookingId, action);
  const operationKey = key();
  await service.requestLineChannelAction(actor, propertyId, receipt.bookingId,
    operationKey, action, signed.previewToken);
  // A later source takeover is not proof that this close belongs to the
  // original booking, even when OwlNest now reads closed on every cell.
  await repository.transact(propertyId, (draft) => {
    draft.bookings[0].status = "cancelled";
    draft.bookings.push({ ...structuredClone(draft.bookings[0]), id: key(),
      status: "confirmed", channelOperationKey: null });
  });
  state = await repository.read(propertyId);
  const result = await service.recordChannelReadback(principal("channel"), { propertyId,
    operationKey, observedAt: new Date().toISOString(), providerVersion: "replacement-closed",
    cells: observed(state.operations[0].cells), appliedClosedCells: cells });
  assert.equal(result.state, "review_required");
  const after = await repository.read(propertyId);
  assert.equal(after.bookings[0].channelSyncState, "review_required");
  assert.equal(after.fences.some((fence) => fence.key === operationKey), true);
});

test("manual LINE date change closes acquired nights before safely opening former nights", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read", "booking:create",
    "booking:amend", "booking:manage_all", "inventory:write"], fields: ["notes"] });
  const input = bookingInput(1, { source: "line", channelPolicy: "manual" });
  const preview = await service.previewLineCreate(actor, propertyId, input);
  const created = await service.createBooking(actor, propertyId, key(), input, preview.previewToken);
  let state = await repository.read(propertyId);
  const original = state.bookings[0].lineChannelPending.map(({ roomId, date }) => ({ roomId, date }));
  const close = { expectedBookingVersion: 1, expectedInventoryVersion: state.version,
    desired: "closed", cells: original };
  const signedClose = await service.previewLineChannelAction(actor, propertyId, created.bookingId, close);
  const closeKey = key();
  await service.requestLineChannelAction(actor, propertyId, created.bookingId,
    closeKey, close, signedClose.previewToken);
  await service.recordChannelReadback(principal("channel"), { propertyId, operationKey: closeKey,
    observedAt: new Date().toISOString(), providerVersion: "initial-close",
    cells: observed(original.map((cell) => ({ ...cell, desired: "closed" }))),
    appliedClosedCells: original });
  state = await repository.read(propertyId);
  const amend = { expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version, channelPolicy: "manual",
    changes: { stays: [{ checkIn: "2026-11-11", checkOut: "2026-11-13", roomIds: [roomId] }] } };
  const signedAmend = await service.previewLineAction(actor, propertyId,
    created.bookingId, "amend", amend);
  await service.amendBooking(actor, propertyId, created.bookingId, key(), amend,
    signedAmend.previewToken);
  state = await repository.read(propertyId);
  assert.equal(state.bookings[0].channelSyncState, "action_required");
  assert.match(state.bookings[0].lineChannelActionRequiredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(state.bookings[0].lineChannelPending.map(({ date, desired }) => [date, desired]),
    [["2026-11-10", "open"], ["2026-11-12", "closed"]]);
  const waitingSince = state.bookings[0].lineChannelActionRequiredAt;
  const metadata = { expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version, channelPolicy: "manual",
    changes: { notes: "synthetic note" } };
  const signedMetadata = await service.previewLineAction(actor, propertyId,
    created.bookingId, "amend", metadata);
  await service.amendBooking(actor, propertyId, created.bookingId, key(), metadata,
    signedMetadata.previewToken);
  state = await repository.read(propertyId);
  assert.equal(state.bookings[0].lineChannelActionRequiredAt, waitingSince);
  assert.equal(state.fences.find((fence) => fence.reason === "line_action_required")?.cells[0].date,
    "2026-11-10");
  const opening = { expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version, desired: "open",
    cells: [{ roomId, date: "2026-11-10" }] };
  await assert.rejects(service.previewLineChannelAction(actor, propertyId,
    created.bookingId, opening), errorCode("LINE_CLOSE_FIRST"));
  const acquired = { ...opening, desired: "closed", cells: [{ roomId, date: "2026-11-12" }] };
  const signedAcquired = await service.previewLineChannelAction(actor, propertyId,
    created.bookingId, acquired);
  const acquiredKey = key();
  await service.requestLineChannelAction(actor, propertyId, created.bookingId,
    acquiredKey, acquired, signedAcquired.previewToken);
  await service.recordChannelReadback(principal("channel"), { propertyId,
    operationKey: acquiredKey, observedAt: new Date().toISOString(),
    providerVersion: "new-close", cells: observed([{ roomId, date: "2026-11-12", desired: "closed" }]),
    appliedClosedCells: acquired.cells });
  state = await repository.read(propertyId);
  assert.equal(state.bookings[0].channelSyncState, "action_required");
  const signedOpen = await service.previewLineChannelAction(actor, propertyId,
    created.bookingId, { ...opening, expectedBookingVersion: state.bookings[0].version,
      expectedInventoryVersion: state.version });
  const openKey = key();
  await service.requestLineChannelAction(actor, propertyId, created.bookingId, openKey,
    { ...opening, expectedBookingVersion: state.bookings[0].version,
      expectedInventoryVersion: state.version }, signedOpen.previewToken);
  await service.recordChannelReadback(principal("channel"), { propertyId,
    operationKey: openKey, observedAt: new Date().toISOString(), providerVersion: "old-open",
    cells: observed([{ roomId, date: "2026-11-10", desired: "open" }]) });
  state = await repository.read(propertyId);
  assert.equal(state.bookings[0].channelSyncState, "verified");
  assert.equal(state.bookings[0].lineChannelPending.length, 0);
  assert.equal(state.fences.length, 0);
});

test("legacy LINE provider status cannot become a fabricated manual open baseline", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read", "booking:create",
    "booking:amend", "booking:cancel", "booking:manage_all", "inventory:write"],
    fields: ["notes"] });
  const input = bookingInput(1, { source: "line" });
  const preview = await service.previewLineCreate(actor, propertyId, input);
  const created = await service.createBooking(actor, propertyId, key(), input,
    preview.previewToken);
  let state = await repository.read(propertyId);
  await service.recordChannelReadback(principal("channel"), { propertyId,
    operationKey: created.operationKey, observedAt: new Date().toISOString(),
    providerVersion: "legacy-close", cells: observed(state.operations[0].cells) });
  state = await repository.read(propertyId);
  assert.equal(state.bookings[0].channelSyncState, "verified");
  assert.equal(state.bookings[0].lineChannelBaselineNights, undefined);
  const metadata = { expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version, channelPolicy: "manual",
    changes: { notes: "synthetic note" } };
  const signed = await service.previewLineAction(actor, propertyId, created.bookingId,
    "amend", metadata);
  await service.amendBooking(actor, propertyId, created.bookingId, key(), metadata,
    signed.previewToken);
  state = await repository.read(propertyId);
  assert.equal(state.bookings[0].lineChannelBaselineNights, undefined);
  const cancel = { expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version, channelPolicy: "manual" };
  await assert.rejects(service.previewLineAction(actor, propertyId, created.bookingId,
    "cancel", cancel), errorCode("LINE_CHANNEL_BASELINE_UNPROVEN"));
  assert.equal((await repository.read(propertyId)).bookings[0].status, "confirmed");
});

test("LINE room batch is one signed operation and refuses a partly occupied batch", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(),
    actions: ["booking:read", "booking:manage_all", "inventory:write"] });
  const cells = [{ roomId, date: "2026-11-10" }, { roomId, date: "2026-11-11" }];
  const input = { expectedInventoryVersion: 1, cells, desired: "closed" };
  await repository.transact(propertyId, (state) => { state.manualBlocks.push(cells[1]); });
  await assert.rejects(service.previewLineInventoryBatch(actor, propertyId, input),
    errorCode("ROOM_CONFLICT"));
  assert.equal((await repository.read(propertyId)).operations.length, 0);
  await repository.transact(propertyId, (state) => { state.manualBlocks = []; });
  const handle = createHandler(service, async () => actor);
  const base = `https://iron.invalid/v1/properties/${propertyId}`;
  const prepared = await handle(new Request(base + "/inventory-batch-previews", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(input) }));
  assert.equal(prepared.status, 200);
  const preview = await prepared.json();
  await assert.rejects(service.setLineInventoryBatch({ ...actor, subjectId: "other" },
    propertyId, key(), input, preview.previewToken), errorCode("LINE_PREVIEW_REQUIRED"));
  const requestKey = key();
  const submitted = await handle(new Request(base + "/inventory-batches", {
    method: "POST", headers: { "content-type": "application/json",
      "idempotency-key": requestKey, "x-iron-gate-line-preview": preview.previewToken },
    body: JSON.stringify(input) }));
  assert.equal(submitted.status, 202);
  const result = await submitted.json();
  assert.equal(result.operationState, "sync_pending");
  assert.deepEqual(result.cells, cells);
  assert.deepEqual(await service.setLineInventoryBatch(actor, propertyId, requestKey,
    input, preview.previewToken), result);
  let state = await repository.read(propertyId);
  assert.deepEqual(state.manualBlocks, cells);
  const operation = state.operations.find((item) => item.key === result.operationKey);
  assert.deepEqual(operation.cells.map((item) => item.desired), ["closed", "closed"]);
  await service.recordChannelReadback(principal("channel"), { propertyId,
    operationKey: operation.key, observedAt: new Date().toISOString(),
    providerVersion: "synthetic", cells: observed(operation.cells) });
  state = await repository.read(propertyId);
  const open = { expectedInventoryVersion: state.version, cells, desired: "open" };
  const openPreview = await service.previewLineInventoryBatch(actor, propertyId, open);
  await service.setLineInventoryBatch(actor, propertyId, key(), open,
    openPreview.previewToken);
  state = await repository.read(propertyId);
  assert.deepEqual(state.manualBlocks, []);
  assert.equal(state.operations.at(-1).cells.length, 2);
  await assert.rejects(service.previewLineInventoryBatch(actor, propertyId,
    { ...open, expectedInventoryVersion: state.version, desired: "closed" }),
  errorCode("ROOM_CONFLICT"));
  assert.deepEqual(state.manualBlocks, []);
});

test("LINE manual opening rejects a separate unresolved fence", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
    state.manualBlocks.push({ roomId, date: "2026-11-10" });
    state.fences.push({ key: "review:synthetic", cells: [{ roomId, date: "2026-11-10" }],
      reason: "source_review" });
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(),
    actions: ["booking:read", "booking:manage_all", "inventory:write"] });
  await assert.rejects(service.previewLineInventory(actor, propertyId,
    { expectedInventoryVersion: 1, roomId, date: "2026-11-10", desired: "open" }),
  errorCode("ROOM_CONFLICT"));
  assert.equal((await repository.read(propertyId)).manualBlocks.length, 1);
});

test("manage-all LINE grant reads and amends an external order without source overwrite", async () => {
  const { repository } = setup();
  const service = new IronGateService(repository, "p".repeat(43));
  const source = principal("source");
  await service.applySourceEvent(source, key(), sourceInput());
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.mode = "owlnest";
    state.channel.ready = true;
    state.channel.grantId = channelGrantId;
    state.channel.sourceReadbackEnabled = true;
  });
  const event = await service.applySourceEvent(source, key(), sourceInput(2, {
    sourceVersion: "v2", previousSourceVersion: "v1" }));
  assert.equal(event.state, "applied");
  let state = await repository.read(propertyId);
  const original = state.bookings[0];
  const operation = state.operations[0];
  await service.recordChannelReadback(principal("channel"), { propertyId,
    operationKey: operation.key, observedAt: new Date().toISOString(),
    providerVersion: "source-verified", cells: observed(operation.cells) });
  state = await repository.read(propertyId);
  const scope = principal("line", { grantId: key(), actions: ["booking:read", "booking:amend",
    "booking:cancel", "booking:manage_all"], fields: ["guest_name", "contact", "notes", "money"] });
  const read = await service.getBooking(scope, propertyId, original.id);
  assert.deepEqual(read.lineScope, { grantId: scope.grantId, manageAll: true });
  assert.equal(read.source, "external");
  const list = await service.listBookings(scope, propertyId,
    { limit: 10, cursor: null, status: null, from: null, to: null });
  assert.equal(list.bookings.length, 1);
  const input = { expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version,
    changes: { stays: [{ checkIn: "2026-11-11", checkOut: "2026-11-13", roomIds: [roomId] }] } };
  const preview = await service.previewLineAction(scope, propertyId, original.id, "amend", input);
  const receipt = await service.amendBooking(scope, propertyId, original.id, key(),
    input, preview.previewToken);
  assert.equal(receipt.sourceReviewRequired, true);
  state = await repository.read(propertyId);
  assert.equal(state.sourceLinks[0].diverged, true);
  assert.equal(state.bookings[0].lineOverridePending, true);
  assert.deepEqual(state.operations.find((item) => item.key === receipt.operationKey)
    .cells.map((cell) => [cell.date, cell.desired]).sort(),
  [["2026-11-10", "closed"], ["2026-11-12", "closed"]]);
  assert.equal(state.fences.some((fence) => fence.key === "review:line:" + original.id), true);
  const sourceAgain = await service.applySourceEvent(source, key(),
    sourceInput(state.version, { sourceVersion: "v3", previousSourceVersion: "v2" }));
  assert.equal(sourceAgain.state, "review_required");
  assert.equal((await repository.read(propertyId)).bookings[0].stays[0].checkIn, "2026-11-11");
});

test("manage-all LINE cancellation of external order leaves provider nights closed for review", async () => {
  const { repository } = setup();
  const service = new IronGateService(repository, "p".repeat(43));
  await service.applySourceEvent(principal("source"), key(), sourceInput());
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.mode = "owlnest";
    state.channel.ready = true;
    state.channel.grantId = channelGrantId;
    state.channel.sourceReadbackEnabled = true;
  });
  const event = await service.applySourceEvent(principal("source"), key(), sourceInput(2, {
    sourceVersion: "v2", previousSourceVersion: "v1" }));
  const operation = (await repository.read(propertyId)).operations[0];
  await service.recordChannelReadback(principal("channel"), { propertyId,
    operationKey: operation.key, observedAt: new Date().toISOString(),
    providerVersion: "source-verified", cells: observed(operation.cells) });
  const state = await repository.read(propertyId);
  const scope = principal("line", { grantId: key(), actions: ["booking:read", "booking:amend",
    "booking:cancel", "booking:manage_all"] });
  const input = { expectedBookingVersion: state.bookings[0].version,
    expectedInventoryVersion: state.version };
  const preview = await service.previewLineAction(scope, propertyId, event.bookingId,
    "cancel", input);
  const receipt = await service.cancelBooking(scope, propertyId, event.bookingId, key(),
    input.expectedBookingVersion, input.expectedInventoryVersion, preview.previewToken);
  const after = await repository.read(propertyId);
  assert.equal(after.bookings[0].status, "cancelled");
  assert.equal(receipt.sourceReviewRequired, true);
  assert.equal(after.operations.find((item) => item.key === receipt.operationKey)
    .cells.every((cell) => cell.desired === "closed"), true);
  assert.equal(after.fences.some((fence) => fence.key === "review:line:" + event.bookingId), true);
  const cancelOp = after.operations.find((item) => item.key === receipt.operationKey);
  await service.recordChannelReadback(principal("channel"), { propertyId,
    operationKey: cancelOp.key, observedAt: new Date().toISOString(),
    providerVersion: "cancel-closed", cells: observed(cancelOp.cells) });
  const ready = await repository.read(propertyId);
  assert.equal(ready.fences.some((fence) => fence.key === "review:line:" + event.bookingId), true);
  const sourceAck = await service.applySourceEvent(principal("source"), key(),
    sourceInput(ready.version, { kind: "cancel", sourceVersion: "v3", previousSourceVersion: "v2" }));
  assert.equal(sourceAck.lineOverrideReconciled, true);
  assert.equal(sourceAck.channelSyncState, "pending");
  let reconciled = await repository.read(propertyId);
  assert.equal(reconciled.sourceLinks[0].diverged, false);
  assert.equal(reconciled.bookings[0].lineOverridePending, false);
  assert.equal(reconciled.fences.some((fence) => fence.key === "review:line:" + event.bookingId), false);
  const releaseOp = reconciled.operations.find((item) => item.key === sourceAck.operationKey);
  assert.equal(releaseOp.cells.every((cell) => cell.desired === "open"), true);
  await service.recordChannelReadback(principal("channel"), { propertyId,
    operationKey: releaseOp.key, observedAt: new Date().toISOString(),
    providerVersion: "source-cancel-open", cells: observed(releaseOp.cells) });
  reconciled = await repository.read(propertyId);
  assert.equal(reconciled.bookings[0].channelSyncState, "verified");
  assert.equal(reconciled.fences.length, 0);
});

test("external contact edit stays under review because source events cannot prove contact", async () => {
  const { repository } = setup();
  const service = new IronGateService(repository, "p".repeat(43));
  await service.applySourceEvent(principal("source"), key(), sourceInput(1, { totalCents: null }));
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.mode = "owlnest";
    state.channel.ready = true;
    state.channel.grantId = channelGrantId;
    state.channel.sourceReadbackEnabled = true;
  });
  const first = await service.applySourceEvent(principal("source"), key(),
    sourceInput(2, { sourceVersion: "v2", previousSourceVersion: "v1", totalCents: null }));
  const channel = principal("channel");
  const initialOperation = (await repository.read(propertyId)).operations[0];
  await service.recordChannelReadback(channel, { propertyId,
    operationKey: initialOperation.key, observedAt: new Date().toISOString(),
    providerVersion: "source-verified", cells: observed(initialOperation.cells) });
  const before = await repository.read(propertyId);
  const actor = principal("line", { grantId: key(),
    actions: ["booking:read", "booking:amend", "booking:manage_all"], fields: ["contact"] });
  const input = { expectedBookingVersion: before.bookings[0].version,
    expectedInventoryVersion: before.version, changes: { contact: "new@example.invalid" } };
  const preview = await service.previewLineAction(actor, propertyId, first.bookingId,
    "amend", input);
  const receipt = await service.amendBooking(actor, propertyId, first.bookingId, key(),
    input, preview.previewToken);
  assert.equal(receipt.operationState, "sync_verified");
  assert.equal(receipt.sourceReviewRequired, true);
  const amended = await repository.read(propertyId);
  assert.equal(amended.bookings[0].lineOverrideUnverifiable, true);
  const sourceAck = await service.applySourceEvent(principal("source"), key(),
    sourceInput(amended.version, { sourceVersion: "v3", previousSourceVersion: "v2",
      totalCents: null }));
  assert.equal(sourceAck.state, "review_required");
  const after = await repository.read(propertyId);
  assert.equal(after.bookings[0].contact, "new@example.invalid");
  assert.equal(after.bookings[0].lineOverridePending, true);
  assert.equal(after.sourceLinks[0].diverged, true);
});

test("LINE amendment of an imported external order verifies every retained night", async () => {
  const { repository } = setup("owlnest");
  const bookingId = key();
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
    state.bookings.push({ id: bookingId, workspaceId, propertyId, version: 1,
      status: "confirmed", channelSyncState: "not_required", channelOperationKey: null,
      stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-12", roomIds: [roomId] }],
      guestName: "Imported", contact: null, notes: null, totalCents: 10000,
      currency: "TWD", bookedAt: "2026-10-13", createdAt: new Date().toISOString(),
      source: "external", sourceKey: null });
  });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = principal("line", { grantId: key(), actions: ["booking:read", "booking:amend",
    "booking:cancel", "booking:manage_all"] });
  const input = { expectedBookingVersion: 1, expectedInventoryVersion: 1,
    changes: { stays: [{ checkIn: "2026-11-11", checkOut: "2026-11-13", roomIds: [roomId] }] } };
  const preview = await service.previewLineAction(actor, propertyId, bookingId, "amend", input);
  const receipt = await service.amendBooking(actor, propertyId, bookingId, key(),
    input, preview.previewToken);
  const operation = (await repository.read(propertyId)).operations.find((item) =>
    item.key === receipt.operationKey);
  assert.deepEqual(operation.cells.map((cell) => [cell.date, cell.desired]).sort(),
    [["2026-11-10", "closed"], ["2026-11-11", "closed"], ["2026-11-12", "closed"]]);
});

test("source version and booking divergence stop an external overwrite", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  const first = await service.applySourceEvent(source, key(), sourceInput());
  assert.equal(first.state, "applied");
  assert.equal((await repository.read(propertyId)).bookings[0].bookedAt, "2026-10-12");
  await repository.transact(propertyId, (state) => {
    state.bookings[0].version++;
    state.bookings[0].guestName = "Owner correction";
    state.version++;
  });
  const result = await service.applySourceEvent(source, key(), sourceInput(3,
    { sourceVersion: "v2", previousSourceVersion: "v1", guestName: "Stale external name" }));
  assert.equal(result.state, "review_required");
  const state = await repository.read(propertyId);
  assert.equal(state.bookings[0].guestName, "Owner correction");
  assert.equal(state.sourceLinks[0].diverged, true);
  assert.equal(state.fences.length, 1);
  const repeat = await service.applySourceEvent(source, key(), sourceInput(state.version,
    { sourceVersion: "v2", previousSourceVersion: "v1", guestName: "Stale external name" }));
  assert.equal(repeat.reason, "SOURCE_REVIEW_OPEN");
  assert.equal((await repository.read(propertyId)).bookings[0].guestName, "Owner correction");
});

test("source lookup exposes only current link state to its scoped writer", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  const lookup = { propertyId, sourceSystem: "ota", sourceAccount: "synthetic-account",
    externalOrderId: "external-1" };
  assert.deepEqual(await service.sourceOrderLookup(source, lookup), {
    propertyId, inventoryVersion: 1, readOnly: false, sourceVersion: null,
    bookingId: null, bookingVersion: null, bookingStatus: null, stays: [], bookedAt: null,
    diverged: false, tombstoned: false,
  });
  const first = await service.applySourceEvent(source, key(), sourceInput());
  const linked = await service.sourceOrderLookup(source, lookup);
  assert.equal(linked.sourceVersion, "v1");
  assert.equal(linked.bookingId, first.bookingId);
  assert.deepEqual(linked.stays, sourceInput().stays);
  assert.equal(linked.bookedAt, "2026-10-12");
  assert.equal((await repository.read(propertyId)).sourceLinks[0].key,
    JSON.stringify(["ota", "synthetic-account", "external-1"]));
  assert.equal(JSON.stringify(linked).includes("External Guest"), false);
  await assert.rejects(service.sourceOrderLookup(principal("source", {
    sourceAccount: "other-account" }), lookup), errorCode("FORBIDDEN"));
  await repository.transact(propertyId, (state) => { state.readOnly = true; });
  assert.equal((await service.sourceOrderLookup(source, lookup)).readOnly, true);
  await assert.rejects(service.applySourceEvent(source, key(), sourceInput(2, {
    sourceVersion: "v2", previousSourceVersion: "v1",
  })), errorCode("PROPERTY_READ_ONLY"));
});

test("source lookup HTTP route rejects unscoped requests and returns no guest data", async () => {
  const { service } = setup();
  const request = new Request("https://iron.invalid/v1/source-orders/lookup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ propertyId, sourceSystem: "ota",
      sourceAccount: "synthetic-account", externalOrderId: "external-1" }),
  });
  const denied = createHandler(service, async () => principal("os"));
  assert.equal((await denied(request.clone())).status, 403);
  const allowed = createHandler(service, async () => principal("source"));
  const response = await allowed(request.clone());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sourceVersion, null);
});

test("booking-only source modification clears a stale imported fee", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  const first = await service.applySourceEvent(source, key(), sourceInput());
  await repository.transact(propertyId, (state) => {
    state.bookings[0].totalCents = 1200000;
  });
  const updated = await service.applySourceEvent(source, key(), sourceInput(2, {
    sourceVersion: "v2", previousSourceVersion: "v1",
  }));
  assert.equal(updated.state, "applied");
  const state = await repository.read(propertyId);
  assert.equal(state.bookings.find((item) => item.id === first.bookingId).totalCents, null);
});

test("source event keeps explicit OTA amount and labels with scoped calendar projection", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  const input = sourceInput(1, { totalCents: 191700, currency: "TWD",
    platform: "booking", externalOrderNo: "5526320838" });
  const requestKey = key();
  const first = await service.applySourceEvent(source, requestKey, input);
  assert.equal((await service.applySourceEvent(source, requestKey, input)).bookingId,
    first.bookingId);
  const booking = (await repository.read(propertyId)).bookings[0];
  assert.equal(booking.totalCents, 191700);
  assert.deepEqual(booking.sourceCalendar, { platform: "booking",
    externalOrderNo: "5526320838" });
  const owner = await service.calendarSnapshot(principal("os"), propertyId,
    "2026-11-01", "2026-12-01");
  assert.deepEqual(owner.bookings[0].sourceCalendar, { platform: "booking",
    externalOrderNo: "5526320838", bookedAt: "2026-10-12" });
  assert.equal(owner.bookings[0].totalCents, 191700);
  assert.deepEqual(owner.bookings[0].stayAmountsCents, [191700]);
  const noMoney = await service.calendarSnapshot(principal("os", {
    fields: ["guest_name"] }), propertyId, "2026-11-01", "2026-12-01");
  assert.equal("totalCents" in noMoney.bookings[0], false);
  assert.equal("stayAmountsCents" in noMoney.bookings[0], false);
  assert.equal("externalOrderNo" in noMoney.bookings[0].sourceCalendar, false);
  const noGuest = await service.calendarSnapshot(principal("os", {
    fields: ["money"] }), propertyId, "2026-11-01", "2026-12-01");
  assert.equal("sourceCalendar" in noGuest.bookings[0], false);
});

test("a different source key with the same OTA order number stays in review", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  const first = await service.applySourceEvent(source, key(), sourceInput(1, {
    platform: "booking", externalOrderNo: "OTA12345" }));
  const duplicate = await service.applySourceEvent(source, key(), sourceInput(2, {
    externalOrderId: "external-2", platform: "booking", externalOrderNo: "OTA12345",
    stays: [{ checkIn: "2026-11-14", checkOut: "2026-11-16", roomIds: [roomId] }],
  }));
  assert.equal(duplicate.state, "review_required");
  assert.equal(duplicate.reason, "SOURCE_IDENTITY_COLLISION");
  const state = await repository.read(propertyId);
  assert.deepEqual(state.bookings.map((booking) => booking.id), [first.bookingId]);
  assert.ok(state.fences.some((fence) => fence.reason === "source_review" &&
    fence.cells.some((cell) => cell.date === "2026-11-14")));
});

test("four-room source amount remains whole-order money without invented room split", async () => {
  const { service, repository } = setup();
  const extraRooms = [key(), key(), key()];
  await repository.transact(propertyId, (state) => { state.roomIds.push(...extraRooms); });
  const stays = [roomId, ...extraRooms].map((id) => ({
    checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [id] }));
  await service.applySourceEvent(principal("source"), key(), sourceInput(1, {
    stays, totalCents: 2061400, currency: "TWD", platform: "booking" }));
  const read = await service.calendarSnapshot(principal("os"), propertyId,
    "2026-11-01", "2026-12-01");
  assert.equal(read.bookings[0].totalCents, 2061400);
  assert.equal(read.bookings[0].stayAmountsCents, null);
});

test("source money and labels reject malformed or ambiguous facts before writing", async () => {
  const { service, repository } = setup();
  const bad = [
    { totalCents: -1, currency: "TWD" },
    { totalCents: 191700 },
    { totalCents: 191700.5, currency: "TWD" },
    { totalCents: 191700, currency: "USD" },
    { platform: "<script>" },
    { externalOrderNo: "bad\nvalue" },
  ];
  for (const fields of bad) {
    await assert.rejects(service.applySourceEvent(principal("source"), key(),
      sourceInput(1, fields)), error => /^INVALID_/.test(error?.code));
  }
  assert.equal((await repository.read(propertyId)).bookings.length, 0);
});

test("scoped metadata repair enriches a current source email without changing occupancy", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  const original = await service.applySourceEvent(source, key(), sourceInput());
  const before = await repository.read(propertyId);
  const input = { propertyId, sourceSystem: "ota", sourceAccount: "synthetic-account",
    externalOrderId: "external-1", sourceVersion: "v1",
    expectedInventoryVersion: before.version, expectedBookingVersion: 1,
    totalCents: 191700, currency: "TWD", platform: "booking",
    externalOrderNo: "6200060561" };
  const repairKey = key();
  await assert.rejects(service.enrichSourceFacts(principal("os"), key(), input),
    errorCode("FORBIDDEN"));
  const repaired = await service.enrichSourceFacts(source, repairKey, input);
  assert.equal(repaired.state, "applied");
  assert.equal(repaired.bookingId, original.bookingId);
  assert.deepEqual(await service.enrichSourceFacts(source, repairKey, input), repaired);
  const after = await repository.read(propertyId);
  assert.deepEqual(after.bookings[0].stays, before.bookings[0].stays);
  assert.equal(after.sourceLinks[0].sourceVersion, "v1");
  assert.equal(after.sourceLinks[0].lastAppliedBookingVersion, 2);
  assert.equal(after.bookings[0].totalCents, 191700);
  assert.deepEqual((await service.sourceOrderLookup(source, input)).sourceFacts,
    { totalCents: 191700, currency: "TWD", platform: "booking",
      externalOrderNo: "6200060561" });
  await assert.rejects(service.enrichSourceFacts(source, key(),
    { ...input, expectedInventoryVersion: after.version,
      expectedBookingVersion: 2, sourceVersion: "v0" }),
  errorCode("SOURCE_FACTS_STALE"));
  await assert.rejects(service.enrichSourceFacts(source, key(),
    { ...input, expectedInventoryVersion: after.version,
      expectedBookingVersion: 2, totalCents: 1 }),
  errorCode("SOURCE_FACTS_CONFLICT"));
  await repository.transact(propertyId, (state) => { state.channel.mode = "owlnest"; });
  await assert.rejects(service.enrichSourceFacts(source, key(),
    { ...input, expectedInventoryVersion: after.version,
      expectedBookingVersion: 2 }),
  errorCode("SOURCE_FACTS_CHANNEL_ACTIVE"));
  await repository.transact(propertyId, (state) => {
    state.channel.mode = "none";
    state.bookings[0].sweetfunSnapshot = { rows: [] };
  });
  const protectedLookup = await service.sourceOrderLookup(source, input);
  assert.equal("sourceFacts" in protectedLookup, false);
  await assert.rejects(service.enrichSourceFacts(source, key(),
    { ...input, expectedInventoryVersion: protectedLookup.inventoryVersion,
      expectedBookingVersion: 2 }),
  errorCode("SOURCE_FACTS_STALE"));
  assert.equal((await repository.read(propertyId)).bookings.length, 1);
});

test("source identity parts reject control characters before key composition", async () => {
  const { service } = setup();
  const bad = sourceInput(1, { externalOrderId: "first\u0000second" });
  await assert.rejects(service.applySourceEvent(principal("source"), key(), bad),
    errorCode("INVALID_INPUT"));
});

test("external bookings cannot be locally cancelled without source coordination", async () => {
  const { service, repository } = setup();
  const first = await service.applySourceEvent(principal("source"), key(), sourceInput());
  await assert.rejects(service.cancelBooking(principal(), propertyId, first.bookingId, key(), 1, 2),
    errorCode("SOURCE_CANCEL_REQUIRES_REVIEW"));
  assert.equal((await repository.read(propertyId)).bookings[0].status, "confirmed");
});

test("source review keeps every affected night across repeated conflicts", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  const first = await service.applySourceEvent(source, key(), sourceInput(1, {
    previousSourceVersion: "unexpected",
  }));
  assert.equal(first.state, "review_required");
  const second = await service.applySourceEvent(source, key(), sourceInput(2, {
    previousSourceVersion: "still-unexpected",
    stays: [{ checkIn: "2026-11-13", checkOut: "2026-11-14", roomIds: [roomId] }],
  }));
  assert.equal(second.state, "review_required");
  const fenced = (await repository.read(propertyId)).fences[0].cells.map((cell) => cell.date).sort();
  assert.deepEqual(fenced, ["2026-11-10", "2026-11-11", "2026-11-13"]);
  await assert.rejects(service.createBooking(principal(), propertyId, key(), bookingInput(3)),
    errorCode("ROOM_CONFLICT"));
});

test("OwlNest external cancellation stays under review until provider evidence exists", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  const first = await service.applySourceEvent(source, key(), sourceInput());
  await repository.transact(propertyId, (state) => {
    state.channel.mode = "owlnest";
    state.channel.ready = true;
    state.channel.grantId = channelGrantId;
  });
  const cancellation = await service.applySourceEvent(source, key(), sourceInput(2, {
    kind: "cancel", sourceVersion: "v2", previousSourceVersion: "v1",
  }));
  assert.equal(cancellation.reason, "CHANNEL_CANCEL_REQUIRES_READBACK");
  const state = await repository.read(propertyId);
  assert.equal(state.bookings.find((item) => item.id === first.bookingId).status, "confirmed");
  assert.equal(state.fences.length, 1);
  await assert.rejects(service.createBooking(principal(), propertyId, key(), bookingInput(state.version)),
    errorCode("ROOM_CONFLICT"));
});

test("OwlNest source events without identity fence stock before any booking is applied", async () => {
  const { service, repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.channel.sourceReadbackEnabled = false;
  });
  const source = principal("source");
  const incoming = await service.applySourceEvent(source, key(), sourceInput());
  assert.equal(incoming.reason, "SOURCE_IDENTITY_UNVERIFIED");
  let state = await repository.read(propertyId);
  assert.equal(state.bookings.length, 0);
  assert.deepEqual(state.fences[0].cells.map((cell) => cell.date).sort(),
    ["2026-11-10", "2026-11-11"]);
  const unknownCancel = await service.applySourceEvent(source, key(), sourceInput(2, {
    externalOrderId: "external-2", kind: "cancel",
  }));
  assert.equal(unknownCancel.reason, "CHANNEL_UNKNOWN_CANCEL_REQUIRES_READBACK");
  state = await repository.read(propertyId);
  assert.equal(state.bookings.length, 0);
  assert.equal(state.sourceLinks.length, 0);
  assert.equal(state.fences.length, 2);
});

test("new OwlNest source events require a verified order identity even with stock readback", async () => {
  const { service, repository } = setup("owlnest");
  const incoming = await service.applySourceEvent(principal("source"), key(), sourceInput());
  assert.equal(incoming.state, "review_required");
  assert.equal(incoming.reason, "SOURCE_IDENTITY_UNVERIFIED");
  const state = await repository.read(propertyId);
  assert.equal(state.bookings.length, 0);
  assert.equal(state.operations.length, 0);
  assert.deepEqual(state.fences[0].cells.map((cell) => cell.date).sort(),
    ["2026-11-10", "2026-11-11"]);
});

test("OwlNest source date changes hold old and new room nights for review", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  const first = await service.applySourceEvent(source, key(), sourceInput());
  await repository.transact(propertyId, (state) => {
    state.channel.mode = "owlnest";
    state.channel.ready = true;
    state.channel.grantId = channelGrantId;
  });
  const moved = await service.applySourceEvent(source, key(), sourceInput(2, {
    sourceVersion: "v2", previousSourceVersion: "v1",
    stays: [{ checkIn: "2026-11-12", checkOut: "2026-11-14", roomIds: [roomId] }],
  }));
  assert.equal(moved.reason, "CHANNEL_UPSERT_REQUIRES_READBACK");
  const state = await repository.read(propertyId);
  assert.equal(state.bookings[0].id, first.bookingId);
  assert.equal(state.bookings[0].version, 1);
  assert.deepEqual(state.fences[0].cells.map((cell) => cell.date).sort(),
    ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
});

test("gated source readback preserves Gmail source version after OwlNest verification", async () => {
  const { service, repository } = setup();
  const source = principal("source"), channel = principal("channel");
  const imported = await service.applySourceEvent(source, key(), sourceInput());
  assert.equal(imported.state, "applied");
  await repository.transact(propertyId, (state) => {
    state.channel.mode = "owlnest";
    state.channel.ready = true;
    state.channel.grantId = channelGrantId;
    state.channel.sourceReadbackEnabled = true;
  });
  const first = await service.applySourceEvent(source, key(), sourceInput(2, {
    sourceVersion: "v2", previousSourceVersion: "v1",
  }));
  assert.equal(first.state, "applied");
  assert.equal(first.channelSyncState, "pending");
  let state = await repository.read(propertyId);
  assert.equal(state.bookings[0].status, "confirmed");
  assert.equal(state.fences.length, 1);
  assert.equal(state.operations[0].cells.every((cell) => cell.desired === "closed"), true);
  const observedAt = new Date(Date.now() + 1000).toISOString();
  const verified = await service.recordChannelReadback(channel, { propertyId,
    operationKey: first.operationKey, providerVersion: "synthetic-closed-v1", observedAt,
    cells: state.operations[0].cells.map((cell) =>
      ({ roomId: cell.roomId, date: cell.date, count: 0, isLock: true })) });
  assert.equal(verified.state, "sync_verified");
  state = await repository.read(propertyId);
  assert.equal(state.fences.length, 0);
  assert.equal(state.sourceLinks[0].lastAppliedBookingVersion, state.bookings[0].version);
  const detailChange = await service.applySourceEvent(source, key(), sourceInput(state.version, {
    sourceVersion: "v3", previousSourceVersion: "v2", guestName: "Updated Synthetic Guest",
  }));
  assert.equal(detailChange.state, "applied");
  assert.equal(detailChange.channelSyncState, undefined);
  state = await repository.read(propertyId);
  assert.equal(state.operations.length, 1);
  const cancellation = await service.applySourceEvent(source, key(), sourceInput(state.version, {
    kind: "cancel", sourceVersion: "v4", previousSourceVersion: "v3",
  }));
  assert.equal(cancellation.state, "applied");
  assert.equal(cancellation.channelSyncState, "pending");
  state = await repository.read(propertyId);
  assert.equal(state.bookings[0].status, "cancelled");
  assert.equal(state.fences.length, 1);
  assert.equal(state.operations[1].cells.every((cell) => cell.desired === "open"), true);
  await assert.rejects(service.createBooking(principal(), propertyId, key(),
    bookingInput(state.version)), errorCode("ROOM_CONFLICT"));
  const reopened = await service.recordChannelReadback(channel, { propertyId,
    operationKey: cancellation.operationKey, providerVersion: "synthetic-open-v2",
    observedAt: new Date(Date.now() + 1000).toISOString(),
    cells: state.operations[1].cells.map((cell) =>
      ({ roomId: cell.roomId, date: cell.date, count: 1, isLock: false })) });
  assert.equal(reopened.state, "sync_verified");
  state = await repository.read(propertyId);
  assert.equal(state.fences.length, 0);
  assert.equal(state.sourceLinks[0].lastAppliedBookingVersion, state.bookings[0].version);
});

test("gated source amendment reads back old opened and new closed nights", async () => {
  const { service, repository } = setup();
  const source = principal("source"), channel = principal("channel");
  const first = await service.applySourceEvent(source, key(), sourceInput());
  await repository.transact(propertyId, (state) => {
    state.channel.mode = "owlnest";
    state.channel.ready = true;
    state.channel.grantId = channelGrantId;
    state.channel.sourceReadbackEnabled = true;
  });
  const moved = await service.applySourceEvent(source, key(), sourceInput(2, {
    sourceVersion: "v2", previousSourceVersion: "v1",
    stays: [{ checkIn: "2026-11-12", checkOut: "2026-11-14", roomIds: [roomId] }],
  }));
  assert.equal(moved.state, "applied");
  let state = await repository.read(propertyId);
  assert.equal(state.bookings[0].id, first.bookingId);
  assert.deepEqual(state.operations[0].cells.map((cell) => [cell.date, cell.desired]).sort(),
    [["2026-11-10", "open"], ["2026-11-11", "open"],
     ["2026-11-12", "closed"], ["2026-11-13", "closed"]]);
  const verified = await service.recordChannelReadback(channel, { propertyId,
    operationKey: moved.operationKey, providerVersion: "synthetic-move-v1",
    observedAt: new Date(Date.now() + 1000).toISOString(),
    cells: state.operations[0].cells.map((cell) => ({ roomId: cell.roomId, date: cell.date,
      count: cell.desired === "closed" ? 0 : 1, isLock: cell.desired === "closed" })) });
  assert.equal(verified.state, "sync_verified");
  state = await repository.read(propertyId);
  assert.equal(state.sourceLinks[0].lastAppliedBookingVersion, state.bookings[0].version);
  assert.equal(state.fences.length, 0);
});

test("gated source events cannot overtake a pending channel operation", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  await service.applySourceEvent(source, key(), sourceInput());
  await repository.transact(propertyId, (state) => {
    state.channel.mode = "owlnest";
    state.channel.ready = true;
    state.channel.grantId = channelGrantId;
    state.channel.sourceReadbackEnabled = true;
  });
  const first = await service.applySourceEvent(source, key(), sourceInput(2, {
    sourceVersion: "v2", previousSourceVersion: "v1" }));
  const attempted = await service.applySourceEvent(source, key(), sourceInput(3, {
    sourceVersion: "v3", previousSourceVersion: "v2",
    stays: [{ checkIn: "2026-11-12", checkOut: "2026-11-14", roomIds: [roomId] }],
  }));
  assert.equal(attempted.state, "review_required");
  assert.equal(attempted.reason, "CHANNEL_PREVIOUS_OPERATION_UNRESOLVED");
  const state = await repository.read(propertyId);
  assert.equal(state.bookings[0].id, first.bookingId);
  assert.equal(state.bookings[0].version, 2);
  assert.equal(state.sourceLinks[0].sourceVersion, "v2");
  assert.equal(state.fences.length, 2);
});

test("gated source cancellation keeps manually blocked nights closed", async () => {
  const { service, repository } = setup();
  const source = principal("source"), channel = principal("channel");
  await service.applySourceEvent(source, key(), sourceInput());
  await repository.transact(propertyId, (state) => {
    state.channel.mode = "owlnest";
    state.channel.ready = true;
    state.channel.grantId = channelGrantId;
    state.channel.sourceReadbackEnabled = true;
  });
  const first = await service.applySourceEvent(source, key(), sourceInput(2, {
    sourceVersion: "v2", previousSourceVersion: "v1" }));
  let state = await repository.read(propertyId);
  await service.recordChannelReadback(channel, { propertyId,
    operationKey: first.operationKey, providerVersion: "synthetic-closed-v1",
    observedAt: new Date(Date.now() + 1000).toISOString(),
    cells: state.operations[0].cells.map((cell) =>
      ({ roomId: cell.roomId, date: cell.date, count: 0, isLock: true })) });
  state = await repository.read(propertyId);
  await repository.transact(propertyId, (current) => {
    current.manualBlocks.push({ roomId, date: "2026-11-10" });
    current.version++;
  });
  state = await repository.read(propertyId);
  const cancelled = await service.applySourceEvent(source, key(), sourceInput(state.version, {
    kind: "cancel", sourceVersion: "v3", previousSourceVersion: "v2",
  }));
  state = await repository.read(propertyId);
  assert.deepEqual(state.operations[1].cells.map((cell) => [cell.date, cell.desired]).sort(),
    [["2026-11-10", "closed"], ["2026-11-11", "open"]]);
  const verified = await service.recordChannelReadback(channel, { propertyId,
    operationKey: cancelled.operationKey, providerVersion: "synthetic-mixed-v2",
    observedAt: new Date(Date.now() + 1000).toISOString(),
    cells: state.operations[1].cells.map((cell) => ({ roomId: cell.roomId,
      date: cell.date, count: cell.desired === "closed" ? 0 : 1,
      isLock: cell.desired === "closed" })) });
  assert.equal(verified.state, "sync_verified");
  state = await repository.read(propertyId);
  assert.deepEqual(state.manualBlocks, [{ roomId, date: "2026-11-10" }]);
  assert.equal(state.fences.length, 0);
});

test("only current channel grant reads operation details and only OS cancels", async () => {
  const { service, repository } = setup("owlnest");
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  const requested = await requestSync(service, repository, created);
  await assert.rejects(service.channelOperation(principal("channel", { grantId: key() }),
    propertyId, requested.operationKey), errorCode("FORBIDDEN"));
  await assert.rejects(service.cancelBooking(principal("service"), propertyId,
    created.bookingId, key(), 1, requested.inventoryVersion), errorCode("FORBIDDEN"));
  assert.equal((await repository.read(propertyId)).bookings[0].status, "confirmed");
});

test("channel worker can discover only its own pending operations", async () => {
  const { service, repository } = setup("owlnest");
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  const requested = await requestSync(service, repository, created);
  const channel = principal("channel");
  const pending = await service.pendingChannelOperations(channel, propertyId, 1);
  assert.equal(pending.operations.length, 1);
  assert.equal(pending.operations[0].key, requested.operationKey);
  assert.equal(pending.operations[0].state, "sync_pending");
  assert.equal(pending.hasMore, false);
  await assert.rejects(service.pendingChannelOperations(principal("channel", {
    grantId: key() }), propertyId, 1), errorCode("FORBIDDEN"));
  await assert.rejects(service.pendingChannelOperations(principal("source"), propertyId, 1),
    errorCode("FORBIDDEN"));
  await assert.rejects(service.pendingChannelOperations(channel, propertyId, 101),
    errorCode("INVALID_LIMIT"));
  await verifyManualSync(service, repository, requested);
  const after = await service.pendingChannelOperations(channel, propertyId, 1);
  assert.deepEqual(after.operations, []);
});

test("guest order credentials cannot enumerate availability and website sale readiness stays closed", async () => {
  const { service } = setup();
  await assert.rejects(service.availability(principal("guest"), propertyId,
    "2026-11-10", "2026-11-11"), errorCode("FORBIDDEN"));
  const cells = await service.availability(principal(), propertyId, "2026-11-10", "2026-11-11");
  assert.equal(cells.cells[0].saleReady, false);
});

test("LINE local room-night read sees OTA occupancy without exposing its booking", async () => {
  const { service } = setup();
  await service.applySourceEvent(principal("source"), key(), sourceInput());
  const grantId = key();
  const line = principal("line", { grantId, actions: ["booking:read"], fields: [] });
  const local = await service.availability(line, propertyId,
    "2026-11-10", "2026-11-11");
  assert.deepEqual(local.lineScope, { grantId });
  assert.equal(local.readOnly, false);
  assert.equal(local.cells[0].state, "sold");
  assert.equal(local.cells[0].saleReady, false);
  assert.equal(JSON.stringify(local).includes("External Guest"), false);
  const direct = await service.listBookings(line, propertyId,
    { limit: 20, cursor: null, status: null, from: null, to: null });
  assert.deepEqual(direct.bookings, []);
});

test("availability caps the response before expanding a large property calendar", async () => {
  const { service, repository } = setup();
  await repository.transact(propertyId, (state) => {
    state.roomIds = Array.from({ length: 133 }, () => key());
  });
  await assert.rejects(service.availability(principal(), propertyId,
    "2026-11-01", "2026-12-02"), errorCode("READ_CAPACITY_LIMIT"));
});

test("housekeeping and occupancy consumers get separate PII-free projections", async () => {
  const { service } = setup();
  await service.createBooking(principal(), propertyId, key(), bookingInput(1, {
    stays: [
      { checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] },
      { checkIn: "2026-11-11", checkOut: "2026-11-12", roomIds: [roomId] },
    ],
  }));
  const summaryActor = principal("service", { actions: ["occupancy:aggregate"], fields: [] });
  const summary = await service.occupancySummary(summaryActor, propertyId,
    "2026-11-10", "2026-11-13");
  assert.deepEqual(summary.days.map((day) => day.confirmed), [1, 1, 0]);
  assert.equal(summary.saleReady, false);
  assert.equal(JSON.stringify(summary).includes("Synthetic Guest"), false);
  await assert.rejects(service.housekeepingTurnovers(summaryActor, propertyId,
    "2026-11-10", "2026-11-13"), errorCode("FORBIDDEN"));
  const cleaningActor = principal("service", { actions: ["housekeeping:read"], fields: [] });
  const cleaning = await service.housekeepingTurnovers(cleaningActor, propertyId,
    "2026-11-10", "2026-11-13");
  assert.deepEqual(cleaning.turnovers.map((item) => item.checkoutDate), ["2026-11-12"]);
  assert.equal(cleaning.turnovers[0].roomId, roomId);
  assert.equal(JSON.stringify(cleaning).includes("Synthetic Guest"), false);
  await assert.rejects(service.occupancySummary(cleaningActor, propertyId,
    "2026-11-10", "2026-11-13"), errorCode("FORBIDDEN"));
});

test("cancellation tombstone rejects an older create event", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  const tombstone = await service.applySourceEvent(source, key(), sourceInput(1,
    { kind: "cancel", sourceVersion: "v2" }));
  assert.equal(tombstone.bookingId, null);
  const conflict = await service.applySourceEvent(source, key(), sourceInput(2,
    { kind: "upsert", sourceVersion: "v1", previousSourceVersion: null }));
  assert.equal(conflict.state, "review_required");
  assert.equal(conflict.reason, "SOURCE_VERSION_CONFLICT");
  assert.equal((await repository.read(propertyId)).fences.length, 1);
});

test("a newer create after a cancellation tombstone needs review", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  await service.applySourceEvent(source, key(), sourceInput(1,
    { kind: "cancel", sourceVersion: "v2" }));
  const later = await service.applySourceEvent(source, key(), sourceInput(2,
    { kind: "upsert", sourceVersion: "v3", previousSourceVersion: "v2" }));
  assert.equal(later.state, "review_required");
  assert.equal((await repository.read(propertyId)).bookings.length, 0);
  assert.equal((await repository.read(propertyId)).fences.length, 1);
});

test("a linked source order cannot be reactivated after cancellation without review", async () => {
  const { service, repository } = setup();
  const source = principal("source");
  const first = await service.applySourceEvent(source, key(), sourceInput());
  const cancelled = await service.applySourceEvent(source, key(), sourceInput(2, {
    kind: "cancel", sourceVersion: "v2", previousSourceVersion: "v1",
  }));
  assert.equal(cancelled.state, "applied");
  const attempted = await service.applySourceEvent(source, key(), sourceInput(3, {
    kind: "upsert", sourceVersion: "v3", previousSourceVersion: "v2",
  }));
  assert.equal(attempted.reason, "SOURCE_TOMBSTONE_REACTIVATION");
  const state = await repository.read(propertyId);
  assert.equal(state.bookings.length, 1);
  assert.equal(state.bookings[0].id, first.bookingId);
  assert.equal(state.bookings[0].status, "cancelled");
  assert.equal(state.fences.length, 1);
});

test("revoked source and wrong OwlNest grant cannot mutate state", async () => {
  const { service, repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => { state.sourceGrants[0].active = false; });
  await assert.rejects(service.applySourceEvent(principal("source"), key(), sourceInput()),
    errorCode("FORBIDDEN"));
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  const requested = await requestSync(service, repository, created);
  const operation = await service.channelOperation(principal("channel"), propertyId, requested.operationKey);
  await assert.rejects(service.recordChannelReadback(principal("channel", { grantId: key() }),
    { propertyId, operationKey: requested.operationKey, providerVersion: "provider-v1",
      observedAt: new Date().toISOString(), cells: observed(operation.cells) }), errorCode("FORBIDDEN"));
  assert.equal((await repository.read(propertyId)).fences.length, 1);
});

test("revoked source grant cannot recover its old request receipt", async () => {
  const { service, repository } = setup();
  const source = principal("source"), sourceKey = key();
  await service.applySourceEvent(source, sourceKey, sourceInput());
  await repository.transact(propertyId, (state) => { state.sourceGrants[0].active = false; });
  await assert.rejects(service.requestResult(source, propertyId, sourceKey), errorCode("FORBIDDEN"));
});

test("HTTP boundary rejects missing identity and returns only coded errors", async () => {
  const { service } = setup();
  const denied = createHandler(service, async () => null);
  const response = await denied(new Request(`https://iron.invalid/v1/properties/${propertyId}/availability?from=2026-11-10&to=2026-11-11`));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: "UNAUTHORIZED" } });
  const allowed = createHandler(service, async () => principal());
  const bad = await allowed(new Request(`https://iron.invalid/v1/properties/${propertyId}/bookings`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bookingInput()) }));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
  const missing = await allowed(new Request(`https://iron.invalid/v1/properties/${otherPropertyId}/bookings`,
    { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key() },
      body: JSON.stringify(bookingInput()) }));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: { code: "PROPERTY_NOT_FOUND" } });
});

test("HTTP create and read use the same scoped booking", async () => {
  const { service } = setup();
  const handler = createHandler(service, async () => principal());
  const created = await handler(new Request(`https://iron.invalid/v1/properties/${propertyId}/bookings`,
    { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key() },
      body: JSON.stringify(bookingInput()) }));
  assert.equal(created.status, 201);
  const receipt = await created.json();
  const read = await handler(new Request(`https://iron.invalid/v1/properties/${propertyId}/bookings/${receipt.bookingId}`));
  assert.equal(read.status, 200);
  const booking = await read.json();
  assert.equal(booking.id, receipt.bookingId);
  assert.equal(booking.totalCents, 1200000);
  assert.equal(read.headers.get("cache-control"), "private, no-store");
});

test("HTTP pending-operation poll is channel-only and returns no guest data", async () => {
  const { service, repository } = setup("owlnest");
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  const requested = await requestSync(service, repository, created);
  const url = `https://iron.invalid/v1/inventory-operations?propertyId=${propertyId}&limit=1`;
  const channel = createHandler(service, async () => principal("channel"));
  const result = await channel(new Request(url));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.operations[0].key, requested.operationKey);
  assert.equal(JSON.stringify(body).includes("Synthetic Guest"), false);
  const other = createHandler(service, async () => principal());
  assert.equal((await other(new Request(url))).status, 403);
});

test("HTTP LINE create route requires the server preview header", async () => {
  const { repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.readOnly = false;
    state.channel.sourceReadbackEnabled = true;
  });
  const actor = principal("line", { grantId: key(), actions: ["booking:read", "booking:create"] });
  const handler = createHandler(new IronGateService(repository, "p".repeat(43)),
    async () => actor);
  const input = bookingInput(1, { source: "line" });
  const previewUrl = `https://iron.invalid/v1/properties/${propertyId}/line-create-previews`;
  const bookingUrl = `https://iron.invalid/v1/properties/${propertyId}/bookings`;
  const previewResponse = await handler(new Request(previewUrl, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  const missing = await handler(new Request(bookingUrl, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key() },
    body: JSON.stringify(input) }));
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).error.code, "LINE_PREVIEW_REQUIRED");
  const created = await handler(new Request(bookingUrl, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key(),
      "x-iron-gate-line-preview": preview.previewToken }, body: JSON.stringify(input) }));
  assert.equal(created.status, 202);
  assert.equal((await created.json()).operationState, "sync_pending");
});

test("hold occupies inventory until explicit release, even after expiry", async () => {
  const { service, repository } = setup();
  const actor = principal("os", { actions: [...principal().actions, "hold:write"] });
  const holdKey = key(), input = holdInput();
  const created = await service.createHold(actor, propertyId, holdKey, input);
  const savedHold = (await repository.read(propertyId)).bookings[0].hold;
  const expiry = savedHold.expiresAt;
  assert.equal(savedHold.schema, 1);
  assert.equal(savedHold.scope, "platform_only");
  assert.equal(Date.parse(expiry) - Date.parse(savedHold.startedAt), 86_400_000);
  await assert.rejects(service.cancelBooking(actor, propertyId, created.bookingId, key(), 1, 2),
    errorCode("HOLD_RELEASE_REQUIRED"));
  const oldNow = Date.now;
  Date.now = () => Date.parse(expiry) + 1000;
  try {
    assert.deepEqual(await service.createHold(actor, propertyId, holdKey, input), created);
  } finally { Date.now = oldNow; }
  await repository.transact(propertyId, (state) => {
    state.bookings[0].hold.expiresAt = new Date(Date.now() - 60_000).toISOString();
  });
  assert.equal((await service.availability(actor, propertyId, "2026-11-10", "2026-11-11")).cells[0].state, "held");
  await assert.rejects(service.convertHold(actor, propertyId, created.bookingId, key(), 1),
    errorCode("HOLD_EXPIRED_REVIEW"));
  await assert.rejects(service.createBooking(actor, propertyId, key(), bookingInput(2)), errorCode("ROOM_CONFLICT"));
  const released = await service.releaseHold(actor, propertyId, created.bookingId, key(), 1, 2);
  assert.equal(released.refundReviewRequired, false);
  assert.equal((await repository.read(propertyId)).bookings[0].hold.state, "released");
  assert.equal((await service.availability(actor, propertyId, "2026-11-10", "2026-11-11")).cells[0].state, "unsold");
});

test("hold conversion requires recorded money and retains the same booking ID", async () => {
  const { service, repository } = setup();
  const actor = principal("os", { actions: [...principal().actions, "hold:write", "payment:write"] });
  const created = await service.createHold(actor, propertyId, key(), holdInput());
  await assert.rejects(service.convertHold(actor, propertyId, created.bookingId, key(), 1),
    errorCode("PAYMENT_EVIDENCE_REQUIRED"));
  const eventId = key(), paymentKey = key();
  const paid = await service.recordPaymentEvent(actor, propertyId, created.bookingId, paymentKey, {
    expectedBookingVersion: 1, eventId, kind: "received", amountCents: 10000,
    currency: "TWD", evidenceRef: "synthetic-receipt", occurredAt: new Date().toISOString(),
  });
  assert.equal(paid.bookingVersion, 2);
  assert.deepEqual(await service.recordPaymentEvent(actor, propertyId, created.bookingId, paymentKey, {
    expectedBookingVersion: 1, eventId, kind: "received", amountCents: 10000,
    currency: "TWD", evidenceRef: "synthetic-receipt", occurredAt: (await repository.read(propertyId)).bookings[0].paymentEvents[0].occurredAt,
  }), paid);
  await assert.rejects(service.releaseHold(actor, propertyId, created.bookingId, key(), 2, 2),
    errorCode("CANCELLATION_REQUIRES_SETTLEMENT"));
  const converted = await service.convertHold(actor, propertyId, created.bookingId, key(), 2);
  assert.equal(converted.bookingId, created.bookingId);
  assert.equal((await repository.read(propertyId)).bookings[0].status, "confirmed");
  assert.equal((await repository.read(propertyId)).version, 2);
});

test("expired native hold remains occupied until owner extends or releases it", async () => {
  const { service, repository } = setup();
  const actor = principal("os", { actions: [...principal().actions, "hold:write"] });
  await assert.rejects(service.createHold(actor, propertyId, key(), {
    ...holdInput(), totalCents: null,
  }), errorCode("HOLD_TOTAL_REQUIRED"));
  const created = await service.createHold(actor, propertyId, key(), holdInput());
  await repository.transact(propertyId, (state) => {
    state.bookings[0].hold.expiresAt = new Date(Date.now() - 1000).toISOString();
  });
  const pending = await service.getBooking(actor, propertyId, created.bookingId);
  assert.equal(pending.hold.state, "awaiting_owner");
  assert.equal((await repository.read(propertyId)).bookings[0].hold.state, "active");
  const newExpiresAt = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const extensionKey = key(), input = { expectedBookingVersion: 1, newExpiresAt };
  const handler = createHandler(service, async () => actor);
  const httpResponse = await handler(new Request(
    `https://iron.invalid/v1/properties/${propertyId}/holds/${created.bookingId}/extend`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": extensionKey },
      body: JSON.stringify(input),
    }));
  assert.equal(httpResponse.status, 200);
  const extended = await httpResponse.json();
  assert.equal(extended.bookingVersion, 2);
  assert.equal(extended.inventoryVersion, 2);
  assert.deepEqual(await service.extendHold(actor, propertyId, created.bookingId, extensionKey, input), extended);
  assert.equal((await service.getBooking(actor, propertyId, created.bookingId)).hold.state, "active");
  await assert.rejects(service.extendHold(actor, propertyId, created.bookingId, key(),
    { expectedBookingVersion: 2, newExpiresAt: new Date(Date.now() - 1000).toISOString() }),
  errorCode("INVALID_HOLD_EXPIRY"));
  assert.equal((await service.availability(actor, propertyId, "2026-11-10", "2026-11-11")).cells[0].state, "held");
  await service.releaseHold(actor, propertyId, created.bookingId, key(), 2, 2);
  assert.deepEqual(repository.auditRecords(propertyId).map((item) => item.type),
    ["hold.created", "hold.extended", "hold.released"]);
});

test("money received after hold release stays in the ledger and triggers review", async () => {
  const { service, repository } = setup();
  const actor = principal("os", { actions: [...principal().actions, "hold:write", "payment:write"] });
  const created = await service.createHold(actor, propertyId, key(), holdInput());
  await service.releaseHold(actor, propertyId, created.bookingId, key(), 1, 2);
  const late = await service.recordPaymentEvent(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 2, eventId: key(), kind: "received", amountCents: 10000,
    currency: "TWD", evidenceRef: "synthetic-late-money", occurredAt: new Date().toISOString(),
  });
  assert.equal(late.refundReviewRequired, true);
  assert.equal((await service.getBooking(actor, propertyId, created.bookingId)).hold.latePaymentReview, true);
  const limited = await service.getBooking(principal("os", { fields: [] }), propertyId, created.bookingId);
  assert.equal("latePaymentReview" in limited.hold, false);
  assert.equal((await service.availability(actor, propertyId, "2026-11-10", "2026-11-11")).cells[0].state, "unsold");
  const refund = await service.recordPaymentEvent(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 3, eventId: key(), kind: "refunded", amountCents: 10000,
    currency: "TWD", evidenceRef: "synthetic-late-refund", occurredAt: new Date().toISOString(),
  });
  assert.equal(refund.netReceivedCents, 0);
  assert.equal((await repository.read(propertyId)).bookings[0].hold.latePaymentReview, false);
});

test("amendment atomically moves room nights and rejects conflicting destinations", async () => {
  const { service, repository } = setup();
  const actor = principal("os", { actions: [...principal().actions, "booking:amend"] });
  const original = await service.createBooking(actor, propertyId, key(), bookingInput());
  const moved = await service.amendBooking(actor, propertyId, original.bookingId, key(), {
    expectedBookingVersion: 1, expectedInventoryVersion: 2,
    changes: { stays: [{ checkIn: "2026-11-12", checkOut: "2026-11-13", roomIds: [roomId] }] },
  });
  assert.equal(moved.inventoryVersion, 3);
  await service.createBooking(actor, propertyId, key(), bookingInput(3));
  await assert.rejects(service.amendBooking(actor, propertyId, original.bookingId, key(), {
    expectedBookingVersion: 2, expectedInventoryVersion: 4,
    changes: { stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }] },
  }), errorCode("ROOM_CONFLICT"));
  const unchanged = (await repository.read(propertyId)).bookings.find((item) => item.id === original.bookingId);
  assert.equal(unchanged.stays[0].checkIn, "2026-11-12");
  assert.equal(unchanged.version, 2);
});

test("OS room move on OwlNest fences both stays until close and open readback", async () => {
  const { service, repository } = setup("owlnest");
  await repository.transact(propertyId, (state) => {
    state.channel.sourceReadbackEnabled = true;
    state.channel.stockObservedThrough = "2026-12-31";
  });
  const actor = principal("os", { actions: [...principal().actions, "booking:amend"] });
  const channel = principal("channel");
  const created = await service.createBooking(actor, propertyId, key(), bookingInput());
  const requested = await requestSync(service, repository, created, actor);
  await verifyManualSync(service, repository, requested);
  let state = await repository.read(propertyId);
  const moved = await service.amendBooking(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: state.bookings[0].version, expectedInventoryVersion: state.version,
    reason: "Synthetic date correction",
    changes: { stays: [{ checkIn: "2026-11-12", checkOut: "2026-11-13", roomIds: [roomId] }] },
  });
  assert.equal(moved.operationState, "sync_pending");
  state = await repository.read(propertyId);
  const operation = state.operations.at(-1);
  assert.deepEqual(operation.cells.map((cell) => [cell.date, cell.desired]), [
    ["2026-11-12", "closed"], ["2026-11-10", "open"], ["2026-11-11", "open"],
  ]);
  assert.deepEqual(state.fences[0].cells.map((cell) => cell.date).sort(),
    ["2026-11-10", "2026-11-11", "2026-11-12"]);
  await assert.rejects(service.amendBooking(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: state.bookings[0].version, expectedInventoryVersion: state.version,
    changes: { stays: [{ checkIn: "2026-11-13", checkOut: "2026-11-14", roomIds: [roomId] }] },
  }), errorCode("CHANNEL_AMENDMENT_NOT_READY"));
  const verified = await service.recordChannelReadback(channel, { propertyId,
    operationKey: moved.operationKey, providerVersion: "synthetic-move",
    observedAt: new Date(Date.now() + 1000).toISOString(),
    cells: observed(operation.cells) });
  assert.equal(verified.state, "sync_verified");
  state = await repository.read(propertyId);
  assert.equal(state.fences.length, 0);
  assert.equal(state.bookings[0].stays[0].checkIn, "2026-11-12");
  assert.equal(repository.auditRecords(propertyId).find((item) =>
    item.type === "booking.amended").reason, "Synthetic date correction");
});

test("OS create records locally without OwlNest readiness; only the button queues sync", async () => {
  const { service, repository } = setup("owlnest");
  await repository.transact(propertyId, state => {
    state.channel.sourceReadbackEnabled = false;
    state.channel.ready = false;
    delete state.channel.stockObservedFrom;
    delete state.channel.stockObservedThrough;
  });
  await assert.rejects(service.createBooking(principal(), propertyId, key(),
    bookingInput(1, { guestName: null })), errorCode("GUEST_NAME_REQUIRED"));
  await assert.rejects(service.createBooking(principal(), propertyId, key(),
    bookingInput(1, { totalCents: null })), errorCode("PRICE_REQUIRED"));
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  assert.equal(created.operationState, "awaiting_manual_sync");
  assert.equal(created.operationKey, null);
  assert.equal((await repository.read(propertyId)).operations.length, 0);
  await assert.rejects(requestSync(service, repository, created),
    errorCode("CHANNEL_SYNC_NOT_READY"));
  await repository.transact(propertyId, state => {
    state.channel.sourceReadbackEnabled = true;
    state.channel.ready = true;
  });
  const requested = await requestSync(service, repository, created);
  assert.equal(requested.operationState, "sync_pending");
  assert.equal((await repository.read(propertyId)).operations.length, 1);
  await assert.rejects(requestSync(service, repository, created),
    errorCode("CHANNEL_SYNC_NOT_READY"));
});

test("manual sync button is scoped, versioned, and idempotent", async () => {
  const { service, repository } = setup("owlnest");
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  const state = await repository.read(propertyId);
  const actor = principal("os", { actions: [...principal().actions, "booking:amend"] });
  const requestKey = key();
  await assert.rejects(service.requestManualChannelSync(principal("line"), propertyId,
    created.bookingId, key(), 1, state.version), errorCode("FORBIDDEN"));
  await assert.rejects(service.requestManualChannelSync(actor, propertyId,
    created.bookingId, key(), 1, state.version - 1), errorCode("VERSION_CONFLICT"));
  const requested = await service.requestManualChannelSync(actor, propertyId,
    created.bookingId, requestKey, 1, state.version);
  assert.equal(requested.operationState, "sync_pending");
  assert.equal((await repository.read(propertyId)).operations[0].ownCloseWriteRequired, true);
  assert.deepEqual(await service.requestManualChannelSync(actor, propertyId,
    created.bookingId, requestKey, 1, state.version), requested);
  await assert.rejects(service.requestManualChannelSync(actor, propertyId,
    created.bookingId, key(), 1, requested.inventoryVersion),
  errorCode("CHANNEL_SYNC_NOT_READY"));
  assert.equal((await repository.read(propertyId)).operations.length, 1);
});

test("unsynced OS stay edits remain local; verified OwlNest moves need observed stock window", async () => {
  const { service, repository } = setup("owlnest");
  const actor = principal("os", { actions: [...principal().actions, "booking:amend"] });
  const created = await service.createBooking(actor, propertyId, key(), bookingInput(1, {
    stays: [{ checkIn: "2026-10-31", checkOut: "2026-11-02", roomIds: [roomId] }],
  }));
  const local = await service.amendBooking(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 1, expectedInventoryVersion: created.inventoryVersion,
    changes: { stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }] },
  });
  assert.equal(local.operationState, "awaiting_manual_sync");
  assert.equal((await repository.read(propertyId)).operations.length, 0);
  const requested = await requestSync(service, repository, created, actor);
  await verifyManualSync(service, repository, requested);
  await repository.transact(propertyId, state => {
    state.channel.stockObservedFrom = "2026-11-11";
  });
  const state = await repository.read(propertyId);
  await assert.rejects(service.amendBooking(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: state.bookings[0].version, expectedInventoryVersion: state.version,
    changes: { stays: [{ checkIn: "2026-11-12", checkOut: "2026-11-13", roomIds: [roomId] }] },
  }), errorCode("CHANNEL_STOCK_NOT_OBSERVED"));
  const cancelled = await service.cancelBooking(actor, propertyId, created.bookingId, key(),
    state.bookings[0].version, state.version);
  assert.equal(cancelled.operationState, "sync_pending");
  assert.equal((await repository.read(propertyId)).bookings[0].status, "cancelled");
});

test("verified own manual close can be cancelled without a complete activation window", async () => {
  const { service, repository } = setup("owlnest");
  await repository.transact(propertyId, state => { state.channel.stockObservedFrom = null; });
  const actor = principal("os", { actions: [...principal().actions, "booking:amend"] });
  const created = await service.createBooking(actor, propertyId, key(), bookingInput(1, {
    stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }],
  }));
  const requested = await requestSync(service, repository, created, actor);
  assert.equal((await verifyManualSync(service, repository, requested)).state, "sync_verified");
  const before = await repository.read(propertyId);
  const booking = before.bookings[0];
  const cancelled = await service.cancelBooking(actor, propertyId, booking.id, key(),
    booking.version, before.version, null, "Synthetic test cleanup");
  assert.equal(cancelled.operationState, "sync_pending");
  const after = await repository.read(propertyId);
  assert.equal(after.bookings[0].status, "cancelled");
  assert.deepEqual(after.operations.at(-1).cells, [{ roomId, date: "2026-11-10", desired: "open" }]);
});

test("missing own-close proof cannot bypass the observed stock window", async () => {
  const { service, repository } = setup("owlnest");
  await repository.transact(propertyId, state => { state.channel.stockObservedFrom = null; });
  const actor = principal("os", { actions: [...principal().actions, "booking:amend"] });
  const created = await service.createBooking(actor, propertyId, key(), bookingInput(1, {
    stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }],
  }));
  const requested = await requestSync(service, repository, created, actor);
  await verifyManualSync(service, repository, requested);
  await repository.transact(propertyId, state => {
    state.operations[0].ownCloseWriteRequired = false;
  });
  const before = await repository.read(propertyId);
  await assert.rejects(service.cancelBooking(actor, propertyId, created.bookingId, key(),
    before.bookings[0].version, before.version, null, "Synthetic test cleanup"),
  errorCode("CHANNEL_STOCK_NOT_OBSERVED"));
});

test("OS can correct only the name on a uniquely linked source order and keeps source review", async () => {
  const { service, repository } = setup();
  const imported = await service.applySourceEvent(principal("source"), key(), sourceInput());
  const state = await repository.read(propertyId);
  const actor = principal("os", { actions: [...principal().actions, "booking:amend"] });
  for (const changes of [{ contact: "synthetic-contact" }, { notes: "synthetic note" },
    { totalCents: 1000 }, { guestName: "Manual correction", totalCents: 1000 },
    { guestName: null }, { guestName: "External Guest" }]) {
    await assert.rejects(service.amendBooking(actor, propertyId, imported.bookingId,
      key(), { expectedBookingVersion: 1, expectedInventoryVersion: state.version,
        changes, reason: "Synthetic correction" }), errorCode("SOURCE_AMEND_REQUIRES_REVIEW"));
  }
  const input = { expectedBookingVersion: 1, expectedInventoryVersion: state.version,
    changes: { guestName: "Manual correction" }, reason: "Synthetic correction" };
  const requestKey = key();
  const result = await service.amendBooking(actor, propertyId, imported.bookingId,
    requestKey, input);
  assert.equal(result.sourceReviewRequired, true);
  assert.deepEqual(await service.amendBooking(actor, propertyId, imported.bookingId,
    requestKey, input), result);
  const after = await repository.read(propertyId);
  assert.equal(after.bookings[0].guestName, "Manual correction");
  assert.equal(after.bookings[0].lineOverridePending, true);
  assert.equal(after.sourceLinks[0].diverged, true);
  assert.equal(after.fences.length, 0);
  assert.equal(after.operations.length, 0);
  assert.equal(after.version, state.version);
  assert.equal((await service.getBooking(actor, propertyId, imported.bookingId))
    .sourceReviewRequired, true);
  assert.equal(repository.auditRecords(propertyId).at(-1).reason, "Synthetic correction");
  const sourceAgain = await service.applySourceEvent(principal("source"), key(),
    sourceInput(after.version, { sourceVersion: "v2", previousSourceVersion: "v1",
      totalCents: null }));
  assert.equal(sourceAgain.state, "review_required");
  assert.equal((await repository.read(propertyId)).bookings[0].guestName, "Manual correction");
});

test("native paid booking requires settlement before cancellation; refund stays append-only", async () => {
  const { service, repository } = setup();
  const actor = principal("os", { actions: [...principal().actions, "payment:write"] });
  const created = await service.createBooking(actor, propertyId, key(), bookingInput());
  await assert.rejects(service.recordPaymentEvent(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 1, eventId: key(), kind: "received", amountCents: 50000,
    currency: "TWD", evidenceRef: "synthetic-future-payment",
    occurredAt: new Date(Date.now() + 60_000).toISOString(),
  }), errorCode("FUTURE_RECEIPT"));
  const paid = await service.recordPaymentEvent(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 1, eventId: key(), kind: "received", amountCents: 50000,
    currency: "TWD", evidenceRef: "synthetic-payment", occurredAt: new Date().toISOString(),
  });
  await assert.rejects(service.cancelBooking(actor, propertyId, created.bookingId, key(),
    paid.bookingVersion, 2), errorCode("CANCELLATION_REQUIRES_SETTLEMENT"));
  assert.equal((await repository.read(propertyId)).bookings[0].paymentEvents.length, 1);
  await assert.rejects(service.recordPaymentEvent(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 2, eventId: key(), kind: "refunded", amountCents: 50001,
    currency: "TWD", evidenceRef: "synthetic-refund", occurredAt: new Date().toISOString(),
  }), errorCode("REFUND_EXCEEDS_RECEIVED"));
  const refunded = await service.recordPaymentEvent(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 2, eventId: key(), kind: "refunded", amountCents: 50000,
    currency: "TWD", evidenceRef: "synthetic-refund", occurredAt: new Date().toISOString(),
  });
  assert.equal(refunded.netReceivedCents, 0);
  const cancelled = await service.cancelBooking(actor, propertyId, created.bookingId, key(),
    refunded.bookingVersion, 2);
  assert.equal(cancelled.refundReviewRequired, false);
  assert.equal((await repository.read(propertyId)).bookings[0].paymentEvents.length, 2);
});

test("finance grant can append a payment fact but cannot change room nights or cancel", async () => {
  const { service, repository } = setup();
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  const finance = principal("finance", { actions: ["booking:read", "event:read", "payment:write",
    "finance:ledger"],
    fields: ["money"] });
  const before = await service.getBooking(finance, propertyId, created.bookingId);
  assert.equal(before.totalCents, 1200000);
  assert.equal("guestName" in before, false);
  const received = await service.recordPaymentEvent(finance, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 1, eventId: key(), kind: "received", amountCents: 50000,
    currency: "TWD", evidenceRef: "synthetic-finance-proof", occurredAt: new Date().toISOString(),
  });
  assert.equal(received.netReceivedCents, 50000);
  await service.recordPaymentEvent(finance, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 2, eventId: key(), kind: "refunded", amountCents: 10000,
    currency: "TWD", evidenceRef: "synthetic-finance-refund", occurredAt: new Date().toISOString(),
  });
  const first = await service.financeLedger(finance, propertyId, { limit: 1, cursor: null });
  assert.equal(first.events.length, 1);
  assert.ok(first.nextCursor);
  const second = await service.financeLedger(finance, propertyId,
    { limit: 1, cursor: first.nextCursor });
  assert.equal(second.events.length, 1);
  assert.equal(second.nextCursor, null);
  assert.notEqual(first.events[0].eventId, second.events[0].eventId);
  assert.equal(JSON.stringify([first, second]).includes("Synthetic Guest"), false);
  await assert.rejects(service.financeLedger(principal("finance", {
    actions: ["finance:ledger"], fields: [] }), propertyId, { limit: 10, cursor: null }),
  errorCode("FORBIDDEN"));
  await assert.rejects(service.cancelBooking(finance, propertyId, created.bookingId, key(), 3, 2),
    errorCode("FORBIDDEN"));
  await assert.rejects(service.amendBooking(finance, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 3, expectedInventoryVersion: 2, changes: { notes: "alter" },
  }), errorCode("FORBIDDEN"));
  assert.equal((await repository.read(propertyId)).bookings[0].status, "confirmed");
});

test("booking list uses scoped seek pagination and hides money without its grant", async () => {
  const { service } = setup();
  const writer = principal();
  await service.createBooking(writer, propertyId, key(), bookingInput());
  await service.createBooking(writer, propertyId, key(), bookingInput(2, {
    stays: [{ checkIn: "2026-11-12", checkOut: "2026-11-13", roomIds: [roomId] }],
  }));
  const reader = principal("os", { fields: [] });
  const first = await service.listBookings(reader, propertyId,
    { limit: 1, cursor: null, status: null, from: null, to: null });
  assert.equal(first.bookings.length, 1);
  assert.equal(first.inventoryVersion, 3);
  assert.equal(first.authorityEpoch, 7);
  assert.equal(first.readOnly, false);
  assert.equal(first.snapshot, null);
  assert.equal("totalCents" in first.bookings[0], false);
  assert.ok(first.nextCursor);
  const second = await service.listBookings(reader, propertyId,
    { limit: 1, cursor: first.nextCursor, status: null, from: null, to: null });
  assert.equal(second.bookings.length, 1);
  assert.equal(second.inventoryVersion, first.inventoryVersion);
  assert.equal(second.authorityEpoch, first.authorityEpoch);
  assert.notEqual(second.bookings[0].id, first.bookings[0].id);
  assert.equal(second.nextCursor, null);
  await assert.rejects(service.listBookings(reader, otherPropertyId,
    { limit: 1, cursor: first.nextCursor, status: null, from: null, to: null }), errorCode("INVALID_CURSOR"));
});

test("OS room attention stays visible ahead of cancellation history", async () => {
  const { service, repository } = setup();
  const writer = principal();
  const receipts = [];
  for (let index = 0; index < 3; index++) {
    const from = `2026-11-${10 + index}`;
    const to = `2026-11-${11 + index}`;
    const state = await repository.read(propertyId);
    receipts.push(await service.createBooking(writer, propertyId, key(),
      bookingInput(state.version, { stays: [{ checkIn: from, checkOut: to,
        roomIds: [roomId] }] })));
  }
  for (const receipt of receipts.slice(1)) {
    const state = await repository.read(propertyId);
    await service.cancelBooking(writer, propertyId, receipt.bookingId, key(),
      receipt.bookingVersion, state.version);
  }
  await repository.transact(propertyId, (state) => {
    state.bookings.find((item) => item.id === receipts[0].bookingId).channelSyncState =
      "action_required";
    state.bookings.find((item) => item.id === receipts[1].bookingId).channelSyncState =
      "review_required";
  });
  const reader = principal("os", { actions: ["booking:read"], fields: [] });
  const options = { limit: 1, status: null, from: null, to: null, attention: true };
  const first = await service.listBookings(reader, propertyId, { ...options, cursor: null });
  assert.equal(first.bookings.length, 1);
  assert.ok(first.nextCursor);
  const second = await service.listBookings(reader, propertyId,
    { ...options, cursor: first.nextCursor });
  assert.equal(second.bookings.length, 1);
  assert.deepEqual(new Set([first.bookings[0].id, second.bookings[0].id]),
    new Set(receipts.slice(0, 2).map((item) => item.bookingId)));
  assert.equal(second.nextCursor, null);
  const cancelled = await service.listBookings(reader, propertyId,
    { limit: 50, cursor: null, status: "cancelled", from: null, to: null });
  assert.deepEqual(new Set(cancelled.bookings.map((item) => item.id)),
    new Set(receipts.slice(1).map((item) => item.bookingId)));
  await assert.rejects(service.listBookings(reader, propertyId,
    { ...options, attention: false, cursor: first.nextCursor }), errorCode("INVALID_CURSOR"));
  await assert.rejects(service.listBookings(principal("line", { actions: ["booking:read"] }),
    propertyId, { ...options, cursor: null }), errorCode("FORBIDDEN"));
});

test("read-only Sweetfun list exposes only a pinned snapshot identity to OS readers", async () => {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId, propertyId, roomIds: [roomId], version: 7,
    authorityEpoch: 0, readOnly: true,
    sweetfunImport: { capturedAt: "2026-10-21T09:52:08.770Z",
      sourceHash: "f".repeat(64), privateRows: [{ guestName: "Do not expose" }] },
    channel: { mode: "none", ready: false, websiteSalesEnabled: false,
      grantId: null, websiteBindingId: null },
    sourceGrants: [], bookings: [], sourceLinks: [], operations: [], fences: [],
    manualBlocks: [], receipts: [] });
  const result = await new IronGateService(repository).listBookings(
    principal("os", { authorityEpoch: 0, actions: ["booking:read"], fields: [] }),
    propertyId, { limit: 10, cursor: null, status: null, from: null, to: null });
  assert.deepEqual(result.snapshot, { capturedAt: "2026-10-21T09:52:08.770Z",
    sourceHash: "f".repeat(64) });
  assert.equal(JSON.stringify(result).includes("Do not expose"), false);
});

test("outbox events are ordered, PII-free, replayable, and not duplicated by retries", async () => {
  const { service } = setup();
  const actor = principal("os", { actions: [...principal().actions, "event:read"] });
  const requestKey = key();
  const created = await service.createBooking(actor, propertyId, requestKey, bookingInput());
  await service.createBooking(actor, propertyId, requestKey, bookingInput());
  await service.cancelBooking(actor, propertyId, created.bookingId, key(), 1, 2);
  const first = await service.listEvents(actor, propertyId, 0, 1);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].type, "booking.created");
  assert.equal(first.hasMore, true);
  const second = await service.listEvents(actor, propertyId, first.nextCursor, 10);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].type, "booking.cancelled");
  assert.equal(second.hasMore, false);
  assert.equal(JSON.stringify([...first.events, ...second.events]).includes("Synthetic Guest"), false);
  await assert.rejects(service.listEvents(principal("guest", { actions: ["event:read"] }),
    propertyId, 0, 10), errorCode("FORBIDDEN"));
});

test('OS full-edit capability is restricted to immutable direct evidence and field grants', async () => {
  for (const platform of ['LINE', 'booking.com', '', 'mixed']) {
    const { service, repository } = setup();
    const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
    await repository.transact(propertyId, state => {
      const booking = state.bookings[0]; booking.source = 'external';
      const row = value => { const values = Array(19).fill(''); values[2] = value; return { values }; };
      booking.sweetfunSnapshot = { rows: platform === 'mixed' ? [row('LINE'), row('OTA')] : [row(platform)] };
    });
    const actor = principal('os', { actions: ['booking:read', 'booking:amend'] });
    const raw = await service.getBooking(actor, propertyId, created.bookingId);
    assert.equal(raw.osEditMode, platform === 'LINE' ? 'full' : 'guest_name');
    const input = { expectedBookingVersion: 1, expectedInventoryVersion: created.inventoryVersion,
      changes: { bookedAt: '2026-10-20', totalCents: 1300000 }, reason: 'Synthetic edit', channelPolicy: 'manual' };
    if (platform === 'LINE') {
      await assert.rejects(service.amendBooking({ ...actor, fields: ['guest_name'] }, propertyId,
        created.bookingId, key(), input), errorCode('FORBIDDEN'));
      await assert.rejects(service.amendBooking(actor, propertyId, created.bookingId, key(), {
        ...input, changes: { bookedAt: '2026-02-30' } }), errorCode('INVALID_DATE'));
      await service.amendBooking(actor, propertyId, created.bookingId, key(), input);
      const redacted = await service.getBooking({ ...actor, fields: ['guest_name'] }, propertyId, created.bookingId);
      assert.equal(redacted.totalCents, undefined); assert.equal(redacted.roomNightPrices, undefined);
    } else await assert.rejects(service.amendBooking(actor, propertyId, created.bookingId, key(), input), errorCode('FORBIDDEN'));
  }
});

test('a legacy LINE edit retains its ledger alias and cannot be overwritten by a later source event', async () => {
  const { service, repository } = setup();
  const created = await service.applySourceEvent(principal('source'), key(), sourceInput(1, { totalCents: 1200000, currency: 'TWD' }));
  await repository.transact(propertyId, state => {
    const booking = state.bookings[0]; delete booking.sourceCalendar;
    const values = Array(19).fill(''); Object.assign(values, { 2: 'LINE', 9: 'synthetic-line-order', 6: '12000',
      3: '2026/11/10', 4: '2026/11/12' });
    booking.sweetfunSnapshot = { groupKey: 'J:synthetic-line-order', rows: [{ values, roomFeeCents: 1200000 }] };
  });
  const before = await repository.read(propertyId);
  const actor = principal('os', { actions: ['booking:read', 'booking:amend'] });
  const saved = await service.amendBooking(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 1, expectedInventoryVersion: before.version, channelPolicy: 'manual',
    reason: 'Synthetic owner edit', changes: { guestName: 'New Synthetic Guest', bookedAt: '2026-10-21' } });
  const publicBooking = await service.getBooking(actor, propertyId, created.bookingId);
  assert.equal(publicBooking.sourceCalendar.sourceOrderRef, 'J:synthetic-line-order');
  assert.equal(publicBooking.sourceCalendar.bookedAt, '2026-10-21');
  assert.equal(publicBooking.sourceReviewRequired, false);
  const result = await service.applySourceEvent(principal('source'), key(), sourceInput(saved.inventoryVersion,
    { previousSourceVersion: 'v1', sourceVersion: 'v2', guestName: 'Stale Upstream Guest' }));
  assert.equal(result.reason, 'OS_DIRECT_ORDER_MANAGED');
  const after = await repository.read(propertyId);
  assert.equal(after.bookings[0].guestName, 'New Synthetic Guest');
  assert.equal(after.sourceLinks[0].diverged, true);
  assert.equal(after.bookings.length, 1);
});

test('legacy LINE room changes can be saved beyond the observation window without unsafe provider dispatch', async () => {
  const { service, repository } = setup('owlnest');
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  await repository.transact(propertyId, state => {
    const booking = state.bookings[0]; booking.source = 'external'; booking.channelSyncState = 'not_required';
    const values = Array(19).fill(''); values[2] = 'LINE'; booking.sweetfunSnapshot = { rows: [{ values }] };
    state.channel.stockObservedFrom = null; state.channel.stockObservedThrough = null;
  });
  const actor = principal('os', { actions: ['booking:read', 'booking:amend'] });
  const saved = await service.amendBooking(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 1, expectedInventoryVersion: created.inventoryVersion, channelPolicy: 'manual',
    changes: { stays: [{ checkIn: '2027-01-01', checkOut: '2027-01-02', roomIds: [roomId] }] } });
  assert.equal(saved.operationState, 'awaiting_manual_sync');
  await assert.rejects(service.requestManualChannelSync(actor, propertyId, created.bookingId, key(),
    saved.bookingVersion, saved.inventoryVersion), errorCode('CHANNEL_STOCK_NOT_OBSERVED'));
  const state = await repository.read(propertyId);
  assert.equal(state.operations.length, 0);
  assert.equal(state.bookings[0].stays[0].checkIn, '2027-01-01');
  assert.equal(state.fences[0].cells.length, 2);
});
