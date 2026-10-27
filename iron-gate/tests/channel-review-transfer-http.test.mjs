import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createChannelReviewTransferFetch } from "../api/channel-review-transfer.mjs";

const id = n => `${n}`.repeat(8) + "-1111-4111-8111-111111111111";
const token = "r".repeat(43), now = Date.now();
const digest = value => createHash("sha256").update(value).digest("hex");
const baseIntent = {propertyId: id(1), targetOperationKey: id(2), expectedClaimId: id(3),
  expectedInventoryVersion: 9, expectedCells: [{roomId: id(4), date: "2099-01-22", desired: "closed"}],
  reviewReason: "Explicitly reviewed isolated legacy scope", issuedAt: new Date(now - 1000).toISOString(),
  expiresAt: new Date(now + 899_000).toISOString()};
const baseEnv = {VERCEL_ENV: "production", IRON_GATE_PRODUCTION_ENABLED: "true",
  IRON_GATE_PRODUCTION_CHANNEL_WORKER_ENABLED: "true", IRON_GATE_CHANNEL_PROPERTY_ID: id(1),
  IRON_GATE_PRODUCTION_CHANNEL_REVIEW_TRANSFER_ENABLED: "true",
  IRON_GATE_CHANNEL_REVIEW_TRANSFER_TOKEN_SHA256: digest(token),
  IRON_GATE_CHANNEL_REVIEW_TRANSFER_INTENT_JSON: JSON.stringify(baseIntent)};
function req({method = "POST", url = "https://example.test/api/channel-review-transfer", body = "{}",
  authorization = "Bearer " + token, type = "application/json", headers = {}} = {}) {
  return new Request(url, {method, headers: {authorization, "content-type": type, ...headers},
    ...(method === "GET" || method === "HEAD" ? {} : {body})});
}
function create(env = {}, dependencies = {}) {
  const calls = [];
  const handler = createChannelReviewTransferFetch({...baseEnv, ...env}, {now: () => now,
    execute: async intent => {calls.push(intent); return {state: "sync_verified",
      propertyId: intent.propertyId, operationKey: intent.targetOperationKey};}, ...dependencies});
  return {handler, calls};
}
const changedIntent = patch => ({IRON_GATE_CHANNEL_REVIEW_TRANSFER_INTENT_JSON:
  JSON.stringify({...baseIntent, ...patch})});

for (const env of [
  {IRON_GATE_PRODUCTION_CHANNEL_REVIEW_TRANSFER_ENABLED: undefined},
  {IRON_GATE_PRODUCTION_CHANNEL_REVIEW_TRANSFER_ENABLED: "false"}, {VERCEL_ENV: "preview"},
  {IRON_GATE_PRODUCTION_ENABLED: "false"}, {IRON_GATE_PRODUCTION_CHANNEL_WORKER_ENABLED: "false"},
]) test("review route is absent unless all production gates are enabled", async () => {
  const {handler, calls} = create(env);
  assert.equal((await handler(req())).status, 404);
  assert.equal(calls.length, 0);
});

