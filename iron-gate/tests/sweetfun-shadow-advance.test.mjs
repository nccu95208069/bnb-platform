import test from "node:test";
import assert from "node:assert/strict";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { prepareSweetfunGroups } from "../src/sweetfun-sheet-candidate.mjs";
import { prepareSweetfunShadow } from "../src/sweetfun-shadow.mjs";
import { planSweetfunAdditiveShadow } from "../src/sweetfun-shadow-advance.mjs";

function row(number, sourceId, parentId, room, checkIn, checkOut) {
  const values = Array(19).fill("");
  Object.assign(values, { 0: room, 1: "Synthetic guest", 2: "AI",
    3: checkIn, 4: checkOut, 5: "2026/10/01", 6: "1200",
    7: "not_yet", 8: "OK", 9: sourceId, 11: parentId });
  return { rowNumber: number, values, notes: Array(19).fill(null) };
}

const before = { headers: [...SWEETFUN_HEADERS], rows: [
  row(2, "synthetic-j1", "synthetic-l1", "101", "2026/10/24", "2026/10/25") ] };
const after = { headers: [...SWEETFUN_HEADERS], rows: [
  structuredClone(before.rows[0]),
  row(3, "synthetic-j2", "synthetic-l2", "102", "2026/10/25", "2026/10/26") ] };
const oldKey = prepareSweetfunGroups(before).candidates[0].key;
const newKey = prepareSweetfunGroups(after).candidates[1].key;
const fixed = {
  sourceId: "synthetic-original", sourceCopyId: "synthetic-copy-1",
  sourceCopyCreatedAt: "2026-10-20T00:00:00.000Z",
  capturedAt: "2026-10-20T00:00:00.000Z",
  expectedSourceHash: prepareSweetfunGroups(before).sourceHash,
  workspaceId: crypto.randomUUID(), propertyId: crypto.randomUUID(),
  roomIds: Object.fromEntries(["101", "102", "201", "202", "301", "302"]
    .map((room) => [room, crypto.randomUUID()])),
  bookingIds: { [oldKey]: crypto.randomUUID() },
  inventoryVersion: 1, authorityEpoch: 0,
};
const newConfig = { ...fixed, sourceCopyId: "synthetic-copy-2",
  sourceCopyCreatedAt: "2026-10-21T00:00:00.000Z",
  capturedAt: "2026-10-21T00:00:00.000Z",
  expectedSourceHash: prepareSweetfunGroups(after).sourceHash,
  inventoryVersion: 2,
  bookingIds: { ...fixed.bookingIds, [newKey]: crypto.randomUUID() } };

test("Sweetfun read-only shadow advances one additive source room-night", () => {
  const current = prepareSweetfunShadow(before, fixed).state;
  const plan = planSweetfunAdditiveShadow(current, after, newConfig);
  assert.equal(plan.summary.addedRows, 1);
  assert.equal(plan.summary.addedBookings, 1);
  assert.equal(plan.summary.addedRoomNights, 1);
  assert.equal(plan.summary.paymentEventsCreated, 0);
  assert.equal(plan.summary.canCutover, false);
  assert.equal(plan.state.readOnly, true);
  assert.equal(plan.state.bookings.find((booking) =>
    booking.sweetfunSnapshot.groupKey === oldKey).id, fixed.bookingIds[oldKey]);
});

test("Sweetfun additive shadow refuses changed, removed, or unpinned rows", () => {
  const current = prepareSweetfunShadow(before, fixed).state;
  const changed = structuredClone(after);
  changed.rows[0].values[6] = "1201";
  assert.throws(() => planSweetfunAdditiveShadow(current, changed, {
    ...newConfig, expectedSourceHash: prepareSweetfunGroups(changed).sourceHash,
  }), /SWEETFUN_SHADOW_NON_ADDITIVE_SOURCE/);
  const noteChanged = structuredClone(after);
  noteChanged.rows[0].notes[7] = "Synthetic payment note";
  assert.throws(() => planSweetfunAdditiveShadow(current, noteChanged, {
    ...newConfig, expectedSourceHash: prepareSweetfunGroups(noteChanged).sourceHash,
  }), /SWEETFUN_SHADOW_NON_ADDITIVE_SOURCE/);
  assert.throws(() => planSweetfunAdditiveShadow(current,
    { ...after, rows: [after.rows[1]] }, newConfig),
  /SWEETFUN_SHADOW_NON_ADDITIVE_SOURCE/);
  assert.throws(() => planSweetfunAdditiveShadow(current, after,
    { ...newConfig, bookingIds: { ...newConfig.bookingIds, [oldKey]: crypto.randomUUID() } }),
  /SWEETFUN_SHADOW_BOOKING_ID_DRIFT/);
  assert.throws(() => planSweetfunAdditiveShadow(current, after,
    { ...newConfig, sourceCopyId: newConfig.sourceId }),
  /UNSAFE_SWEETFUN_SHADOW_ADVANCE/);
});
