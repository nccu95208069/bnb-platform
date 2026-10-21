import test from "node:test";
import assert from "node:assert/strict";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { prepareSweetfunGroups } from "../src/sweetfun-sheet-candidate.mjs";
import { prepareSweetfunShadow } from "../src/sweetfun-shadow.mjs";
import { prepareSweetfunSourceLinks } from "../src/sweetfun-source-links.mjs";

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const roomNames = ["101", "102", "201", "202", "301", "302"];
const roomIds = Object.fromEntries(roomNames.map((name, i) => [name, uid(10 + i)]));

function row(rowNumber, j, l, room, checkIn) {
  const values = Array(19).fill("");
  Object.assign(values, { 0: room, 1: "Synthetic guest", 2: "AI",
    3: checkIn, 4: "2026/11/02", 5: "2026/10/01", 6: "1200",
    7: "not_yet", 8: "OK", 9: j, 11: l });
  return { rowNumber, values, notes: Array(19).fill(null) };
}

function shadow() {
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [
    row(2, "j1", "platform-1", "101", "2026/11/01"),
    row(3, "j2", "", "102", "2026/11/01"),
  ] };
  const config = { workspaceId: uid(1), propertyId: uid(2), roomIds,
    sourceId: "synthetic-sheet", capturedAt: "2026-10-20T00:00:00.000Z",
    expectedSourceHash: prepareSweetfunGroups(snapshot).sourceHash,
    inventoryVersion: 1, authorityEpoch: 0,
    bookingIds: { "L:platform-1": uid(100), "J:j2": uid(101) } };
  return prepareSweetfunShadow(snapshot, config).state;
}

test("final source identity keeps imported UUIDs and known cancellation tombstones read-only", () => {
  const current = shadow();
  const cancelled = row(4, "j-cancelled", "platform-cancelled", "202", "2026/11/01");
  current.sweetfunImport.cancellationTombstones = [{ sourceId: "j-cancelled",
    before: cancelled, beforeHash: "a".repeat(64), afterHash: "b".repeat(64),
    evidenceType: "owner_attestation" }];
  const planned = prepareSweetfunSourceLinks(current, "sweetfun-calendar-sheet", "synthetic-sheet");
  assert.deepEqual(planned.summary, { activeLinks: 2, cancelledLinks: 1,
    sourceHash: current.sweetfunImport.sourceHash, readOnly: true, canCutover: false });
  assert.deepEqual(current.sourceLinks, []);
  assert.equal(planned.state.readOnly, true);
  assert.equal(planned.state.sourceLinks.length, 3);
  const imported = planned.state.sourceLinks.find((item) => item.externalOrderId === "L:platform-1");
  assert.equal(imported.bookingId, uid(100));
  assert.equal(imported.lastAppliedBookingVersion, 1);
  assert.match(imported.sourceVersion, /^sheet-v1:[0-9a-f]{64}$/);
  const tombstone = planned.state.sourceLinks.find((item) =>
    item.externalOrderId === "L:platform-cancelled");
  assert.equal(tombstone.bookingId, null);
  assert.deepEqual(tombstone.tombstoneNights,
    [{ roomId: roomIds["202"], date: "2026-11-01" }]);
});

test("source identity preparation refuses changed groups or authority already open", () => {
  const current = shadow();
  current.bookings[0].sweetfunSnapshot.rows[0].values[11] = "another-order";
  assert.throws(() => prepareSweetfunSourceLinks(current, "sweetfun-calendar-sheet", "synthetic-sheet"),
    /SWEETFUN_SOURCE_GROUP_ID_DRIFT/);
  const writable = shadow();
  writable.readOnly = false;
  assert.throws(() => prepareSweetfunSourceLinks(writable, "sweetfun-calendar-sheet", "synthetic-sheet"),
    /UNSAFE_SWEETFUN_SOURCE_LINK_PREPARATION/);
  assert.throws(() => prepareSweetfunSourceLinks(shadow(), "sweetfun-calendar-sheet", "other-sheet"),
    /UNSAFE_SWEETFUN_SOURCE_LINK_PREPARATION/);
});
