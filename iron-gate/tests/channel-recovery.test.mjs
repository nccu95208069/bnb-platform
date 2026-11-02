import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";
import { recoverChannelClaim } from "../src/channel-recovery.mjs";

const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const grantId = "44444444-4444-4444-8444-444444444444";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const principal = { clientId: "channel", subjectId: "operator", origin: "channel",
  workspaceId, propertyIds: [propertyId], authorityEpoch: 1,
  actions: ["channel:verify"], fields: [], grantId };

async function setup() {
  const repository = new MemoryPropertyRepository();
  const bookingId = crypto.randomUUID(), operationKey = crypto.randomUUID();
  const claimId = crypto.randomUUID();
  repository.seed({ propertyId, workspaceId, roomIds: [roomId], version: 2,
    authorityEpoch: 1, readOnly: false,
    channel: { mode: "owlnest", ready: true, sourceReadbackEnabled: true,
      websiteSalesEnabled: false, grantId, websiteBindingId: null },
    channelDispatch: { claimId, operationKey, state: "review_required",
      claimedAt: new Date().toISOString() },
    sourceGrants: [], sourceLinks: [], manualBlocks: [], receipts: [],
    bookings: [{ id: bookingId, workspaceId, propertyId, version: 1,
      status: "confirmed", channelSyncState: "pending", channelOperationKey: operationKey,
      stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }],
      guestName: null, contact: null, notes: null, totalCents: null,
      currency: "TWD", bookedAt: null, createdAt: new Date().toISOString(),
      source: "os", sourceKey: null }],
    operations: [{ key: operationKey, bookingId, bookingVersion: 1,
      state: "sync_pending", cells: [{ roomId, date: "2026-11-10", desired: "closed" }],
      createdAt: new Date(Date.now() - 1000).toISOString(),
      verifiedAt: null, providerVersion: null }],
    fences: [{ key: operationKey, cells: [{ roomId, date: "2026-11-10" }],
      reason: "channel_pending" }] });
  return { repository, service: new IronGateService(repository), claimId, operationKey };
}

test("manual recovery only clears a claim after fresh exact provider readback", async () => {
  const { repository, service, claimId, operationKey } = await setup();
  const observed = (closed) => ({ async observe() {
    return { observedAt: new Date().toISOString(), providerVersion: "fresh",
      cells: [{ roomId, date: "2026-11-10", count: closed ? 0 : 1,
        isLock: closed }] };
  } });
  const unknown = await recoverChannelClaim({ repository, service,
    provider: observed(false), principal, propertyId, expectedClaimId: claimId });
  assert.equal(unknown.state, "review_required");
  assert.equal((await repository.read(propertyId)).channelDispatch.claimId, claimId);
  const recovered = await recoverChannelClaim({ repository, service,
    provider: observed(true), principal, propertyId, expectedClaimId: claimId });
  assert.deepEqual(recovered, { state: "sync_verified", operationKey });
  assert.equal((await repository.read(propertyId)).channelDispatch, null);
  await assert.rejects(recoverChannelClaim({ repository, service,
    provider: observed(true), principal, propertyId, expectedClaimId: claimId }),
  /CHANNEL_RECOVERY_CLAIM_MOVED/);
});

test("manual recovery clears a bookingless inventory claim only after exact observation", async () => {
  const { repository, service, claimId, operationKey } = await setup();
  await repository.transact(propertyId, (state) => {
    state.bookings = [];
    state.manualBlocks = [{ roomId, date: "2026-11-10" }];
    state.operations[0].bookingId = null;
    state.operations[0].bookingVersion = 0;
  });
  const observed = { async observe() {
    return { observedAt: new Date().toISOString(), providerVersion: "manual-close-readback",
      cells: [{ roomId, date: "2026-11-10", count: 0, isLock: true }] };
  } };
  const recovered = await recoverChannelClaim({ repository, service,
    provider: observed, principal, propertyId, expectedClaimId: claimId });
  assert.equal(recovered.state, "sync_verified");
  const state = await repository.read(propertyId);
  assert.equal(state.channelDispatch, null);
  assert.equal(state.fences.length, 0);
  assert.equal(state.operations[0].state, "sync_verified");
});
