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

export const PROJECT_REF = "brcszrkwkgiwatrxevkf";
const SOURCE_SYSTEM = "offland-calendar-sheet";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Dedicated Offland booking grant. No inventory, finance, source or payment action. */
export function planOfflandLineBookingGrant(state, manifest) {
  if (manifest?.projectRef !== PROJECT_REF ||
    ![manifest.propertyId, manifest.workspaceId, manifest.credentialId,
      manifest.grantId, manifest.clientId].every((value) => UUID.test(value ?? "")) ||
    !Number.isSafeInteger(manifest.expectedVersion) || manifest.expectedVersion < 1 ||
    state?.propertyId !== manifest.propertyId || state.workspaceId !== manifest.workspaceId ||
    state.version !== manifest.expectedVersion ||
    state.authorityEpoch !== 1 || state.readOnly !== false ||
    state.channel?.mode !== "none" || state.channel.ready !== false ||
    state.channel.sourceReadbackEnabled === true || state.channel.grantId !== null ||
    state.channel.lineBookingMode !== undefined || state.channel.lineBookingGrantId !== undefined ||
    state.offlandImport?.sourceId !== manifest.sourceAccount ||
    typeof manifest.sourceAccount !== "string" || !manifest.sourceAccount ||
    state.operations?.length !== 0 || state.channelDispatch || state.channelReviewHolds?.length ||
    !state.sourceGrants?.some((grant) => grant.active === true &&
      grant.sourceSystem === SOURCE_SYSTEM &&
      grant.sourceAccount === state.offlandImport?.sourceId) ||
    !Array.isArray(state.roomIds) || state.roomIds.length !== 1 ||
    !state.roomIds.every((roomId) => UUID.test(roomId)) ||
    !Array.isArray(manifest.actorIds))
    throw Error("OFFLAND_LINE_BOOKING_PREFLIGHT_FAILED");
  if (manifest.inventoryEnabled !== undefined || manifest.channelPolicy !== "provider_free")
    throw Error("OFFLAND_LINE_BOOKING_PREFLIGHT_FAILED");
  const grant = { credentialId: manifest.credentialId,
    workspaceId: manifest.workspaceId, propertyId: manifest.propertyId,
    authorityEpoch: 1, clientId: manifest.clientId, subjectId: "offland-line-staff-booking",
    origin: "line", actions: ["booking:read", "booking:create", "booking:amend",
      "booking:cancel", "booking:manage_all"],
    fields: ["guest_name", "contact", "notes", "money"],
    grantId: manifest.grantId, lineGroupId: manifest.groupId,
    lineActorIds: [...manifest.actorIds],
    lineCreateEnabled: true, lineManageAllEnabled: true, lineProviderFreeEnabled: true };
  validateGrant(grant, manifest.expiresAt);
  return { grant, expiresAt: manifest.expiresAt };
}

/** Pure activation candidate for review by the controlled property release.
 * The database activation must atomically enable the exact staged credential,
 * compare the original property version and persist this incremented state. */
export function planOfflandLineBookingActivation(state, manifest) {
  const planned = planOfflandLineBookingGrant(state, manifest);
  const next = structuredClone(state);
  next.channel.lineBookingMode = "provider_free";
  next.channel.lineBookingGrantId = planned.grant.grantId;
  next.version++;
  return { ...planned, state: next, expectedVersion: state.version };
}

/** Stage an INACTIVE credential. Secret distribution, exact-grant activation
 * and enabling GCO remain separate owner-authorized release steps. */
export async function stageOfflandLineBookingGrant(pool, manifest, outputPath) {
  const output = resolve(outputPath);
  if (!["/private/tmp", tmpdir()].some((root) => output.startsWith(resolve(root) + sep)))
    throw Error("OFFLAND_LINE_BOOKING_OUTPUT_MUST_BE_PRIVATE_TEMP");
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== "postgres" ||
    identity.rows[0]?.database_name !== "postgres")
    throw Error("WRONG_OFFLAND_CREDENTIAL_ADMIN");
  const client = await pool.connect();
  let file, created = false, commitStarted = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const selected = await client.query("SELECT state_json FROM iron_gate.property_state " +
      "WHERE property_id = $1 FOR UPDATE", [manifest.propertyId]);
    if (selected.rows.length !== 1) throw Error("OFFLAND_LINE_BOOKING_STATE_MISSING");
    const { grant, expiresAt } = planOfflandLineBookingGrant(selected.rows[0].state_json,
      manifest);
    const existing = await client.query("SELECT credential_id FROM iron_gate.credentials " +
      "WHERE property_id = $1 AND expires_at > now() " +
      "AND grant_json->>'origin' = 'line' " +
      "AND (grant_json->>'lineCreateEnabled' = 'true' " +
      "OR grant_json->>'lineManageAllEnabled' = 'true') LIMIT 1", [manifest.propertyId]);
    if (existing.rows.length) throw Error("OFFLAND_LINE_WRITER_GRANT_ALREADY_PRESENT");
    const token = randomBytes(32).toString("base64url");
    await client.query("INSERT INTO iron_gate.credentials " +
      "(token_hash, credential_id, property_id, grant_json, expires_at, active) " +
      "VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, false)",
    [tokenHash(token), grant.credentialId, grant.propertyId,
      JSON.stringify(grant), expiresAt]);
    const readback = await client.query("SELECT token_hash, grant_json, active " +
      "FROM iron_gate.credentials WHERE credential_id = $1", [grant.credentialId]);
    if (readback.rows.length !== 1 || readback.rows[0].active !== false ||
      readback.rows[0].token_hash !== tokenHash(token) ||
      !isDeepStrictEqual(readback.rows[0].grant_json, grant))
      throw Error("OFFLAND_LINE_BOOKING_GRANT_READBACK_MISMATCH");
    file = await open(output, "wx", 0o600);
    created = true;
    await file.writeFile(JSON.stringify({ projectRef: PROJECT_REF,
      propertyId: grant.propertyId, workspaceId: grant.workspaceId,
      credentialId: grant.credentialId, grantId: grant.grantId,
      clientId: grant.clientId, groupId: grant.lineGroupId,
      actorIds: grant.lineActorIds, token, expiresAt, active: false, channelPolicy: "provider_free" }) + "\n");
    await file.sync();
    commitStarted = true;
    await client.query("COMMIT");
    return { status: "staged_inactive_provider_free", credentialId: grant.credentialId,
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
    if (process.argv.length !== 6 || process.argv[2] !== "--stage") throw Error("PRIVATE_MANIFEST_ADMIN_AND_OUTPUT_REQUIRED");
    const manifest = privateJson(process.argv[3]);
    const admin = privateJson(process.argv[4]);
    pool = new Pool({ connectionString: adminDatabaseUrl(admin), max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    process.stdout.write(JSON.stringify(await stageOfflandLineBookingGrant(
      pool, manifest, process.argv[5])) + "\n");
  } catch (error) {
    const safe = typeof error?.message === "string" &&
      /^(?:OFFLAND_|WRONG_OFFLAND_|INVALID_|PRIVATE_)[A-Z0-9_]+$/.test(error.message);
    process.stderr.write((safe ? error.message : "OFFLAND_LINE_BOOKING_STAGE_FAILED") + "\n");
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
