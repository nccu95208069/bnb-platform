import test from "node:test";
import assert from "node:assert/strict";
import { analyzeOsWorkspace, prepareOsPropertyCandidate,
  compareOsPropertyCandidate } from "../src/os-shadow.mjs";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";

test("OS shadow report finds collisions and unmapped fields without returning guest PII", () => {
  const workspaceId = crypto.randomUUID(), propertyId = crypto.randomUUID();
  const roomId = crypto.randomUUID(), otherRoomId = crypto.randomUUID();
  const workspace = { id: workspaceId,
    properties: [{ id: propertyId, rooms: [{ id: roomId }, { id: otherRoomId }] }],
    bookings: [
      { id: crypto.randomUUID(), propertyId, status: "confirmed", guestName: "Private A",
        checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId],
        total: 100.25, payments: [{ amount: 50.25 }], importedFinance: { sourceAmount: null } },
      { id: crypto.randomUUID(), propertyId, status: "held", guestName: "Private B",
        checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId],
        total: null, payments: [], hold: { state: "awaiting_owner", scope: "platform_only" } },
      { id: crypto.randomUUID(), propertyId, status: "cancelled", guestName: "Private C",
        stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-12", roomIds: [otherRoomId] }],
        total: null, payments: [] },
    ] };
  const report = analyzeOsWorkspace(workspace);
  assert.equal(report.canCutover, false);
  assert.equal(report.properties[0].bookingCount, 3);
  assert.equal(report.properties[0].activeRoomNights, 2);
  assert.equal(report.properties[0].uniqueOccupiedRoomNights, 1);
  assert.equal(report.properties[0].collisions.length, 1);
  assert.ok(report.properties[0].unsupported.some((item) => item.fields.includes("importedFinance")));
  assert.ok(report.properties[0].unsupported.some((item) => item.fields.includes("hold.awaiting_owner")));
  assert.equal(JSON.stringify(report).includes("Private"), false);
  const unknownField = structuredClone(workspace);
  unknownField.bookings[0]["Secret Guest Identity"] = true;
  const redacted = analyzeOsWorkspace(unknownField);
  assert.equal(JSON.stringify(redacted).includes("Secret Guest Identity"), false);
  assert.ok(redacted.properties[0].unsupported[0].fields.includes("unknown_field"));
  assert.equal(report.sourceHash.length, 64);
  const orphan = structuredClone(workspace);
  orphan.bookings[0].propertyId = crypto.randomUUID();
  assert.throws(() => analyzeOsWorkspace(orphan), /ORPHAN_OS_BOOKING/);
});

test("simple native OS booking yields a private read-only candidate with original IDs", async () => {
  const workspaceId = crypto.randomUUID(), propertyId = crypto.randomUUID();
  const firstRoomId = crypto.randomUUID(), secondRoomId = crypto.randomUUID();
  const bookingId = crypto.randomUUID();
  const booking = { id: bookingId, propertyId, version: 4, status: "confirmed",
    guestName: "Private Guest", contact: "private@example.test", notes: "Private note",
    checkIn: "2026-11-10", checkOut: "2026-11-14", roomIds: [firstRoomId, secondRoomId],
    stays: [
      { checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [firstRoomId] },
      { checkIn: "2026-11-13", checkOut: "2026-11-14", roomIds: [secondRoomId] },
    ], total: 100.25, payments: [], bookedAt: "2026-10-13", guestNotified: false,
    createdAt: "2026-10-13T00:00:00.000Z", actor: crypto.randomUUID(), entry: "os",
    requestKey: "old-request-key", requestHash: "old-request-hash" };
  const workspace = { id: workspaceId, version: 8, properties: [{ id: propertyId,
    name: "Private Property", rooms: [{ id: firstRoomId }, { id: secondRoomId }],
    setup: { mode: "empty" } }], bookings: [booking] };
  const { state, summary, sourceHash } = prepareOsPropertyCandidate(workspace, propertyId,
    { authorityEpoch: 7, inventoryVersion: 1 });
  assert.equal(state.readOnly, true);
  assert.equal(state.bookings[0].id, bookingId);
  assert.equal(state.bookings[0].version, 4);
  assert.equal(state.bookings[0].totalCents, 10025);
  assert.deepEqual(state.bookings[0].osSnapshot, booking);
  assert.equal(state.osImport.sourceHash, sourceHash);
  assert.equal(summary.activeRoomNights, 2);
  const matching = compareOsPropertyCandidate(workspace, propertyId, state,
    { authorityEpoch: 7, inventoryVersion: 1 });
  assert.equal(matching.matches, true);
  assert.equal(matching.canCutover, false);
  assert.equal(JSON.stringify(matching).includes("Private"), false);
  const modifiedShadow = structuredClone(state);
  modifiedShadow.bookings[0].contact = "different@example.test";
  const difference = compareOsPropertyCandidate(workspace, propertyId, modifiedShadow,
    { authorityEpoch: 7, inventoryVersion: 1 });
  assert.equal(difference.matches, false);
  assert.deepEqual(difference.changedBookingIds, [bookingId]);
  const staleShadow = structuredClone(state);
  staleShadow.readOnly = false;
  assert.equal(compareOsPropertyCandidate(workspace, propertyId, staleShadow,
    { authorityEpoch: 7, inventoryVersion: 1 }).matches, false);
  const repository = new MemoryPropertyRepository();
  repository.seed(state);
  const service = new IronGateService(repository);
  const principal = { clientId: "os", subjectId: crypto.randomUUID(), origin: "os",
    workspaceId, propertyIds: [propertyId], authorityEpoch: 7,
    actions: ["booking:read", "booking:create"], fields: ["guest_name", "contact", "notes", "money"] };
  const publicBooking = await service.getBooking(principal, propertyId, bookingId);
  assert.equal(publicBooking.id, bookingId);
  assert.equal("osSnapshot" in publicBooking, false);
  assert.equal("osImport" in publicBooking, false);
  await assert.rejects(service.createBooking(principal, propertyId, crypto.randomUUID(), {
    expectedInventoryVersion: 1, source: "os", guestName: null, contact: null, notes: null,
    bookedAt: null, totalCents: null,
    stays: [{ checkIn: "2026-11-11", checkOut: "2026-11-12", roomIds: [firstRoomId] }],
  }), (error) => error?.code === "PROPERTY_READ_ONLY");

  const mismatch = structuredClone(workspace);
  mismatch.bookings[0].checkOut = "2026-11-15";
  assert.throws(() => prepareOsPropertyCandidate(mismatch, propertyId,
    { authorityEpoch: 7, inventoryVersion: 1 }), /OS_STAY_MISMATCH/);
  const withMoney = structuredClone(workspace);
  withMoney.bookings[0].payments.push({ amount: 100.25 });
  assert.throws(() => prepareOsPropertyCandidate(withMoney, propertyId,
    { authorityEpoch: 7, inventoryVersion: 1 }), /OS_FIELD_PARITY_REQUIRED/);
  const unknown = structuredClone(workspace);
  unknown.bookings[0].newBusinessMeaning = true;
  assert.throws(() => prepareOsPropertyCandidate(unknown, propertyId,
    { authorityEpoch: 7, inventoryVersion: 1 }), /OS_FIELD_PARITY_REQUIRED/);
});
