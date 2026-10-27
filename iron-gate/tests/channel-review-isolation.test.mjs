import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";
import { createChannelWorker } from "../src/channel-worker.mjs";
import { createChannelDispatchClaim } from "../src/channel-dispatch-claim.mjs";
import { recoverChannelClaim } from "../src/channel-recovery.mjs";
import { transferReviewedChannelOperation } from "../src/channel-review-transfer.mjs";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";
import { createHash } from "node:crypto";
import { createChannelReviewTransferFetch } from "../api/channel-review-transfer.mjs";

const id = n => `${n}`.repeat(8) + "-1111-4111-8111-111111111111";
const propertyId = id(2), roomId = id(3), otherRoom = id(8), oldKey = id(7);
const oldCell = {roomId, date: "2099-02-09"}, newCell = {roomId, date: "2099-01-22"};
const oldClaim = {claimId: id(9), operationKey: oldKey, state: "review_required",
  claimedAt: "2026-01-01T00:00:00.000Z", scopeVersion: 1, settledAt: "2026-01-01T00:01:00.000Z"};

function setup() {
  const repository = new MemoryPropertyRepository();
  repository.seed({workspaceId: id(1), propertyId, roomIds: [roomId, otherRoom], version: 7,
    authorityEpoch: 1, readOnly: false, channel: {mode: "owlnest", ready: true,
      sourceReadbackEnabled: true, grantId: id(4), stockObservedFrom: "2099-01-01",
      stockObservedThrough: "2099-12-31"}, sourceGrants: [], manualBlocks: [], receipts: [], sourceLinks: [],
    bookings: [{id: id(5), version: 3, status: "confirmed", channelSyncState: "review_required",
      channelOperationKey: oldKey, stays: [{checkIn: oldCell.date, checkOut: "2099-02-10", roomIds: [roomId]}]}],
    fences: [{key: oldKey, cells: [oldCell], reason: "channel_pending"}], channelDispatch: structuredClone(oldClaim),
    operations: [{key: oldKey, bookingId: id(5), bookingVersion: 3, state: "review_required",
      cells: [{...oldCell, desired: "closed"}], createdAt: "2026-01-01T00:00:00.000Z",
      verifiedAt: null, providerVersion: null, ownCloseWriteRequired: true,
      lineGrantId: id(6), lineActorId: "synthetic-staff", reviewAlertedAt: "2026-01-01T00:01:00.000Z",
      observations: [{observedAt: "2026-01-01T00:00:30.000Z", providerVersion: "old",
        cells: [{...oldCell, count: 1, isLock: false}], exact: false, accepted: false}]}]});
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = {clientId: "line", subjectId: "synthetic-staff", origin: "line",
    workspaceId: id(1), propertyIds: [propertyId], authorityEpoch: 1, grantId: id(6),
    actions: ["booking:read", "booking:manage_all", "inventory:write"], fields: []};
  const channel = {...actor, origin: "channel", grantId: id(4), actions: ["channel:verify"]};
  const calls = {observed: [], written: [], alerts: []}, stock = new Map();
  const provider = {async observe(_property, cells) {
    calls.observed.push(...cells.map(cell => ({roomId: cell.roomId, date: cell.date})));
    return {observedAt: new Date().toISOString(), providerVersion: "synthetic",
      cells: cells.map(({roomId, date}) => ({roomId, date,
        ...(stock.get(`${roomId}|${date}`) ?? {count: 1, isLock: false})}))};
  }, async setNight(_property, cell) {
    calls.written.push(cell);
    stock.set(`${cell.roomId}|${cell.date}`, cell.desired === "closed" ?
      {count: 0, isLock: true} : {count: 1, isLock: false});
  }};
  const worker = createChannelWorker({repository, service, provider,
    onReview: async item => {calls.alerts.push(item);}});
  return {repository, service, actor, channel, calls, provider, worker, stock};
}
const preserved = s => ({oldOperation: s.operations.find(o => o.key === oldKey),
  bookings: s.bookings, fences: s.fences, manualBlocks: s.manualBlocks,
  version: s.version, sourceLinks: s.sourceLinks});
