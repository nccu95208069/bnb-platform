import test from "node:test";
import assert from "node:assert/strict";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { prepareSweetfunGroups } from "../src/sweetfun-sheet-candidate.mjs";
import { prepareSweetfunShadow } from "../src/sweetfun-shadow.mjs";
import { prepareSweetfunSourceLinks } from "../src/sweetfun-source-links.mjs";
import { planSweetfunHistoricalReviewWaiver,
  sweetfunHistoricalReviewFingerprint, sweetfunReviewResolved } from
  "../src/sweetfun-historical-review.mjs";
import { planSweetfunAuthorityActivation } from "../src/sweetfun-authority.mjs";
import { planSweetfunCutoverCredentials } from
  "../scripts/stage-sweetfun-cutover-credentials.mjs";
import { nightsFor } from "../src/service.ts";

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rooms = ["101", "102", "201", "202", "301", "302"];

function row(number, room, arrival, departure, id) {
  const values = Array(19).fill("");
  Object.assign(values, { 0: room, 1: "Synthetic", 2: "LINE",
    3: arrival.replaceAll("-", "/"), 4: departure.replaceAll("-", "/"),
    5: "2025/01/01", 6: "1000", 8: "OK", 9: id });
  return { rowNumber: number, values, notes: Array(19).fill(null) };
}

function fixture() {
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [
    row(2, "201", "2025-10-05", "2025-10-06", "old-a"),
    row(3, "201", "2025-10-05", "2025-10-06", "old-b"),
    row(4, "102", "2025-11-08", "2025-11-09", "old-c"),
    row(5, "102", "2025-11-08", "2025-11-09", "old-d"),
    row(6, "301", "2026-11-01", "2026-11-02", "current") ] };
  const prepared = prepareSweetfunGroups(snapshot);
  const config = { workspaceId: uid(1), propertyId: uid(2),
    roomIds: Object.fromEntries(rooms.map((room, i) => [room, uid(10 + i)])),
    sourceId: "synthetic-sheet", capturedAt: "2026-10-20T00:00:00.000Z",
    expectedSourceHash: prepared.sourceHash, inventoryVersion: 8,
    authorityEpoch: 0,
    bookingIds: Object.fromEntries(prepared.candidates.filter((group) =>
      group.issues.length === 0).map((group) => [group.key, uid(100)])) };
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
  const credentialManifest = { ...manifest, projectRef: "brcszrkwkgiwatrxevkf",
    sourceGrantId: manifest.grantId, sourceCredentialId: uid(201),
    osCredentialId: uid(202), sourceClientId: uid(203), osClientId: uid(204),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  return { state, occupancy, manifest, credentialManifest };
}

test("the exact approved past collision stays as evidence but permits cutover", () => {
  const { state, occupancy, manifest, credentialManifest } = fixture();
  assert.equal(state.sweetfunImport.quarantined.length, 4);
  assert.equal(state.fences.length, 2);
  assert.equal(sweetfunReviewResolved(state), false);
  const fingerprint = sweetfunHistoricalReviewFingerprint(state);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  const decided = planSweetfunHistoricalReviewWaiver(state, {
    expectedVersion: 8, expectedSourceHash: state.sweetfunImport.sourceHash,
    fingerprint, approvalRef: "synthetic-owner-approval",
    approvedAt: "2026-10-20T00:00:01.000Z" }).state;
  assert.equal(decided.version, 9);
  assert.deepEqual(decided.sweetfunImport.quarantined,
    state.sweetfunImport.quarantined);
  assert.deepEqual(decided.fences, state.fences);
  assert.equal(sweetfunReviewResolved(decided), true);
  assert.equal(planSweetfunCutoverCredentials(decided, occupancy,
    { ...credentialManifest, expectedVersion: 9 }).source.authorityEpoch, 1);
  assert.equal(planSweetfunAuthorityActivation(decided, occupancy,
    { ...manifest, expectedVersion: 9 }).state.authorityEpoch, 1);
});

test("the exception fails closed on a changed source, fence, or current collision", () => {
  const { state } = fixture();
  state.sweetfunImport.historicalReviewWaiver = {
    decision: "retain_source_exclude_live", cutoffDate: "2026-01-01",
    sourceHash: state.sweetfunImport.sourceHash,
    fingerprint: sweetfunHistoricalReviewFingerprint(state),
    approvalRef: "synthetic-owner-approval", approvedAt: "2026-10-20T00:00:01.000Z" };
  const changedSource = structuredClone(state);
  changedSource.sweetfunImport.sourceHash = "a".repeat(64);
  assert.equal(sweetfunReviewResolved(changedSource), false);
  const changedFence = structuredClone(state);
  changedFence.fences[0].cells[0].date = "2026-11-01";
  assert.equal(sweetfunReviewResolved(changedFence), false);
  const newConflict = structuredClone(state);
  newConflict.sweetfunImport.quarantined[0].rows[0].checkIn = "2026-11-01";
  assert.equal(sweetfunReviewResolved(newConflict), false);
  const missingEvidence = structuredClone(state);
  delete missingEvidence.sweetfunImport.historicalReviewWaiver.approvalRef;
  assert.equal(sweetfunReviewResolved(missingEvidence), false);
  assert.throws(() => planSweetfunHistoricalReviewWaiver(state, {
    expectedVersion: 8, expectedSourceHash: state.sweetfunImport.sourceHash,
    fingerprint: "a".repeat(64), approvalRef: "synthetic-owner-approval",
    approvedAt: "2026-10-20T00:00:01.000Z" }));
});
