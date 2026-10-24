import test from "node:test";
import assert from "node:assert/strict";
import { verifySweetfunOsFinanceDelta, verifySweetfunOsReceiptAppend,
  verifySweetfunOsSheetSync } from "../src/sweetfun-os-writer-delta.mjs";

const clone = (value) => structuredClone(value);
function sample() {
  const before = { version: 0, entries: [], operations: [] };
  const entry = { id: "entry-synthetic", property_id: "sweetfun", kind: "income",
    source: "manual", amount_cents: 10000, status: "active" };
  const id = "request-synthetic", at = "2026-10-21T07:00:00.000Z";
  const event = { schema_version: 1, id, request_id: id, property_id: "sweetfun",
    action: "income_created", actor_id: "actor-synthetic", at,
    source: "finance", result: "succeeded", target_type: "entry",
    target_id: entry.id, before: null, after: clone(entry),
    changed_fields: Object.keys(entry), version_before: 0, version_after: 1,
    completeness: "complete" };
  const after = { version: 1, entries: [entry], operations: [{ id, hash: "request-hash",
    entry_id: entry.id, at, actor: "actor-synthetic", event }] };
  return { before, after };
}

test("one OS finance operation proves its version, target and audit snapshot", () => {
  const { before, after } = sample();
  const receipt = verifySweetfunOsFinanceDelta(JSON.stringify(before),
    JSON.stringify(after), "sweetfun", 2026);
  assert.equal(receipt.action, "income_created");
  assert.equal(receipt.versionAfter, 1);
  assert.equal(receipt.requestHash.length, 64);
});

test("OS finance delta rejects unrecorded side changes or a forged audit", () => {
  const { before, after } = sample();
  const sideChange = clone(after);
  sideChange.payment_accounts = [{ id: "extra" }];
  assert.throws(() => verifySweetfunOsFinanceDelta(before, sideChange,
    "sweetfun", 2026), /OS_WRITER_DELTA_UNVERIFIED/);
  const wrongSnapshot = clone(after);
  wrongSnapshot.entries[0].amount_cents++;
  assert.throws(() => verifySweetfunOsFinanceDelta(before, wrongSnapshot,
    "sweetfun", 2026), /OS_WRITER_DELTA_UNVERIFIED/);
  const wrongActor = clone(after);
  wrongActor.operations[0].event.actor_id = "someone-else";
  assert.throws(() => verifySweetfunOsFinanceDelta(before, wrongActor,
    "sweetfun", 2026), /OS_WRITER_DELTA_UNVERIFIED/);
});

test("OS finance delta rejects skipped versions and altered earlier operations", () => {
  const { before, after } = sample();
  const skipped = clone(after);
  skipped.version = 2;
  assert.throws(() => verifySweetfunOsFinanceDelta(before, skipped,
    "sweetfun", 2026), /OS_WRITER_DELTA_UNVERIFIED/);
  const first = clone(after), next = clone(after);
  next.version = 2;
  next.operations[0].hash = "changed-history";
  next.operations.push({ ...clone(after.operations[0]), id: "another-request" });
  assert.throws(() => verifySweetfunOsFinanceDelta(first, next,
    "sweetfun", 2026), /OS_WRITER_DELTA_UNVERIFIED/);
});

function receiptSample() {
  const receipt = { id: "receipt-synthetic", amount: 100, status_only: false,
    actor: "actor-synthetic", request_id: "request-synthetic",
    request_hash: "hash-synthetic", mission_id: "mission-synthetic",
    source_version: "source-synthetic", created_at: "2026-10-21T07:00:00.000Z",
    sheet_sync: { state: "pending", paid: true,
      targets: [{ uid: "row-synthetic", fingerprint: "fingerprint-synthetic" }] } };
  const audited = { ...receipt };
  delete audited.sheet_sync;
  delete audited.request_hash;
  receipt.audit = { schema_version: 1, id: receipt.request_id,
    request_id: receipt.request_id, property_id: "sweetfun",
    action: "calendar_payment_recorded", actor_id: receipt.actor,
    at: receipt.created_at, source: "calendar", result: "succeeded",
    target_type: "receipt", target_id: receipt.id, before: null,
    after: { ...audited, order_id: "ORDER-SYNTHETIC" },
    changed_fields: [...Object.keys(audited), "order_id"],
    version_before: 0, version_after: 1, completeness: "complete" };
  const before = { version: 0, receipts: [] };
  const after = { version: 1, receipts: [receipt] };
  const mission = { id: receipt.mission_id, receipt_id: receipt.id,
    actor: receipt.actor, status: "verification_pending" };
  return { before, after, mission };
}

test("OS receipt append requires matching audited receipt and mission", () => {
  const { before, after, mission } = receiptSample();
  const result = verifySweetfunOsReceiptAppend(before, after, mission,
    "sweetfun", "ORDER-SYNTHETIC");
  assert.equal(result.sheetPending, true);
  const wrongMission = { ...mission, receipt_id: "wrong" };
  assert.throws(() => verifySweetfunOsReceiptAppend(before, after, wrongMission,
    "sweetfun", "ORDER-SYNTHETIC"), /OS_WRITER_DELTA_UNVERIFIED/);
  const wrongAudit = clone(after);
  wrongAudit.receipts[0].audit.after.amount = 999;
  assert.throws(() => verifySweetfunOsReceiptAppend(before, wrongAudit, mission,
    "sweetfun", "ORDER-SYNTHETIC"), /OS_WRITER_DELTA_UNVERIFIED/);
});

test("OS Sheet sync verifies only the pending receipt transitions", () => {
  const { after: before, mission } = receiptSample();
  const after = clone(before);
  after.version = 2;
  after.receipts[0].sheet_sync = { ...after.receipts[0].sheet_sync,
    state: "verified", verified_at: "2026-10-21T07:01:00.000Z" };
  const completed = { ...mission, status: "completed", sheet_write: true,
    steps: ["check_order", "record_payment", "verify_receipt",
      "update_main_sheet", "verify_main_sheet"] };
  assert.equal(verifySweetfunOsSheetSync(before, after, completed,
    "sweetfun", "receipt-synthetic").versionAfter, 2);
  const changed = clone(after);
  changed.receipts[0].amount = 200;
  assert.throws(() => verifySweetfunOsSheetSync(before, changed, completed,
    "sweetfun", "receipt-synthetic"), /OS_WRITER_DELTA_UNVERIFIED/);
});