async function request(set, cell = newCell) {
  const input = {cells: [cell], desired: "closed"}, key = crypto.randomUUID();
  const preview = await set.service.previewLineRoomControl(set.actor, propertyId, input);
  await set.service.requestLineRoomControl(set.actor, propertyId, key, input, preview.previewToken);
  return key;
}
async function pending(set, cell = newCell, key = crypto.randomUUID()) {
  await set.repository.transact(propertyId, state => {state.operations.push({
    key, bookingId: null, bookingVersion: 0, controlMode: "provider_only", state: "sync_pending",
    cells: [{...cell, desired: "closed"}], createdAt: new Date().toISOString(), verifiedAt: null,
    providerVersion: null, lineGrantId: set.actor.grantId, lineActorId: set.actor.subjectId});});
  return key;
}

for (const cell of [newCell, {...oldCell, roomId: otherRoom}]) {
  test(`scoped settled review is retained while unrelated ${cell.roomId}/${cell.date} completes`, async () => {
    const set = setup(), before = preserved(await set.repository.read(propertyId));
    const key = await request(set, cell);
    const queued = await set.service.lineChannelAction(set.actor, propertyId, key);
    assert.equal(queued.dispatchStatus, "queued");
    assert.equal(queued.blockingReason, null);
    assert.ok(queued.queuedAt);
    assert.equal((await set.worker.runOne(set.channel, propertyId, key)).state, "sync_verified");
    const after = await set.repository.read(propertyId);
    assert.deepEqual(preserved(after), before);
    assert.equal(after.channelDispatch, null);
    assert.equal(after.channelReviewHolds.length, 1);
    assert.deepEqual(after.channelReviewHolds[0].claim, oldClaim);
    assert.deepEqual(after.channelReviewHolds[0].cells, [{...oldCell, desired: "closed"}]);
    assert.equal(set.calls.written.length, 1);
    assert(set.calls.observed.every(c => c.roomId === cell.roomId && c.date === cell.date));
    const audit = set.repository.auditRecords(propertyId).filter(a => a.type === "channel.review_isolated");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].requestKey, oldKey);
    const terminal = await set.service.lineChannelAction(set.actor, propertyId, key);
    assert.equal(terminal.state, "sync_verified");
    assert.equal(terminal.dispatchStatus, undefined);
    await set.worker.runOne(set.channel, propertyId, key);
    assert.equal(set.calls.written.length, 1);
  });
}

test("overlapping pending work is truthful and cannot bypass the claim transaction", async () => {
  const set = setup(), key = await pending(set, oldCell);
  const status = await set.service.lineChannelAction(set.actor, propertyId, key);
  assert.equal(status.dispatchStatus, "blocked_by_review");
  assert.equal(status.blockingReason, "reviewed_operation_overlap");
  assert.equal(JSON.stringify(status).includes(oldKey), false);
  assert.equal((await set.worker.runOne(set.channel, propertyId, key)).state, "sync_pending");
  await assert.rejects(createChannelDispatchClaim(set.repository).forOperation(key)(propertyId,
    async () => assert.fail("overlapping writer entered")), /CHANNEL_REVIEW_BLOCKED/);
  assert.equal(set.calls.observed.length, 0);
  assert.equal(set.calls.written.length, 0);
  assert.deepEqual((await set.repository.read(propertyId)).channelDispatch, oldClaim);
});

test("preview and confirmation both refuse a reviewed overlap without creating an operation", async () => {
  const set = setup(), input = {cells: [oldCell], desired: "closed"};
  await assert.rejects(set.service.previewLineRoomControl(set.actor, propertyId, input),
    e => e.code === "LINE_CHANNEL_REVIEW_BLOCKED");
  await set.repository.transact(propertyId, s => {s.channelDispatch = null;});
  const preview = await set.service.previewLineRoomControl(set.actor, propertyId, input);
  await set.repository.transact(propertyId, s => {s.channelDispatch = structuredClone(oldClaim);});
  await assert.rejects(set.service.requestLineRoomControl(set.actor, propertyId, crypto.randomUUID(),
    input, preview.previewToken), e => e.code === "LINE_CHANNEL_REVIEW_BLOCKED");
  assert.equal((await set.repository.read(propertyId)).operations.length, 1);
});

