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
      grantId: channel === "owlnest" ? channelGrantId : null, websiteBindingId },
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
  const cancelled = await service.cancelBooking(actor, propertyId, created.bookingId, key(), 1, 2);
  assert.equal(cancelled.operationState, "local_only");
  const state = await repository.read(propertyId);
  assert.equal(state.bookings.length, 1);
  assert.equal(state.bookings[0].status, "cancelled");
  const audit = repository.auditRecords(propertyId);
  assert.deepEqual(audit.map((record) => record.type), ["booking.created", "booking.cancelled"]);
  assert.equal(audit[1].bookingStatus, "cancelled");
  assert.equal(audit[1].actorSubjectId, actor.subjectId);
  const availability = await service.availability(actor, propertyId, "2026-11-10", "2026-11-11");
  assert.equal(availability.cells[0].state, "unsold");
});

test("OwlNest partial readback holds the fence; exact readback verifies it", async () => {
  const { service, repository } = setup("owlnest");
  const actor = principal();
  const connector = principal("channel");
  const created = await service.createBooking(actor, propertyId, key(), bookingInput());
  assert.equal(created.operationState, "sync_pending");
  const operation = await service.channelOperation(connector, propertyId, created.operationKey);
  await assert.rejects(service.recordChannelReadback(connector, { propertyId,
    operationKey: created.operationKey, providerVersion: "stale-before-write",
    observedAt: new Date(Date.parse((await repository.read(propertyId)).operations[0].createdAt) - 1000).toISOString(),
    cells: observed(operation.cells) }), errorCode("STALE_READBACK"));
  const partial = await service.recordChannelReadback(connector, { propertyId,
    operationKey: created.operationKey, providerVersion: "provider-v1",
    observedAt: new Date().toISOString(), cells: observed(operation.cells.slice(0, 1)) });
  assert.equal(partial.state, "review_required");
  assert.equal((await repository.read(propertyId)).fences.length, 1);
  const stillOpen = await service.recordChannelReadback(connector, { propertyId,
    operationKey: created.operationKey, providerVersion: "provider-still-open",
    observedAt: new Date().toISOString(), cells: operation.cells.map(({ roomId, date }) =>
      ({ roomId, date, count: 1, isLock: false })) });
  assert.equal(stillOpen.state, "review_required");
  assert.equal((await repository.read(propertyId)).fences.length, 1);
  const verified = await service.recordChannelReadback(connector, { propertyId,
    operationKey: created.operationKey, providerVersion: "provider-v2",
    observedAt: new Date().toISOString(), cells: observed(operation.cells) });
  assert.equal(verified.state, "sync_verified");
  assert.equal((await repository.read(propertyId)).fences.length, 0);
  assert.deepEqual((await repository.read(propertyId)).operations[0].observations.map((item) => item.accepted),
    [false, false, true]);
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
  const connector = principal("channel");
  const created = await service.createBooking(actor, propertyId, key(), bookingInput());
  await service.recordPaymentEvent(actor, propertyId, created.bookingId, key(), {
    expectedBookingVersion: 1, eventId: key(), kind: "received", amountCents: 10000,
    currency: "TWD", evidenceRef: "synthetic-payment", occurredAt: new Date().toISOString(),
  });
  const operation = await service.channelOperation(connector, propertyId, created.operationKey);
  const verified = await service.recordChannelReadback(connector, {
    propertyId, operationKey: created.operationKey, providerVersion: "provider-after-payment",
    observedAt: new Date().toISOString(), cells: observed(operation.cells),
  });
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
  const { service, repository } = setup("owlnest");
  const source = principal("source");
  const first = await service.applySourceEvent(source, key(), sourceInput());
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

test("only current channel grant reads operation details and only OS cancels", async () => {
  const { service, repository } = setup("owlnest");
  const created = await service.createBooking(principal(), propertyId, key(), bookingInput());
  await assert.rejects(service.channelOperation(principal("channel", { grantId: key() }),
    propertyId, created.operationKey), errorCode("FORBIDDEN"));
  await assert.rejects(service.cancelBooking(principal("service"), propertyId,
    created.bookingId, key(), 1, 2), errorCode("FORBIDDEN"));
  assert.equal((await repository.read(propertyId)).bookings[0].status, "confirmed");
});

test("guest order credentials cannot enumerate availability and website sale readiness stays closed", async () => {
  const { service } = setup();
  await assert.rejects(service.availability(principal("guest"), propertyId,
    "2026-11-10", "2026-11-11"), errorCode("FORBIDDEN"));
  const cells = await service.availability(principal(), propertyId, "2026-11-10", "2026-11-11");
  assert.equal(cells.cells[0].saleReady, false);
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
  const operation = await service.channelOperation(principal("channel"), propertyId, created.operationKey);
  await assert.rejects(service.recordChannelReadback(principal("channel", { grantId: key() }),
    { propertyId, operationKey: created.operationKey, providerVersion: "provider-v1",
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
  assert.equal("totalCents" in first.bookings[0], false);
  assert.ok(first.nextCursor);
  const second = await service.listBookings(reader, propertyId,
    { limit: 1, cursor: first.nextCursor, status: null, from: null, to: null });
  assert.equal(second.bookings.length, 1);
  assert.notEqual(second.bookings[0].id, first.bookings[0].id);
  assert.equal(second.nextCursor, null);
  await assert.rejects(service.listBookings(reader, otherPropertyId,
    { limit: 1, cursor: first.nextCursor, status: null, from: null, to: null }), errorCode("INVALID_CURSOR"));
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
