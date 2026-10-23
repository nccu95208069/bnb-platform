import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { planSweetfunChannelActivation, planSweetfunChannelNoWriteRollback } from
  "../src/sweetfun-channel-activation.mjs";

const propertyId = "95ae9bd1-5e6d-4386-be5b-6af3c5668a16";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const grantId = "44444444-4444-4444-8444-444444444444";
const bookingId = "55555555-5555-4555-8555-555555555555";
const rooms = Array.from({ length: 6 }, (_, i) =>
  `${String(i + 1).repeat(8)}-${String(i + 1).repeat(4)}-4${String(i + 1).repeat(3)}-8${String(i + 1).repeat(3)}-${String(i + 1).repeat(12)}`);
const now = new Date("2026-10-23T10:00:00.000Z");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const day = (offset) => new Date(Date.parse("2026-10-23T00:00:00Z") +
  offset * 86_400_000).toISOString().slice(0, 10);
const cellKey = (cell) => `${cell.roomId}|${cell.date}`;

function fixture() {
  const state = { propertyId, workspaceId, roomIds: rooms, version: 38,
    authorityEpoch: 1, readOnly: false,
    sweetfunImport: { sourceId: "sheet-1" },
    channel: { mode: "none", ready: false, sourceReadbackEnabled: false,
      websiteSalesEnabled: false, grantId: null, websiteBindingId: null },
    sourceGrants: [{ grantId: "66666666-6666-4666-8666-666666666666",
      sourceSystem: "sweetfun-calendar-sheet", sourceAccount: "sheet-1", active: true }],
    bookings: [{ id: bookingId, propertyId, workspaceId, status: "confirmed",
      stays: [{ checkIn: day(2), checkOut: day(3), roomIds: [rooms[0]] }] }],
    operations: [], receipts: [], manualBlocks: [],
    fences: [{ key: "past-review", reason: "source_review",
      cells: [{ roomId: rooms[0], date: "2025-10-05" }] }] };
  const occupancy = [{ room_id: rooms[0], night: day(2), booking_id: bookingId }];
  const cells = rooms.flatMap((roomId) => Array.from({ length: 251 }, (_, offset) =>
    ({ roomId, date: day(offset), count: 1, isLock: false })));
  cells.find((cell) => cell.roomId === rooms[0] && cell.date === day(2)).isLock = true;
  cells.find((cell) => cell.roomId === rooms[1] && cell.date === day(4)).isLock = true;
  const snapshot = { propertyId, startDate: day(0), endDate: day(250),
    capturedAt: "2026-10-23T09:59:00.000Z", cells };
  const canonical = [...cells].sort((a, b) => cellKey(a).localeCompare(cellKey(b)));
  const manifest = { projectRef: "brcszrkwkgiwatrxevkf", propertyId, workspaceId,
    channelGrantId: grantId, expectedVersion: 38,
    expectedSnapshotHash: digest(canonical) };
  return { state, occupancy, snapshot, manifest };
}

test("fresh complete stock imports provider-only closures and activates the gated channel", () => {
  const { state, occupancy, snapshot, manifest } = fixture();
  const planned = planSweetfunChannelActivation(state, occupancy, manifest, snapshot, now);
  assert.equal(planned.summary.observedCells, 1506);
  assert.equal(planned.summary.stockObservedThrough, "2027-06-30");
  assert.equal(planned.summary.occupiedCells, 1);
  assert.equal(planned.summary.importedBlocks, 1);
  assert.deepEqual(planned.state.manualBlocks, [{ roomId: rooms[1], date: day(4) }]);
  assert.deepEqual(planned.state.channel, { mode: "owlnest", ready: true,
    sourceReadbackEnabled: true, stockObservedThrough: "2027-06-30",
    websiteSalesEnabled: false,
    grantId, websiteBindingId: null });
  assert.equal(planned.state.version, 39);
  assert.equal(state.channel.mode, "none");
  const rollback = planSweetfunChannelNoWriteRollback(planned.state, occupancy, {
    projectRef: manifest.projectRef, propertyId, workspaceId, channelGrantId: grantId,
    expectedVersion: 39, expectedOperationCount: 0,
    expectedBlockHash: planned.summary.blockHash });
  assert.equal(rollback.state.channel.mode, "none");
  assert.equal(rollback.state.version, 40);
  assert.deepEqual(rollback.state.manualBlocks, planned.state.manualBlocks);
});

test("an occupied OwlNest-open cell, incomplete or old observation blocks cutover", () => {
  const { state, occupancy, snapshot, manifest } = fixture();
  const booked = snapshot.cells.find((cell) => cell.roomId === rooms[0] && cell.date === day(2));
  booked.isLock = false;
  manifest.expectedSnapshotHash = digest([...snapshot.cells].sort((a, b) =>
    cellKey(a).localeCompare(cellKey(b))));
  assert.throws(() => planSweetfunChannelActivation(state, occupancy, manifest, snapshot, now),
    /SWEETFUN_CHANNEL_OCCUPIED_OPEN/);
  booked.isLock = true;
  snapshot.cells.pop();
  assert.throws(() => planSweetfunChannelActivation(state, occupancy, manifest, snapshot, now),
    /SWEETFUN_CHANNEL_SNAPSHOT_INVALID/);
  snapshot.cells.push({ roomId: rooms[5], date: day(250), count: 1, isLock: false });
  snapshot.capturedAt = "2026-10-23T09:45:00.000Z";
  assert.throws(() => planSweetfunChannelActivation(state, occupancy, manifest, snapshot, now),
    /SWEETFUN_CHANNEL_SNAPSHOT_INVALID/);
});

test("new future fence and post-activation operation prevent an unsafe mode change", () => {
  const { state, occupancy, snapshot, manifest } = fixture();
  state.fences.push({ key: "future-review", reason: "source_review",
    cells: [{ roomId: rooms[2], date: day(3) }] });
  assert.throws(() => planSweetfunChannelActivation(state, occupancy, manifest, snapshot, now),
    /SWEETFUN_CHANNEL_SNAPSHOT_INVALID/);
  state.fences.pop();
  const activated = planSweetfunChannelActivation(state, occupancy, manifest, snapshot, now);
  activated.state.operations.push({ key: "new-operation", state: "sync_verified", cells: [] });
  assert.throws(() => planSweetfunChannelNoWriteRollback(activated.state, occupancy, {
    projectRef: manifest.projectRef, propertyId, workspaceId, channelGrantId: grantId,
    expectedVersion: activated.state.version, expectedOperationCount: 0,
    expectedBlockHash: activated.summary.blockHash }), /SWEETFUN_CHANNEL_ROLLBACK_UNSAFE/);
});