test("an active claim is never isolated, even after a long delay", async () => {
  const set = setup(), key = await pending(set);
  await set.repository.transact(propertyId, s => {s.channelDispatch.state = "active";});
  assert.equal((await set.service.lineChannelAction(set.actor, propertyId, key)).dispatchStatus, "queued");
  assert.equal((await set.worker.runOne(set.channel, propertyId, key)).state, "sync_pending");
  const state = await set.repository.read(propertyId);
  assert.equal(state.channelDispatch.state, "active");
  assert.equal(state.channelReviewHolds, undefined);
  assert.equal(set.calls.observed.length, 0);
});

test("an externally reviewed active writer cannot be auto-isolated without runner settlement", async () => {
  const set = setup(), key = await pending(set);
  await set.repository.transact(propertyId, state => {delete state.channelDispatch.settledAt;});
  const before = await set.repository.read(propertyId);
  const status = await set.service.lineChannelAction(set.actor, propertyId, key);
  assert.equal(status.blockingReason, "review_isolation_required");
  assert.equal((await set.worker.runOne(set.channel, propertyId, key)).state, "sync_pending");
  assert.deepEqual(await set.repository.read(propertyId), before);
  assert.equal(set.calls.observed.length, 0);
});

for (const corrupt of [
  state => {state.operations[0].cells = [];},
  state => {state.operations[0].cells.push({...state.operations[0].cells[0]});},
  state => {state.operations[0].cells[0].date = "2099-02-31";},
  state => {state.channelDispatch.operationKey = crypto.randomUUID();},
]) test("unknown review scope fails closed without touching the provider", async () => {
  const set = setup(), key = await pending(set);
  await set.repository.transact(propertyId, corrupt);
  const before = await set.repository.read(propertyId);
  const status = await set.service.lineChannelAction(set.actor, propertyId, key);
  assert.equal(status.dispatchStatus, "blocked_by_review");
  assert.equal(status.blockingReason, "review_scope_unavailable");
  assert.equal((await set.worker.runOne(set.channel, propertyId, key)).state, "sync_pending");
  assert.deepEqual(await set.repository.read(propertyId), before);
  assert.equal(set.calls.observed.length, 0);
});

test("cron skips an overlapping queued request and completes an unrelated request", async () => {
  const set = setup(), blocked = await pending(set, oldCell), key = await pending(set);
  const result = await set.worker.runOne(set.channel, propertyId);
  assert.equal(result.operationKey, key);
  assert.equal(result.state, "sync_verified");
  assert.equal((await set.service.lineChannelAction(set.actor, propertyId, blocked)).dispatchStatus,
    "blocked_by_review");
  assert.equal((await set.service.pendingChannelOperations(set.channel, propertyId, 10)).operations.length, 0);
  assert.equal(set.calls.written.length, 1);
});

test("concurrent acceleration/cron keeps one writer; old recovery cannot clear the new claim", async () => {
  const set = setup(), key = await pending(set);
  let enter, release;
  const entered = new Promise(resolve => {enter = resolve;});
  const held = new Promise(resolve => {release = resolve;});
  const observe = set.provider.observe;
  set.provider.observe = async (...args) => {enter(); await held; return observe(...args);};
  const first = set.worker.runOne(set.channel, propertyId, key);
  await entered;
  const during = await set.service.lineChannelAction(set.actor, propertyId, key);
  assert.equal(during.dispatchStatus, "running");
  await set.worker.runOne(set.channel, propertyId);
  await set.worker.runOne(set.channel, propertyId, key);
  await assert.rejects(recoverChannelClaim({repository: set.repository, service: set.service,
    provider: set.provider, principal: set.channel, propertyId, expectedClaimId: oldClaim.claimId}),
  /CHANNEL_RECOVERY_CLAIM_MOVED/);
  assert.equal((await set.repository.read(propertyId)).channelDispatch.operationKey, key);
  release();
  assert.equal((await first).state, "sync_verified");
  assert.equal(set.calls.written.length, 1);
  assert.equal((await set.repository.read(propertyId)).channelReviewHolds.length, 1);
});

