import test from "node:test";
import assert from "node:assert/strict";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { prepareSweetfunGroups } from "../src/sweetfun-sheet-candidate.mjs";
import { prepareSweetfunShadow, sweetfunRowHash, verifySweetfunShadow } from "../src/sweetfun-shadow.mjs";
import { planSweetfunAdditiveShadow, planSweetfunRetainedCancellation } from
  "../src/sweetfun-shadow-advance.mjs";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";
import { IronGateService, nightsFor } from "../src/service.ts";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rooms = Object.fromEntries(["101", "102", "201", "202", "301", "302"]
  .map((name, i) => [name, uid(10 + i)]));

function row(rowNumber, j, l, room, guest, ota = "") {
  const values = Array(19).fill("");
  Object.assign(values, { 0: room, 1: guest, 2: "Synthetic OTA", 3: "2026/11/01",
    4: "2026/11/02", 5: "2026/10/01", 6: "1200.50", 7: "done",
    8: "OK", 9: j, 10: "Synthetic note", 11: l, 13: ota });
  const notes = Array(19).fill(null);
  notes[7] = "Synthetic status marker, no cash";
  return { rowNumber, values, notes };
}

function fixture() {
  return { headers: [...SWEETFUN_HEADERS], rows: [
    row(2, "j1", "parent1", "101", "Synthetic guest A"),
    row(3, "j2", "parent1", "102", "Synthetic guest B"),
    row(4, "j3", "", "301", "Synthetic guest C", "ota-group"),
    row(5, "j4", "conflictA", "201", "Synthetic guest D"),
    row(6, "j5", "conflictB", "201", "Synthetic guest E"),
  ] };
}

function config(snapshot = fixture()) {
  return { workspaceId: uid(1), propertyId: uid(2), roomIds: rooms,
    sourceId: "synthetic-sheet", capturedAt: "2026-10-20T00:00:00.000Z",
    expectedSourceHash: prepareSweetfunGroups(snapshot).sourceHash,
    inventoryVersion: 1, authorityEpoch: 0,
    bookingIds: { "L:parent1": uid(100), "J:j3": uid(101) } };
}

test("prepares a lossless read-only shadow, fences conflicts, and creates no payments", () => {
  const snapshot = fixture(), cfg = config();
  const { state, summary } = prepareSweetfunShadow(snapshot, cfg);
  assert.deepEqual(summary, {
    sourceRows: 5, sourceGroups: 4, acceptedGroups: 2, acceptedRows: 3,
    acceptedFeeCents: "360150", occupiedRoomNights: 3,
    quarantinedGroups: 2, quarantinedRows: 2, fencedRoomNights: 1,
    uncontainedReviewRows: 0, paymentEventsCreated: 0,
    canStage: false, canCutover: false,
  });
  assert.equal(state.readOnly, true);
  assert.equal(state.channel.ready, false);
  assert.equal(state.channel.websiteSalesEnabled, false);
  assert.deepEqual(state.sourceGrants, []);
  assert.deepEqual(state.sourceLinks, []);
  assert.equal(state.bookings[0].guestName, null);
  assert.equal(state.bookings[0].totalCents, 240100);
  assert.equal(state.bookings[0].sweetfunSnapshot.rows[0].notes[7],
    "Synthetic status marker, no cash");
  assert.equal(state.bookings[0].sweetfunSnapshot.rows[1].values[1], "Synthetic guest B");
  assert.ok(state.bookings.every((booking) => booking.paymentEvents.length === 0));
  assert.equal(state.sweetfunImport.quarantined.length, 2);
  assert.equal(state.fences.length, 1);
  const occupied = state.bookings.flatMap((booking) => nightsFor(booking.stays, state.roomIds)
    .map((night) => ({ room_id: night.roomId, night: night.date, booking_id: booking.id })));
  assert.equal(checkPropertyIntegrity(state, occupied).ok, true);
  assert.equal(verifySweetfunShadow(snapshot, cfg, state).matches, true);
});

