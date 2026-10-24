import test from "node:test";
import assert from "node:assert/strict";
import { createChannelWorkerFetch, createFreshChannelAuthorization } from
  "../api/channel-worker.mjs";
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
  IRON_GATE_CHANNEL_ALERT_URL: "https://alerts.example.invalid/internal/iron-gate-channel-alert",
  IRON_GATE_CHANNEL_ALERT_TOKEN: "z".repeat(43),
  IRON_GATE_CHANNEL_AUTH_URL: "https://alerts.example.invalid/internal/iron-gate-channel-auth",
  IRON_GATE_CHANNEL_AUTH_TOKEN: "a".repeat(43),
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
  const missingAlert = createChannelWorkerFetch({ ...env(),
    IRON_GATE_CHANNEL_ALERT_TOKEN: "" }, { pool: {},
    assertRuntimeDatabase: async () => {} });
  assert.equal((await missingAlert(call())).status, 503);
  const missingBroker = createChannelWorkerFetch({ ...env(),
    IRON_GATE_CHANNEL_AUTH_TOKEN: "" }, { pool: {},
    assertRuntimeDatabase: async () => {} });
  assert.equal((await missingBroker(call())).status, 503);
});

test("fresh OwlNest auth uses a scoped HTTPS broker and never accepts a partial response", async () => {
  const url = new URL(env().IRON_GATE_CHANNEL_AUTH_URL);
  let now = 0, calls = 0;
  const get = createFreshChannelAuthorization({ url,
    token: env().IRON_GATE_CHANNEL_AUTH_TOKEN, propertyId, now: () => now,
    fetchImpl: async (target, init) => {
      calls++;
      assert.equal(String(target), String(url));
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization,
        "Bearer " + env().IRON_GATE_CHANNEL_AUTH_TOKEN);
      assert.deepEqual(JSON.parse(init.body), { propertyId });
      return new Response(JSON.stringify({ authorization: "Bearer " + "x".repeat(64) }),
        { status: 200, headers: { "content-type": "application/json" } });
    } });
  assert.equal(await get(propertyId), "Bearer " + "x".repeat(64));
  await assert.rejects(get(grantId), /CHANNEL_AUTH_UNAVAILABLE/);
  assert.equal(await get(propertyId), "Bearer " + "x".repeat(64));
  assert.equal(calls, 1);
  now = 120_001;
  assert.equal(await get(propertyId), "Bearer " + "x".repeat(64));
  assert.equal(calls, 2);
  const invalid = createFreshChannelAuthorization({ url, token: "b".repeat(43), propertyId,
    fetchImpl: async () => new Response(JSON.stringify({ authorization: "invalid" }),
      { status: 200 }) });
  await assert.rejects(invalid(propertyId), /CHANNEL_AUTH_UNAVAILABLE/);
  const unavailable = createFreshChannelAuthorization({ url, token: "b".repeat(43), propertyId,
    fetchImpl: async () => new Response("unavailable", { status: 503 }) });
  await assert.rejects(unavailable(propertyId), /CHANNEL_AUTH_UNAVAILABLE/);
});

test("one authorized cron tick records exact provider readback and releases the claim", async () => {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId: "11111111-1111-4111-8111-111111111111",
    propertyId, roomIds: [roomId], version: 1, authorityEpoch: 1, readOnly: false,
    channel: { mode: "owlnest", ready: true, sourceReadbackEnabled: true,
      websiteSalesEnabled: false, grantId, websiteBindingId: null,
      stockObservedThrough: "2099-12-31" },
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

test("channel review sends only scoped identifiers to the configured alert receiver", async () => {
  const repository = new MemoryPropertyRepository();
  const operationKey = crypto.randomUUID();
  repository.seed({ workspaceId: "11111111-1111-4111-8111-111111111111",
    propertyId, roomIds: [roomId], version: 1, authorityEpoch: 1, readOnly: false,
    channel: { mode: "owlnest", ready: true, sourceReadbackEnabled: true,
      websiteSalesEnabled: false, grantId, websiteBindingId: null },
    sourceGrants: [], bookings: [], sourceLinks: [], manualBlocks: [], receipts: [],
    operations: [{ key: operationKey, bookingId: null, bookingVersion: 0,
      state: "sync_pending", cells: [{ roomId, date: "2026-11-10", desired: "closed" }],
      createdAt: new Date(Date.now() - 1000).toISOString(), verifiedAt: null,
      providerVersion: null }],
    fences: [{ key: operationKey, cells: [{ roomId, date: "2026-11-10" }],
      reason: "channel_pending" }] });
  const alerts = [];
  const handler = createChannelWorkerFetch(env(), { repository,
    service: new IronGateService(repository), pool: {},
    assertRuntimeDatabase: async () => {},
    provider: { async observe() { throw Error("synthetic_provider_failure"); },
      async setNight() { throw Error("must_not_write"); } },
    alertFetch: async (url, init) => {
      alerts.push({ url: String(url), method: init.method,
        authorization: init.headers.authorization, body: JSON.parse(init.body) });
      return { ok: true };
    } });
  assert.equal((await handler(call())).status, 503);
  assert.deepEqual(alerts, [{
    url: env().IRON_GATE_CHANNEL_ALERT_URL, method: "POST",
    authorization: "Bearer " + env().IRON_GATE_CHANNEL_ALERT_TOKEN,
    body: { propertyId, operationKey, status: "dispatch_unknown" },
  }]);
  const state = await repository.read(propertyId);
  assert.equal(state.channelDispatch.state, "review_required");
  assert.equal(state.fences.length, 1);
});
