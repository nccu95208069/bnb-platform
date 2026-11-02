import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tokenHash } from "../src/credential-grant.mjs";
import { planReportCredential, issueReportCredential, revokeReportCredential,
  readPrivateJson, reportAdminDatabaseUrl } from "../scripts/reporting-credential.mjs";

const propertyId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const manifest = (changes = {}) => ({ projectRef: "brcszrkwkgiwatrxevkf", propertyId, workspaceId,
  credentialId: crypto.randomUUID(), authorityEpoch: 1,
  expiresAt: new Date(Date.now() + 28 * 86_400_000).toISOString(), ...changes });
const scope = (changes = {}) => ({ propertyId, workspaceId, authorityEpoch: "1", readOnly: false, ...changes });

function database({ property = scope(), existing = null, badReadback = false, ambiguousCommit = false } = {}) {
  let saved = existing ? structuredClone(existing) : null;
  let draft = null;
  const queries = [];
  const client = { async query(sql, values = []) {
    queries.push({ sql, values });
    if (sql.startsWith("BEGIN")) { draft = saved ? structuredClone(saved) : null; return { rows: [] }; }
    if (sql.startsWith("SET LOCAL")) return { rows: [] };
    if (sql === "COMMIT") {
      saved = draft;
      if (ambiguousCommit) throw Error("synthetic connection lost after commit");
      return { rows: [] };
    }
    if (sql === "ROLLBACK") { draft = null; return { rows: [] }; }
    if (sql.startsWith("SELECT current_user")) return { rows: [{ login: "postgres", database_name: "postgres" }] };
    if (sql.startsWith("SELECT property_id")) return { rows: property ? [property] : [] };
    if (sql.startsWith("INSERT INTO iron_gate.credentials")) {
      if (draft) throw Error("synthetic duplicate credential");
      draft = { token_hash: values[0], credential_id: values[1], property_id: values[2],
        grant_json: JSON.parse(values[3]), expires_at: values[4], active: true };
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT token_hash")) return { rows: draft
      ? [{ ...draft, token_hash: badReadback ? "invalid" : draft.token_hash }] : [] };
    if (sql.startsWith("SELECT grant_json")) return { rows: draft && draft.credential_id === values[0]
      && draft.property_id === values[1] ? [draft] : [] };
    if (sql.startsWith("UPDATE iron_gate.credentials")) {
      const rowCount = draft?.credential_id === values[0] && draft.active ? 1 : 0;
      if (rowCount) draft.active = false;
      return { rows: [], rowCount };
    }
    if (sql.startsWith("SELECT active")) return { rows: draft ? [{ active: draft.active }] : [] };
    throw Error("unexpected synthetic query");
  }, release() {} };
  return { pool: { connect: async () => client }, queries, saved: () => saved };
}

test("report credential plan fixes least privilege and preserves the 30-day expiry limit", () => {
  const input = manifest();
  const { grant } = planReportCredential(scope(), input);
  assert.equal(grant.origin, "service");
  assert.equal(grant.clientId, "sean-dashboard-business-report");
  assert.equal(grant.subjectId, "service:sean-dashboard");
  assert.deepEqual(grant.actions, ["booking:aggregate"]);
  assert.deepEqual(grant.fields, []);
  for (const extra of [{ actions: ["booking:read"] }, { fields: ["money"] }, { origin: "os" }])
    assert.throws(() => planReportCredential(scope(), { ...input, ...extra }), /MANIFEST_INVALID/);
  assert.throws(() => planReportCredential(scope(), manifest({ expiresAt: new Date(Date.now() + 31 * 86_400_000).toISOString() })),
    /INVALID_CREDENTIAL_EXPIRY/);
  assert.throws(() => planReportCredential(scope(), manifest({ expiresAt: new Date(Date.now() - 1000).toISOString() })),
    /INVALID_CREDENTIAL_EXPIRY/);
  for (const change of [{ workspaceId: crypto.randomUUID() }, { propertyId: crypto.randomUUID() },
    { authorityEpoch: 2 }, { readOnly: true }])
    assert.throws(() => planReportCredential(scope(change), input), /AUTHORITY_CHANGED/);
});

