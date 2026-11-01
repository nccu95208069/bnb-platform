import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tokenHash } from "../src/credential-grant.mjs";
import { planCredentialRotation, prepareCredentialRotation, checkPreparedCredentialRotation,
  readPrivateJson, runCredentialRotationCli } from "../scripts/credential-rotation.mjs";

const DAY = 86_400_000;
const projectRef = "brcszrkwkgiwatrxevkf";
const propertyId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const now = Date.now();
  const expiresAt = new Date(now - 1000).toISOString();
  const os = { credentialId: randomUUID(), propertyId, workspaceId, authorityEpoch: 1,
    origin: "os", clientId: randomUUID(), subjectId: "sweetfun-os",
    actions: ["booking:read", "occupancy:aggregate"], fields: ["guest_name", "payment_status", "money"] };
  const source = { credentialId: randomUUID(), propertyId, workspaceId, authorityEpoch: 1,
    origin: "source", clientId: randomUUID(), subjectId: "gmail-order-handler",
    actions: ["source:write"], fields: [], grantId: randomUUID(),
    sourceSystem: "offland-calendar-sheet", sourceAccount: "synthetic-offland-sheet" };
  const snapshot = { projectRef, capturedAt: new Date(now).toISOString(),
    property: { propertyId, workspaceId, authorityEpoch: 1, readOnly: false },
    credentials: [os, source].map(grant => ({ credentialId: grant.credentialId,
      propertyId, grant, active: true, expiresAt })) };
  const manifest = { projectRef, propertyId, workspaceId, authorityEpoch: 1,
    replacements: [os, source].map(grant => ({ oldCredentialId: grant.credentialId,
      newCredentialId: randomUUID(), expectedOrigin: grant.origin, expectedExpiresAt: expiresAt,
      expiresAt: new Date(now + 28 * DAY).toISOString() })) };
  return { now, snapshot, manifest };
}

test("rotation preserves every field of both existing grants and only changes the credential identity", () => {
  const { snapshot, manifest, now } = fixture();
  // Unknown future restriction must survive; reconstructing only known fields would silently widen it.
  snapshot.credentials[0].grant.futureRestriction = { partition: "synthetic", allowed: false };
  const before = structuredClone(snapshot);
  const planned = planCredentialRotation(snapshot, manifest, now);
  for (const entry of planned.replacements) {
    const old = snapshot.credentials.find(row => row.credentialId === entry.oldCredentialId).grant;
    assert.deepEqual(entry.newGrant, { ...old, credentialId: entry.newCredentialId });
    assert.deepEqual(entry.oldGrant, old);
    assert.notEqual(entry.newCredentialId, entry.oldCredentialId);
  }
  assert.deepEqual(snapshot, before);
});

test("cannot widen scope by extra manifest input, change authority, or revive a revoked grant", () => {
  for (const mutate of [
    x => { x.manifest.actions = ["booking:create"]; },
    x => { x.manifest.replacements[0].fields = ["contact"]; },
    x => { x.snapshot.property.readOnly = true; },
    x => { x.snapshot.property.authorityEpoch = 2; },
    x => { x.snapshot.property.workspaceId = randomUUID(); },
    x => { x.snapshot.credentials[0].active = false; },
    x => { x.snapshot.credentials[0].grant.propertyId = randomUUID(); },
    x => { x.snapshot.credentials[0].grant.authorityEpoch = 2; },
    x => { x.snapshot.credentials[0].grant.actions.push("booking:create"); },
    x => { x.snapshot.credentials[1].grant.sourceSystem = "another-source"; },
    x => { x.manifest.replacements[0].expectedExpiresAt = new Date(x.now - DAY).toISOString(); },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => planCredentialRotation(value.snapshot, value.manifest, value.now));
  }
});

test("expiry is bounded to 30 days; the old expired grant may be rotated but never extended in place", () => {
  const value = fixture();
  assert.doesNotThrow(() => planCredentialRotation(value.snapshot, value.manifest, value.now));
  for (const expiry of [value.now, value.now - 1, value.now + 30 * DAY + 1]) {
    const input = structuredClone(value.manifest);
    input.replacements[0].expiresAt = new Date(expiry).toISOString();
    assert.throws(() => planCredentialRotation(value.snapshot, input, value.now), /EXPIRY_INVALID/);
  }
  const sameId = structuredClone(value.manifest);
  sameId.replacements[0].newCredentialId = sameId.replacements[0].oldCredentialId;
  assert.throws(() => planCredentialRotation(value.snapshot, sameId, value.now), /MANIFEST_INVALID/);
  const exactMaximum = structuredClone(value.manifest);
  exactMaximum.replacements[0].expiresAt = new Date(value.now + 30 * DAY).toISOString();
  assert.doesNotThrow(() => planCredentialRotation(value.snapshot, exactMaximum, value.now));
});

