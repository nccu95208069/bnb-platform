import test from "node:test";
import assert from "node:assert/strict";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { prepareSweetfunGroups } from "../src/sweetfun-sheet-candidate.mjs";
import { prepareSweetfunShadow } from "../src/sweetfun-shadow.mjs";
import { prepareSweetfunSourceLinks } from "../src/sweetfun-source-links.mjs";
import { planSweetfunAuthorityActivation, planSweetfunNoWriteRollback } from
  "../src/sweetfun-authority.mjs";
import { nightsFor } from "../src/service.ts";

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture() {
  const names = ["101", "102", "201", "202", "301", "302"];
  const roomIds = Object.fromEntries(names.map((name, i) => [name, uid(i + 10)]));
  const values = Array(19).fill("");
  Object.assign(values, { 0: "101", 1: "Synthetic guest", 2: "AI",
    3: "2026/11/01", 4: "2026/11/02", 5: "2026/10/01", 6: "1200",
    7: "not_yet", 8: "OK", 9: "synthetic-j", 11: "synthetic-ota" });
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [
    { rowNumber: 2, values, notes: Array(19).fill(null) }] };
  const config = { workspaceId: uid(1), propertyId: uid(2), roomIds,
    sourceId: "synthetic-sheet", capturedAt: "2026-10-20T00:00:00.000Z",
    expectedSourceHash: prepareSweetfunGroups(snapshot).sourceHash,
    inventoryVersion: 8, authorityEpoch: 0,
    bookingIds: { "L:synthetic-ota": uid(100) } };
  const state = prepareSweetfunSourceLinks(prepareSweetfunShadow(snapshot, config).state,
    "sweetfun-calendar-sheet", config.sourceId).state;
  const occupancy = state.bookings.flatMap((booking) =>
    nightsFor(booking.stays, state.roomIds).map((cell) =>
      ({ room_id: cell.roomId, night: cell.date, booking_id: booking.id })));
  const manifest = { propertyId: state.propertyId, workspaceId: state.workspaceId,
    sourceSystem: "sweetfun-calendar-sheet", sourceAccount: config.sourceId,
    expectedSourceHash: config.expectedSourceHash, expectedVersion: 8,
    grantId: uid(200), legacyFrozenAt: "2026-10-19T23:00:00.000Z",
    gmailDrainedAt: "2026-10-19T23:30:00.000Z",
    cutoverTimestampMs: Date.parse("2026-10-19T23:29:00.000Z"),
    authorizedAt: "2026-10-20T00:01:00.000Z" };
  return { state, occupancy, manifest };
}

test("a complete frozen source can activate, then roll back before any write", () => {
  const { state, occupancy, manifest } = fixture();
  const planned = planSweetfunAuthorityActivation(state, occupancy, manifest);
  assert.equal(state.readOnly, true);
  assert.equal(planned.state.readOnly, false);
  assert.equal(planned.state.authorityEpoch, 1);
  assert.equal(planned.state.version, 9);
  assert.equal(planned.state.sourceGrants[0].grantId, manifest.grantId);
  const rolled = planSweetfunNoWriteRollback(planned.state, occupancy,
    { ...manifest, rolledBackAt: "2026-10-20T00:02:00.000Z" });
  assert.equal(rolled.state.readOnly, true);
  assert.equal(rolled.state.authorityEpoch, 2);
  assert.equal(rolled.state.sourceGrants[0].active, false);
});

test("activation refuses missing links, occupancy drift, unfrozen source and review rows", () => {
  const { state, occupancy, manifest } = fixture();
  const missing = structuredClone(state);
  missing.sourceLinks = [];
  assert.throws(() => planSweetfunAuthorityActivation(missing, occupancy, manifest));
  assert.throws(() => planSweetfunAuthorityActivation(state, [], manifest));
  assert.throws(() => planSweetfunAuthorityActivation(state, occupancy,
    { ...manifest, legacyFrozenAt: "2026-10-20T00:02:00.000Z" }));
  assert.throws(() => planSweetfunAuthorityActivation(state, occupancy,
    { ...manifest, cutoverTimestampMs: Date.parse("2026-10-20T00:02:00.000Z") }));
  const review = structuredClone(state);
  review.sweetfunImport.quarantined.push({ reason: "synthetic" });
  assert.throws(() => planSweetfunAuthorityActivation(review, occupancy, manifest));
});

test("rollback refuses a changed version or booking even with no operation marker", () => {
  const { state, occupancy, manifest } = fixture();
  const activated = planSweetfunAuthorityActivation(state, occupancy, manifest).state;
  const rollback = { ...manifest, rolledBackAt: "2026-10-20T00:02:00.000Z" };
  const written = structuredClone(activated);
  written.version++;
  assert.throws(() => planSweetfunNoWriteRollback(written, occupancy, rollback));
  const changed = structuredClone(activated);
  changed.bookings[0].guestName = "Changed";
  assert.throws(() => planSweetfunNoWriteRollback(changed, occupancy, rollback));
});