test("persisted holds reject tampering and overlapping direct claim acquisition", async () => {
  const set = setup(), key = await pending(set);
  await set.worker.runOne(set.channel, propertyId, key);
  const overlap = await pending(set, oldCell);
  await assert.rejects(createChannelDispatchClaim(set.repository).forOperation(overlap)(propertyId,
    async () => assert.fail("held night reached writer")), /CHANNEL_REVIEW_BLOCKED/);
  await set.repository.transact(propertyId, s => {s.channelReviewHolds[0].cells[0].date = "2099-02-10";});
  const unrelated = await pending(set, {...newCell, date: "2099-01-23"});
  assert.equal((await set.service.lineChannelAction(set.actor, propertyId, unrelated)).blockingReason,
    "review_scope_unavailable");
  assert(checkPropertyIntegrity(await set.repository.read(propertyId), []).issues.includes("INVALID_CHANNEL_REVIEW_HOLD"));
  await assert.rejects(createChannelDispatchClaim(set.repository).forOperation(unrelated)(propertyId,
    async () => assert.fail("invalid scope reached writer")), /CHANNEL_REVIEW_BLOCKED/);
});

async function legacyTransfer(set, key, overrides = {}) {
  return transferReviewedChannelOperation({repository: set.repository, service: set.service,
    provider: set.provider, principal: set.channel, propertyId, targetOperationKey: key,
    expectedClaimId: oldClaim.claimId, expectedInventoryVersion: 7,
    expectedCells: [{...newCell, desired: "closed"}],
    reviewReason: "Operator reviewed the legacy scope; retain its unresolved evidence", ...overrides});
}

test("deploying alone cannot release a legacy claim; explicit transfer runs only the original pending key", async () => {
  const set = setup(), key = await pending(set);
  await set.repository.transact(propertyId, state => {delete state.channelDispatch.scopeVersion;});
  const before = await set.repository.read(propertyId), old = preserved(before);
  const status = await set.service.lineChannelAction(set.actor, propertyId, key);
  assert.equal(status.dispatchStatus, "blocked_by_review");
  assert.equal(status.blockingReason, "review_isolation_required");
  assert.equal((await set.worker.runOne(set.channel, propertyId)).state, "idle");
  assert.equal((await set.worker.runOne(set.channel, propertyId, key)).state, "sync_pending");
  assert.deepEqual(await set.repository.read(propertyId), before);
  assert.equal(set.calls.observed.length, 0);
  const result = await legacyTransfer(set, key);
  assert.equal(result.operationKey, key);
  assert.equal(result.state, "sync_verified");
  const after = await set.repository.read(propertyId);
  assert.deepEqual(preserved(after), old);
  assert.equal(after.operations.length, before.operations.length);
  assert.equal(after.channelReviewHolds.length, 1);
  assert.deepEqual(after.channelReviewHolds[0].claim, before.channelDispatch);
  assert.equal(after.channelReviewHolds[0].observation.cells[0].count, 1);
  assert.equal(after.channelReviewHolds[0].observation.cells[0].isLock, false);
  assert.deepEqual(set.calls.written.map(c => c.operationKey), [key]);
  assert.deepEqual(set.calls.written.map(({roomId, date}) => ({roomId, date})), [newCell]);
  await assert.rejects(legacyTransfer(set, key), /CHANNEL_REVIEW_TRANSFER_STATE_MOVED/);
  assert.equal(set.calls.written.length, 1);
});

for (const overrides of [
  {expectedInventoryVersion: 6}, {expectedClaimId: id(1)},
  {expectedCells: [{...oldCell, desired: "closed"}]}, {reviewReason: "short"},
]) test("operator transfer refuses stale authority or target without provider access", async () => {
  const set = setup(), key = await pending(set);
  await set.repository.transact(propertyId, state => {delete state.channelDispatch.scopeVersion;});
  const before = await set.repository.read(propertyId);
  await assert.rejects(legacyTransfer(set, key, overrides), /CHANNEL_REVIEW_TRANSFER_/);
  assert.deepEqual(await set.repository.read(propertyId), before);
  assert.equal(set.calls.observed.length, 0);
});

test("a concurrent change during legacy GET cannot archive the claim or write the target", async () => {
  const set = setup(), key = await pending(set);
  await set.repository.transact(propertyId, state => {delete state.channelDispatch.scopeVersion;});
  const observe = set.provider.observe;
  set.provider.observe = async (...args) => {
    await set.repository.transact(propertyId, state => {state.version++;});
    return observe(...args);
  };
  await assert.rejects(legacyTransfer(set, key), /CHANNEL_REVIEW_TRANSFER_STATE_MOVED/);
  const state = await set.repository.read(propertyId);
  assert.equal(state.channelDispatch.claimId, oldClaim.claimId);
  assert.equal(state.channelReviewHolds, undefined);
  assert.equal(set.calls.written.length, 0);
});

