import test from "node:test";
import assert from "node:assert/strict";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { legacySweetfunIds, prepareSweetfunGroups, verifySweetfunGroups } from
  "../src/sweetfun-sheet-candidate.mjs";
import { adaptSheetBookings } from "../../frontend/src/lib/booking-sources/sweetfun-sheet.ts";

function row(rowNumber, id, parent, room, checkIn, options = {}) {
  const values = Array(19).fill("");
  Object.assign(values, { 0: room, 1: options.guest ?? "Synthetic guest", 2: "OTA",
    3: checkIn, 4: options.checkOut ?? "2026-11-02", 5: "2026-10-01",
    6: options.fee ?? "1,200.50", 7: "not_yet", 8: "OK", 9: id,
    11: parent, 13: options.ota ?? "" });
  return { rowNumber, values };
}

test("groups only by an explicit parent alias, preserving every original row", () => {
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [
    row(2, "j1", "l1", "101", "2026-11-01"),
    row(3, "j2", "l1", "102", "2026-11-01"),
    row(4, "j3", "", "201", "2026-11-01"),
    row(5, "j4", "", "202", "2026-11-01"),
  ] };
  const prepared = prepareSweetfunGroups(snapshot);
  assert.deepEqual(prepared.candidates.map((item) => item.key), ["L:l1", "J:j3", "J:j4"]);
  assert.deepEqual(prepared.candidates[0].rows.map(({ sourceId, room, checkIn, checkOut,
    bookedAt, platform, otaAlias, roomFeeCents }) => ({ sourceId, room, checkIn, checkOut,
    bookedAt, platform, otaAlias, roomFeeCents })), [
    { sourceId: "j1", room: "101", checkIn: "2026-11-01", checkOut: "2026-11-02",
      bookedAt: "2026-10-01", platform: "OTA", otaAlias: "", roomFeeCents: 120050 },
    { sourceId: "j2", room: "102", checkIn: "2026-11-01", checkOut: "2026-11-02",
      bookedAt: "2026-10-01", platform: "OTA", otaAlias: "", roomFeeCents: 120050 },
  ]);
  assert.equal(prepared.candidates[0].roomFeeCents, "240100");
  assert.equal(prepared.summary.sourceRows, 4);
  assert.equal(prepared.summary.paymentEventsCreated, 0);
  assert.equal(prepared.summary.canCutover, false);
  assert.equal(verifySweetfunGroups(snapshot, prepared).matches, true);
  prepared.candidates[0].rows[0].values[1] = "Changed guest";
  assert.equal(verifySweetfunGroups(snapshot, prepared).matches, false);
});

test("flags ambiguous parents, missing parent alias, and room conflicts", () => {
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [
    row(2, "j1", "l1", "101", "2026-11-01"),
    row(3, "j2", "l1", "101", "2026-11-01", { guest: "Other synthetic guest" }),
    row(4, "j3", "", "201", "2026-11-01", { ota: "ota1" }),
  ] };
  const prepared = prepareSweetfunGroups(snapshot);
  assert.deepEqual(prepared.candidates[0].issues,
    ["PARENT_GUEST_INCONSISTENT", "ROOM_NIGHT_CONFLICT"]);
  assert.deepEqual(prepared.candidates[1].issues, ["OTA_WITHOUT_PARENT_ALIAS"]);
  assert.equal(prepared.summary.flaggedGroups, 2);
});

test("detects an omitted source row and a changed snapshot", () => {
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [
    row(2, "j1", "", "101", "2026-11-01"),
    row(3, "j2", "", "102", "2026-11-01"),
  ] };
  const prepared = prepareSweetfunGroups(snapshot);
  prepared.candidates.pop();
  assert.equal(verifySweetfunGroups(snapshot, prepared).missing, 1);
  const fresh = prepareSweetfunGroups(snapshot);
  snapshot.rows[0].values[6] = "1,300.50";
  assert.equal(verifySweetfunGroups(snapshot, fresh).sourceUnchanged, false);
});

test("preserves source cell notes and rejects a changed payment note", () => {
  const source = row(2, "j1", "l1", "101", "2026-11-01");
  source.notes = Array(19).fill("");
  source.notes[7] = "Synthetic status-only request; zero income";
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [source] };
  const prepared = prepareSweetfunGroups(snapshot);
  assert.equal(prepared.candidates[0].rows[0].notes[7], source.notes[7]);
  assert.equal(prepared.summary.paymentEventsCreated, 0);
  assert.equal(verifySweetfunGroups(snapshot, prepared).matches, true);
  prepared.candidates[0].rows[0].notes[7] = "Changed note";
  assert.equal(verifySweetfunGroups(snapshot, prepared).matches, false);
  const fresh = prepareSweetfunGroups(snapshot);
  source.notes[7] = "Source changed";
  assert.equal(verifySweetfunGroups(snapshot, fresh).sourceUnchanged, false);
});

test("legacy aliases exactly match the existing Sean OS Sheet adapter", () => {
  const sourceId = "sweetfun-operations-sheet-v1";
  const rows = [
    row(2, "j1", "l1", "101", "2026-11-01", { fee: "1200" }),
    row(3, "j2", "", "102", "2026-11-01", { fee: "1200" }),
  ];
  const adapted = adaptSheetBookings([SWEETFUN_HEADERS, ...rows.map(r => r.values)],
    sourceId, "2026-10-20T00:00:00.000Z");
  for (let i = 0; i < rows.length; i++) {
    const ids = legacySweetfunIds(sourceId, rows[i].values[9], rows[i].values[11]);
    assert.equal(ids.rowId, adapted.bookings[i].id);
    assert.equal(ids.orderId, adapted.bookings[i].order_id);
  }
  assert.notEqual(legacySweetfunIds(sourceId, "j1", "l1").orderId,
    legacySweetfunIds(sourceId, "j1", "").orderId);
  assert.throws(() => legacySweetfunIds(sourceId, ""), /INVALID_SWEETFUN_SOURCE_ID/);
});
