import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlitePropertyRepository } from "../src/sqlite-repository.mjs";
import { SqliteCredentialDirectory, createGrantAuthenticator } from "../src/sqlite-auth.mjs";
import { IronGateService } from "../src/service.ts";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { createHandler } from "../src/http.ts";
import { createOsMemberProofVerifier, signOsMemberProof } from "../src/os-member-proof.mjs";

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
    assert.equal((await handler(request.clone())).status, 201);
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
    const issued = grant("os", ["booking:create", "booking:read"], ["guest_name"]);
    const token = directory.issue(issued, new Date(Date.now() + 60_000).toISOString());
    const request = new Request(`https://iron.invalid/v1/properties/${propertyId}/bookings`, {
      method: "POST", headers: { authorization: `Bearer ${token}`,
        "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ expectedInventoryVersion: 1, source: "os", guestName: "Synthetic",
        contact: null, notes: null, totalCents: null, bookedAt: null,
        stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }] }),
    });
    const secret = Buffer.alloc(32, 9);
    const member = { active: true, subjectId: crypto.randomUUID(), workspaceId,
      propertyIds: [propertyId], actions: ["booking:create"], fields: ["guest_name"] };
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