for (const boundary of ["before GET", "during GET", "inside claim transaction"]) {
  test(`expired operator transfer ${boundary} retains the old claim and writes nothing`, async t => {
    const set = setup(), key = await pending(set);
    await set.repository.transact(propertyId, state => {delete state.channelDispatch.scopeVersion;});
    const before = await set.repository.read(propertyId), realNow = Date.now();
    let tick = realNow;
    t.mock.method(Date, "now", () => tick);
    const expiresAt = new Date(realNow + 1000).toISOString();
    if (boundary === "before GET") tick += 1001;
    if (boundary === "during GET") {
      const observe = set.provider.observe;
      set.provider.observe = async (...args) => {tick += 1001; return observe(...args);};
    }
    if (boundary === "inside claim transaction") {
      const transact = set.repository.transact.bind(set.repository);
      set.repository.transact = (id, callback) => transact(id, (...args) => {
        tick += 1001;
        return callback(...args);
      });
    }
    await assert.rejects(legacyTransfer(set, key, {expiresAt}), /CHANNEL_REVIEW_TRANSFER_EXPIRED/);
    assert.deepEqual(await set.repository.read(propertyId), before);
    assert.equal(set.calls.written.length, 0);
    if (boundary === "before GET") assert.equal(set.calls.observed.length, 0);
  });
}

test("concurrent authorized HTTP transfers and a duplicate execute the original target only once", async () => {
  const set = setup(), key = await pending(set);
  await set.repository.transact(propertyId, state => {delete state.channelDispatch.scopeVersion;});
  const before = preserved(await set.repository.read(propertyId)), token = "t".repeat(43), now = Date.now();
  const intent = {propertyId, targetOperationKey: key, expectedClaimId: oldClaim.claimId,
    expectedInventoryVersion: 7, expectedCells: [{...newCell, desired: "closed"}],
    reviewReason: "Authorized fixed target runtime transfer", issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 899_000).toISOString()};
  const env = {VERCEL_ENV: "production", IRON_GATE_PRODUCTION_ENABLED: "true",
    IRON_GATE_PRODUCTION_CHANNEL_WORKER_ENABLED: "true",
    IRON_GATE_PRODUCTION_CHANNEL_REVIEW_TRANSFER_ENABLED: "true", IRON_GATE_CHANNEL_PROPERTY_ID: propertyId,
    IRON_GATE_CHANNEL_REVIEW_TRANSFER_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"),
    IRON_GATE_CHANNEL_REVIEW_TRANSFER_INTENT_JSON: JSON.stringify(intent)};
  const handler = createChannelReviewTransferFetch(env, {execute: pinned => legacyTransfer(set, key, pinned)});
  const req = () => new Request("https://example.test/api/channel-review-transfer", {method: "POST",
    headers: {authorization: "Bearer " + token, "content-type": "application/json"}, body: "{}"});
  const observe = set.provider.observe;
  let entered = 0, release;
  const bothEntered = new Promise(resolve => {release = resolve;});
  set.provider.observe = async (...args) => {
    if (args[1][0].date === oldCell.date) {
      entered++;
      if (entered === 2) release();
      await bothEntered;
    }
    return observe(...args);
  };
  const responses = await Promise.all([handler(req()), handler(req())]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal((await handler(req())).status, 409);
  const after = await set.repository.read(propertyId);
  assert.deepEqual(preserved(after), before);
  assert.equal(after.channelDispatch, null);
  assert.equal(after.channelReviewHolds.length, 1);
  assert.deepEqual(set.calls.written.map(c => c.operationKey), [key]);
  assert.deepEqual(set.calls.written.map(({roomId, date}) => ({roomId, date})), [newCell]);
});

