import test from "node:test";
import assert from "node:assert/strict";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { prepareSweetfunGroups } from "../src/sweetfun-sheet-candidate.mjs";
import { annotateSweetfunDisappearances, diffSweetfunSnapshots } from
  "../src/sweetfun-sheet-delta.mjs";
import { prepareSweetfunShadow, verifySweetfunShadow } from "../src/sweetfun-shadow.mjs";
import { planSweetfunMixedShadow } from "../src/sweetfun-shadow-advance.mjs";

function row(rowNumber, sourceId, parentId, room, checkIn, checkOut) {
  const values = Array(19).fill("");
  Object.assign(values, { 0: room, 1: "Synthetic guest", 2: "Synthetic OTA",
    3: checkIn, 4: checkOut, 5: "2026/10/01", 6: "1200",
    7: "not_yet", 8: "OK", 9: sourceId, 11: parentId });
  return { rowNumber, values, notes: Array(19).fill(null) };
}

const before = { headers: [...SWEETFUN_HEADERS], rows: [
  row(2, "cancel-a", "parent-a", "202", "2026/12/13", "2026/12/14"),
  row(3, "cancel-b", "parent-b", "302", "2026/12/12", "2026/12/13"),
  row(4, "keep", "parent-keep", "101", "2026/12/15", "2026/12/16"),
] };
const after = { headers: [...SWEETFUN_HEADERS], rows: [
  { ...structuredClone(before.rows[2]), rowNumber: 2 },
  row(3, "add-c", "parent-c", "301", "2026/10/25", "2026/10/26"),
] };
const beforeGroups = prepareSweetfunGroups(before);
const afterGroups = prepareSweetfunGroups(after);
const ids = Object.fromEntries(beforeGroups.candidates.map((group) =>
  [group.key, crypto.randomUUID()]));
const fixed = { sourceId: "synthetic-original", sourceCopyId: "synthetic-before",
  sourceCopyCreatedAt: "2026-10-21T00:00:00.000Z",
  capturedAt: "2026-10-21T00:00:00.000Z",
  expectedSourceHash: beforeGroups.sourceHash,
  workspaceId: crypto.randomUUID(), propertyId: crypto.randomUUID(),
  roomIds: Object.fromEntries(["101", "102", "201", "202", "301", "302"]
    .map((room) => [room, crypto.randomUUID()])),
  bookingIds: ids, inventoryVersion: 1, authorityEpoch: 0 };
const current = prepareSweetfunShadow(before, fixed).state;
const diff = diffSweetfunSnapshots(before, after);
const decisions = ["cancel-a", "cancel-b"].map((sourceId) => ({
  outcome: "cancelled", evidenceType: "owner_attestation",
  evidenceRef: "synthetic-owner-confirmation", beforeHash: diff.beforeHash,
  afterHash: diff.afterHash, sourceIds: [sourceId],
}));
const newKey = afterGroups.candidates.find((group) =>
  group.rows.some((source) => source.values[9] === "add-c")).key;
const afterIds = Object.fromEntries(afterGroups.candidates.map((group) =>
  [group.key, ids[group.key] ?? crypto.randomUUID()]));
const config = { ...fixed, sourceCopyId: "synthetic-after",
  sourceCopyCreatedAt: "2026-10-21T01:00:00.000Z",
  capturedAt: "2026-10-21T01:00:00.000Z",
  expectedSourceHash: diff.afterHash, bookingIds: afterIds,
  inventoryVersion: 2,
  cancellationTombstones: annotateSweetfunDisappearances(diff, decisions).tombstones };

test("mixed revision adds one booking and cancels two different bookings atomically", () => {
  const plan = planSweetfunMixedShadow(current, after, config, decisions);
  assert.equal(plan.summary.addedRows, 1);
  assert.equal(plan.summary.addedBookings, 1);
  assert.equal(plan.summary.addedRoomNights, 1);
  assert.equal(plan.summary.removedRows, 2);
  assert.equal(plan.summary.removedBookings, 2);
  assert.equal(plan.summary.removedRoomNights, 2);
  assert.equal(plan.summary.ownerConfirmedCancelled, 2);
  assert.equal(plan.summary.canCutover, false);
  assert.equal(plan.state.readOnly, true);
  assert.equal(plan.state.bookings.find((booking) =>
    booking.sweetfunSnapshot.groupKey === newKey).id, afterIds[newKey]);
  assert.equal(plan.state.sweetfunImport.cancellationTombstones.length, 2);
  assert.equal(verifySweetfunShadow(after, config, plan.state).matches, true);
});

test("mixed revision refuses one unconfirmed cancellation or altered old row", () => {
  assert.throws(() => planSweetfunMixedShadow(current, after, config,
    [decisions[0]]), /SWEETFUN_SHADOW_MIXED_DECISION_DRIFT/);
  const changed = structuredClone(after);
  changed.rows[0].values[6] = "1300";
  const changedDiff = diffSweetfunSnapshots(before, changed);
  const changedDecisions = decisions.map((item) => ({ ...item,
    afterHash: changedDiff.afterHash }));
  assert.throws(() => planSweetfunMixedShadow(current, changed,
    { ...config, expectedSourceHash: changedDiff.afterHash,
      cancellationTombstones: annotateSweetfunDisappearances(changedDiff,
        changedDecisions).tombstones }, changedDecisions),
  /SWEETFUN_SHADOW_MIXED_SOURCE_DRIFT/);
});

test("mixed revision refuses reusing a cancelled room-night for a new booking", () => {
  const reassigned = structuredClone(after);
  reassigned.rows[1].values[0] = "202";
  reassigned.rows[1].values[3] = "2026/12/13";
  reassigned.rows[1].values[4] = "2026/12/14";
  const reassignedDiff = diffSweetfunSnapshots(before, reassigned);
  const reassignedDecisions = decisions.map((item) => ({ ...item,
    afterHash: reassignedDiff.afterHash }));
  const reassignedConfig = { ...config, expectedSourceHash: reassignedDiff.afterHash,
    cancellationTombstones: annotateSweetfunDisappearances(reassignedDiff,
      reassignedDecisions).tombstones };
  assert.throws(() => planSweetfunMixedShadow(current, reassigned,
    reassignedConfig, reassignedDecisions),
  /SWEETFUN_SHADOW_MIXED_OCCUPANCY_DRIFT/);
});
