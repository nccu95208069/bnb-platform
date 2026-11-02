import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { createChannelDispatchClaim } from "../src/channel-dispatch-claim.mjs";
import { reconcileChannelOperation } from "../src/channel-runner.mjs";

const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const operationKey = "44444444-4444-4444-8444-444444444444";

function setup() {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId: "11111111-1111-4111-8111-111111111111",
    propertyId, roomIds: [roomId], version: 1, authorityEpoch: 1, readOnly: false,
    channel: { mode: "owlnest", ready: true, sourceReadbackEnabled: true,
      websiteSalesEnabled: false,
      grantId: "55555555-5555-4555-8555-555555555555", websiteBindingId: null },
    bookings: [], sourceGrants: [], sourceLinks: [], fences: [], manualBlocks: [], receipts: [],
    operations: [{ key: operationKey, state: "sync_pending", cells: [{ roomId,
      date: "2026-11-10", desired: "closed" }] }] });
  return { repository, claim: createChannelDispatchClaim(repository).forOperation(operationKey) };
}

test("property claim is atomic and only a verified readback releases it", async () => {
  const { repository, claim } = setup();
  let entered;
  const inWork = new Promise((resolve) => { entered = resolve; });
  let finish;
  const hold = new Promise((resolve) => { finish = resolve; });
  const first = claim(propertyId, async () => {
    entered();
    return hold;
  });
  await inWork;
  await assert.rejects(claim(propertyId, async () => ({ state: "sync_verified" })),
    { message: "CHANNEL_PROPERTY_CLAIMED" });
  await repository.transact(propertyId, (state) => {
    state.operations[0].state = "sync_verified";
  });
  finish({ state: "sync_verified", operationKey });
  assert.equal((await first).state, "sync_verified");
  assert.equal((await repository.read(propertyId)).channelDispatch, null);
});

test("unknown outcome or unverified result leaves a durable review claim", async () => {
  const { repository, claim } = setup();
  await assert.rejects(claim(propertyId, async () => { throw Error("PROVIDER_UNKNOWN"); }),
    { message: "PROVIDER_UNKNOWN" });
  assert.equal((await repository.read(propertyId)).channelDispatch.state, "review_required");
  await assert.rejects(claim(propertyId, async () => {}),
    { message: "CHANNEL_OPERATION_NOT_DISPATCHABLE" });
  const other = setup();
  const partial = await other.claim(propertyId, async () => ({ state: "review_required",
    operationKey }));
  assert.equal(partial.state, "review_required");
  assert.equal((await other.repository.read(propertyId)).channelDispatch.state, "review_required");
});

test("one-shot channel runner uses the claim without an external write when already closed", async () => {
  const { repository, claim } = setup();
  let writes = 0;
  const result = await reconcileChannelOperation({ propertyId, operationKey,
    withPropertyLease: claim,
    loadOperation: async () => ({ key: operationKey, state: "sync_pending",
      cells: [{ roomId, date: "2026-11-10", desired: "closed" }] }),
    provider: {
      observe: async () => ({ observedAt: new Date().toISOString(), providerVersion: "v1",
        cells: [{ roomId, date: "2026-11-10", count: 0, isLock: true }] }),
      setNight: async () => { writes++; },
    },
    recordReadback: async () => {
      await repository.transact(propertyId, (state) => {
        state.operations[0].state = "sync_verified";
      });
      return { operationKey, state: "sync_verified" };
    },
  });
  assert.equal(result.state, "sync_verified");
  assert.equal(writes, 0);
  assert.equal((await repository.read(propertyId)).channelDispatch, null);
});
