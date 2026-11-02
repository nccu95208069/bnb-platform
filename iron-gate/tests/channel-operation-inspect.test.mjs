import test from "node:test";
import assert from "node:assert/strict";
import { inspectOperation } from "../scripts/inspect-channel-operation.mjs";

const propertyId = "22222222-2222-4222-8222-222222222222";
const operationKey = "33333333-3333-4333-8333-333333333333";
const roomId = "44444444-4444-4444-8444-444444444444";
const claimId = "55555555-5555-4555-8555-555555555555";
const grantId = "66666666-6666-4666-8666-666666666666";
const cell = { roomId, date: "2027-01-22", desired: "closed" };
const fixture = () => ({ manifest: { propertyId, operationKey, expectedInventoryVersion: 10,
  expectedClaimId: claimId, expectedCells: [cell], expectedOperationState: "sync_pending" },
  state: { propertyId, version: 10, readOnly: false,
    channel: { mode: "owlnest", ready: true, sourceReadbackEnabled: true, grantId },
    channelDispatch: { claimId, operationKey: "77777777-7777-4777-8777-777777777777", state: "review_required" },
    operations: [{ key: operationKey, state: "sync_pending", cells: [cell], observations: [] }],
    bookings: [{ guestName: "Never expose this guest" }] } });

test("inspection observes exact cells without modifying or claiming the pending operation", async () => {
  const { manifest, state } = fixture();
  const before = structuredClone(state);
  let observations = 0;
  const result = await inspectOperation(manifest, { grantId,
    repository: { read: async () => structuredClone(state),
      transact: () => assert.fail("inspection must not transact") },
    readback: { observe: async (id, requested) => {
      observations++; assert.equal(id, propertyId); assert.deepEqual(requested, [cell]);
      return { observedAt: new Date().toISOString(), providerVersion: "synthetic",
        cells: [{ roomId, date: cell.date, count: 0, isLock: true }] };
    }, setNight: () => assert.fail("inspection must not write") } });
  assert.equal(observations, 1);
  assert.equal(result.operationState, "sync_pending");
  assert.equal(result.verifiedAt, null);
  assert.equal(result.observationCount, 0);
  assert.equal(JSON.stringify(result).includes("Never expose"), false);
  assert.deepEqual(state, before);
});

test("inspection fails before provider access for moved version, claim, state, grant, or target cells", async () => {
  for (const mutate of [s => s.version++, s => s.channelDispatch = null,
    s => s.operations[0].state = "sync_verified", s => s.channel.grantId = operationKey,
    s => s.operations[0].cells[0].date = "2027-01-23"]) {
    const { manifest, state } = fixture();
    const changed = structuredClone(state); mutate(changed);
    await assert.rejects(inspectOperation(manifest, { grantId,
      repository: { read: async () => changed },
      readback: { observe: () => assert.fail("must not access provider") } }),
    /CHANNEL_INSPECT_STATE_MOVED/);
  }
});

test("inspection rejects a concurrent change even when inventory version does not advance", async () => {
  const { manifest, state } = fixture();
  let reads = 0;
  await assert.rejects(inspectOperation(manifest, { grantId,
    repository: { read: async () => {
      reads++; const current = structuredClone(state);
      if (reads === 2) current.channelDispatch.state = "active";
      return current;
    } }, readback: { observe: async () => ({ cells: [] }) } }), /CHANNEL_INSPECT_STATE_MOVED/);
});