for (const env of [
  {IRON_GATE_CHANNEL_REVIEW_TRANSFER_TOKEN_SHA256: undefined},
  {IRON_GATE_CHANNEL_REVIEW_TRANSFER_TOKEN_SHA256: "invalid"}, {CRON_SECRET: token},
  {IRON_GATE_CHANNEL_AUTH_TOKEN: token}, {IRON_GATE_CHANNEL_ALERT_TOKEN: token},
  {IRON_GATE_CHANNEL_REVIEW_TRANSFER_INTENT_JSON: "{}"},
  {IRON_GATE_CHANNEL_REVIEW_TRANSFER_INTENT_JSON: "{"},
  changedIntent({expiresAt: new Date(now).toISOString()}),
  changedIntent({expiresAt: new Date(now + 900_000).toISOString()}),
  changedIntent({issuedAt: new Date(now + 1).toISOString()}),
  changedIntent({issuedAt: "2026-01-01"}), changedIntent({expiresAt: "invalid"}),
  changedIntent({propertyId: id(5)}), changedIntent({targetOperationKey: "unknown"}),
  changedIntent({expectedClaimId: "unknown"}), changedIntent({expectedInventoryVersion: -1}),
  changedIntent({expectedCells: []}), changedIntent({expectedCells: [...baseIntent.expectedCells, ...baseIntent.expectedCells]}),
  changedIntent({expectedCells: [{...baseIntent.expectedCells[0], date: "2099-02-31"}]}),
  changedIntent({observation: {}}), changedIntent({runtimeEnv: {}}),
]) test("review route rejects invalid, reused, expired or broadened deployment authorization", async () => {
  const {handler, calls} = create(env);
  assert.equal((await handler(req())).status, 403);
  assert.equal(calls.length, 0);
});

for (const authorization of ["", "Bearer " + "x".repeat(43), token, "Basic " + token,
  "Bearer short", "Bearer " + token + ",Bearer " + token])
  test("review route checks a dedicated bearer hash before execution", async () => {
    const {handler, calls} = create();
    assert.equal((await handler(req({authorization}))).status, 401);
    assert.equal(calls.length, 0);
  });

for (const request of [
  {method: "GET"}, {method: "PUT"},
  {url: "https://example.test/api/channel-review-transfer?targetOperationKey=" + id(5)},
  {url: "https://example.test/api/another-route"}, {body: ""}, {body: "null"}, {body: "[]"},
  {body: '{"propertyId":"' + id(5) + '"}'}, {body: '{"runtimeEnv":{}}'},
  {body: '{"observation":{}}'}, {body: '{"targetOperationKey":"' + id(5) + '"}'},
  {body: "{"}, {body: " ".repeat(129) + "{}"}, {type: "text/plain"},
  {headers: {"content-length": "99999"}},
]) test("HTTP cannot supply a target, evidence or runtime configuration", async () => {
  const {handler, calls} = create();
  assert.equal((await handler(req(request))).status, ["GET", "PUT"].includes(request.method) ? 405 : 400);
  assert.equal(calls.length, 0);
});

test("authorized empty body executes exactly the pinned deployment intent and returns no identifiers", async () => {
  const {handler, calls} = create();
  const result = await handler(req({body: " { }\n"}));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {state: "sync_verified"});
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(calls, [baseIntent]);
});

test("expiry while consuming the body prevents runtime access", async () => {
  let tick = now;
  const {handler, calls} = create({}, {now: () => tick});
  let reads = 0;
  const request = {method: "POST", url: "https://example.test/api/channel-review-transfer",
    headers: new Headers({authorization: "Bearer " + token, "content-type": "application/json"}),
    body: {getReader: () => ({async read() {
      tick = now + 900_000;
      return reads++ ? {done: true} : {done: false, value: new TextEncoder().encode("{}")};
    }, releaseLock() {}})}};
  assert.equal((await handler(request)).status, 403);
  assert.equal(reads, 2);
  assert.equal(calls.length, 0);
});

test("provider errors stay private and never trigger an automatic second execution", async () => {
  let calls = 0;
  const {handler} = create({}, {execute: async () => {calls++; throw Error("private credential details");}});
  const response = await handler(req());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {state: "unavailable"});
  assert.equal(calls, 1);
});

test("a state conflict is bounded and a mismatched result is never reported as success", async () => {
  const conflict = create({}, {execute: async () => {throw Error("CHANNEL_REVIEW_TRANSFER_STATE_MOVED");}});
  assert.equal((await conflict.handler(req())).status, 409);
  const mismatch = create({}, {execute: async () => ({state: "sync_verified", propertyId: id(1), operationKey: id(5)})});
  assert.equal((await mismatch.handler(req())).status, 503);
});
