import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { tokenHash, validateGrant } from "../src/credential-grant.mjs";
import { validateDatabaseTransport } from "../src/runtime-safety.mjs";
import { privateJson } from "./seed-sweetfun-shadow.mjs";

const PROJECT_REF = "brcszrkwkgiwatrxevkf";
const SOURCE_SYSTEM = "sweetfun-calendar-sheet";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Pure preflight. The resulting grant has no booking mutation action. */
export function planSweetfunLineReadGrant(state, manifest) {
  if (manifest?.projectRef !== PROJECT_REF ||
    ![manifest.propertyId, manifest.workspaceId, manifest.credentialId,
      manifest.grantId, manifest.clientId].every((value) => UUID.test(value ?? "")) ||
    !Number.isSafeInteger(manifest.expectedVersion) || manifest.expectedVersion < 0 ||
    state?.propertyId !== manifest.propertyId ||
    state.workspaceId !== manifest.workspaceId ||
    state.version !== manifest.expectedVersion ||
    state.authorityEpoch !== 1 || state.readOnly !== false ||
    state.channel?.mode !== "none" || state.channel.sourceReadbackEnabled === true ||
    !state.sourceGrants?.some((grant) => grant.active === true &&
      grant.sourceSystem === SOURCE_SYSTEM &&
      grant.sourceAccount === state.sweetfunImport?.sourceId) ||
    !Array.isArray(manifest.actorIds) ||
    !Array.isArray(state.roomIds) || state.roomIds.length !== 6 ||
    !state.roomIds.every((roomId) => UUID.test(roomId)))
    throw Error("SWEETFUN_LINE_READ_PREFLIGHT_FAILED");
  const grant = { credentialId: manifest.credentialId,
    workspaceId: manifest.workspaceId, propertyId: manifest.propertyId,
    authorityEpoch: 1, clientId: manifest.clientId, subjectId: "line-staff-read",
    origin: "line", actions: ["booking:read"],
    fields: ["guest_name", "contact", "notes", "money"],
    grantId: manifest.grantId, lineGroupId: manifest.groupId,
    lineActorIds: manifest.actorIds };
  validateGrant(grant, manifest.expiresAt);
  return { grant, expiresAt: manifest.expiresAt };
}

function adminDatabaseUrl(config) {
  if (config?.projectRef !== PROJECT_REF || typeof config.url !== "string")
    throw Error("INVALID_SWEETFUN_ADMIN_DATABASE");
  validateDatabaseTransport(config.url);
  const url = new URL(config.url);
  if (url.hostname !== "aws-0-ap-northeast-1.pooler.supabase.com" ||
    url.port !== "6543" || url.pathname !== "/postgres" ||
    decodeURIComponent(url.username) !== `postgres.${PROJECT_REF}` ||
    !url.password || [...url.searchParams.keys()].join() !== "sslmode" ||
    url.searchParams.get("sslmode") !== "verify-full")
    throw Error("INVALID_SWEETFUN_ADMIN_DATABASE");
  url.searchParams.set("sslrootcert", fileURLToPath(
    new URL("../certs/prod-ca-2021.crt", import.meta.url)));
  return url.toString();
}

/** Stages only one read credential. A separate owner-approved release must
 * distribute secrets, deploy a zero-traffic candidate, and enable the group. */
export async function stageSweetfunLineReadGrant(pool, manifest, outputPath) {
  const output = resolve(outputPath);
  if (!["/private/tmp", tmpdir()].some((root) => output.startsWith(resolve(root) + sep)))
    throw Error("SWEETFUN_LINE_READ_OUTPUT_MUST_BE_PRIVATE_TEMP");
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== "postgres" ||
    identity.rows[0]?.database_name !== "postgres")
    throw Error("WRONG_SWEETFUN_CREDENTIAL_ADMIN");
  const client = await pool.connect();
  let file;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const selected = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1 FOR UPDATE`, [manifest.propertyId]);
    if (selected.rows.length !== 1) throw Error("SWEETFUN_LINE_READ_STATE_MISSING");
    const { grant, expiresAt } = planSweetfunLineReadGrant(selected.rows[0].state_json,
      manifest);
    const existing = await client.query(`SELECT credential_id FROM iron_gate.credentials
      WHERE property_id = $1 AND active = true AND expires_at > now()
        AND grant_json->>'origin' = 'line' LIMIT 1`, [manifest.propertyId]);
    if (existing.rows.length) throw Error("SWEETFUN_LINE_READ_GRANT_ALREADY_ACTIVE");
    const token = randomBytes(32).toString("base64url");
    const proofSecret = randomBytes(32).toString("base64url");
    await client.query(`INSERT INTO iron_gate.credentials
      (token_hash, credential_id, property_id, grant_json, expires_at)
      VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
    [tokenHash(token), grant.credentialId, grant.propertyId,
      JSON.stringify(grant), expiresAt]);
    const readback = await client.query(`SELECT token_hash, grant_json, active
      FROM iron_gate.credentials WHERE credential_id = $1`, [grant.credentialId]);
    if (readback.rows.length !== 1 || readback.rows[0].active !== true ||
      readback.rows[0].token_hash !== tokenHash(token) ||
      !isDeepStrictEqual(readback.rows[0].grant_json, grant))
      throw Error("SWEETFUN_LINE_READ_GRANT_READBACK_MISMATCH");
    file = await open(output, "wx", 0o600);
    await file.writeFile(JSON.stringify({ projectRef: PROJECT_REF,
      propertyId: grant.propertyId, workspaceId: grant.workspaceId,
      credentialId: grant.credentialId, grantId: grant.grantId,
      clientId: grant.clientId, groupId: grant.lineGroupId,
      actorIds: grant.lineActorIds, token, proofSecret, expiresAt }) + "\n");
    await file.sync();
    await client.query("COMMIT");
    return { status: "staged_read_only", credentialId: grant.credentialId,
      propertyId: grant.propertyId, outputPath: output };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
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
    process.stdout.write(`${JSON.stringify(await stageSweetfunLineReadGrant(
      pool, manifest, process.argv[4]))}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? "SWEETFUN_LINE_READ_STAGE_FAILED"}\n`);
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
