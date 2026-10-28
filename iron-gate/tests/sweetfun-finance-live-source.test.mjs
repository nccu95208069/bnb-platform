import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { auditSweetfunFinanceSources } from "../scripts/audit-sweetfun-finance-sources.mjs";
import { legacySweetfunIds } from "../src/sweetfun-sheet-candidate.mjs";
import { planSweetfunFinanceLinks } from "../src/sweetfun-finance-link.mjs";

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
  const sourceId = "sweetfun-operations-sheet-v1";
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
  const sheetMap = { sourceId, sheetSourceId: "synthetic-sheet-file", rows: [
    { sourceJ: "synthetic-j1", parentL: "synthetic-l1", markerH: "done",
      noteH: "confirmed synthetic-request" },
    { sourceJ: "synthetic-j2", parentL: lineParent, markerH: "not_yet", noteH: "" },
  ] };
  const projection = { entryId: lineEntry.entry_id, orderId: lineParent,
    kind: "deposit", status: "active", version: 1, amountCents: 100000 };
  return { osRaw, lineRaw, sheetMap, projection };
}

function withIgStatus() {
  const data = fixture();
  const bookingId = "33333333-3333-4333-8333-333333333333";
  const propertyId = "11111111-1111-4111-8111-111111111111";
  const orderId = `IG-${bookingId}`;
  const sourceVersion = createHash("sha256").update(JSON.stringify([
    "iron_gate", bookingId, 3, 10000,
  ])).digest("hex");
  const receipt = { id: "synthetic-ig-status", amount: 0, status_only: true,
    payment_type: "full", payment_method: "other", settles_room: true,
    request_id: "synthetic-ig-request", received_at: "2026-10-20T02:00:00Z",
    created_at: "2026-10-20T02:01:00Z", actor: "synthetic-owner",
    source_version: sourceVersion, booking_version: sourceVersion,
    audit: { schema_version: 1, property_id: "sweetfun", source: "calendar",
      result: "succeeded", action: "calendar_payment_confirmed",
      target_id: "synthetic-ig-status", request_id: "synthetic-ig-request",
      actor_id: "synthetic-owner", at: "2026-10-20T02:01:00Z",
      version_before: 0, version_after: 1,
      source_version: sourceVersion, after: { order_id: orderId,
        source_version: sourceVersion, booking_version: sourceVersion } } };
  data.osRaw.records.push({ key: key(orderId), raw: JSON.stringify({ version: 1,
    receipts: [receipt] }) });
  data.osRaw.records.push({ key: `${key(orderId)}:mission:33333333-3333-4333-8333-333333333333`,
    raw: JSON.stringify({ id: "33333333-3333-4333-8333-333333333333",
      receipt_id: receipt.id, status: "completed" }) });
  const igReadback = { schema: 1, source: "iron_gate", property_key: "sweetfun",
    property_id: propertyId, read_only: true, complete: true,
    as_of_change_seq: 30, captured_at: "2026-10-28T00:00:00.000Z",
    snapshot_hash: "a".repeat(64), bookings: [{ id: bookingId,
      property_id: propertyId, status: "confirmed", version: 3,
      total_cents: 10000 }] };
  return { ...data, igReadback };
}

