import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";
import { createChannelWorker } from "../src/channel-worker.mjs";
import { recoverChannelClaim, releaseReviewedManualClaim } from "../src/channel-recovery.mjs";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const channelGrant = "44444444-4444-4444-8444-444444444444";

function setup({ providerFails = false, initiallyClosed = false } = {}) {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId, propertyId, roomIds: [roomId], version: 1,
    authorityEpoch: 1, readOnly: false,
    channel: { mode: "owlnest", ready: true, sourceReadbackEnabled: true,
      websiteSalesEnabled: false, grantId: channelGrant, websiteBindingId: null,
      stockObservedFrom: "2099-01-01", stockObservedThrough: "2099-12-31" },
    sourceGrants: [], bookings: [], sourceLinks: [], operations: [], fences: [],
    manualBlocks: [], receipts: [] });
  const service = new IronGateService(repository);
  const owner = { clientId: "os-client", subjectId: "os-user", origin: "os",
    workspaceId, propertyIds: [propertyId], authorityEpoch: 1,
    actions: ["booking:create", "booking:amend"],
    fields: ["guest_name", "money"], grantId: null };
  const channel = { clientId: "channel-client", subjectId: "channel-worker", origin: "channel",
    workspaceId, propertyIds: [propertyId], authorityEpoch: 1,
    actions: ["channel:verify"], fields: [], grantId: channelGrant };
  const stock = new Map([["2099-11-10", initiallyClosed ?
    { count: 0, isLock: true } : { count: 1, isLock: false }]]);
  let writes = 0;
  const alerts = [];
  const provider = {
    observe: async (_propertyId, cells) => ({ observedAt: new Date().toISOString(),
      providerVersion: "synthetic-v1", cells: cells.map((cell) => ({
        roomId: cell.roomId, date: cell.date,
        ...(stock.get(cell.date) ?? { count: 1, isLock: false }) })) }),
    setNight: async (_propertyId, cell) => {
      writes++;
      if (providerFails) throw Error("SYNTHETIC_UNKNOWN_WRITE");
      stock.set(cell.date, { count: 0, isLock: true });
    },
  };
  const worker = createChannelWorker({ repository, service, provider,
    onReview: async (item) => { alerts.push(item); } });
  return { repository, service, owner, channel, worker, provider, alerts,
    writes: () => writes };
}

async function createPending(set, date = "2099-11-10") {
  const current = await set.repository.read(propertyId);
  const result = await set.service.createBooking(set.owner, propertyId, crypto.randomUUID(), {
    expectedInventoryVersion: current.version,
    stays: [{ checkIn: date,
      checkOut: new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
      roomIds: [roomId] }],
    guestName: "Synthetic Guest", contact: null, notes: null, totalCents: 10000,
    bookedAt: "2099-01-01", source: "os" });
  assert.equal(result.operationState, "awaiting_manual_sync");
  const requested = await set.service.requestManualChannelSync(set.owner, propertyId,
    result.bookingId, crypto.randomUUID(), result.bookingVersion, result.inventoryVersion);
  assert.equal(requested.operationState, "sync_pending");
  return requested.operationKey;
}

async function markManual(set, operationKey) {
  await set.repository.transact(propertyId, (state) => {
    const operation = state.operations.find((item) => item.key === operationKey);
    operation.lineGrantId = crypto.randomUUID();
    operation.lineActorId = "synthetic-line-actor";
    const booking = state.bookings.find((item) => item.id === operation.bookingId);
    booking.lineChannelBaselineNights = [];
    booking.lineChannelPending = operation.cells;
  });
}

test("worker commits a fresh exact provider readback before releasing the claim", async () => {
  const set = setup(), operationKey = await createPending(set);
  const result = await set.worker.runOne(set.channel, propertyId);
  assert.deepEqual(result, { state: "sync_verified", propertyId, operationKey });
  assert.equal(set.writes(), 1);
  const state = await set.repository.read(propertyId);
  assert.equal(state.channelDispatch, null);
  assert.equal(state.operations[0].state, "sync_verified");
  assert.equal(state.fences.length, 0);
  assert.deepEqual(set.alerts, []);
  assert.equal((await set.worker.runOne(set.channel, propertyId)).state, "idle");
});

test("immediate dispatch runs only its exact operation and a repeat cannot write again", async () => {
  const set = setup(), older = await createPending(set);
  const target = await createPending(set, "2099-11-12");
  const result = await set.worker.runOne(set.channel, propertyId, target);
  assert.deepEqual(result, { state: "sync_verified", propertyId, operationKey: target });
  assert.equal((await set.repository.read(propertyId)).operations.find(o => o.key === older).state,
    "sync_pending");
  assert.equal((await set.worker.runOne(set.channel, propertyId, target)).state, "sync_verified");
  assert.equal(set.writes(), 1);
});

