#!/usr/bin/env node
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { PostgresCredentialDirectory } from "../src/postgres-auth.mjs";
import { tokenHash, validateGrant, validateGrantShape } from "../src/credential-grant.mjs";
import { validateDatabaseTransport } from "../src/runtime-safety.mjs";

const PROJECT_REF = "brcszrkwkgiwatrxevkf";
const CLIENT_ID = "sean-dashboard-business-report";
const SUBJECT_ID = "service:sean-dashboard";
const MANIFEST_FIELDS = new Set(["projectRef", "credentialId", "workspaceId", "propertyId", "authorityEpoch", "expiresAt"]);

function reportGrant(manifest) {
  if (!manifest || manifest.projectRef !== PROJECT_REF ||
    Object.keys(manifest).some((key) => !MANIFEST_FIELDS.has(key)) ||
    !Number.isSafeInteger(manifest.authorityEpoch) || manifest.authorityEpoch < 1)
    throw Error("REPORT_CREDENTIAL_MANIFEST_INVALID");
  const grant = { credentialId: manifest.credentialId, workspaceId: manifest.workspaceId,
    propertyId: manifest.propertyId, authorityEpoch: manifest.authorityEpoch,
    clientId: CLIENT_ID, subjectId: SUBJECT_ID, origin: "service",
    actions: ["booking:aggregate"], fields: [] };
  validateGrantShape(grant);
  return grant;
}

/** Pure issuance preflight; scope contains property metadata only, never bookings. */
export function planReportCredential(scope, manifest) {
  const grant = reportGrant(manifest);
  if (scope?.propertyId !== grant.propertyId || scope.workspaceId !== grant.workspaceId ||
    Number(scope.authorityEpoch) !== grant.authorityEpoch || scope.readOnly !== false)
    throw Error("REPORT_CREDENTIAL_AUTHORITY_CHANGED");
  // Keep the existing canonical ISO expiry and maximum 30-day limit intact.
  validateGrant(grant, manifest.expiresAt);
  return { grant, expiresAt: manifest.expiresAt };
}

export async function readPrivateJson(path) {
  const file = await lstat(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0 || file.size > 65_536 ||
    (typeof process.getuid === "function" && file.uid !== process.getuid()))
    throw Error("REPORT_CREDENTIAL_INPUT_NOT_PRIVATE");
  return JSON.parse(await readFile(path, "utf8"));
}

/** Same approved project, admin login, pooler and pinned CA as existing staging tools. */
export function reportAdminDatabaseUrl(config) {
  if (config?.projectRef !== PROJECT_REF || typeof config.url !== "string")
    throw Error("REPORT_CREDENTIAL_ADMIN_CONFIG_INVALID");
  validateDatabaseTransport(config.url);
  const url = new URL(config.url);
  if (url.hostname !== "aws-0-ap-northeast-1.pooler.supabase.com" || url.port !== "6543" ||
    url.pathname !== "/postgres" || decodeURIComponent(url.username) !== `postgres.${PROJECT_REF}` ||
    !url.password || [...url.searchParams.keys()].join() !== "sslmode" ||
    url.searchParams.get("sslmode") !== "verify-full")
    throw Error("REPORT_CREDENTIAL_ADMIN_CONFIG_INVALID");
  url.searchParams.set("sslrootcert", fileURLToPath(new URL("../certs/prod-ca-2021.crt", import.meta.url)));
  return url.toString();
}

async function adminIdentity(client) {
  const result = await client.query("SELECT current_user AS login, current_database() AS database_name");
  if (result.rows[0]?.login !== "postgres" || result.rows[0]?.database_name !== "postgres")
    throw Error("REPORT_CREDENTIAL_ADMIN_IDENTITY_INVALID");
}

async function privateOutput(path) {
  const output = resolve(path);
  const parent = await lstat(dirname(output));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && parent.uid !== process.getuid()))
    throw Error("REPORT_CREDENTIAL_OUTPUT_NOT_PRIVATE");
  return output;
}

