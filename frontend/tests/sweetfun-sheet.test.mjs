import test from "node:test";
import assert from "node:assert/strict";
import { adaptSweetfunSheet } from "../src/lib/booking-sources/sweetfun-sheet.ts";

const headers = ["房型", "預定人姓名", "預定平台", "入住日期", "退房日期", "預訂日期", "房費", "全額支付狀態", "檢查狀態", "唯一ID", "備註", "訂單編號", "AI 登記"];
const row = (patch = {}) => Object.assign(["301", "PRIVATE GUEST", "Agoda", "2026/9/15", "2026/9/16", "2026/8/1", "2500", "done", "OK", "PRIVATE-ROW", "PRIVATE NOTES", "PRIVATE-ORDER", ""], patch);
const adapt = rows => adaptSweetfunSheet([headers, ...rows], "test-source", "2026-09-06T00:00:00Z");
test("done means guest paid in full but never synthesizes an OTA or property receipt", () => {
  const result = adapt([row()]);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(result.bookings[0].payment_status, "paid");
  assert.deepEqual(result.bookings[0].payments, []);
  assert.equal(result.bookings[0].nightly_amounts[0].amount, 2500);
});
test("duplicate IDs and room-night conflicts are blocked, never chosen or double counted", () => {
  const result = adapt([row(), row({ 6: "3000" })]);
  assert.equal(result.summary.quarantined_rows, 2);
  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0].source_conflict, true);
  assert.equal(result.bookings[0].room_rate, 0);
});
test("missing order IDs never merge by same guest across adjacent nights", () => {
  const result = adapt([row({ 11: "" }), row({ 3: "2026/9/16", 4: "2026/9/17", 9: "row2", 11: "" })]);
  assert.notEqual(result.bookings[0].order_id, result.bookings[1].order_id);
});
test("same explicit parent keeps linkage but preserves unequal daily amounts", () => {
  const result = adapt([row(), row({ 3: "2026/9/16", 4: "2026/9/17", 9: "row2", 6: "3100" })]);
  assert.equal(result.bookings[0].order_id, result.bookings[1].order_id);
  assert.deepEqual(result.bookings.map(b => b.nightly_amounts[0].amount), [2500, 3100]);
});
test("unmapped whole-property rows block all rooms without inventing allocation", () => {
  const result = adapt([row({ 0: "包棟" })]);
  assert.equal(result.summary.blocked_room_nights, 6);
  assert.equal(result.bookings.every(b => b.source_conflict), true);
});
test("whole-property ambiguity also quarantines physical-room bookings for that date", () => {
  const result = adapt([row({ 0: "包棟" }), row({ 9: "another-row" })]);
  assert.equal(result.summary.accepted_rows, 0);
  assert.equal(result.bookings.length, 6);
});
test("bad schema fails closed; calendar-invalid dates are not normalized silently", () => {
  assert.throws(() => adaptSweetfunSheet([["房號"]], "x", "x"), /SCHEMA/);
  const result = adapt([row({ 3: "2026/2/30", 4: "2026/3/3" })]);
  assert.equal(result.summary.accepted_rows, 0);
  assert.equal(result.issues.some(i => i.code === "invalid_room_night"), true);
});

test("all rows without a parent ID use J regardless of AI registration", () => {
  const result = adapt([row({11: ""}), row({9: "row2", 3: "2026/9/16", 4: "2026/9/17", 11: "", 12: "LINE AI Agent"})]);
  assert.equal(result.summary.row_id_fallback_rows, 2);
  assert.equal(result.bookings.every(b => b.source_identity_kind === "row"), true);
  assert.equal(result.bookings[0].source_order_linked, false);
});
const withAcks = (rows, keys) => adaptSweetfunSheet([headers, ...rows], "test-source", "2026-09-06T00:00:00Z", keys);
test("acknowledged conflicts are quiet but never count as verified revenue or availability", () => {
  const source = [row(), row({6: "3000"})];
  const initial = adapt(source);
  const next = withAcks(source, initial.issues.map(i => i.fingerprint));
  assert.equal(next.summary.new_issue_rows, 0);
  assert.equal(next.summary.historical_issue_rows, 2);
  assert.equal(next.bookings[0].source_issue_acknowledged, true);
  assert.equal(next.bookings[0].room_rate, 0);
  assert.equal(next.source.availability_authoritative, false);
  assert.notEqual(next.source.snapshot_version, initial.source.snapshot_version);
});
test("acknowledgements survive reordering, but changed/new conflicts still alert", () => {
  const source = [row(), row({6: "3000"})];
  const keys = adapt(source).issues.map(i => i.fingerprint);
  assert.equal(withAcks([...source].reverse(), keys).summary.new_issue_rows, 0);
  assert.equal(withAcks([source[0], row({6: "3100"})], keys).summary.new_issue_rows, 2);
  assert.equal(withAcks([...source, row({9: "third"})], keys).summary.new_issue_rows, 3);
});
test("resolved issues drop out of the carried acknowledgement state", () => {
  const source = [row(), row({6: "3000"})];
  const keys = adapt(source).issues.map(i => i.fingerprint);
  const resolved = withAcks([row()], keys);
  const carry = resolved.issues.filter(i => i.acknowledged).map(i => i.fingerprint);
  assert.equal(withAcks(source, carry).summary.new_issue_rows, 2);
});
