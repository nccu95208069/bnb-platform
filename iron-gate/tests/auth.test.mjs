import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlitePropertyRepository } from "../src/sqlite-repository.mjs";
import { SqliteCredentialDirectory, createGrantAuthenticator } from "../src/sqlite-auth.mjs";
import { IronGateService } from "../src/service.ts";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { createHandler } from "../src/http.ts";
import { createOsMemberProofVerifier, signOsMemberProof } from "../src/os-member-proof.mjs";
import { createLineOperatorProofVerifier, signLineOperatorProof } from "../src/line-operator-proof.mjs";
import { validateGrantShape } from "../src/credential-grant.mjs";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const state = () => ({ workspaceId, propertyId, roomIds: [roomId], version: 1, authorityEpoch: 7,
  channel: { mode: "none", ready: false, websiteSalesEnabled: false,
    grantId: null, websiteBindingId: null }, sourceGrants: [], bookings: [], sourceLinks: [],
  operations: [], fences: [], manualBlocks: [], receipts: [] });
const grant = (origin, actions, fields = []) => ({ credentialId: crypto.randomUUID(),
  origin, workspaceId, propertyId, clientId: "synthetic-client", subjectId: "service-subject",
  authorityEpoch: 7, actions, fields });

test("compact payment status field is granted only to the OS origin", () => {
  assert.doesNotThrow(() => validateGrantShape(grant("os", ["booking:read"],
    ["guest_name", "payment_status"])));
  assert.throws(() => validateGrantShape(grant("website", ["booking:read"],
    ["payment_status"])), /INVALID_PAYMENT_STATUS_SCOPE/);
});

test("LINE booking scopes require explicit markers and one bound group", () => {
  const base = { ...grant("line", ["booking:read"], ["guest_name"]),
    grantId: crypto.randomUUID(), lineGroupId: "synthetic-group",
    lineActorIds: ["synthetic-staff"] };
  assert.doesNotThrow(() => validateGrantShape(base));
  assert.throws(() => validateGrantShape({ ...base, lineGroupId: "" }), /INVALID_LINE_SCOPE/);
  assert.throws(() => validateGrantShape({ ...base, lineActorIds: [] }), /INVALID_LINE_SCOPE/);
  assert.throws(() => validateGrantShape({ ...base,
    lineActorIds: ["synthetic-staff", "synthetic-staff"] }), /INVALID_LINE_SCOPE/);
  assert.throws(() => validateGrantShape({ ...base,
    actions: ["booking:read", "booking:create"] }), /INVALID_LINE_SCOPE/);
  assert.doesNotThrow(() => validateGrantShape({ ...base, lineCreateEnabled: true,
    actions: ["booking:read", "booking:create"] }));
  assert.throws(() => validateGrantShape({ ...base, lineCreateEnabled: true,
    actions: ["booking:read", "booking:amend"] }), /INVALID_LINE_SCOPE/);
  const manage = { ...base, lineCreateEnabled: true, lineManageAllEnabled: true,
    actions: ["booking:read", "booking:create", "booking:amend", "booking:cancel",
      "booking:manage_all"] };
  assert.doesNotThrow(() => validateGrantShape(manage));
  assert.throws(() => validateGrantShape({ ...manage, lineManageAllEnabled: false }),
    /INVALID_LINE_SCOPE/);
  assert.throws(() => validateGrantShape({ ...manage,
    actions: manage.actions.filter((action) => action !== "booking:cancel") }),
  /INVALID_LINE_SCOPE/);
  assert.throws(() => validateGrantShape({ ...base, actions: ["booking:create"] }), /INVALID_LINE_SCOPE/);
  assert.throws(() => validateGrantShape({ ...base, fields: ["payment_status"] }), /INVALID_LINE_SCOPE/);
  assert.throws(() => validateGrantShape({ ...manage,
    actions: [...manage.actions, "inventory:write"] }), /INVALID_LINE_SCOPE/);
  assert.doesNotThrow(() => validateGrantShape({ ...manage, lineInventoryEnabled: true,
    actions: [...manage.actions, "inventory:write"] }));
  assert.throws(() => validateGrantShape({ ...manage, lineInventoryEnabled: true }),
    /INVALID_LINE_SCOPE/);
  assert.throws(() => validateGrantShape({ ...base, lineInventoryEnabled: true,
    actions: ["booking:read", "inventory:write"] }), /INVALID_LINE_SCOPE/);
});