test("immediate dispatch preserves an existing property claim and cannot target an unknown key", async () => {
  const set = setup(), operationKey = await createPending(set);
  await assert.rejects(set.worker.runOne(set.channel, propertyId, crypto.randomUUID()),
    error => error?.code === "OPERATION_NOT_FOUND");
  assert.equal(set.writes(), 0);
  const claim = { claimId: crypto.randomUUID(), operationKey, state: "active",
    claimedAt: new Date().toISOString() };
  await set.repository.transact(propertyId, state => { state.channelDispatch = claim; });
  assert.equal((await set.worker.runOne(set.channel, propertyId, operationKey)).state, "sync_pending");
  assert.deepEqual((await set.repository.read(propertyId)).channelDispatch, claim);
  assert.equal(set.writes(), 0);
});

test("immediate dispatch and cron overlap without a second provider write", async () => {
  const set = setup(), operationKey = await createPending(set);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const observing = new Promise(resolve => { entered = resolve; });
  const observe = set.provider.observe;
  set.provider.observe = async (...args) => {
    entered();
    await held;
    return observe(...args);
  };
  const started = set.worker.runOne(set.channel, propertyId, operationKey);
  await observing;
  assert.equal((await set.worker.runOne(set.channel, propertyId)).state, "idle");
  assert.equal((await set.worker.runOne(set.channel, propertyId, operationKey)).state, "sync_pending");
  assert.equal(set.writes(), 0);
  release();
  assert.equal((await started).state, "sync_verified");
  assert.equal(set.writes(), 1);
  assert.deepEqual(set.alerts, []);
});

test("already-closed OwlNest night stays under review without a provider write", async () => {
  const set = setup({ initiallyClosed: true }), operationKey = await createPending(set);
  const result = await set.worker.runOne(set.channel, propertyId);
  assert.equal(result.state, "review_required");
  assert.equal(set.writes(), 0);
  const state = await set.repository.read(propertyId);
  assert.equal(state.operations[0].initialOpenPreflight.status, "blocked");
  assert.equal(state.bookings[0].channelSyncState, "review_required");
  assert.equal(state.fences.length, 1);
  const recovery = await recoverChannelClaim({ repository: set.repository,
    service: set.service, provider: set.provider, principal: set.channel,
    propertyId, expectedClaimId: state.channelDispatch.claimId });
  assert.deepEqual(recovery, { state: "review_required", operationKey });
  assert.equal((await set.repository.read(propertyId)).fences.length, 1);
});

test("reviewed manual close releases only the property claim, then unrelated work proceeds", async () => {
  const set = setup({ initiallyClosed: true }), reviewedKey = await createPending(set);
  assert.equal((await set.worker.runOne(set.channel, propertyId)).state, "review_required");
  const nextKey = await createPending(set, "2099-11-12");
  assert.equal((await set.worker.runOne(set.channel, propertyId)).state, "idle");
  const before = await set.repository.read(propertyId);
  const releaseInput = { repository: set.repository, provider: set.provider,
    principal: set.channel, propertyId, expectedClaimId: before.channelDispatch.claimId,
    expectedInventoryVersion: before.version,
    reviewReason: "Reviewed preclosed night; keep its fence", acknowledgeQuarantine: true };
  await assert.rejects(releaseReviewedManualClaim({ ...releaseInput,
    acknowledgeQuarantine: false }), /CHANNEL_REVIEW_RELEASE_INVALID/);
  const result = await releaseReviewedManualClaim(releaseInput);
  assert.equal(result.claimReleased, true);
  const released = await set.repository.read(propertyId);
  assert.equal(released.channelDispatch, null);
  assert.equal(released.operations.find((item) => item.key === reviewedKey).state,
    "review_required");
  assert.equal(released.bookings[0].channelSyncState, "review_required");
  assert.ok(released.fences.some((item) => item.key === reviewedKey));
  assert.equal(released.operations.find((item) => item.key === reviewedKey).observations.at(-1).accepted,
    false);
  assert.equal(set.repository.auditRecords(propertyId).at(-1).type,
    "channel.review_claim_released");
  await assert.rejects(releaseReviewedManualClaim(releaseInput),
    /CHANNEL_REVIEW_RELEASE_STATE_MOVED/);
  assert.deepEqual(await set.worker.runOne(set.channel, propertyId),
    { state: "sync_verified", propertyId, operationKey: nextKey });
  assert.equal(set.writes(), 1);
  assert.ok((await set.repository.read(propertyId)).fences.some((item) => item.key === reviewedKey));
});

