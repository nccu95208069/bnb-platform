import test from "node:test";
import assert from "node:assert/strict";
import { auditSweetfunSnapshot, SWEETFUN_HEADERS, verifySweetfunAudit } from
  "../src/sweetfun-sheet-audit.mjs";

function row(rowNumber, { room = "101", checkIn, checkOut, fee = "1,200.50",
  id, parent = "", paid = "not_yet", check = "OK" }) {
  const values = Array(19).fill("");
  values[0] = room;
  values[1] = "Synthetic guest";
  values[2] = "synthetic channel";
  values[3] = checkIn;
  values[4] = checkOut;
  values[5] = "2026-10-01";
  values[6] = fee;
  values[7] = paid;
  values[8] = check;
  values[9] = id;
  values[11] = parent;
  return { rowNumber, values };
}

test("audits each source night without inventing receipts or parent orders", () => {
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [
    row(2, { checkIn: "2026/10/20", checkOut: "2026/10/21", id: "n1", parent: "p1", paid: "done" }),
    row(3, { checkIn: "2026/10/21", checkOut: "2026/10/22", id: "n2", parent: "p1" }),
    row(4, { room: "202", checkIn: "2026/10/20", checkOut: "2026/10/21", id: "n3" }),
  ] };
  const result = auditSweetfunSnapshot(snapshot);
  assert.equal(result.summary.sourceRows, 3);
  assert.equal(result.summary.uniqueSourceIds, 3);
  assert.equal(result.summary.blankParentAliases, 1);
  assert.equal(result.summary.multiRowParentAliases, 1);
  assert.equal(result.summary.roomDateKeysObserved, 3);
  assert.equal(result.summary.roomFeeCents, "360150");
  assert.equal(result.summary.paymentEventsCreated, 0);
  assert.deepEqual(result.summary.issues, {});
  assert.equal(result.summary.canCutover, false);
  assert.equal(verifySweetfunAudit(snapshot, result).matches, true);
  result.records[0].roomFeeCents++;
  assert.equal(verifySweetfunAudit(snapshot, result).changed, 1);
  result.records[0].roomFeeCents--;
  snapshot.rows[0].values[1] = "Another synthetic guest";
  assert.equal(verifySweetfunAudit(snapshot, result).sourceUnchanged, false);
  assert.equal(verifySweetfunAudit(snapshot, result).matches, false);
});

test("blocks duplicate source IDs and conflicting room nights on both rows", () => {
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [
    row(2, { checkIn: "2026-11-01", checkOut: "2026-11-02", id: "same" }),
    row(3, { checkIn: "2026-11-01", checkOut: "2026-11-02", id: "same" }),
    row(4, { room: "999", checkIn: "2026-02-30", checkOut: "2026-03-01",
      fee: "unknown", id: "bad", paid: "maybe", check: "" }),
  ] };
  const result = auditSweetfunSnapshot(snapshot);
  assert.deepEqual(result.summary.issues.SOURCE_ID_DUPLICATE.rows, [2, 3]);
  assert.deepEqual(result.summary.issues.ROOM_NIGHT_CONFLICT.rows, [2, 3]);
  assert.deepEqual(result.summary.issues.ROOM_UNKNOWN.rows, [4]);
  assert.deepEqual(result.summary.issues.DATE_INVALID.rows, [4]);
  assert.deepEqual(result.summary.issues.ROOM_FEE_INVALID.rows, [4]);
  assert.equal(result.summary.roomFeeCents, null);
  assert.equal(result.summary.canCutover, false);
});

test("rejects changed headers and incomplete row ordering", () => {
  const valid = row(3, { checkIn: "2026-11-01", checkOut: "2026-11-02", id: "n1" });
  assert.throws(() => auditSweetfunSnapshot({
    headers: [...SWEETFUN_HEADERS.slice(0, 6), "費用", ...SWEETFUN_HEADERS.slice(7)],
    rows: [valid],
  }), /INVALID_SWEETFUN_SNAPSHOT/);
  assert.throws(() => auditSweetfunSnapshot({
    headers: [...SWEETFUN_HEADERS], rows: [valid, { ...valid, rowNumber: 2 }],
  }), /UNORDERED_SWEETFUN_ROWS/);
});

test("keeps source booking date separate from the room night", () => {
  const a = row(2, { checkIn: "2026-11-01", checkOut: "2026-11-02", id: "j1" });
  a.values[5] = "invalid";
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [a] };
  const audit = auditSweetfunSnapshot(snapshot);
  assert.deepEqual(audit.summary.issues.BOOKED_DATE_INVALID.rows, [2]);
  assert.equal(audit.records[0].bookedAt, null);
  a.values[5] = "2026-10-01";
  assert.equal(verifySweetfunAudit(snapshot, audit).matches, false);
});