test("requires a complete persistent ID map and rejects changed source evidence", () => {
  const snapshot = fixture(), cfg = config();
  delete cfg.bookingIds["J:j3"];
  assert.throws(() => prepareSweetfunShadow(snapshot, cfg),
    /INCOMPLETE_SWEETFUN_BOOKING_ID_MAP/);
  cfg.bookingIds["J:j3"] = uid(101);
  const { state } = prepareSweetfunShadow(snapshot, cfg);
  state.bookings[0].sweetfunSnapshot.rows[0].notes[7] = "Changed payment note";
  assert.equal(verifySweetfunShadow(snapshot, cfg, state).matches, false);
  const fresh = prepareSweetfunShadow(snapshot, cfg);
  snapshot.rows[0].values[6] = "1300.50";
  assert.equal(verifySweetfunShadow(snapshot, cfg, fresh.state).matches, false);
  assert.throws(() => prepareSweetfunShadow(snapshot, cfg),
    /SWEETFUN_SOURCE_HASH_MISMATCH/);
});

test("restricted source evidence is absent from booking reads and writes stay closed", async () => {
  const cfg = config(), { state } = prepareSweetfunShadow(fixture(), cfg);
  const repository = new MemoryPropertyRepository();
  repository.seed(state);
  const service = new IronGateService(repository);
  const actor = { clientId: "synthetic-os", subjectId: "synthetic-owner", origin: "os",
    workspaceId: cfg.workspaceId, propertyIds: [cfg.propertyId], authorityEpoch: 0,
    actions: ["booking:read", "booking:create"],
    fields: ["guest_name", "contact", "notes", "money"] };
  const read = await service.getBooking(actor, cfg.propertyId, cfg.bookingIds["L:parent1"]);
  assert.equal(read.guestName, null);
  assert.deepEqual(read.sourceCalendar, { platform: "Synthetic OTA",
    externalOrderNo: null, bookedAt: "2026-10-01" });
  assert.equal(read.totalCents, 240100);
  assert.equal("sweetfunSnapshot" in read, false);
  assert.equal(JSON.stringify(read).includes("Synthetic status marker"), false);
  assert.equal(JSON.stringify(read).includes("j1"), false);
  const restricted = await service.getBooking({ ...actor, fields: [] },
    cfg.propertyId, cfg.bookingIds["L:parent1"]);
  assert.equal("sourceCalendar" in restricted, false);
  await assert.rejects(service.createBooking(actor, cfg.propertyId, uid(900), {
    expectedInventoryVersion: 1,
    stays: [{ checkIn: "2026-11-03", checkOut: "2026-11-04", roomIds: [rooms["101"]] }],
    guestName: "Synthetic new guest", contact: null, notes: null,
    totalCents: 10000, bookedAt: "2026-10-20", source: "os",
  }), (error) => error?.code === "PROPERTY_READ_ONLY");
});

test("calendar payment review projects only a scoped status, not source rows or money", async () => {
  const cfg = config(), { state } = prepareSweetfunShadow(fixture(), cfg);
  const actor = { clientId: "synthetic-os", subjectId: "synthetic-owner", origin: "os",
    workspaceId: cfg.workspaceId, propertyIds: [cfg.propertyId], authorityEpoch: 0,
    actions: ["booking:read"], fields: ["guest_name", "payment_status"] };
  const read = async fields => {
    const repository = new MemoryPropertyRepository();
    repository.seed(state);
    return new IronGateService(repository).calendarSnapshot({ ...actor, fields },
      cfg.propertyId, "2026-11-01", "2026-11-03");
  };
  const paid = await read(actor.fields);
  assert.equal(paid.bookings.length, 2);
  assert.deepEqual(paid.bookings[0].paymentReview,
    { status: "paid", source: "sheet_flag" });
  assert.equal("totalCents" in paid.bookings[0], false);
  assert.equal(JSON.stringify(paid).includes("Synthetic status marker"), false);
  assert.equal("paymentReview" in (await read(["guest_name"])).bookings[0], false);

  const booking = state.bookings.find(item => item.id === cfg.bookingIds["L:parent1"]);
  booking.sweetfunSnapshot.rows[1].values[7] = "not_yet";
  assert.deepEqual((await read(actor.fields)).bookings[0].paymentReview,
    { status: "unknown", source: "unknown" });

  booking.paymentEvents.push({ id: uid(500), kind: "received", amountCents: 240100,
    currency: "TWD", evidenceRef: "synthetic-receipt", actorId: "synthetic-owner",
    occurredAt: "2026-11-01T00:00:00.000Z",
    recordedAt: "2026-11-01T00:00:00.000Z" });
  assert.deepEqual((await read(actor.fields)).bookings[0].paymentReview,
    { status: "paid", source: "payment_events" });

  booking.paymentEvents = [];
  booking.sweetfunSnapshot.rows[1].values[7] = "done";
  booking.version = 2;
  booking.totalCents = null;
  assert.deepEqual((await read(actor.fields)).bookings[0].paymentReview,
    { status: "unknown", source: "unknown" });
});