/** Creates exactly one report-only credential; leaves the previous credential active. */
export async function issueReportCredential(pool, manifest, outputPath) {
  reportGrant(manifest);
  const output = await privateOutput(outputPath);
  const client = await pool.connect();
  let file;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await adminIdentity(client);
    const selected = await client.query(`SELECT property_id::text AS "propertyId",
      workspace_id::text AS "workspaceId", authority_epoch AS "authorityEpoch",
      state_json->'readOnly' AS "readOnly" FROM iron_gate.property_state
      WHERE property_id = $1 FOR SHARE`, [manifest.propertyId]);
    if (selected.rows.length !== 1) throw Error("REPORT_CREDENTIAL_PROPERTY_NOT_FOUND");
    const { grant, expiresAt } = planReportCredential(selected.rows[0], manifest);
    // Reserve a new owner-only file before issuing. Never overwrite an earlier token.
    file = await open(output, "wx", 0o600);
    const directory = new PostgresCredentialDirectory(client, client);
    const token = await directory.issue(grant, expiresAt);
    const readback = await client.query(`SELECT token_hash, grant_json, active, expires_at
      FROM iron_gate.credentials WHERE credential_id = $1`, [grant.credentialId]);
    const row = readback.rows[0];
    if (readback.rows.length !== 1 || row.active !== true || row.token_hash !== tokenHash(token) ||
      !isDeepStrictEqual(row.grant_json, grant) || new Date(row.expires_at).toISOString() !== expiresAt)
      throw Error("REPORT_CREDENTIAL_READBACK_MISMATCH");
    await file.writeFile(JSON.stringify({ projectRef: PROJECT_REF, ...grant, expiresAt, token }) + "\n");
    await file.sync();
    await client.query("COMMIT");
    return { status: "issued", credentialId: grant.credentialId, propertyId: grant.propertyId,
      authorityEpoch: grant.authorityEpoch, expiresAt, outputPath: output };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // COMMIT may have succeeded before a connection error. Preserve any private
    // output for readback/recovery; do not issue a second ID or delete the token.
    throw error;
  } finally { await file?.close(); client.release(); }
}

/** Separate post-verification step; refuses every credential except this exact report grant. */
export async function revokeReportCredential(pool, manifest) {
  const expected = reportGrant(manifest);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await adminIdentity(client);
    const selected = await client.query(`SELECT grant_json, active FROM iron_gate.credentials
      WHERE credential_id = $1 AND property_id = $2 FOR UPDATE`,
    [expected.credentialId, expected.propertyId]);
    const row = selected.rows[0];
    if (selected.rows.length !== 1 || !isDeepStrictEqual(row.grant_json, expected))
      throw Error("REPORT_CREDENTIAL_REVOKE_SCOPE_MISMATCH");
    let status = "already_revoked";
    if (row.active === true) {
      if (!await new PostgresCredentialDirectory(client, client).revoke(expected.credentialId))
        throw Error("REPORT_CREDENTIAL_REVOKE_CONFLICT");
      const checked = await client.query("SELECT active FROM iron_gate.credentials WHERE credential_id = $1",
        [expected.credentialId]);
      if (checked.rows.length !== 1 || checked.rows[0].active !== false)
        throw Error("REPORT_CREDENTIAL_READBACK_MISMATCH");
      status = "revoked";
    }
    await client.query("COMMIT");
    return { status, credentialId: expected.credentialId, propertyId: expected.propertyId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let pool;
  try {
    const [operation, manifestPath, adminPath, outputPath, ...extra] = process.argv.slice(2);
    if (!["issue", "revoke"].includes(operation) || !manifestPath || !adminPath || extra.length ||
      (operation === "issue" ? !outputPath : outputPath !== undefined))
      throw Error("REPORT_CREDENTIAL_USAGE_INVALID");
    const manifest = await readPrivateJson(manifestPath);
    const admin = await readPrivateJson(adminPath);
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: reportAdminDatabaseUrl(admin), max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    const result = operation === "issue" ? await issueReportCredential(pool, manifest, outputPath)
      : await revokeReportCredential(pool, manifest);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    // Database exceptions can contain connection details. Print no driver error,
    // SQL parameters, manifest, grant token or administrative connection string.
    process.stderr.write("REPORT_CREDENTIAL_OPERATION_FAILED: check the manifest credential ID before retrying.\n");
    process.exitCode = 1;
  } finally { if (pool) await pool.end().catch(() => {}); }
}
