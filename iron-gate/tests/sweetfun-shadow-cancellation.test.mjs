import test from "node:test";
import assert from "node:assert/strict";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { prepareSweetfunGroups } from "../src/sweetfun-sheet-candidate.mjs";
import { annotateSweetfunDisappearances, diffSweetfunSnapshots } from
  "../src/sweetfun-sheet-delta.mjs";
import { prepareSweetfunShadow, verifySweetfunShadow } from "../src/sweetfun-shadow.mjs";
import { planSweetfunCancellationShadow } from "../src/sweetfun-shadow-advance.mjs";

function row(number, sourceId, parentId, room, checkIn, checkOut) {
  const values = Array(19).fill("");
  Object.assign(values, { 0: room, 1: "Synthetic guest", 2: "AI",
    3: checkIn, 4: checkOut, 5: "2026/10/01", 6: "1200",
    7: "not_yet", 8: "OK", 9: sourceId, 11: parentId });
  return { rowNumber: number, values, notes: Array(19).fill(null) };
}

const before = { headers: [...SWEETFUN_HEADERS], rows: [
  row(2, "synthetic-cancel-j", "synthetic-cancel-l", "202",
    "2026/10/25", "2026/10/26"),
  row(3, "synthetic-keep-j", "synthetic-keep-l", "101",
    "2026/10/26", "2026/10/27") ] };
const after = { headers: [...SWEETFUN_HEADERS], rows: [
  { ...structuredClone(before.rows[1]), rowNumber: 2 } ] };
const oldGroups = prepareSweetfunGroups(before).candidates;
const cancelledKey = oldGroups.find((group) =>
  group.rows.some((source) => source.values[9] === "synthetic-cancel-j")).key;
const retainedKey = oldGroups.find((group) =>
  group.rows.some((source) => source.values[9] === "synthetic-keep-j")).key;
const fixed = {
  sourceId: "synthetic-original", sourceCopyId: "synthetic-copy-before",
  sourceCopyCreatedAt: "2026-10-20T00:00:00.000Z",
  capturedAt: "2026-10-20T00:00:00.000Z",
  expectedSourceHash: prepareSweetfunGroups(before).sourceHash,
  workspaceId: crypto.randomUUID(), propertyId: crypto.randomUUID(),
  roomIds: Object.fromEntries(["101", "102", "201", "202", "301", "302"]
    .map((room) => [room, crypto.randomUUID()])),
  bookingIds: { [cancelledKey]: crypto.randomUUID(),
    [retainedKey]: crypto.randomUUID() },
  inventoryVersion: 1, authorityEpoch: 0,
};
const diff = diffSweetfunSnapshots(before, after);
const decision = { outcome: "cancelled", evidenceType: "owner_attestation",
  evidenceRef: "synthetic-chat-2026-10-21-1002", beforeHash: diff.beforeHash,
  afterHash: diff.afterHash, sourceIds: ["synthetic-cancel-j"] };
const annotated = annotateSweetfunDisappearances(diff, [decision]);
const nextConfig = { ...fixed, sourceCopyId: "synthetic-copy-after",
  sourceCopyCreatedAt: "2026-10-21T02:10:00.000Z",
  capturedAt: "2026-10-21T02:10:00.000Z",
  expectedSourceHash: prepareSweetfunGroups(after).sourceHash,
  bookingIds: { [retainedKey]: fixed.bookingIds[retainedKey] },
  inventoryVersion: 2, cancellationTombstones: annotated.tombstones };

test("owner-attested cancellation removes exactly one booking and occupied night", () => {
  const current = prepareSweetfunShadow(before, fixed).state;
  const plan = planSweetfunCancellationShadow(current, after, nextConfig, decision);
  assert.equal(plan.summary.removedRows, 1);
  assert.equal(plan.summary.removedBookings, 1);
  assert.equal(plan.summary.removedRoomNights, 1);
  assert.equal(plan.summary.writerReceiptVerified, false);
  assert.equal(plan.summary.paymentEventsCreated, 0);
  assert.equal(plan.summary.canCutover, false);
  assert.equal(plan.state.readOnly, true);
  assert.equal(plan.state.bookings.length, 1);
  assert.equal(plan.state.bookings[0].id, fixed.bookingIds[retainedKey]);
  assert.equal(plan.removedOccupancy[0].booking_id, fixed.bookingIds[cancelledKey]);
  assert.deepEqual(plan.state.sweetfunImport.cancellationTombstones,
    annotated.tombstones);
  assert.equal(verifySweetfunShadow(after, nextConfig, plan.state).matches, true);
});

test("copies a concurrent plain order-note change without changing occupancy", () => {
  const current = prepareSweetfunShadow(before, fixed).state;
  const withNote = structuredClone(after);
  withNote.rows[0].values[10] = "Synthetic housekeeping note";
  const noteDiff = diffSweetfunSnapshots(before, withNote);
  const noteDecision = { ...decision, afterHash: noteDiff.afterHash };
  const noteConfig = { ...nextConfig, expectedSourceHash: noteDiff.afterHash,
    cancellationTombstones: annotateSweetfunDisappearances(noteDiff,
      [noteDecision]).tombstones };
  const plan = planSweetfunCancellationShadow(current, withNote,
    noteConfig, noteDecision);
  assert.equal(plan.summary.sourceNoteRowsChanged, 1);
  assert.equal(plan.summary.removedRoomNights, 1);
  assert.equal(plan.state.bookings[0].notes, "Synthetic housekeeping note");
});

test("cancellation refuses missing decision, altered source, UUID drift and unsafe state", () => {
  const current = prepareSweetfunShadow(before, fixed).state;
  assert.throws(() => planSweetfunCancellationShadow(current, after,
    nextConfig, { ...decision, sourceIds: ["wrong"] }),
  /CANCELLATION_SOURCE_ID_NOT_UNIQUE_DISAPPEARANCE/);
  assert.throws(() => planSweetfunCancellationShadow(current, after,
    { ...nextConfig, cancellationTombstones: [] }, decision),
  /SWEETFUN_SHADOW_CANCELLATION_DECISION_DRIFT/);
  const changed = structuredClone(after);
  changed.rows[0].notes[7] = "Synthetic payment note";
  assert.throws(() => planSweetfunCancellationShadow(current, changed,
    { ...nextConfig, expectedSourceHash: prepareSweetfunGroups(changed).sourceHash },
    decision), /SWEETFUN_SHADOW_CANCELLATION_SOURCE_DRIFT/);
  assert.throws(() => planSweetfunCancellationShadow(current, after,
    { ...nextConfig, bookingIds: { [retainedKey]: crypto.randomUUID() } },
    decision), /SWEETFUN_SHADOW_BOOKING_ID_DRIFT/);
  const paid = structuredClone(current);
  paid.bookings[0].paymentEvents.push({ id: "synthetic-payment" });
  assert.throws(() => planSweetfunCancellationShadow(paid, after,
    nextConfig, decision), /UNSAFE_SWEETFUN_SHADOW_CANCELLATION/);
});
