import test from "node:test";
import assert from "node:assert/strict";
import { createChannelWorkerFetch } from "../api/channel-worker.mjs";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";

const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const grantId = "44444444-4444-4444-8444-444444444444";
const secret = "s".repeat(43);
const env = () => ({ VERCEL_ENV: "production",
  IRON_GATE_PRODUCTION_CHANNEL_WORKER_ENABLED: "true", CRON_SECRET: secret,
  IRON_GATE_CHANNEL_PROPERTY_ID: propertyId, IRON_GATE_CHANNEL_GRANT_ID: grantId,
  IRON_GATE_PRODUCTION_DATABASE_URL: "postgres://runtime:synthetic@localhost:5432/postgres",
  IRON_GATE_CHANNEL_AUTHORIZATION: "Bearer " + "a".repeat(32),
  IRON_GATE_CHANNEL_OWLNEST_CONFIG_JSON: JSON.stringify({
    [propertyId]: { hotelId: 1, roomIds: { [roomId]: 11 } },
  }) });
const call = (token = secret) => new Request("https://iron.invalid/api/channel-worker", {
  headers: { authorization: "Bearer " + token } });

test("channel cron denies missing token and stays disabled without explicit flag", async () => {
  const disabled = createChannelWorkerFetch({ ...env(),
    IRON_GATE_PRODUCTION_CHANNEL_WORKER_ENABLED: "false" });
  assert.equal((await disabled(call())).status, 503);
  const enabled = createChannelWorkerFetch(env());
  assert.equal((await enabled(call("wrong"))).status, 401);
});

test("one authorized cron tick records exact provider readback and releases the claim", async () => {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId: "11111111-1111-4111-8111-111111111111",
    propertyId, roomIds: [roomId], version: 1, authorityEpoch: 1, readOnly: false,
    channel: { mode: "owlnest", ready: true, sourceReadbackEnabled: true,
      websiteSalesEnabled: false, grantId, websiteBindingId: null },
    sourceGrants: [], bookings: [], sourceLinks: [], operations: [], fences: [],
    manualBlocks: [], receipts: [] });
  const service = new IronGateService(repository);
  const os = { clientId: "os", subjectId: "staff", origin: "os",
    workspaceId: "11111111-1111-4111-8111-111111111111", propertyIds: [propertyId],
    authorityEpoch: 1, actions: ["booking:create"], fields: [] };
  await service.createBooking(os, propertyId, crypto.randomUUID(), {
    expectedInventoryVersion: 1,
    stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }],
    guestName: null, contact: null, notes: null, totalCents: null,
    bookedAt: null, source: "os" });
  let closed = false;
  const provider = { async observe(_propertyId, requested) {
    return { observedAt: new Date().toISOString(), providerVersion: closed ? "closed" : "open",
      cells: requested.map((cell) => ({ roomId: cell.roomId, date: cell.date,
        count: closed ? 0 : 1, isLock: closed })) };
  }, async setNight() { closed = true; } };
  const handler = createChannelWorkerFetch(env(), { repository, service, provider,
    pool: {}, assertRuntimeDatabase: async () => {} });
  const result = await handler(call());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { state: "sync_verified" });
  const state = await repository.read(propertyId);
  assert.equal(state.operations[0].state, "sync_verified");
  assert.equal(state.channelDispatch, null);
  assert.equal(state.fences.length, 0);
  assert.deepEqual(await (await handler(call())).json(), { state: "idle" });
});
