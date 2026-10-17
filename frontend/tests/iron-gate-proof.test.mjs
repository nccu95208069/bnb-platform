import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { signCurrentIronGateMembership } from "../src/lib/customer-workspaces/iron-gate-proof.server.ts";

function fixture(role = "owner") {
  const workspaceId = randomUUID(), propertyId = randomUUID(), accountId = randomUUID();
  const slug = "iron-gate-synthetic";
  const workspace = { id: workspaceId, slug, version: 1,
    properties: [{ id: propertyId, rooms: [{ id: randomUUID() }] }], bookings: [],
    members: [{ accountId, role, active: true, allProperties: false, propertyIds: [propertyId] }] };
  const values = new Map([[`slug:${slug}`, workspaceId], [`workspace:${workspaceId}`, workspace]]);
  const store = { read: async (key) => {
    const value = values.get(key) ?? null;
    return { value, raw: value === null ? null : JSON.stringify(value) };
  } };
  const grant = { origin: "os", credentialId: randomUUID(), clientId: "os-gateway",
    workspaceId, propertyId };
  const request = new Request(`https://iron.invalid/v1/properties/${propertyId}/bookings?limit=10`, {
    method: "POST", headers: { "idempotency-key": randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ example: "synthetic" }),
  });
  return { store, workspace, workspaceId, propertyId, accountId, slug, grant, request };
}

test("fresh OS membership signs one bounded read-only Iron Gate request", async () => {
  const input = fixture("viewer_no_price"), secret = "synthetic-iron-gate-proof-secret-32-bytes";
  const now = Date.now();
  const proof = await signCurrentIronGateMembership(input.store, input.accountId,
    input.slug, input.request, input.grant, secret, now);
  const [payload, mac] = proof.split(".");
  assert.equal(createHmac("sha256", secret).update(payload).digest("base64url"), mac);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.equal(claims.aud, "iron-gate-v1");
  assert.equal(claims.subjectId, input.accountId);
  assert.equal(claims.propertyId, input.propertyId);
  assert.deepEqual(claims.actions, ["booking:read", "event:read", "tag:read"]);
  assert.deepEqual(claims.fields, ["guest_name"]);
  assert.equal(claims.expiresAtMs - claims.issuedAtMs, 5000);
  assert.equal(claims.pathAndQuery, new URL(input.request.url).pathname + "?limit=10");
  assert.equal(claims.bodySha256, createHash("sha256").update(JSON.stringify({ example: "synthetic" })).digest("hex"));
});

test("revoked member, wrong workspace, and out-of-scope property cannot sign", async () => {
  const input = fixture(), secret = "synthetic-iron-gate-proof-secret-32-bytes";
  await assert.rejects(signCurrentIronGateMembership(input.store, input.accountId,
    input.slug, input.request, { ...input.grant, workspaceId: randomUUID() }, secret), /FORBIDDEN/);
  input.workspace.members[0].propertyIds = [];
  await assert.rejects(signCurrentIronGateMembership(input.store, input.accountId,
    input.slug, input.request, input.grant, secret), /FORBIDDEN/);
  input.workspace.members[0].propertyIds = [input.propertyId];
  input.workspace.members[0].active = false;
  await assert.rejects(signCurrentIronGateMembership(input.store, input.accountId,
    input.slug, input.request, input.grant, secret), /NOT_FOUND/);
  input.workspace.members[0].active = true;
  input.workspace.members[0].role = "unrecognized";
  await assert.rejects(signCurrentIronGateMembership(input.store, input.accountId,
    input.slug, input.request, input.grant, secret), /FORBIDDEN/);
  input.workspace.members[0].role = "owner";
  input.workspace.members[0].propertyIds = [];
  input.workspace.members[0].allProperties = "true";
  await assert.rejects(signCurrentIronGateMembership(input.store, input.accountId,
    input.slug, input.request, input.grant, secret), /FORBIDDEN/);
  input.workspace.members[0].propertyIds = [input.propertyId];
  await assert.rejects(signCurrentIronGateMembership(input.store, input.accountId,
    input.slug, input.request, input.grant, secret), /FORBIDDEN/);
  input.workspace.members[0].allProperties = false;
  input.workspace.members[0].propertyIds = [input.propertyId];
  input.workspace.members.push({ ...input.workspace.members[0], active: false });
  await assert.rejects(signCurrentIronGateMembership(input.store, input.accountId,
    input.slug, input.request, input.grant, secret), /FORBIDDEN/);
});
