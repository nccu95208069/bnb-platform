import test from "node:test";
import assert from "node:assert/strict";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { annotateSweetfunDisappearances, diffSweetfunSnapshots, verifySweetfunDiff } from
  "../src/sweetfun-sheet-delta.mjs";

function row(rowNumber, id, fee = "1200") {
  const values = Array(19).fill("");
  Object.assign(values, { 0: "101", 1: "Synthetic guest", 2: "OTA", 3: "2026-11-01",
    4: "2026-11-02", 5: "2026-10-01", 6: fee, 7: "not_yet", 8: "OK", 9: id });
  return { rowNumber, values };
}

function snapshot(rows) { return { headers: [...SWEETFUN_HEADERS], rows }; }

test("detects appearance, disappearance, movement and changed cells by J", () => {
  const before = snapshot([row(2, "old"), row(3, "moved"), row(4, "changed")]);
  const after = snapshot([row(2, "moved"), row(3, "changed", "1300"), row(4, "new")]);
  const diff = diffSweetfunSnapshots(before, after);
  assert.deepEqual(diff.summary, { beforeRows: 3, afterRows: 3, appeared: 1,
    disappeared: 1, moved: 2, changed: 1, blockingIssues: [],
    complete: true, canApply: false, canCutover: false });
  assert.deepEqual(diff.changes.find((c) => c.sourceId === "changed").changedColumns, [6]);
  assert.equal(diff.changes.find((c) => c.sourceId === "old").kind, "disappeared");
  assert.equal(verifySweetfunDiff(before, after, diff).matches, true);
  diff.changes.pop();
  assert.equal(verifySweetfunDiff(before, after, diff).matches, false);
});

test("fails closed on missing or duplicated J in either snapshot", () => {
  const before = snapshot([row(2, "a"), row(3, "a")]);
  const after = snapshot([row(2, "")]);
  const diff = diffSweetfunSnapshots(before, after);
  assert.equal(diff.summary.complete, false);
  assert.deepEqual(diff.summary.blockingIssues,
    ["AFTER_SOURCE_ID_MISSING", "BEFORE_SOURCE_ID_DUPLICATE"]);
  assert.deepEqual(diff.changes, []);
});

test("normalizes trailing empty cells but detects a modified source snapshot", () => {
  const before = snapshot([row(2, "a")]);
  const after = structuredClone(before);
  after.rows[0].values = after.rows[0].values.slice(0, 10);
  const diff = diffSweetfunSnapshots(before, after);
  assert.equal(diff.summary.changed, 0);
  assert.equal(diff.changes.length, 0);
  before.rows[0].values[6] = "1500";
  assert.equal(verifySweetfunDiff(before, after, diff).beforeUnchanged, false);
});

test("detects a note-only change on an existing source row", () => {
  const before = snapshot([row(2, "a")]);
  before.rows[0].notes = Array(19).fill(null);
  const after = structuredClone(before);
  after.rows[0].notes[7] = "Synthetic payment note";
  const diff = diffSweetfunSnapshots(before, after);
  assert.equal(diff.summary.changed, 1);
  assert.deepEqual(diff.changes[0].changedColumns, []);
  assert.deepEqual(diff.changes[0].changedNoteColumns, [7]);
  assert.equal(verifySweetfunDiff(before, after, diff).matches, true);
});

test("requires a version-bound owner decision before creating a cancellation memo", () => {
  const before = snapshot([row(2, "cancelled"), row(3, "unresolved")]);
  const after = snapshot([]);
  const diff = diffSweetfunSnapshots(before, after);
  const undecided = annotateSweetfunDisappearances(diff);
  assert.equal(undecided.tombstones.length, 0);
  assert.deepEqual(undecided.unresolved, ["cancelled", "unresolved"]);
  const decision = { outcome: "cancelled", evidenceType: "owner_attestation",
    evidenceRef: "synthetic-conversation-evidence", beforeHash: diff.beforeHash,
    afterHash: diff.afterHash, sourceIds: ["cancelled"] };
  const annotated = annotateSweetfunDisappearances(diff, [decision]);
  assert.equal(annotated.summary.ownerConfirmedCancelled, 1);
  assert.deepEqual(annotated.unresolved, ["unresolved"]);
  assert.equal(annotated.tombstones[0].writerReceiptVerified, false);
  assert.equal(annotated.summary.canCutover, false);
  assert.throws(() => annotateSweetfunDisappearances(diff,
    [{ ...decision, afterHash: "wrong" }]), /INVALID_SWEETFUN_CANCELLATION_DECISION/);
  assert.throws(() => annotateSweetfunDisappearances(diff,
    [{ ...decision, sourceIds: ["other"] }]), /CANCELLATION_SOURCE_ID_NOT_UNIQUE_DISAPPEARANCE/);
});
