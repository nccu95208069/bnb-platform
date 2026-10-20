import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { auditSweetfunFinanceSources } from "../scripts/audit-sweetfun-finance-sources.mjs";
import { legacySweetfunIds } from "../src/sweetfun-sheet-candidate.mjs";

const fs = (value) => {
  if (Array.isArray(value)) return { arrayValue: { values: value.map(fs) } };
  if (value && typeof value === "object") return { mapValue: { fields:
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fs(item)])) } };
  if (typeof value === "number") return { integerValue: String(value) };
  if (typeof value === "boolean") return { booleanValue: value };
  return { stringValue: String(value) };
};
const doc = (value) => ({ fields: Object.fromEntries(Object.entries(value)
  .map(([key, item]) => [key, fs(item)])) });
const key = (id) => `sweetfun-os:payments:v1:sweetfun:${createHash("sha256")
  .update(JSON.stringify(id)).digest("hex")}`;

function fixture() {
  const sourceId = "synthetic-sheet-source";
  const lineParent = "V2-synthetic-order";
  const firstOrder = legacySweetfunIds(sourceId, "synthetic-j1", "synthetic-l1").orderId;
  const lineOrder = legacySweetfunIds(sourceId, "synthetic-j2", lineParent).orderId;
  const receipt = (id, orderId, amount, statusOnly, requestId) => ({ id, amount,
    status_only: statusOnly, request_id: requestId,
    received_at: "2026-10-20T02:00:00Z",
    audit: { target_id: id, request_id: requestId,
      after: { order_id: orderId } } });
  const finance = { version: 1, operations: [{ id: "synthetic-op" }], entries: [
    { id: "synthetic-manual", source: "manual", kind: "income", status: "active",
      category: "lodging", amount_cents: 20000, date: "2026-10-20",
      allocations: [{ order_id: firstOrder, amount_cents: 20000 }] },
    { id: "synthetic-expense", source: "manual", kind: "expense", status: "active",
      amount_cents: 5000, date: "2026-10-20" },
  ] };
  const osRaw = { schema: 1, records: [
    { key: "sweetfun-os:finance:v1:sweetfun:2026", raw: JSON.stringify(finance) },
    { key: key(firstOrder), raw: JSON.stringify({ version: 1, receipts: [
      receipt("synthetic-status", firstOrder, 0, true, "synthetic-request") ] }) },
    { key: key(lineOrder), raw: JSON.stringify({ version: 1, receipts: [
      receipt("synthetic-cash", lineOrder, 100, false, "synthetic-cash-request") ] }) },
    { key: `${key(firstOrder)}:mission:11111111-1111-4111-8111-111111111111`,
      raw: JSON.stringify({ id: "11111111-1111-4111-8111-111111111111",
        receipt_id: "synthetic-status", status: "completed" }) },
    { key: `${key(lineOrder)}:mission:22222222-2222-4222-8222-222222222222`,
      raw: JSON.stringify({ id: "22222222-2222-4222-8222-222222222222",
        receipt_id: "synthetic-cash", status: "completed" }) },
  ] };
  const lineEntry = { entry_id: "synthetic-line-entry", order_id: lineParent,
    kind: "deposit", status: "active", version: 1, amount: 1000,
    paid_on: "2026-10-21" };
  const lineRaw = { schema: 1, collections: {
    entries: [doc(lineEntry)], versions: [doc(lineEntry)],
    operations: [doc({ confirmation: { id: "synthetic-line-operation" },
      status: "recorded", result: { status: "recorded", entry: lineEntry,
        projection_sequence: 1 } })],
    events: [doc({ operation_id: "synthetic-line-operation" })],
    audit: [doc({ after: lineEntry, operation_id: "synthetic-line-operation",
      sequence: 1 })],
    outbox: [doc({ entry: lineEntry, digest: "synthetic-digest", sequence: 1,
      operation_id: "synthetic-line-operation" })],
    projection_receipts: [doc({ digest: "synthetic-digest", sequence: 1 })],
  } };
  const sheetMap = { sourceId, rows: [
    { sourceJ: "synthetic-j1", parentL: "synthetic-l1", markerH: "done",
      noteH: "confirmed synthetic-request" },
    { sourceJ: "synthetic-j2", parentL: lineParent, markerH: "not_yet", noteH: "" },
  ] };
  const projection = { entryId: lineEntry.entry_id, orderId: lineParent,
    kind: "deposit", status: "active", version: 1, amountCents: 100000 };
  return { osRaw, lineRaw, sheetMap, projection };
}

test("live finance evidence counts source claims once and links two order aliases", () => {
  const { osRaw, lineRaw, sheetMap, projection } = fixture();
  const result = auditSweetfunFinanceSources(osRaw, lineRaw, sheetMap, projection);
  assert.equal(result.report.osReceipts, 2);
  assert.equal(result.report.statusOnlyNotesMatched, 1);
  assert.equal(result.report.orphanManualAllocations, 0);
  assert.equal(result.report.lineSourceOrderLinked, true);
  assert.equal(result.report.manualIncomeCents, "20000");
  assert.equal(result.report.calendarReceiptCents, "10000");
  assert.equal(result.report.lineIncomeCents, "100000");
  assert.deepEqual(result.report.issueCodes, []);
  assert.equal(result.report.paymentEventsCreated, 0);
  assert.equal(result.candidate.nonCash.statusOnlyReceipts.length, 1);
  assert.equal(result.candidate.nonCash.calendarProjections.length, 1);
});

test("live finance evidence rejects altered LINE projection and OS ledger identity", () => {
  const data = fixture();
  assert.throws(() => auditSweetfunFinanceSources(data.osRaw, data.lineRaw,
    data.sheetMap, { ...data.projection, amountCents: 99900 }),
  /LINE_SOURCE_PROJECTION_MISMATCH/);
  const changed = structuredClone(data.osRaw);
  changed.records.find((record) => record.key.includes(":payments:") &&
    !record.key.includes(":mission:")).key =
    "sweetfun-os:payments:v1:sweetfun:" + "a".repeat(64);
  assert.throws(() => auditSweetfunFinanceSources(changed, data.lineRaw,
    data.sheetMap, data.projection), /OS_RECEIPT_LEDGER_KEY_MISMATCH/);
  const missingMission = structuredClone(data.osRaw);
  missingMission.records.pop();
  assert.throws(() => auditSweetfunFinanceSources(missingMission, data.lineRaw,
    data.sheetMap, data.projection), /OS_MISSION_RECEIPT_COVERAGE_MISMATCH/);
  const changedOperation = structuredClone(data.lineRaw);
  changedOperation.collections.operations[0].fields.status.stringValue = "failed";
  assert.throws(() => auditSweetfunFinanceSources(data.osRaw, changedOperation,
    data.sheetMap, data.projection), /LINE_SOURCE_PROJECTION_MISMATCH/);
});