function shadowFixture(sheetMap, sourceHash) {
  const sourceCopyCreatedAt = "2026-10-21T00:00:00.000Z";
  const rawRow = (row) => {
    const values = Array(19).fill(""), notes = Array(19).fill(null);
    values[7] = row.markerH; values[9] = row.sourceJ;
    values[11] = row.parentL; notes[7] = row.noteH;
    return { values, notes };
  };
  const shadow = { propertyId: "11111111-1111-4111-8111-111111111111",
    readOnly: true, authorityEpoch: 0,
    channel: { ready: false, websiteSalesEnabled: false },
    sweetfunImport: { sourceId: sheetMap.sheetSourceId, sourceHash,
      capturedAt: sourceCopyCreatedAt, quarantined: [] },
    bookings: sheetMap.rows.map((row, index) => ({
      id: `${index + 1}`.repeat(8) + "-1111-4111-8111-111111111111",
      paymentEvents: [], sweetfunSnapshot: { rows: [rawRow(row)] } })) };
  const manifest = { propertyId: shadow.propertyId, sheetSourceHash: sourceHash,
    sourceCopyCreatedAt,
    normalizedSourceHash: null };
  return { shadow, manifest };
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

test("IG status-only receipt requires exact authoritative booking readback", () => {
  const data = withIgStatus();
  assert.throws(() => auditSweetfunFinanceSources(data.osRaw, data.lineRaw,
    data.sheetMap, data.projection), /OS_IG_BOOKING_EVIDENCE_REQUIRED/);
  const result = auditSweetfunFinanceSources(data.osRaw, data.lineRaw,
    data.sheetMap, data.projection, data.igReadback);
  assert.equal(result.report.osReceipts, 3);
  assert.equal(result.report.statusOnlyReceipts, 2);
  assert.equal(result.report.statusOnlySheetReceipts, 1);
  assert.equal(result.report.statusOnlyNotesMatched, 1);
  assert.equal(result.report.igStatusOnlyVerified, 1);
  assert.deepEqual(result.report.issueCodes, []);
  for (const mutate of [
    proof => { proof.bookings = []; },
    proof => { proof.bookings[0].property_id = "22222222-2222-4222-8222-222222222222"; },
    proof => { proof.bookings[0].status = "cancelled"; },
    proof => { proof.bookings[0].version = 4; },
    proof => { proof.bookings.push(structuredClone(proof.bookings[0])); },
    proof => { proof.complete = false; },
  ]) {
    const invalid = structuredClone(data.igReadback);
    mutate(invalid);
    assert.throws(() => auditSweetfunFinanceSources(data.osRaw, data.lineRaw,
      data.sheetMap, data.projection, invalid),
    /OS_IG_BOOKING_EVIDENCE_(INVALID|MISMATCH)/);
  }
  const money = structuredClone(data.osRaw);
  const ledger = money.records.find(row => row.key === key(`IG-33333333-3333-4333-8333-333333333333`));
  const parsed = JSON.parse(ledger.raw);
  parsed.receipts[0].status_only = false;
  parsed.receipts[0].amount = 100;
  ledger.raw = JSON.stringify(parsed);
  assert.throws(() => auditSweetfunFinanceSources(money, data.lineRaw,
    data.sheetMap, data.projection, data.igReadback), /OS_IG_MONEY_RECEIPT_REVIEW/);
  const changedAudit = structuredClone(data.osRaw);
  const changedLedger = changedAudit.records.find(row => row.key ===
    key(`IG-33333333-3333-4333-8333-333333333333`));
  const stale = JSON.parse(changedLedger.raw);
  stale.receipts[0].audit.version_after = 2;
  changedLedger.raw = JSON.stringify(stale);
  assert.throws(() => auditSweetfunFinanceSources(changedAudit, data.lineRaw,
    data.sheetMap, data.projection, data.igReadback), /OS_IG_BOOKING_EVIDENCE_MISMATCH/);
  const missingMission = structuredClone(data.osRaw);
  missingMission.records.pop();
  assert.throws(() => auditSweetfunFinanceSources(missingMission, data.lineRaw,
    data.sheetMap, data.projection, data.igReadback),
  /OS_MISSION_RECEIPT_COVERAGE_MISMATCH/);
});

test("links each source claim to one shadow booking and keeps property expense separate", () => {
  const data = fixture();
  const rawSources = [data.osRaw, data.lineRaw, data.sheetMap, data.projection];
  const sourceHash = "a".repeat(64);
  const { shadow, manifest } = shadowFixture(data.sheetMap, sourceHash);
  manifest.normalizedSourceHash = auditSweetfunFinanceSources(...rawSources).report.sourceHash;
  const plan = planSweetfunFinanceLinks(rawSources, shadow, manifest);
  assert.equal(plan.report.linkedClaims, 4);
  assert.equal(plan.report.propertyClaims, 1);
  assert.equal(plan.report.unresolvedClaims, 0);
  assert.equal(plan.report.paymentEventsCreated, 0);
  assert.equal(plan.report.canCutover, false);
  assert.ok(plan.bindings.every((binding) => binding.externalSettlement === "unverified"));
  const quarantined = structuredClone(shadow);
  quarantined.sweetfunImport.quarantined.push({
    rows: quarantined.bookings.pop().sweetfunSnapshot.rows });
  const blocked = planSweetfunFinanceLinks(rawSources, quarantined, manifest);
  assert.equal(blocked.report.unresolvedClaims, 2);
  assert.ok(blocked.unresolved.every((item) => item.reason === "QUARANTINED_SOURCE_ROW"));
  assert.throws(() => planSweetfunFinanceLinks(rawSources,
    { ...shadow, sweetfunImport: { ...shadow.sweetfunImport, sourceHash: "b".repeat(64) } },
    manifest), /FINANCE_LINK_SHADOW_MISMATCH/);
});
