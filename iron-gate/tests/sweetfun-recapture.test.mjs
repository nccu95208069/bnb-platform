import test from "node:test";
import assert from "node:assert/strict";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { prepareSweetfunGroups } from "../src/sweetfun-sheet-candidate.mjs";
import { prepareSweetfunShadow } from "../src/sweetfun-shadow.mjs";
import { planSweetfunVerifiedRecapture } from
  "../scripts/recapture-sweetfun-shadow.mjs";

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture() {
  const values = Array(19).fill("");
  Object.assign(values, { 0: "101", 1: "Synthetic", 2: "LINE",
    3: "2026/11/01", 4: "2026/11/02", 5: "2026/10/01",
    6: "1200", 8: "OK", 9: "synthetic-j" });
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [
    { rowNumber: 2, values, notes: Array(19).fill(null) }] };
  const sourceHash = prepareSweetfunGroups(snapshot).sourceHash;
  const config = { workspaceId: uid(1), propertyId: uid(2),
    roomIds: Object.fromEntries(["101", "102", "201", "202", "301", "302"]
      .map((room, i) => [room, uid(10 + i)])), sourceId: "synthetic-sheet",
    capturedAt: "2026-10-20T00:00:00.000Z", expectedSourceHash: sourceHash,
    inventoryVersion: 9, authorityEpoch: 0,
    bookingIds: { "J:synthetic-j": uid(100) } };
  const state = prepareSweetfunShadow(snapshot, config).state;
  const manifest = { expectedVersion: 9, expectedSourceHash: sourceHash,
    sourceId: config.sourceId, sourceCopyId: "synthetic-private-copy",
    capturedAt: "2026-10-22T05:08:57.308Z",
    sourceCopyCreatedAt: "2026-10-22T05:08:57.308Z",
    legacyFrozenAt: "2026-10-22T05:03:35.000Z",
    gmailDrainedAt: "2026-10-22T05:08:42.000Z" };
  return { snapshot, state, manifest };
}

test("unchanged post-drain copy advances time and version without changing bookings", () => {
  const { snapshot, state, manifest } = fixture();
  const next = planSweetfunVerifiedRecapture(state, snapshot, manifest);
  assert.equal(next.state.version, 10);
  assert.equal(next.state.sweetfunImport.capturedAt, manifest.capturedAt);
  assert.deepEqual(next.state.bookings, state.bookings);
  assert.deepEqual(next.state.fences, state.fences);
});

test("recapture refuses a source change or a copy from before drain", () => {
  const { snapshot, state, manifest } = fixture();
  const changed = structuredClone(snapshot);
  changed.rows[0].values[6] = "1300";
  assert.throws(() => planSweetfunVerifiedRecapture(state, changed, manifest));
  assert.throws(() => planSweetfunVerifiedRecapture(state, snapshot,
    { ...manifest, gmailDrainedAt: "2026-10-22T05:09:00.000Z" }));
});
