import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ironGateReadConfig, readIronGateBooking } from
  "../src/lib/customer-workspaces/iron-gate-read.server.ts";

const secret = "synthetic-iron-gate-proof-secret-32-bytes";

function fixture(role = "viewer_no_price") {
  const workspaceId = randomUUID(), propertyId = randomUUID(), accountId = randomUUID(),
    bookingId = randomUUID(), slug = "synthetic-workspace";
  const workspace = { id: workspaceId, slug, version: 1,
    properties: [{ id: propertyId, rooms: [] }], bookings: [],
    members: [{ accountId, role, active: true, allProperties: false, propertyIds: [propertyId] }] };
  const entries = new Map([[`slug:${slug}`, workspaceId], [`workspace:${workspaceId}`, workspace]]);
  const store = { read: async (key) => ({ value: entries.get(key) ?? null, raw: null }) };
  const grant = { credentialId: randomUUID(), clientId: "synthetic-os-gateway",
    workspaceId, propertyId, origin: "os", token: randomBytes(32).toString("base64url") };
  const config = ironGateReadConfig({ IRON_GATE_SHADOW_ENABLED: "true",
    IRON_GATE_BASE_URL: "http://127.0.0.1:8787",
    IRON_GATE_OS_PROOF_SECRET: secret, IRON_GATE_OS_READ_GRANTS: JSON.stringify([grant]) });
  const booking = { id: bookingId, workspaceId, propertyId, version: 1, status: "confirmed",
    channelSyncState: "not_required", stays: [], createdAt: new Date().toISOString(),
    source: "os", guestName: "Synthetic Guest" };
  return { workspace, store, grant, config, accountId, slug, propertyId, bookingId, booking };
}

test("read-only OS gateway signs a fresh member and enforces the response field scope", async () => {
  const input = fixture();
  let seen = false;
  const send = async (url, options) => {
    seen = true;
    assert.match(url, new RegExp(input.bookingId + "$"));
    assert.equal(options.headers.authorization, `Bearer ${input.grant.token}`);
    assert.equal(options.redirect, "error");
    const claims = JSON.parse(Buffer.from(options.headers["x-iron-gate-os-proof"].split(".")[0],
      "base64url").toString("utf8"));
    assert.equal(claims.subjectId, input.accountId);
    assert.deepEqual(claims.fields, ["guest_name"]);
    return Response.json(input.booking);
  };
  assert.deepEqual(await readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config, send), input.booking);
  assert.equal(seen, true);
  await assert.rejects(readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config,
    async () => Response.json({ ...input.booking, totalCents: 100 })), /IRON_GATE_READ_FAILED/);
});

test("revoked membership, wrong IDs, and unsafe configuration fail closed", async () => {
  const input = fixture("owner");
  input.workspace.members[0].active = false;
  await assert.rejects(readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config, async () => Response.json(input.booking)),
  /NOT_FOUND/);
  input.workspace.members[0].active = true;
  await assert.rejects(readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config,
    async () => Response.json({ ...input.booking, id: randomUUID() })), /IRON_GATE_READ_FAILED/);
  await assert.rejects(readIronGateBooking(input.store, input.accountId, input.slug,
    input.propertyId, input.bookingId, input.config,
    async () => { throw new Error("token leaked in transport failure"); }), /IRON_GATE_READ_FAILED/);
  assert.throws(() => ironGateReadConfig({ IRON_GATE_BASE_URL: "https://gate.invalid",
    IRON_GATE_OS_PROOF_SECRET: secret,
    IRON_GATE_OS_READ_GRANTS: JSON.stringify([input.grant]) }), /IRON_GATE_READ_CONFIG_INVALID/);
  assert.throws(() => ironGateReadConfig({ IRON_GATE_SHADOW_ENABLED: "true",
    IRON_GATE_BASE_URL: "http://example.com",
    IRON_GATE_OS_PROOF_SECRET: secret,
    IRON_GATE_OS_READ_GRANTS: JSON.stringify([input.grant]) }), /IRON_GATE_READ_CONFIG_INVALID/);
  assert.throws(() => ironGateReadConfig({ IRON_GATE_SHADOW_ENABLED: "true",
    IRON_GATE_BASE_URL: "https://gate.invalid",
    IRON_GATE_OS_PROOF_SECRET: secret,
    IRON_GATE_OS_READ_GRANTS: JSON.stringify([input.grant, input.grant]) }), /IRON_GATE_READ_CONFIG_INVALID/);
});