test("reviewed claim stays held on incomplete evidence or a changed property version", async () => {
  const set = setup({ initiallyClosed: true });
  await createPending(set);
  await set.worker.runOne(set.channel, propertyId);
  const state = await set.repository.read(propertyId);
  const input = { repository: set.repository, principal: set.channel, propertyId,
    expectedClaimId: state.channelDispatch.claimId,
    expectedInventoryVersion: state.version, reviewReason: "Retain the reviewed room-night fence",
    acknowledgeQuarantine: true };
  await assert.rejects(releaseReviewedManualClaim({ ...input,
    provider: { observe: async () => ({ observedAt: new Date().toISOString(),
      providerVersion: "incomplete", cells: [] }) } }),
  /CHANNEL_REVIEW_RELEASE_READBACK_INCOMPLETE/);
  await assert.rejects(releaseReviewedManualClaim({ ...input,
    provider: { observe: async () => ({ observedAt: new Date().toISOString(),
      providerVersion: "still-open", cells: [{ roomId, date: "2099-11-10",
        count: 1, isLock: false }] }) } }), /CHANNEL_REVIEW_RELEASE_STOCK_OPEN/);
  await assert.rejects(releaseReviewedManualClaim({ ...input, provider: set.provider,
    expectedInventoryVersion: state.version - 1 }), /CHANNEL_REVIEW_RELEASE_STATE_MOVED/);
  await assert.rejects(releaseReviewedManualClaim({ ...input, provider: set.provider,
    principal: { ...set.channel, actions: [] } }), /CHANNEL_REVIEW_RELEASE_INVALID/);
  assert.equal((await set.repository.read(propertyId)).channelDispatch.claimId,
    state.channelDispatch.claimId);
});

test("reviewed claim cannot release past another pending operation on the same night", async () => {
  const set = setup({ initiallyClosed: true });
  await createPending(set);
  await set.worker.runOne(set.channel, propertyId);
  await set.repository.transact(propertyId, (state) => {
    const key = crypto.randomUUID();
    state.operations.push({ key, bookingId: null, bookingVersion: 0,
      state: "sync_pending", cells: [{ roomId, date: "2099-11-10", desired: "closed" }],
      createdAt: new Date().toISOString(), verifiedAt: null, providerVersion: null });
    state.fences.push({ key, cells: [{ roomId, date: "2099-11-10" }],
      reason: "channel_pending" });
    state.version++;
  });
  const state = await set.repository.read(propertyId);
  await assert.rejects(releaseReviewedManualClaim({ repository: set.repository,
    provider: set.provider, principal: set.channel, propertyId,
    expectedClaimId: state.channelDispatch.claimId,
    expectedInventoryVersion: state.version, acknowledgeQuarantine: true,
    reviewReason: "Overlapping operation needs investigation" }),
  /CHANNEL_REVIEW_RELEASE_STATE_MOVED/);
  assert.equal((await set.repository.read(propertyId)).channelDispatch.claimId,
    state.channelDispatch.claimId);
});

test("crash after a manual close cannot be auto-verified from final stock", async () => {
  const set = setup(), operationKey = await createPending(set), claimId = crypto.randomUUID();
  await set.repository.transact(propertyId, (state) => {
    state.channelDispatch = { claimId, operationKey,
      state: "active", claimedAt: new Date().toISOString() };
  });
  await set.service.recordManualChannelPreflight(set.channel, { propertyId,
    operationKey, providerVersion: "synthetic-open", observedAt: new Date().toISOString(),
    cells: [{ roomId, date: "2099-11-10", count: 1, isLock: false }] });
  await set.provider.setNight(propertyId, { roomId, date: "2099-11-10",
    desired: "closed", operationKey });
  const recovery = await recoverChannelClaim({ repository: set.repository,
    service: set.service, provider: set.provider, principal: set.channel,
    propertyId, expectedClaimId: claimId });
  assert.deepEqual(recovery, { state: "review_required", operationKey });
  const state = await set.repository.read(propertyId);
  assert.equal(state.operations[0].state, "review_required");
  assert.equal(state.bookings[0].channelSyncState, "review_required");
  assert.equal(state.channelDispatch.state, "review_required");
  assert.equal(state.fences.length, 1);
  assert.equal((await set.worker.runOne(set.channel, propertyId)).state, "idle");
  const released = await releaseReviewedManualClaim({ repository: set.repository,
    provider: set.provider, principal: set.channel, propertyId, expectedClaimId: claimId,
    expectedInventoryVersion: state.version, acknowledgeQuarantine: true,
    reviewReason: "Unknown write outcome remains under review" });
  assert.equal(released.claimReleased, true);
  const quarantined = await set.repository.read(propertyId);
  assert.equal(quarantined.channelDispatch, null);
  assert.equal(quarantined.operations[0].state, "review_required");
  assert.equal(quarantined.bookings[0].channelSyncState, "review_required");
  assert.equal(quarantined.fences.length, 1);
});