test("owner-attested retained row becomes a cancellation without losing source evidence", () => {
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [
    row(1567, "synthetic-cancelled", "", "101", "Synthetic guest", "ota-alias"),
    row(1568, "synthetic-active", "", "102", "Another guest") ] };
  snapshot.rows[0].values[10] = "Synthetic cancellation note";
  const groups = prepareSweetfunGroups(snapshot);
  const bookingIds = Object.fromEntries(groups.candidates.map((group, index) =>
    [group.key, uid(200 + index)]));
  const base = { ...config(snapshot), expectedSourceHash: groups.sourceHash,
    bookingIds, sourceCopyId: "synthetic-private-copy",
    sourceCopyCreatedAt: "2026-10-20T00:00:00.000Z" };
  const before = prepareSweetfunShadow(snapshot, base).state;
  const decision = { outcome: "cancelled", evidenceType: "owner_attestation",
    evidenceRef: "synthetic-owner-confirmation", sourceHash: groups.sourceHash,
    sourceId: "synthetic-cancelled", rowNumber: 1567,
    rowHash: sweetfunRowHash(groups.candidates.find((group) =>
      group.key === "J:synthetic-cancelled").rows[0]) };
  const nextConfig = { ...base, inventoryVersion: 2,
    retainedCancellationDecisions: [decision] };
  const plan = planSweetfunRetainedCancellation(before, snapshot, nextConfig, decision);
  assert.equal(plan.state.bookings.length, 2);
  assert.equal(plan.state.bookings.find((booking) => booking.id ===
    bookingIds["J:synthetic-cancelled"]).status, "cancelled");
  assert.equal(plan.state.bookings.find((booking) => booking.id ===
    bookingIds["J:synthetic-cancelled"]).sweetfunSnapshot.rows[0].values[10],
    "Synthetic cancellation note");
  assert.equal(plan.removedOccupancy.length, 1);
  assert.equal(plan.state.bookings.filter((booking) => booking.paymentEvents.length).length, 0);
  assert.equal(verifySweetfunShadow(snapshot, nextConfig, plan.state).matches, true);
  const drift = structuredClone(snapshot);
  drift.rows[0].values[10] = "Changed note";
  assert.throws(() => planSweetfunRetainedCancellation(before, drift, nextConfig, decision),
    /SWEETFUN_RETAINED_CANCELLATION_SOURCE_DRIFT|SWEETFUN_SOURCE_HASH_MISMATCH/);
  assert.throws(() => planSweetfunRetainedCancellation(before, snapshot,
    { ...nextConfig, retainedCancellationDecisions: [{ ...decision, rowNumber: 1568 }] },
    decision), /UNSAFE_SWEETFUN_RETAINED_CANCELLATION/);
  const later = structuredClone(snapshot);
  later.rows.push(row(1569, "synthetic-new", "", "201", "New guest"));
  const laterConfig = { ...nextConfig, inventoryVersion: 3,
    capturedAt: "2026-10-21T00:00:00.000Z",
    sourceCopyCreatedAt: "2026-10-21T00:00:00.000Z",
    expectedSourceHash: prepareSweetfunGroups(later).sourceHash,
    bookingIds: { ...bookingIds, "J:synthetic-new": uid(203) } };
  assert.throws(() => planSweetfunAdditiveShadow(plan.state, later,
    { ...laterConfig, retainedCancellationDecisions: [] }),
    /UNSAFE_SWEETFUN_SHADOW_ADVANCE/);
  const advanced = planSweetfunAdditiveShadow(plan.state, later, laterConfig);
  assert.equal(advanced.state.bookings.find((booking) => booking.id ===
    bookingIds["J:synthetic-cancelled"]).status, "cancelled");
  assert.equal(advanced.addedOccupancy.length, 1);
});
