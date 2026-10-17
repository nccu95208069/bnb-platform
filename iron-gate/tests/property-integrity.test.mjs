import test from "node:test";
import assert from "node:assert/strict";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const bookingId = "44444444-4444-4444-8444-444444444444";
const cell = { roomId, date: "2026-11-10" };

function fixture() {
  return { workspaceId, propertyId, roomIds: [roomId], bookings: [{ id: bookingId,
    workspaceId, propertyId, status: "confirmed",
    stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }] }],
  operations: [], fences: [] };
}
const occupancy = () => [{ room_id: roomId, night: "2026-11-10", booking_id: bookingId }];

test("a consistent occupied room night passes without exposing booking details", () => {
  const report = checkPropertyIntegrity(fixture(), occupancy());
  assert.deepEqual(report, { ok: true, issues: [], counts: {
    bookings: 1, activeBookings: 1, expectedRoomNights: 1,
    storedRoomNights: 1, pendingOperations: 0, fences: 0 } });
  assert.equal(JSON.stringify(report).includes(bookingId), false);
});

test("missing and misattributed occupancy rows block cutover", () => {
  assert.deepEqual(checkPropertyIntegrity(fixture(), []).issues, ["OCCUPANCY_DRIFT"]);
  const wrong = occupancy();
  wrong[0].booking_id = crypto.randomUUID();
  assert.deepEqual(checkPropertyIntegrity(fixture(), wrong).issues, ["OCCUPANCY_DRIFT"]);
});

test("colliding active bookings and an unfenced pending channel operation block cutover", () => {
  const state = fixture();
  state.bookings.push({ ...state.bookings[0], id: crypto.randomUUID() });
  state.operations.push({ state: "sync_pending", cells: [{ ...cell, desired: "closed" }] });
  const report = checkPropertyIntegrity(state, occupancy());
  assert.deepEqual(report.issues, ["ACTIVE_ROOM_NIGHT_COLLISION", "OCCUPANCY_DRIFT",
    "UNFENCED_CHANNEL_OPERATION"]);
  state.fences.push({ key: "synthetic", cells: [cell], reason: "channel_pending" });
  assert.deepEqual(checkPropertyIntegrity(state, occupancy()).issues,
    ["ACTIVE_ROOM_NIGHT_COLLISION", "OCCUPANCY_DRIFT"]);
});

test("malformed saved state returns fixed codes without throwing or leaking fields", () => {
  assert.deepEqual(checkPropertyIntegrity(null, []).issues, ["INVALID_PROPERTY_STATE"]);
  const state = fixture();
  state.fences.push({ cells: [null] });
  state.operations.push({ state: "review_required", cells: [null] });
  assert.deepEqual(checkPropertyIntegrity(state, occupancy()).issues,
    ["INVALID_FENCE", "UNFENCED_CHANNEL_OPERATION"]);
});
