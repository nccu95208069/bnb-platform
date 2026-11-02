import test from "node:test";
import assert from "node:assert/strict";
import { auditOfflandSnapshot, OFFLAND_HEADERS } from "../src/offland-sheet-audit.mjs";
import { prepareOfflandGroups, prepareOfflandShadow, verifyOfflandShadow } from
  "../src/offland-shadow.mjs";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";

function row(number, room, night, j, q = "", o = "") {
  return { rowNumber: number,
    values: [room, "Synthetic Guest", "Booking", night,
      new Date(Date.parse(`${night}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
      "2026-10-01", "NT$6,400", "", "OK", j, "", "2", "", "", o, "", q],
    entered: Array(17).fill(""), notes: Array(17).fill(null) };
}
function snapshot() {
  return { headers: [...OFFLAND_HEADERS], rows: [
    row(2, "OFFLAND", "2026-11-01", "night-aaa", "order-aaa", "CARD-A"),
    row(3, "OFFLAND(連住)", "2026-11-02", "night-bbb", "order-aaa", "CARD-B"),
    row(4, "OFFLAND", "2026-11-03", "night-ccc", "", "CARD-A"),
  ] };
}
function config(source) {
  return { workspaceId, propertyId, roomId, inventoryVersion: 1,
    authorityEpoch: 0, expectedSourceHash: auditOfflandSnapshot(source).sourceHash,
    sourceId: "source-sheet", sourceCopyId: "owner-only-copy",
    sourceCopyCreatedAt: "2026-10-24T17:57:16.530Z",
    capturedAt: "2026-10-24T17:57:16.530Z",
    bookingIds: { "Q:order-aaa": "44444444-4444-4444-8444-444444444444",
      "J:night-ccc": "55555555-5555-4555-8555-555555555555" } };
}

test("Offland groups Q orders, isolates blank Q by J and never groups by O", () => {
  const source = snapshot();
  const groups = prepareOfflandGroups(source);
  assert.equal(groups.summary.sourceRows, 3);
  assert.deepEqual(groups.candidates.map(group => group.key), ["Q:order-aaa", "J:night-ccc"]);
  assert.deepEqual(groups.candidates.map(group => group.rows.length), [2, 1]);
  assert.equal(groups.summary.occupiedVillaNights, 3);
  const prepared = prepareOfflandShadow(source, config(source));
  assert.equal(prepared.state.readOnly, true);
  assert.equal(prepared.state.authorityEpoch, 0);
  assert.equal(prepared.state.bookings[0].totalCents, 1_280_000);
  assert.deepEqual(prepared.state.bookings[0].roomNightPrices.map(p => p.amountCents),
    [640_000, 640_000]);
  assert.equal(prepared.state.bookings[0].paymentEvents.length, 0);
  assert.equal(prepared.state.sourceLinks.length, 2);
  assert.equal(verifyOfflandShadow(source, config(source), prepared.state).matches, true);
  const reordered = (value) => Array.isArray(value) ? value.map(reordered) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .reverse().map(([key, item]) => [key, reordered(item)])) : value;
  assert.equal(verifyOfflandShadow(source, config(source),
    reordered(prepared.state)).matches, true);
});

test("Offland rejects a collision between its two source room labels", () => {
  const source = snapshot();
  source.rows[1].values[3] = source.rows[0].values[3];
  source.rows[1].values[4] = source.rows[0].values[4];
  assert.equal(auditOfflandSnapshot(source).summary.issues.VILLA_NIGHT_CONFLICT.count, 2);
  assert.throws(() => prepareOfflandShadow(source, config(source)),
    /OFFLAND_SOURCE_REVIEW_REQUIRED/);
});

test("Offland requires the exact frozen source hash and complete booking map", () => {
  const source = snapshot(), manifest = config(source);
  const prepared = prepareOfflandShadow(source, manifest);
  source.rows[0].values[6] = "NT$6,500";
  assert.throws(() => prepareOfflandShadow(source, manifest), /OFFLAND_SOURCE_HASH_MISMATCH/);
  assert.equal(verifyOfflandShadow(snapshot(), manifest, prepared.state).matches, true);
  delete manifest.bookingIds["J:night-ccc"];
  assert.throws(() => prepareOfflandShadow(snapshot(), manifest),
    /INCOMPLETE_OFFLAND_BOOKING_ID_MAP/);
});

test("Offland shadow projects only scoped calendar facts and keeps payment unknown", async () => {
  const source = snapshot(), manifest = config(source);
  const { state } = prepareOfflandShadow(source, manifest);
  const repository = new MemoryPropertyRepository();
  repository.seed(state);
  const service = new IronGateService(repository);
  const principal = { clientId: "synthetic-os", subjectId: "synthetic-owner", origin: "os",
    workspaceId, propertyIds: [propertyId], authorityEpoch: 0,
    actions: ["booking:read"], fields: ["guest_name", "payment_status", "money"] };
  const result = await service.calendarSnapshot(principal, propertyId,
    "2026-11-01", "2026-11-04");
  assert.equal(result.readOnly, true);
  assert.equal(result.cells.filter(cell => cell.state === "sold").length, 3);
  assert.equal(result.bookings.length, 2);
  assert.deepEqual(result.bookings[0].stayAmountsCents, [640_000, 640_000]);
  assert.deepEqual(result.bookings[0].paymentReview,
    { status: "unknown", source: "unknown" });
  assert.equal(result.bookings[0].sourceCalendar.sourceOrderRef, "Q:order-aaa");
  assert.equal(result.bookings[1].sourceCalendar.sourceOrderRef, "J:night-ccc");
  assert.equal(JSON.stringify(result).includes("CARD-A"), false);
  assert.equal(JSON.stringify(result).includes("night-aaa"), false);
  const noMoney = await service.calendarSnapshot({ ...principal, fields: ["guest_name"] },
    propertyId, "2026-11-01", "2026-11-04");
  assert.equal("sourceOrderRef" in noMoney.bookings[0].sourceCalendar, false);
  assert.equal("stayAmountsCents" in noMoney.bookings[0], false);
  assert.equal("paymentReview" in noMoney.bookings[0], false);
});