test("LINE proof wire format matches the Cloud Run signer", async () => {
  const issued = { origin: "line", credentialId: "55555555-5555-4555-8555-555555555555",
    workspaceId, propertyId, grantId: "44444444-4444-4444-8444-444444444444",
    lineGroupId: "synthetic-line-group", lineActorIds: ["synthetic-staff"] };
  const request = new Request(`https://iron.invalid/v1/properties/${propertyId}/bookings?from=2026-10-24&to=2026-10-25`);
  const proof = await signLineOperatorProof("b".repeat(43), request, issued,
    { active: true, actorId: "synthetic-staff", groupId: "synthetic-line-group" }, 1000);
  assert.equal(createHash("sha256").update(proof).digest("hex"),
    "a70e4236d7c8d7bce4b67a245f77a684f3236df2d2ff5b867e54e03aeb1e8025");
  request.headers.set("x-iron-gate-line-proof", proof);
  assert.equal((await createLineOperatorProofVerifier("b".repeat(43), () => 1001)
    (request, issued)).subjectId, "synthetic-staff");
});

test("LINE operator proof binds actor, group, grant and exact short-lived read", async () => {
  const folder = mkdtempSync(join(tmpdir(), "iron-gate-line-auth-"));
  const filename = join(folder, "private.sqlite");
  const repository = new SqlitePropertyRepository(filename);
  const directory = new SqliteCredentialDirectory(filename);
  try {
    await repository.seed(state());
    const issued = { ...grant("line", ["booking:read"], ["guest_name"]),
      grantId: crypto.randomUUID(), lineGroupId: "synthetic-group",
      lineActorIds: ["synthetic-staff"] };
    const token = directory.issue(issued, new Date(Date.now() + 60_000).toISOString());
    const secret = Buffer.alloc(32, 11);
    const now = Date.now();
    const url = `https://iron.invalid/v1/properties/${propertyId}/bookings?from=2026-11-01&to=2026-11-02`;
    const request = new Request(url, { headers: { authorization: `Bearer ${token}` } });
    const denied = createGrantAuthenticator(directory, repository);
    assert.equal(await denied(request.clone()), null);
    request.headers.set("x-iron-gate-line-proof", await signLineOperatorProof(secret,
      request.clone(), issued, { active: true, actorId: "synthetic-staff",
        groupId: "synthetic-group" }, now));
    const verifier = createLineOperatorProofVerifier(secret, () => now + 1000);
    const authenticate = createGrantAuthenticator(directory, repository, null, verifier);
    const principal = await authenticate(request.clone());
    assert.equal(principal.subjectId, "synthetic-staff");
    assert.deepEqual(principal.actions, ["booking:read"]);
    const handler = createHandler(new IronGateService(repository), authenticate);
    const response = await handler(request.clone());
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).lineScope, { grantId: issued.grantId });
    assert.equal(await authenticate(new Request(`${url}&other=1`,
      { headers: request.headers })), null);
    assert.equal(await authenticate(new Request(url, { method: "POST",
      headers: request.headers, body: "{}" })), null);
    const tamperedHeaders = new Headers(request.headers);
    const originalProof = tamperedHeaders.get("x-iron-gate-line-proof");
    tamperedHeaders.set("x-iron-gate-line-proof",
      `${originalProof[0] === "A" ? "B" : "A"}${originalProof.slice(1)}`);
    assert.equal(await authenticate(new Request(url, { headers: tamperedHeaders })), null);
    assert.equal(await verifier(request.clone(), { ...issued,
      lineGroupId: "another-group" }), null);
    assert.equal(await verifier(request.clone(), { ...issued,
      lineActorIds: ["new-staff"] }), null);
    assert.equal(await createLineOperatorProofVerifier(secret,
      () => now + 15001)(request.clone(), issued), null);
    await assert.rejects(signLineOperatorProof(secret, request.clone(), issued,
      { active: false, actorId: "synthetic-staff", groupId: "synthetic-group" }, now),
    /INVALID_LINE_OPERATOR_PROOF/);
    await assert.rejects(signLineOperatorProof(secret, request.clone(), issued,
      { active: true, actorId: "synthetic-staff", groupId: "another-group" }, now),
    /INVALID_LINE_OPERATOR_PROOF/);
    assert.equal(directory.revoke(issued.credentialId), true);
    assert.equal(await authenticate(request.clone()), null);
  } finally {
    directory.close(); repository.close(); rmSync(folder, { recursive: true, force: true });
  }
});