test("authority changes during operator GET cannot archive or acquire a new claim", async () => {
  const set = setup(), key = await pending(set);
  await set.repository.transact(propertyId, state => {delete state.channelDispatch.scopeVersion;});
  const observe = set.provider.observe;
  set.provider.observe = async (...args) => {
    await set.repository.transact(propertyId, state => {state.authorityEpoch++;});
    return observe(...args);
  };
  await assert.rejects(legacyTransfer(set, key));
  const state = await set.repository.read(propertyId);
  assert.equal(state.channelDispatch.claimId, oldClaim.claimId);
  assert.equal(state.channelReviewHolds, undefined);
  assert.equal(set.calls.written.length, 0);
});

test("operator transfer verifies an already-closed target without any provider write", async () => {
  const set = setup(), key = await pending(set);
  await set.repository.transact(propertyId, state => {delete state.channelDispatch.scopeVersion;});
  set.stock.set(`${newCell.roomId}|${newCell.date}`, {count: 0, isLock: true});
  assert.equal((await legacyTransfer(set, key)).state, "sync_verified");
  assert.equal(set.calls.written.length, 0);
  const state = await set.repository.read(propertyId);
  assert.equal(state.channelReviewHolds.length, 1);
  assert.equal(state.operations.find(o => o.key === oldKey).state, "review_required");
});

test("incomplete or stale operator GET evidence cannot isolate a legacy claim", async () => {
  for (const evidence of [
    {observedAt: new Date().toISOString(), providerVersion: "incomplete", cells: []},
    {observedAt: "2026-01-01T00:00:00.000Z", providerVersion: "stale", cells: [{...oldCell, count: 0, isLock: true}]},
  ]) {
    const set = setup(), key = await pending(set);
    await set.repository.transact(propertyId, state => {delete state.channelDispatch.scopeVersion;});
    set.provider.observe = async () => evidence;
    await assert.rejects(legacyTransfer(set, key), /CHANNEL_REVIEW_TRANSFER_/);
    assert.equal((await set.repository.read(propertyId)).channelDispatch.claimId, oldClaim.claimId);
    assert.equal(set.calls.written.length, 0);
  }
});

test("a new caught provider read failure becomes a scoped review without replaying that operation", async () => {
  const set = setup(), key = await pending(set);
  const observe = set.provider.observe;
  set.provider.observe = async () => {throw Error("SYNTHETIC_READ_FAILED");};
  await assert.rejects(set.worker.runOne(set.channel, propertyId, key), /SYNTHETIC_READ_FAILED/);
  let state = await set.repository.read(propertyId);
  assert.equal(state.operations.find(o => o.key === key).state, "review_required");
  assert.equal(state.channelDispatch.state, "review_required");
  assert.equal(state.channelDispatch.scopeVersion, 1);
  set.provider.observe = observe;
  const nextCell = {...newCell, date: "2099-01-23"}, next = await request(set, nextCell);
  assert.equal((await set.worker.runOne(set.channel, propertyId, next)).state, "sync_verified");
  state = await set.repository.read(propertyId);
  assert.equal(state.channelReviewHolds.length, 2);
  assert.equal(state.operations.find(o => o.key === key).state, "review_required");
  assert.deepEqual(set.calls.written.map(c => c.operationKey), [next]);
});

test("unrelated scoped reviews do not prevent bounded login failure handling", async () => {
  const set = setup(), key = await pending(set);
  let attempts = 0;
  const worker = createChannelWorker({repository: set.repository, service: set.service,
    propertyConfigs: {[propertyId]: {hotelId: 6188, roomIds: {[roomId]: 29260, [otherRoom]: 29261}}},
    getAuthorization: async () => {attempts++; throw Error("SYNTHETIC_LOGIN_FAILED");},
    onReview: async () => {}});
  await assert.rejects(worker.runOne(set.channel, propertyId, key), /SYNTHETIC_LOGIN_FAILED/);
  await assert.rejects(worker.runOne(set.channel, propertyId, key), /SYNTHETIC_LOGIN_FAILED/);
  assert.equal((await worker.runOne(set.channel, propertyId, key)).state, "review_required");
  const state = await set.repository.read(propertyId);
  assert.equal(attempts, 3);
  assert.equal(state.operations.find(o => o.key === key).preflightFailures, 3);
  assert.deepEqual(state.channelDispatch, oldClaim);
  assert.equal(state.channelReviewHolds, undefined);
});
