import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";
import { createHandler } from "../src/http.ts";
import { createChannelWorker } from "../src/channel-worker.mjs";
import { createChannelDispatchClaim } from "../src/channel-dispatch-claim.mjs";
import { reconcileChannelOperation } from "../src/channel-runner.mjs";
import { recoverChannelClaim } from "../src/channel-recovery.mjs";

const id = n => `${n}`.repeat(8) + "-1111-4111-8111-111111111111";
const propertyId = id(2), roomId = id(3), cell = {roomId, date: "2099-11-10"};
function setup() {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId: id(1), propertyId, roomIds: [roomId], version: 7,
    authorityEpoch: 1, readOnly: false, channel: {mode: "owlnest", ready: true,
      sourceReadbackEnabled: true, grantId: id(4), stockObservedFrom: "2099-01-01",
      stockObservedThrough: "2099-12-31"}, sourceGrants: [],
    bookings: [{id: id(5), version: 3, status: "confirmed", channelSyncState: "awaiting_manual_sync",
      channelOperationKey: null, stays: [{checkIn: cell.date, checkOut: "2099-11-11", roomIds: [roomId]}]}],
    manualBlocks: [cell], fences: [{key: "os-manual", cells: [cell], reason: "channel_pending"}],
    operations: [], receipts: [], sourceLinks: []});
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = {clientId: "line", subjectId: "synthetic-staff", origin: "line",
    workspaceId: id(1), propertyIds: [propertyId], authorityEpoch: 1, grantId: id(6),
    actions: ["booking:read", "booking:manage_all", "inventory:write"], fields: []};
  const channel = {...actor, origin: "channel", grantId: id(4), actions: ["channel:verify"]};
  return {repository, service, actor, channel};
}
const orderState = s => ({bookings: s.bookings, manualBlocks: s.manualBlocks,
  fences: s.fences, version: s.version, sourceLinks: s.sourceLinks});
const code = value => error => error.code === value;

for (const desired of ["closed", "open"]) {
  test(`independent ${desired}: OS occupancy/edits do not block and provider readback leaves OS untouched`, async () => {
    const {repository, service, actor, channel} = setup();
    const input = {cells: [cell], desired}, key = crypto.randomUUID();
    const preview = await service.previewLineRoomControl(actor, propertyId, input);
    await repository.transact(propertyId, state => {state.version++; state.bookings[0].version++;});
    const before = orderState(await repository.read(propertyId));
    const receipt = await service.requestLineRoomControl(actor, propertyId, key, input, preview.previewToken);
    assert.equal(receipt.controlMode, "provider_only");
    assert.deepEqual(orderState(await repository.read(propertyId)), before);
    assert.deepEqual(await service.requestLineRoomControl(actor, propertyId, key, input, preview.previewToken), receipt);
    let actual = desired === "closed" ? {count: 0, isLock: false} : {count: 0, isLock: true};
    let writes = 0;
    const worker = createChannelWorker({repository, service, onReview: async () => {}, provider: {
      async observe(_property, cells) {return {observedAt: new Date().toISOString(), providerVersion: "synthetic",
        cells: cells.map(c => ({roomId: c.roomId, date: c.date, ...actual}))};},
      async setNight(_property, target) {writes++; assert.equal(target.desired, desired);
        actual = desired === "closed" ? {count: 0, isLock: true} : {count: 1, isLock: false};}
    }});
    assert.equal((await worker.runOne(channel, propertyId, key)).state, "sync_verified");
    assert.equal(writes, 1);
    assert.deepEqual(orderState(await repository.read(propertyId)), before);
    await worker.runOne(channel, propertyId, key);
    assert.equal(writes, 1);
  });
}

test("preview binds actor, target, direction, authority and expiry; no confirmation means no write", async () => {
  const {repository, service, actor} = setup(), input = {cells: [cell], desired: "closed"};
  const preview = await service.previewLineRoomControl(actor, propertyId, input);
  for (const [who, body, proof] of [
    [actor, input, null], [{...actor, subjectId: "other"}, input, preview.previewToken],
    [actor, {...input, desired: "open"}, preview.previewToken],
    [actor, {...input, cells: [{...cell, date: "2099-11-11"}]}, preview.previewToken],
  ]) await assert.rejects(service.requestLineRoomControl(who, propertyId, crypto.randomUUID(), body, proof), code("LINE_PREVIEW_REQUIRED"));
  await assert.rejects(service.previewLineRoomControl({...actor, actions: ["inventory:write"]}, propertyId, input));
  await assert.rejects(service.previewLineRoomControl(actor, propertyId, {...input, cells: [cell, cell]}));
  await repository.transact(propertyId, state => {state.authorityEpoch++;});
  await assert.rejects(service.requestLineRoomControl(actor, propertyId, crypto.randomUUID(), input, preview.previewToken));
  assert.equal((await repository.read(propertyId)).operations.length, 0);
});

test("HTTP confirmation schedules exact job; same key cannot change intent", async () => {
  const {repository, service, actor} = setup(), jobs = [];
  const input = {cells: [cell], desired: "closed"}, key = crypto.randomUUID();
  const handle = createHandler(service, async () => actor, job => jobs.push(job));
  const call = (path, body, proof) => handle(new Request(`https://test.invalid/v1/properties/${propertyId}/${path}`, {
    method: "POST", headers: {"content-type": "application/json", "idempotency-key": key,
      ...(proof ? {"x-iron-gate-line-preview": proof} : {})}, body: JSON.stringify(body)}));
  const preview = await (await call("line-room-control-previews", input)).json();
  assert.equal((await call("line-room-controls", input, preview.previewToken)).status, 202);
  assert.deepEqual(jobs, [{propertyId, operationKey: key}]);
  assert.equal((await call("line-room-controls", {...input, desired: "open"}, preview.previewToken)).status, 409);
  const status = await service.lineChannelAction(actor, propertyId, key);
  assert.equal(status.controlMode, "provider_only");
  assert.equal(status.bookingId, null);
  assert.equal((await repository.read(propertyId)).operations.length, 1);
});

