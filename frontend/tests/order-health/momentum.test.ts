import test from "node:test";
import assert from "node:assert/strict";
import { tablesFromMatrices } from "../../src/lib/order-health/parser.ts";
import { analyze } from "../../src/lib/order-health/engine.ts";
import { buildBookingCohorts, cohortSummary, monthlyView, pacingView, shiftMonth } from "../../src/lib/order-health/momentum.ts";
import type { Answers } from "../../src/lib/order-health/types.ts";
const scope = { kind: "villa" as const };
const headers = ["訂單編號", "入住日期", "退房日期", "金額", "平台", "狀態", "預訂日期"];
const row = (id: string, date: string, end: string, amount: string, booked: string) => [id, date, end, amount, "官網", "已確認", booked];
const report = (rows: string[][], answers: Answers = { unit: "night", money: "total", booked: "yes" }) => analyze({
  id: "synthetic-momentum", sourceHash: "synthetic-momentum", sourceTitle: "合成測試", receptionKind: "villa",
  tables: tablesFromMatrices([{ title: "訂單", matrix: [headers, ...rows] }]), answers,
}, new Date("2026-10-05T09:00:00Z"));

test("anonymous nightly rows retain money and nights without inventing order counts", () => {
  const r = report([row("", "2026-10-01", "2026-10-02", "3000", "2026-09-01"), row("", "2026-10-02", "2026-10-03", "4000", "2026-09-01")]);
  const month = monthlyView(r, scope, "2026-10", "stay");
  assert.equal(month.orders, null);
  assert.equal(month.knownOrders, 0);
  assert.equal(month.unidentifiedRows, 2);
  assert.equal(month.nights, 2);
  assert.equal(month.amount, 7000);
  assert.equal(month.coverage, 100);
  assert.deepEqual(month.refs, ["訂單!2", "訂單!3"]);
});

test("stable ID combines nightly rows once while cross-month money remains allocated per night", () => {
  const r = report([row("one", "2026-09-30", "2026-10-01", "3000", "2026-08-01"), row("one", "2026-10-01", "2026-10-02", "4000", "2026-08-01")]);
  assert.equal(monthlyView(r, scope, "2026-09", "stay").orders, 1);
  assert.equal(monthlyView(r, scope, "2026-10", "stay").orders, 1);
  assert.equal(monthlyView(r, scope, "2026-09", "stay").amount, 3000);
  assert.equal(monthlyView(r, scope, "2026-10", "stay").amount, 4000);
  const booked = monthlyView(r, scope, "2026-08", "booked");
  assert.equal(booked.orders, 1);
  assert.equal(booked.amount, 7000);
  assert.equal(booked.ticket, null);
});

test("partial IDs produce partial counts without changing included revenue", () => {
  const r = report([row("one", "2026-10-01", "2026-10-02", "3000", "2026-09-01"), row("", "2026-10-02", "2026-10-03", "4000", "2026-09-01")]);
  const m = monthlyView(r, scope, "2026-10", "stay");
  assert.equal(m.orders, null);
  assert.equal(m.knownOrders, 1);
  assert.equal(m.amount, 7000);
});

test("stay month and booking month intentionally include different orders and amounts", () => {
  const r = report([row("a", "2026-10-10", "2026-10-12", "9000", "2026-09-22"), row("b", "2026-11-04", "2026-11-05", "3000", "2026-10-01")], { unit: "stay", money: "total", booked: "yes" });
  const stay = monthlyView(r, scope, "2026-10", "stay"), booked = monthlyView(r, scope, "2026-10", "booked");
  assert.equal(stay.amount, 9000);
  assert.equal(stay.nights, 2);
  assert.equal(booked.amount, 3000);
  assert.equal(booked.nights, 1);
  assert.equal(stay.orders, 1);
  assert.equal(booked.orders, 1);
});