test("unknown OwlNest outcome keeps the fence and claim for review", async () => {
  const set = setup({ providerFails: true }), operationKey = await createPending(set);
  const result = await set.worker.runOne(set.channel, propertyId);
  assert.equal(result.state, "review_required");
  assert.equal(set.writes(), 1);
  const state = await set.repository.read(propertyId);
  assert.equal(state.channelDispatch.state, "review_required");
  assert.equal(state.operations[0].state, "review_required");
  assert.equal(state.fences.length, 1);
  assert.equal((await set.worker.runOne(set.channel, propertyId)).state, "idle");
  assert.deepEqual(set.alerts, [{ propertyId, operationKey, status: "review_required" }]);
});

test("worker rejects the wrong principal before any provider call", async () => {
  const set = setup();
  await createPending(set);
  await assert.rejects(set.worker.runOne({ ...set.channel, origin: "line" }, propertyId),
    { message: "CHANNEL_WORKER_PRINCIPAL_INVALID" });
  assert.equal(set.writes(), 0);
  assert.equal((await set.repository.read(propertyId)).channelDispatch, undefined);
});

test("login failure before dispatch leaves the pending operation unclaimed", async () => {
  const set = setup(), operationKey = await createPending(set);
  let attempts = 0;
  const worker = createChannelWorker({ repository: set.repository, service: set.service,
    propertyConfigs: { [propertyId]: { hotelId: 6188, roomIds: { [roomId]: 29260 } } },
    getAuthorization: async () => { attempts++; throw Error("SYNTHETIC_LOGIN_FAILED"); },
    onReview: async () => { throw Error("NO_DISPATCH_TO_REVIEW"); } });
  await assert.rejects(worker.runOne(set.channel, propertyId),
    { message: "SYNTHETIC_LOGIN_FAILED" });
  assert.equal(attempts, 1);
  const state = await set.repository.read(propertyId);
  assert.equal(state.channelDispatch, undefined);
  assert.equal(state.operations[0].key, operationKey);
  assert.equal(state.operations[0].state, "sync_pending");
});

test("an overlapping cron tick does not report a normal active claim as group failure", async () => {
  const set = setup(), operationKey = await createPending(set);
  await set.repository.transact(propertyId, (state) => {
    state.channelDispatch = { claimId: crypto.randomUUID(), operationKey,
      state: "active", claimedAt: new Date().toISOString() };
  });
  assert.deepEqual(await set.worker.runOne(set.channel, propertyId),
    { state: "idle", propertyId });
  assert.equal(set.writes(), 0);
  assert.deepEqual(set.alerts, []);
});

test("three manual LINE login failures become fenced review and retry the alert callback", async () => {
  const set = setup(), operationKey = await createPending(set);
  await markManual(set, operationKey);
  let attempts = 0, alerts = 0;
  const worker = createChannelWorker({ repository: set.repository, service: set.service,
    propertyConfigs: { [propertyId]: { hotelId: 6188, roomIds: { [roomId]: 29260 } } },
    getAuthorization: async () => { attempts++; throw Error("SYNTHETIC_LOGIN_FAILED"); },
    onReview: async (item) => {
      assert.equal(item.operationKey, operationKey);
      assert.equal(item.status, "review_required");
      alerts++;
      if (alerts === 1) throw Error("SYNTHETIC_CALLBACK_FAILED");
    } });
  await assert.rejects(worker.runOne(set.channel, propertyId), { message: "SYNTHETIC_LOGIN_FAILED" });
  await assert.rejects(worker.runOne(set.channel, propertyId), { message: "SYNTHETIC_LOGIN_FAILED" });
  assert.equal((await worker.runOne(set.channel, propertyId)).state, "review_required");
  assert.equal(attempts, 3);
  let state = await set.repository.read(propertyId);
  assert.equal(state.operations[0].state, "review_required");
  assert.equal(state.bookings[0].channelSyncState, "review_required");
  assert.equal(state.fences.length, 1);
  assert.equal((await worker.runOne(set.channel, propertyId)).state, "idle");
  assert.equal((await worker.runOne(set.channel, propertyId)).state, "idle");
  state = await set.repository.read(propertyId);
  assert.equal(alerts, 2);
  assert.ok(state.operations[0].reviewAlertedAt);
});

test("an abandoned manual dispatch claim becomes review without a second provider write", async () => {
  const set = setup(), operationKey = await createPending(set);
  await markManual(set, operationKey);
  await set.repository.transact(propertyId, (state) => {
    state.channelDispatch = { claimId: crypto.randomUUID(), operationKey,
      state: "active", claimedAt: new Date(Date.now() - 8 * 60_000).toISOString() };
  });
  assert.equal((await set.worker.runOne(set.channel, propertyId)).state, "review_required");
  const state = await set.repository.read(propertyId);
  assert.equal(state.operations[0].state, "review_required");
  assert.equal(state.channelDispatch.state, "active");
  assert.equal(set.writes(), 0);
  assert.equal(state.fences.length, 1);
});
