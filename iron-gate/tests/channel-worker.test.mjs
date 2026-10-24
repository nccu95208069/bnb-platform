import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";
import { createChannelWorker } from "../src/channel-worker.mjs";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const channelGrant = "44444444-4444-4444-8444-444444444444";

function setup({ providerFails = false } = {}) {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId, propertyId, roomIds: [roomId], version: 1,
    authorityEpoch: 1, readOnly: false,
    channel: { mode: "owlnest", ready: true, sourceReadbackEnabled: true,
      websiteSalesEnabled: false, grantId: channelGrant, websiteBindingId: null },
    sourceGrants: [], bookings: [], sourceLinks: [], operations: [], fences: [],
    manualBlocks: [], receipts: [] });
  const service = new IronGateService(repository);
  const owner = { clientId: "os-client", subjectId: "os-user", origin: "os",
    workspaceId, propertyIds: [propertyId], authorityEpoch: 1,
    actions: ["booking:create"], fields: [], grantId: null };
  const channel = { clientId: "channel-client", subjectId: "channel-worker", origin: "channel",
    workspaceId, propertyIds: [propertyId], authorityEpoch: 1,
    actions: ["channel:verify"], fields: [], grantId: channelGrant };
  let stock = { count: 1, isLock: false }, writes = 0;
  const alerts = [];
  const provider = {
    observe: async () => ({ observedAt: new Date().toISOString(), providerVersion: "synthetic-v1",
      cells: [{ roomId, date: "2099-11-10", ...stock }] }),
    setNight: async () => {
      writes++;
      if (providerFails) throw Error("SYNTHETIC_UNKNOWN_WRITE");
      stock = { count: 0, isLock: true };
    },
  };
  const worker = createChannelWorker({ repository, service, provider,
    onReview: async (item) => { alerts.push(item); } });
  return { repository, service, owner, channel, worker, alerts,
    writes: () => writes };
}

async function createPending(set) {
  const result = await set.service.createBooking(set.owner, propertyId, crypto.randomUUID(), {
    expectedInventoryVersion: 1,
    stays: [{ checkIn: "2099-11-10", checkOut: "2099-11-11", roomIds: [roomId] }],
    guestName: "Synthetic Guest", contact: null, notes: null, totalCents: 10000,
    bookedAt: "2099-01-01", source: "os" });
  assert.equal(result.operationState, "sync_pending");
  return result.operationKey;
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

test("unknown OwlNest outcome keeps the fence and claim for review", async () => {
  const set = setup({ providerFails: true }), operationKey = await createPending(set);
  const result = await set.worker.runOne(set.channel, propertyId);
  assert.equal(result.state, "review_required");
  assert.equal(set.writes(), 1);
  const state = await set.repository.read(propertyId);
  assert.equal(state.channelDispatch.state, "review_required");
  assert.equal(state.operations[0].state, "review_required");
  assert.equal(state.fences.length, 1);
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
  await assert.rejects(set.worker.runOne(set.channel, propertyId),
    { message: "CHANNEL_PROPERTY_CLAIMED" });
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
