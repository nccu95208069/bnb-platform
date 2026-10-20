import test from "node:test";
import assert from "node:assert/strict";
import { prepareSweetfunFinanceClaims, verifySweetfunFinanceClaims } from
  "../src/sweetfun-finance-candidate.mjs";

function fixture() {
  return {
    osEntries: [
      { id: "manual-1", source: "manual", kind: "income", status: "active",
        amountCents: 30000, date: "2026-10-20", allocations: [
          { orderId: "order-a", amountCents: 10000 },
          { orderId: "order-b", amountCents: 20000 } ] },
      { id: "payment:receipt-1", source: "calendar", kind: "income", status: "active",
        amountCents: 5000, date: "2026-10-20" },
    ],
    osReceipts: [
      { id: "receipt-1", orderId: "order-c", amountCents: 5000,
        statusOnly: false, date: "2026-10-20" },
      { id: "status-1", orderId: "order-d", amountCents: 0,
        statusOnly: true, date: "2026-10-20" },
    ],
    lineEntries: [ { entryId: "line-1", kind: "deposit", status: "active",
      amountCents: 7000, version: 1, orderId: "order-e", date: "2026-10-20" } ],
    lineDetailProjections: [ { entryId: "line-1", kind: "deposit", status: "active",
      amountCents: 7000, version: 1 } ],
    sheetMarkers: [ { sourceId: "sheet-j", marker: "done" } ],
  };
}

test("counts source claims once while keeping status and projections noncash", () => {
  const source = fixture();
  const candidate = prepareSweetfunFinanceClaims(source);
  assert.equal(candidate.issues.length, 0);
  assert.deepEqual({ manual: candidate.summary.osManualIncomeCents,
    calendar: candidate.summary.osCalendarReceiptCents,
    line: candidate.summary.lineIncomeCents },
  { manual: "30000", calendar: "5000", line: "7000" });
  assert.equal(candidate.nonCash.calendarProjections.length, 1);
  assert.equal(candidate.nonCash.lineDetailProjections.length, 1);
  assert.equal(candidate.nonCash.statusOnlyReceipts.length, 1);
  assert.equal(candidate.summary.paymentEventsCreated, 0);
  assert.equal(candidate.summary.canStage, false);
  assert.equal(verifySweetfunFinanceClaims(source, candidate).matches, true);
  candidate.claims.lineIncome[0].amountCents = 8000;
  assert.equal(verifySweetfunFinanceClaims(source, candidate).matches, false);
});

test("requires calendar receipts and matching LINE projection; rejects positive status-only", () => {
  const source = fixture();
  source.osEntries[1].amountCents = 6000;
  source.lineDetailProjections[0].amountCents = 8000;
  source.osEntries[0].allocations[1].amountCents = 10000;
  const candidate = prepareSweetfunFinanceClaims(source);
  assert.deepEqual(candidate.issues.map((issue) => issue.code), [
    "MANUAL_ALLOCATION_MISMATCH", "CALENDAR_RECEIPT_UNMATCHED",
    "OS_RECEIPT_WITHOUT_CALENDAR_PROJECTION", "LINE_DETAIL_PROJECTION_MISMATCH",
  ]);
  source.osReceipts[1].amountCents = 100;
  assert.throws(() => prepareSweetfunFinanceClaims(source), /STATUS_ONLY_HAS_AMOUNT/);
});

test("flags matching order allocation across separate ledgers without merging it", () => {
  const source = fixture();
  source.lineEntries[0].orderId = "order-a";
  source.lineEntries[0].amountCents = 10000;
  source.lineDetailProjections[0].amountCents = 10000;
  const result = prepareSweetfunFinanceClaims(source);
  assert.deepEqual(result.issues.map((issue) => issue.code),
    ["POSSIBLE_CROSS_LEDGER_DUPLICATE"]);
  assert.equal(result.claims.manualIncome.length, 1);
  assert.equal(result.claims.lineIncome.length, 1);
  assert.equal(result.summary.canCutover, false);
});
