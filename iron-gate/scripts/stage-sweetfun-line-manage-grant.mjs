import { randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { tokenHash, validateGrant } from "../src/credential-grant.mjs";
import { privateJson } from "./seed-sweetfun-shadow.mjs";
import { adminDatabaseUrl } from "./stage-sweetfun-line-read-grant.mjs";

const PROJECT_REF = "brcszrkwkgiwatrxevkf";
const SOURCE_SYSTEM = "sweetfun-calendar-sheet";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Dedicated operator grant for all canonical bookings; no source or payment action. */
export function planSweetfunLineManageGrant(state, manifest) {
  if (manifest?.projectRef !== PROJECT_REF ||
    ![manifest.propertyId, manifest.workspaceId, manifest.credentialId,
      manifest.grantId, manifest.clientId].every((value) => UUID.test(value ?? "")) ||
    !Number.isSafeInteger(manifest.expectedVersion) || manifest.expectedVersion < 0 ||
    state?.propertyId !== manifest.propertyId || state.workspaceId !== manifest.workspaceId ||
    state.version !== manifest.expectedVersion ||
    state.authorityEpoch !== 1 || state.readOnly !== false ||
    state.channel?.mode !== "owlnest" || state.channel.ready !== true ||
    state.channel.sourceReadbackEnabled !== true || !UUID.test(state.channel.grantId ?? "") ||
    !state.sourceGrants?.some((grant) => grant.active === true &&
      grant.sourceSystem === SOURCE_SYSTEM &&
      grant.sourceAccount === state.sweetfunImport?.sourceId) ||
    !Array.isArray(state.roomIds) || state.roomIds.length !== 6 ||
    !state.roomIds.every((roomId) => UUID.test(roomId)) ||
    !Array.isArray(manifest.actorIds))
    throw Error("SWEETFUN_LINE_MANAGE_PREFLIGHT_FAILED");
  if (manifest.inventoryEnabled !== undefined && typeof manifest.inventoryEnabled !== "boolean")
    throw Error("SWEETFUN_LINE_MANAGE_PREFLIGHT_FAILED");
  const grant = { credentialId: manifest.credentialId,
    workspaceId: manifest.workspaceId, propertyId: manifest.propertyId,
    authorityEpoch: 1, clientId: manifest.clientId, subjectId: "line-staff-manage-all",
    origin: "line", actions: ["booking:read", "booking:create", "booking:amend",
      "booking:cancel", "booking:manage_all",
      ...(manifest.inventoryEnabled === true ? ["inventory:write"] : [])],
    fields: ["guest_name", "contact", "notes", "money"],
    grantId: manifest.grantId, lineGroupId: manifest.groupId,
    lineActorIds: manifest.actorIds,
    lineCreateEnabled: true, lineManageAllEnabled: true,
    ...(manifest.inventoryEnabled === true ? { lineInventoryEnabled: true } : {}) };
  validateGrant(grant, manifest.expiresAt);
  return { grant, expiresAt: manifest.expiresAt };
}

/** Stage only. Secret distribution and enabling the LINE lane are separate release steps. */
export async function stageSweetfunLineManageGrant(pool, manifest, outputPath) {
  const output = resolve(outputPath);
  if (!["/private/tmp", tmpdir()].some((root) => output.startsWith(resolve(root) + sep)))
    throw Error("SWEETFUN_LINE_MANAGE_OUTPUT_MUST_BE_PRIVATE_TEMP");
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== "postgres" ||
    identity.rows[0]?.database_name !== "postgres")
    throw Error("WRONG_SWEETFUN_CREDENTIAL_ADMIN");
  const client = await pool.connect();
  let file, created = false, commitStarted = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const selected = await client.query("SELECT state_json FROM iron_gate.property_state " +
      "WHERE property_id = $1 FOR UPDATE", [manifest.propertyId]);
    if (selected.rows.length !== 1) throw Error("SWEETFUN_LINE_MANAGE_STATE_MISSING");
    const { grant, expiresAt } = planSweetfunLineManageGrant(selected.rows[0].state_json,
      manifest);
    const existing = await client.query("SELECT credential_id FROM iron_gate.credentials " +
      "WHERE property_id = $1 AND active = true AND expires_at > now() " +
      "AND grant_json->>'origin' = 'line' " +
      "AND (grant_json->>'lineCreateEnabled' = 'true' " +
      "OR grant_json->>'lineManageAllEnabled' = 'true') LIMIT 1", [manifest.propertyId]);
    if (existing.rows.length) throw Error("SWEETFUN_LINE_WRITER_GRANT_ALREADY_ACTIVE");
    const token = randomBytes(32).toString("base64url");
    await client.query("INSERT INTO iron_gate.credentials " +
      "(token_hash, credential_id, property_id, grant_json, expires_at) " +
      "VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)",
    [tokenHash(token), grant.credentialId, grant.propertyId,
      JSON.stringify(grant), expiresAt]);
    const readback = await client.query("SELECT token_hash, grant_json, active " +
      "FROM iron_gate.credentials WHERE credential_id = $1", [grant.credentialId]);
    if (readback.rows.length !== 1 || readback.rows[0].active !== true ||
      readback.rows[0].token_hash !== tokenHash(token) ||
      !isDeepStrictEqual(readback.rows[0].grant_json, grant))
      throw Error("SWEETFUN_LINE_MANAGE_GRANT_READBACK_MISMATCH");
    file = await open(output, "wx", 0o600);
    created = true;
    await file.writeFile(JSON.stringify({ projectRef: PROJECT_REF,
      propertyId: grant.propertyId, workspaceId: grant.workspaceId,
      credentialId: grant.credentialId, grantId: grant.grantId,
      clientId: grant.clientId, groupId: grant.lineGroupId,
      actorIds: grant.lineActorIds, token, expiresAt }) + "\n");
    await file.sync();
    commitStarted = true;
    await client.query("COMMIT");
    return { status: "staged_manage_all", credentialId: grant.credentialId,
      propertyId: grant.propertyId, outputPath: output };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // A lost COMMIT acknowledgement is ambiguous: preserve the token for
    // readback/revocation instead of orphaning an active credential.
    if (created && !commitStarted) await unlink(output).catch(() => {});
    throw error;
  } finally { await file?.close(); client.release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let pool;
  try {
    if (process.argv.length !== 5) throw Error("PRIVATE_MANIFEST_ADMIN_AND_OUTPUT_REQUIRED");
    const manifest = privateJson(process.argv[2]);
    const admin = privateJson(process.argv[3]);
    pool = new Pool({ connectionString: adminDatabaseUrl(admin), max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    process.stdout.write(JSON.stringify(await stageSweetfunLineManageGrant(
      pool, manifest, process.argv[4])) + "\n");
  } catch (error) {
    process.stderr.write((error?.message ?? "SWEETFUN_LINE_MANAGE_STAGE_FAILED") + "\n");
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
