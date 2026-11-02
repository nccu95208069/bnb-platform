import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";
import { createHandler } from "../src/http.ts";
import { createChannelWorker } from "../src/channel-worker.mjs";
import { createChannelWorkerRunner } from "../api/channel-worker.mjs";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const grantId = "44444444-4444-4444-8444-444444444444";

async function setup() {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId, propertyId, roomIds: [roomId], version: 1,
    authorityEpoch: 1, readOnly: false,
    channel: { mode: "owlnest", ready: true, sourceReadbackEnabled: true,
      websiteSalesEnabled: false, grantId, websiteBindingId: null,
      stockObservedFrom: "2099-01-01", stockObservedThrough: "2099-12-31" },
    sourceGrants: [], bookings: [], sourceLinks: [], operations: [], fences: [],
    manualBlocks: [], receipts: [] });
  const service = new IronGateService(repository, "p".repeat(43));
  const actor = { clientId: "line", subjectId: "synthetic-staff", origin: "line",
    workspaceId, propertyIds: [propertyId], authorityEpoch: 1,
    actions: ["booking:read", "booking:create", "booking:manage_all", "inventory:write"],
    fields: ["guest_name", "money"], grantId: crypto.randomUUID() };
  const channel = { ...actor, origin: "channel", grantId, actions: ["channel:verify"] };
  const input = { expectedInventoryVersion: 1,
    stays: [{ checkIn: "2099-11-10", checkOut: "2099-11-11", roomIds: [roomId] }],
    guestName: "Synthetic Guest", contact: null, notes: null, totalCents: 10000,
    bookedAt: "2099-01-01", source: "line", channelPolicy: "manual" };
  const preview = await service.previewLineCreate(actor, propertyId, input);
  const created = await service.createBooking(actor, propertyId, crypto.randomUUID(),
    input, preview.previewToken);
  const actionInput = { expectedBookingVersion: created.bookingVersion,
    expectedInventoryVersion: created.inventoryVersion, desired: "closed",
    cells: [{ roomId, date: "2099-11-10" }] };
  const action = await service.previewLineChannelAction(actor, propertyId,
    created.bookingId, actionInput);
  const operationKey = crypto.randomUUID();
  const request = (proof = action.previewToken) => new Request(
    `https://iron.invalid/v1/properties/${propertyId}/bookings/${created.bookingId}/line-channel-actions`,
    { method: "POST", headers: { "content-type": "application/json",
      "idempotency-key": operationKey, "x-iron-gate-line-preview": proof },
    body: JSON.stringify(actionInput) });
  return { repository, service, actor, channel, operationKey, request };
}

test("confirmed HTTP action starts its committed operation before cron and status verifies it", async () => {
  const set = await setup();
  let closed = false, writes = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const worker = createChannelWorker({ repository: set.repository, service: set.service,
    provider: { async observe(_id, cells) {
      await held;
      return { observedAt: new Date().toISOString(), providerVersion: closed ? "after" : "before",
        cells: cells.map(cell => ({ roomId: cell.roomId, date: cell.date,
          count: closed ? 0 : 1, isLock: closed })) };
    }, async setNight() { writes++; closed = true; } }, onReview: async () => {} });
  const jobs = [];
  const handle = createHandler(set.service, async () => set.actor, job => {
    assert.deepEqual(job, { propertyId, operationKey: set.operationKey });
    jobs.push(worker.runOne(set.channel, job.propertyId, job.operationKey));
  });
  const receipt = await handle(set.request());
  assert.equal(receipt.status, 202);
  assert.equal((await receipt.json()).operationKey, set.operationKey);
  assert.equal(jobs.length, 1);
  const statusUrl = `https://iron.invalid/v1/properties/${propertyId}/line-channel-actions/${set.operationKey}`;
  assert.equal((await (await handle(new Request(statusUrl))).json()).state, "sync_pending");
  release();
  await Promise.all(jobs);
  const result = await (await handle(new Request(statusUrl))).json();
  assert.equal(result.state, "sync_verified");
  assert.ok(result.verifiedAt && result.providerVersion);
  assert.equal(result.cells.length, 1);
  await handle(set.request());
  await Promise.all(jobs);
  assert.equal(writes, 1);
});

test("missing identity, invalid confirmation and invalid body never schedule a job", async () => {
  const set = await setup(), jobs = [];
  const denied = createHandler(set.service, async () => null, job => jobs.push(job));
  assert.equal((await denied(set.request())).status, 401);
  const handle = createHandler(set.service, async () => set.actor, job => jobs.push(job));
  assert.equal((await handle(set.request("invalid"))).status, 409);
  const bad = set.request();
  assert.equal((await handle(new Request(bad.url, { method: "POST", headers: bad.headers,
    body: JSON.stringify({ desired: "closed" }) }))).status, 400);
  assert.equal(jobs.length, 0);
  assert.equal((await set.repository.read(propertyId)).operations.length, 0);
});

test("scheduling failure preserves the durable receipt for cron without claiming success", async () => {
  const set = await setup();
  const handle = createHandler(set.service, async () => set.actor,
    () => { throw Error("synthetic scheduler unavailable"); });
  const response = await handle(set.request());
  assert.equal(response.status, 202);
  assert.equal((await response.json()).operationState, "sync_pending");
  const state = await set.repository.read(propertyId);
  assert.equal(state.operations.length, 1);
  assert.equal(state.operations[0].key, set.operationKey);
  assert.equal(state.channelDispatch ?? null, null);
});

test("production worker acceleration denies another property before database or provider access", async () => {
  const run = createChannelWorkerRunner({ VERCEL_ENV: "production",
    IRON_GATE_PRODUCTION_CHANNEL_WORKER_ENABLED: "true",
    IRON_GATE_CHANNEL_PROPERTY_ID: propertyId });
  await assert.rejects(run({ propertyId: workspaceId, operationKey: crypto.randomUUID() }),
    /CHANNEL_WORKER_TARGET_INVALID/);
});