test("opaque credential is stored only as a digest and revocation takes effect on next request", async () => {
  const folder = mkdtempSync(join(tmpdir(), "iron-gate-auth-"));
  const filename = join(folder, "private.sqlite");
  const repository = new SqlitePropertyRepository(filename);
  const directory = new SqliteCredentialDirectory(filename);
  try {
    await repository.seed(state());
    const issued = grant("service", ["event:read"]);
    const token = directory.issue(issued, new Date(Date.now() + 60_000).toISOString());
    assert.equal(readFileSync(filename).includes(Buffer.from(token)), false);
    const auth = createGrantAuthenticator(directory, repository);
    const request = new Request("https://iron.invalid/v1/properties/22222222-2222-4222-8222-222222222222/events",
      { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await auth(request)).actions[0], "event:read");
    assert.equal(directory.revoke(issued.credentialId), true);
    assert.equal(await auth(request), null);
  } finally {
    directory.close();
    repository.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("OS machine credential needs current member proof and intersects current scopes", async () => {
  const folder = mkdtempSync(join(tmpdir(), "iron-gate-auth-"));
  const filename = join(folder, "private.sqlite");
  const repository = new SqlitePropertyRepository(filename);
  const directory = new SqliteCredentialDirectory(filename);
  try {
    await repository.seed(state());
    const issued = grant("os", ["booking:create", "booking:read"], ["money", "guest_name"]);
    const token = directory.issue(issued, new Date(Date.now() + 60_000).toISOString());
    const url = `https://iron.invalid/v1/properties/${propertyId}/bookings`;
    const request = new Request(url, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID(),
        "content-type": "application/json" },
      body: JSON.stringify({ expectedInventoryVersion: 1,
        stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }],
        guestName: "Synthetic", contact: null, notes: null, totalCents: 10000,
        bookedAt: null, source: "os" }) });
    const denied = createHandler(new IronGateService(repository),
      createGrantAuthenticator(directory, repository));
    assert.equal((await denied(request.clone())).status, 401);
    const verifier = async () => ({ subjectId: "verified-member", workspaceId,
      propertyIds: [propertyId], actions: ["booking:create"], fields: ["guest_name"] });
    const authenticate = createGrantAuthenticator(directory, repository, verifier);
    const identity = await authenticate(request.clone());
    assert.deepEqual(identity.actions, ["booking:create"]);
    assert.deepEqual(identity.fields, ["guest_name"]);
    const handler = createHandler(new IronGateService(repository), authenticate);
    assert.equal((await handler(request.clone())).status, 403);
    const fullVerifier = createGrantAuthenticator(directory, repository, async () => ({
      subjectId: "verified-member", workspaceId, propertyIds: [propertyId],
      actions: ["booking:create"], fields: ["guest_name", "money"] }));
    assert.equal((await createHandler(new IronGateService(repository),
      fullVerifier)(request.clone())).status, 201);
    const noProperty = createGrantAuthenticator(directory, repository, async () => ({
      subjectId: "verified-member", workspaceId, propertyIds: [], actions: ["booking:create"], fields: [] }));
    assert.equal(await noProperty(request.clone()), null);
  } finally {
    directory.close();
    repository.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("finance credential issuer rejects booking mutation scopes", async () => {
  const folder = mkdtempSync(join(tmpdir(), "iron-gate-auth-"));
  const directory = new SqliteCredentialDirectory(join(folder, "private.sqlite"));
  try {
    const expiry = new Date(Date.now() + 60_000).toISOString();
    assert.throws(() => directory.issue(grant("finance", ["booking:cancel"], ["money"]), expiry),
      /INVALID_FINANCE_SCOPE/);
    assert.throws(() => directory.issue(grant("finance", ["payment:write"], ["contact"]), expiry),
      /INVALID_FINANCE_SCOPE/);
    assert.throws(() => directory.issue(grant("os", ["source:write"]), expiry),
      /INVALID_OS_SCOPE/);
    assert.throws(() => directory.issue(grant("service", ["occupancy:aggregate"], ["guest_name"]), expiry),
      /INVALID_SERVICE_SCOPE/);
    assert.equal(typeof directory.issue(grant("service", ["housekeeping:read"]), expiry), "string");
  } finally { directory.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("stored malformed grants and malformed OS member scopes fail authentication", async () => {
  const repository = new MemoryPropertyRepository();
  repository.seed(state());
  const issued = grant("os", ["booking:read"], ["guest_name"]);
  const request = new Request(`https://iron.invalid/v1/properties/${propertyId}/bookings`,
    { headers: { authorization: `Bearer ${"A".repeat(43)}` } });
  const directory = { lookup: async () => ({ ...issued, actions: "booking:read" }) };
  assert.equal(await createGrantAuthenticator(directory, repository, async () => ({
    subjectId: "member", workspaceId, propertyIds: [propertyId],
    actions: ["booking:read"], fields: ["guest_name"] }))(request), null);
  directory.lookup = async () => issued;
  assert.equal(await createGrantAuthenticator(directory, repository, async () => ({
    subjectId: "member", workspaceId, propertyIds: propertyId,
    actions: "booking:read", fields: "guest_name" }))(request), null);
  assert.equal(await createGrantAuthenticator(directory, repository, async () => ({
    subjectId: "member", workspaceId, propertyIds: [propertyId],
    actions: ["booking:read"], fields: "guest_name" }))(request), null);
});

test("OS member proof is short lived and bound to grant, path, key, and body", async () => {
  const secret = Buffer.alloc(32, 7);
  const issued = grant("os", ["booking:read", "booking:create"], ["guest_name", "money"]);
  const now = Date.now();
  const url = `https://iron.invalid/v1/properties/${propertyId}/bookings`;
  const body = JSON.stringify({ example: "synthetic" });
  const request = new Request(url, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body });
  const member = { active: true, subjectId: crypto.randomUUID(), workspaceId,
    propertyIds: [propertyId], actions: ["booking:create"], fields: ["guest_name"] };
  const proof = await signOsMemberProof(secret, request.clone(), issued, member, now);
  request.headers.set("x-iron-gate-os-proof", proof);
  const verifier = createOsMemberProofVerifier(secret, () => now + 1000);
  assert.deepEqual((await verifier(request.clone(), issued)).actions, ["booking:create"]);
  assert.equal(await verifier(new Request(url, { method: "POST", headers: request.headers,
    body: JSON.stringify({ example: "changed" }) }), issued), null);
  assert.equal(await verifier(new Request(`${url}?other=1`, { method: "POST", headers: request.headers,
    body }), issued), null);
  const changedHeaders = new Headers(request.headers);
  changedHeaders.set("idempotency-key", crypto.randomUUID());
  assert.equal(await verifier(new Request(url, { method: "POST", headers: changedHeaders,
    body }), issued), null);
  assert.equal(await verifier(request.clone(), { ...issued, credentialId: crypto.randomUUID() }), null);
  assert.equal(await createOsMemberProofVerifier(secret, () => now + 5001)(request.clone(), issued), null);
  await assert.rejects(signOsMemberProof(secret, request.clone(), issued,
    { ...member, active: false }, now), /INVALID_OS_MEMBER_PROOF/);
});

test("signed OS member proof authorizes only its current scoped HTTP request", async () => {
  const folder = mkdtempSync(join(tmpdir(), "iron-gate-auth-"));
  const filename = join(folder, "private.sqlite");
  const repository = new SqlitePropertyRepository(filename);
  const directory = new SqliteCredentialDirectory(filename);
  try {
    await repository.seed(state());
    const issued = grant("os", ["booking:create", "booking:read"], ["guest_name", "money"]);
    const token = directory.issue(issued, new Date(Date.now() + 60_000).toISOString());
    const request = new Request(`https://iron.invalid/v1/properties/${propertyId}/bookings`, {
      method: "POST", headers: { authorization: `Bearer ${token}`,
        "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ expectedInventoryVersion: 1, source: "os", guestName: "Synthetic",
        contact: null, notes: null, totalCents: 10000, bookedAt: null,
        stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }] }),
    });
    const secret = Buffer.alloc(32, 9);
    const member = { active: true, subjectId: crypto.randomUUID(), workspaceId,
      propertyIds: [propertyId], actions: ["booking:create"], fields: ["guest_name", "money"] };
    request.headers.set("x-iron-gate-os-proof",
      await signOsMemberProof(secret, request.clone(), issued, member));
    const handler = createHandler(new IronGateService(repository),
      createGrantAuthenticator(directory, repository, createOsMemberProofVerifier(secret)));
    assert.equal((await handler(request.clone())).status, 201);
    assert.equal((await repository.read(propertyId)).bookings.length, 1);
    assert.equal(directory.revoke(issued.credentialId), true);
    assert.equal((await handler(request.clone())).status, 401);
  } finally {
    directory.close(); repository.close(); rmSync(folder, { recursive: true, force: true });
  }
});
