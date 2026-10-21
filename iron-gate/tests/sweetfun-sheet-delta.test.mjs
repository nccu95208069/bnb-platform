import test from "node:test";
import assert from "node:assert/strict";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { annotateSweetfunDisappearances, decisionFromSweetfunCancellationNotice,
  diffSweetfunSnapshots, verifySweetfunDiff } from
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

test("an authenticated writer notification must match the vanished room and night", () => {
  const before = snapshot([row(2, "synthetic-j")]);
  before.rows[0].values[11] = "synthetic-order";
  before.rows[0].values[3] = "2026/11/01";
  before.rows[0].values[4] = "2026/11/02";
  const diff = diffSweetfunSnapshots(before, snapshot([]));
  const body = ["通知時間: 2026-10-21 13:42:55", "處理狀態: ✅ 成功",
    "通知類型: 訂單取消處理成功",
    "訊息: 已成功刪除訂單 synthetic-order 的 1 筆資料", "",
    "詳細資訊:", "  order_id: synthetic-order", "  deleted_count: 1",
    "  deleted_details: 101 (2026-11-01 → 2026-11-02)"].join("\r\n");
  const message = { id: "1a15eb365772fde1", internal_date: "1792590175000",
    payload: { headers: [
      { name: "From", value: "sweet <owner@example.com>" },
      { name: "Subject", value: "[Gmail 訂單系統] ✅ 訂單取消處理成功" },
      { name: "Authentication-Results", value:
        "mx.google.com; dkim=pass header.i=@gmail.com; spf=pass; dmarc=pass header.from=gmail.com" },
    ], parts: [{ mime_type: "text/plain", body: { content: body } }] } };
  const decision = decisionFromSweetfunCancellationNotice(diff, "synthetic-j", message,
    "owner@example.com");
  const annotated = annotateSweetfunDisappearances(diff, [decision]);
  assert.equal(annotated.summary.writerReceiptVerified, 1);
  assert.equal(annotated.summary.ownerConfirmedCancelled, 0);
  assert.equal(annotated.unresolved.length, 0);
  const wrongNight = structuredClone(message);
  wrongNight.payload.parts[0].body.content = body.replace("2026-11-02", "2026-11-03");
  assert.throws(() => decisionFromSweetfunCancellationNotice(diff, "synthetic-j",
    wrongNight, "owner@example.com"), /UNVERIFIED/);
  const wrongAuth = structuredClone(message);
  wrongAuth.payload.headers[2].value = "mx.google.com; dkim=fail; spf=pass; dmarc=fail";
  assert.throws(() => decisionFromSweetfunCancellationNotice(diff, "synthetic-j",
    wrongAuth, "owner@example.com"), /UNVERIFIED/);
});