test("issue uses the existing directory, reads only property metadata and saves the token privately", async () => {
  const folder = await mkdtemp(join(tmpdir(), "report-credential-"));
  try {
    const output = join(folder, "new.json"), input = manifest(), db = database();
    const result = await issueReportCredential(db.pool, input, output);
    const privateOutput = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.status, "issued");
    assert.equal(result.credentialId, input.credentialId);
    assert.equal("token" in result, false);
    assert.match(privateOutput.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(db.saved().token_hash, tokenHash(privateOutput.token));
    assert.deepEqual(db.saved().grant_json.actions, ["booking:aggregate"]);
    assert.equal(JSON.stringify(db.queries).includes(privateOutput.token), false);
    assert.equal(db.queries.some(({ sql }) => sql.includes("SELECT state_json")), false);
    assert.equal(db.queries.some(({ sql }) => /(?:UPDATE|INSERT INTO|DELETE FROM) iron_gate\.(?:property_state|occupied_room_nights|outbox|audit_log)/.test(sql)), false);
    assert.equal(db.queries.some(({ sql }) => sql === "COMMIT"), true);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("private files are required and an existing output is never overwritten or issued", async () => {
  const folder = await mkdtemp(join(tmpdir(), "report-credential-"));
  try {
    const output = join(folder, "existing.json");
    await writeFile(output, "{}", { mode: 0o600 });
    const db = database();
    await assert.rejects(issueReportCredential(db.pool, manifest(), output), { code: "EEXIST" });
    assert.equal(db.saved(), null);
    assert.equal(db.queries.some(({ sql }) => sql.startsWith("INSERT")), false);
    await chmod(output, 0o644);
    await assert.rejects(readPrivateJson(output), /INPUT_NOT_PRIVATE/);
    await chmod(output, 0o600);
    assert.deepEqual(await readPrivateJson(output), {});
    await chmod(folder, 0o755);
    await assert.rejects(issueReportCredential(database().pool, manifest(), join(folder, "new.json")), /OUTPUT_NOT_PRIVATE/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("failed readback rolls back; an ambiguous successful commit preserves its recoverable token", async () => {
  const folder = await mkdtemp(join(tmpdir(), "report-credential-"));
  try {
    const failed = database({ badReadback: true });
    await assert.rejects(issueReportCredential(failed.pool, manifest(), join(folder, "bad.json")), /READBACK_MISMATCH/);
    assert.equal(failed.saved(), null);
    const uncertain = database({ ambiguousCommit: true });
    const output = join(folder, "uncertain.json");
    await assert.rejects(issueReportCredential(uncertain.pool, manifest(), output), /connection lost/);
    const recovery = JSON.parse(await readFile(output, "utf8"));
    assert.equal(uncertain.saved().active, true);
    assert.equal(uncertain.saved().token_hash, tokenHash(recovery.token));
    assert.equal((await stat(output)).mode & 0o777, 0o600);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("separate revocation accepts only the exact report grant and can clean up expired grants", async () => {
  const input = manifest();
  const grant = planReportCredential(scope(), input).grant;
  const row = { credential_id: input.credentialId, property_id: propertyId,
    grant_json: grant, active: true, expires_at: input.expiresAt };
  const db = database({ existing: row });
  const expired = { ...input, expiresAt: "2020-01-01T00:00:00.000Z" };
  assert.equal((await revokeReportCredential(db.pool, expired)).status, "revoked");
  assert.equal(db.saved().active, false);
  assert.equal((await revokeReportCredential(db.pool, expired)).status, "already_revoked");
  for (const change of [{ origin: "os" }, { actions: ["booking:aggregate", "booking:read"] },
    { fields: ["money"] }, { clientId: "another-client" }]) {
    const other = database({ existing: { ...row, grant_json: { ...grant, ...change } } });
    await assert.rejects(revokeReportCredential(other.pool, input), /REVOKE_SCOPE_MISMATCH/);
    assert.equal(other.saved().active, true);
  }
});

test("administrator connection is confined to the existing project, verified TLS and pinned CA", () => {
  const input = { projectRef: "brcszrkwkgiwatrxevkf",
    url: "postgresql://postgres.brcszrkwkgiwatrxevkf:synthetic@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full" };
  const parsed = new URL(reportAdminDatabaseUrl(input));
  assert.equal(parsed.searchParams.get("sslmode"), "verify-full");
  assert.equal(parsed.searchParams.get("sslrootcert").endsWith("/certs/prod-ca-2021.crt"), true);
  for (const url of [input.url.replace("verify-full", "require"), input.url.replace("postgres.brcs", "iron_gate_app.brcs"),
    input.url.replace("ap-northeast-1", "us-east-1"), input.url + "&sslrootcert=/other/ca"])
    assert.throws(() => reportAdminDatabaseUrl({ ...input, url }));
});