test("future booking days and months are unknown, while future stay reservations remain visible", () => {
  const r = report([row("a", "2026-11-04", "2026-11-05", "3000", "2026-10-01")]);
  const october = monthlyView(r, scope, "2026-10", "booked");
  assert.equal(october.daily[3].nights, 0);
  assert.equal(october.daily[5].nights, null);
  assert.equal(october.daily[5].orders, null);
  const november = monthlyView(r, scope, "2026-11", "booked");
  assert.equal(november.future, true);
  assert.equal(november.orders, null);
  const stay = monthlyView(r, scope, "2026-11", "stay");
  assert.equal(stay.future, false);
  assert.equal(stay.nights, 1);
  assert.equal(stay.orders, 1);
});

test("unknown prices and missing booking dates stay distinct from zero amounts", () => {
  const r = report([row("a", "2026-10-01", "2026-10-02", "", ""), row("b", "2026-10-02", "2026-10-03", "0", "2026-09-01")]);
  const stay = monthlyView(r, scope, "2026-10", "stay");
  assert.equal(stay.amount, 0);
  assert.equal(stay.coverage, 50);
  assert.equal(stay.adr, null);
  assert.equal(stay.orders, 2);
  assert.equal(monthlyView(r, scope, "2026-09", "booked").orders, 1);
});

test("month selection moves across years correctly and leap years contain correct dates", () => {
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  const r = report([row("a", "2026-10-01", "2026-10-02", "1000", "2026-09-01")]);
  assert.equal(monthlyView(r, scope, "2024-02", "stay").daily.length, 29);
  assert.equal(monthlyView(r, scope, "2025-02", "stay").daily.length, 28);
});

test("anonymous cohort aggregation preserves exact room counts for disjoint stay spans", () => {
  const segment = { kind: "rooms" as const, money: 1000, booked: "2026-08-01", channel: "官網", refs: ["synthetic!2"] };
  const cohorts = buildBookingCohorts([
    { ...segment, id: "a", start: "2026-09-30", end: "2026-10-01", count: 1 },
    { ...segment, id: "a", start: "2026-10-01", end: "2026-10-03", count: 3 },
    { ...segment, id: "b", start: "2026-09-30", end: "2026-10-01", count: 1 },
    { ...segment, id: "b", start: "2026-10-01", end: "2026-10-03", count: 3 },
  ], { unit: "multi", money: "night" }, "2026-10-05");
  assert.equal(cohorts.length, 1);
  assert.equal(cohortSummary(cohorts).orders, 2);
  assert.equal(cohortSummary(cohorts).nights, 14);
  const r = report([row("stub", "2026-10-01", "2026-10-02", "1000", "2026-09-01")]);
  r.analysis!.cohorts = cohorts;
  assert.equal(pacingView(r, { kind: "rooms" }, "2026-10").current.nights, 12);
  assert.equal(pacingView(r, { kind: "rooms" }, "2026-09").current.nights, 2);
});

test("monthly stay totals match authoritative daily cells and original report totals", () => {
  const r = report([row("a", "2026-09-30", "2026-10-03", "10000", "2026-09-01"), row("b", "2026-11-01", "2026-11-03", "6000", "2026-10-02")], { unit: "stay", money: "total", booked: "yes" });
  const months = ["2026-09", "2026-10", "2026-11"].map((month) => monthlyView(r, scope, month, "stay"));
  assert.equal(months.reduce((n, m) => n + m.nights, 0), r.nights);
  assert.ok(Math.abs(months.reduce((n, m) => n + (m.amount ?? 0), 0) - r.amount!) <= 0.01);
  for (const month of months) {
    assert.equal(month.nights, month.daily.reduce((n, d) => n + (d.nights ?? 0), 0));
    assert.ok(Math.round(Math.abs(month.amount! - month.daily.reduce((n, d) => n + (d.amount ?? 0), 0)) * 100) <= 1);
  }
});

test("legacy reports cannot imply zero orders when only daily monetary data exists", () => {
  const r = report([row("a", "2026-10-01", "2026-10-02", "3000", "2026-09-01")]);
  delete r.analysis!.cohorts;
  const m = monthlyView(r, scope, "2026-10", "stay");
  assert.equal(m.orders, null);
  assert.equal(m.amount, 3000);
  assert.equal(m.observed, true);
});