test("unknown provider claim is preserved and never bypassed by independent controls", async () => {
  const {repository, service, actor, channel} = setup(), input = {cells: [cell], desired: "closed"};
  const preview = await service.previewLineRoomControl(actor, propertyId, input), key = crypto.randomUUID();
  const claim = {claimId: crypto.randomUUID(), operationKey: crypto.randomUUID(), state: "review_required", claimedAt: new Date().toISOString()};
  await repository.transact(propertyId, state => {state.channelDispatch = claim;});
  await service.requestLineRoomControl(actor, propertyId, key, input, preview.previewToken);
  const worker = createChannelWorker({repository, service, onReview: async () => {}, provider: {
    async observe() {assert.fail("claimed provider must not be touched");}, async setNight() {assert.fail("no write");}}});
  assert.equal((await worker.runOne(channel, propertyId, key)).state, "sync_pending");
  assert.deepEqual((await repository.read(propertyId)).channelDispatch, claim);
});

test("expired preview and wrong actor cannot operate or inspect another staff request", async (t) => {
  const {repository, service, actor} = setup(), input = {cells: [cell], desired: "closed"};
  const preview = await service.previewLineRoomControl(actor, propertyId, input), key = crypto.randomUUID();
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 16 * 60_000);
  await assert.rejects(service.requestLineRoomControl(actor, propertyId, key, input, preview.previewToken), code("LINE_PREVIEW_REQUIRED"));
  assert.equal((await repository.read(propertyId)).operations.length, 0);
  t.mock.restoreAll();
  await service.requestLineRoomControl(actor, propertyId, key, input, preview.previewToken);
  await assert.rejects(service.lineChannelAction({...actor, subjectId: "other"}, propertyId, key), code("OPERATION_NOT_FOUND"));
});

for (const outcome of ["already_closed", "zero_unlocked", "incomplete", "unknown_write", "open_wrong_count"]) {
  test(`provider proof ${outcome} never falsely completes or repeats a write`, async () => {
    const {repository, service, actor, channel} = setup(), input = {
      cells: [cell], desired: outcome === "open_wrong_count" ? "open" : "closed"};
    const before = orderState(await repository.read(propertyId));
    const preview = await service.previewLineRoomControl(actor, propertyId, input), key = crypto.randomUUID();
    await service.requestLineRoomControl(actor, propertyId, key, input, preview.previewToken);
    let writes = 0;
    const run = () => reconcileChannelOperation({propertyId, operationKey: key,
      withPropertyLease: createChannelDispatchClaim(repository).forOperation(key),
      loadOperation: (id, op) => service.channelOperation(channel, id, op),
      recordReadback: input => service.recordChannelReadback(channel, input), wait: async () => {},
      provider: {async observe() {return {observedAt: new Date().toISOString(), providerVersion: "synthetic",
        cells: outcome === "incomplete" ? [] : [{...cell, count: outcome === "open_wrong_count" ? 2 : 0,
          isLock: outcome === "already_closed"}]};},
      async setNight() {writes++; if (outcome === "unknown_write") throw Error("unknown");}}});
    if (outcome === "incomplete") await assert.rejects(run(), /SNAPSHOT_INCOMPLETE/);
    else assert.equal((await run()).state, outcome === "already_closed" ? "sync_verified" : "review_required");
    assert.equal(writes, ["already_closed", "incomplete"].includes(outcome) ? 0 : 1);
    assert.deepEqual(orderState(await repository.read(propertyId)), before);
    if (outcome !== "already_closed") {
      assert.equal((await repository.read(propertyId)).channelDispatch.state, "review_required");
      await assert.rejects(run(), /CHANNEL_PROPERTY_CLAIMED/);
      assert.equal(writes, outcome === "incomplete" ? 0 : 1);
    }
  });
}

for (const locked of [true, false]) {
  test(`explicit read-only recovery requires exact provider evidence (locked=${locked})`, async () => {
    const {repository, service, actor, channel} = setup(), input = {cells: [cell], desired: "closed"};
    const preview = await service.previewLineRoomControl(actor, propertyId, input), key = crypto.randomUUID();
    await service.requestLineRoomControl(actor, propertyId, key, input, preview.previewToken);
    const claimId = crypto.randomUUID();
    await repository.transact(propertyId, state => {
      state.channelDispatch = {claimId, operationKey: key, state: "review_required", claimedAt: new Date().toISOString()};
      state.operations[0].state = "review_required";
    });
    const before = orderState(await repository.read(propertyId));
    const result = await recoverChannelClaim({repository, service, principal: channel,
      propertyId, expectedClaimId: claimId, provider: {async observe() {
        return {observedAt: new Date().toISOString(), providerVersion: "synthetic-recovery",
          cells: [{...cell, count: 0, isLock: locked}]};}, async setNight() {assert.fail("no recovery PUT");}}});
    assert.equal(result.state, locked ? "sync_verified" : "review_required");
    const state = await repository.read(propertyId);
    assert.deepEqual(orderState(state), before);
    assert.equal(state.channelDispatch?.claimId ?? null, locked ? null : claimId);
  });
}