test("rejects stale snapshot, duplicate/missing identities, cross-project input and duplicate origins", () => {
  for (const mutate of [
    x => { x.snapshot.capturedAt = new Date(x.now - 16 * 60_000).toISOString(); },
    x => { x.snapshot.capturedAt = new Date(x.now + 5000).toISOString(); },
    x => { x.snapshot.credentials.pop(); },
    x => { x.snapshot.credentials[1] = structuredClone(x.snapshot.credentials[0]); },
    x => { x.manifest.projectRef = "another-project"; },
    x => { x.manifest.replacements[1].newCredentialId = x.manifest.replacements[0].newCredentialId; },
    x => { x.manifest.replacements[1].newCredentialId = x.manifest.replacements[0].oldCredentialId; },
    x => { x.manifest.replacements[1].expectedOrigin = "os"; },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => planCredentialRotation(value.snapshot, value.manifest, value.now));
  }
});

test("prepared token package is durable/private, tokens never enter SQL or returned metadata, replay never regenerates", async () => {
  const folder = await mkdtemp(join(tmpdir(), "credential-rotation-test-"));
  try {
    const { snapshot, manifest, now } = fixture();
    const output = join(folder, "package");
    const result = await prepareCredentialRotation(snapshot, manifest, output, now);
    assert.equal(result.status, "prepared_not_applied");
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    const privateOutput = await readPrivateJson(join(output, "credentials.private.json"));
    const plan = await readPrivateJson(join(output, "plan.private.json"));
    for (const file of ["credentials.private.json", "plan.private.json", "apply.private.sql",
      "dry-run.private.sql", "verify.private.sql", "expiry-monitor.sql", "receipt.json"])
      assert.equal((await stat(join(output, file))).mode & 0o777, 0o600);
    for (const credential of privateOutput.credentials) {
      assert.match(credential.token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(plan.replacements.find(x => x.newCredentialId === credential.credentialId).tokenHash,
        tokenHash(credential.token));
      for (const file of ["apply.private.sql", "dry-run.private.sql", "verify.private.sql", "expiry-monitor.sql", "receipt.json"])
        assert.equal((await readFile(join(output, file), "utf8")).includes(credential.token), false);
      assert.equal(JSON.stringify(result).includes(credential.token), false);
    }
    const checked = await checkPreparedCredentialRotation(output);
    assert.equal(checked.status, "package_verified_not_applied");
    const savedTokens = await readFile(join(output, "credentials.private.json"), "utf8");
    await assert.rejects(prepareCredentialRotation(snapshot, manifest, output, now), { code: "EEXIST" });
    assert.equal(await readFile(join(output, "credentials.private.json"), "utf8"), savedTokens);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("package check detects damaged SQL/token material and refuses public or symlink inputs", async () => {
  const folder = await mkdtemp(join(tmpdir(), "credential-rotation-test-"));
  try {
    const { snapshot, manifest, now } = fixture();
    const output = join(folder, "package");
    await prepareCredentialRotation(snapshot, manifest, output, now);
    const sqlPath = join(output, "apply.private.sql");
    const sql = await readFile(sqlPath, "utf8");
    await writeFile(sqlPath, sql + "SELECT 1;\n");
    await assert.rejects(checkPreparedCredentialRotation(output), /PACKAGE_CHANGED/);
    await writeFile(sqlPath, sql);
    const secretPath = join(output, "credentials.private.json");
    const secret = await readPrivateJson(secretPath);
    secret.credentials[0].token = "A".repeat(43);
    await writeFile(secretPath, JSON.stringify(secret));
    await assert.rejects(checkPreparedCredentialRotation(output), /PACKAGE_CHANGED/);
    await chmod(secretPath, 0o644);
    await assert.rejects(readPrivateJson(secretPath), /INPUT_NOT_PRIVATE/);
    await chmod(secretPath, 0o600);
    const link = join(folder, "symbolic-input.json"); await symlink(secretPath, link);
    await assert.rejects(readPrivateJson(link));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("CLI error never prints malformed private input or underlying parser error", async () => {
  const folder = await mkdtemp(join(tmpdir(), "credential-rotation-test-"));
  try {
    const input = join(folder, "malformed.json");
    const syntheticSecret = "synthetic-private-value-must-not-be-logged";
    await writeFile(input, syntheticSecret, { mode: 0o600 });
    let stdout = "", stderr = "";
    const status = await runCredentialRotationCli(["prepare", input, input, join(folder, "package")],
      { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /^CREDENTIAL_ROTATION_FAILED:/);
    assert.equal(stderr.includes(syntheticSecret), false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
