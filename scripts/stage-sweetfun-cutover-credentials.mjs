import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { tokenHash, validateGrant } from "../src/credential-grant.mjs";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";
import { prepareSweetfunSourceLinks } from "../src/sweetfun-source-links.mjs";
import { sweetfunReviewResolved } from "../src/sweetfun-historical-review.mjs";
import { validateDatabaseTransport } from "../src/runtime-safety.mjs";
import { privateJson } from "./seed-sweetfun-shadow.mjs";

const projectRef = "brcszrkwkgiwatrxevkf";
const sourceSystem = "sweetfun-calendar-sheet";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/;

/** Credentials are issued while the property is still epoch 0. Authentication
 * rejects their epoch-1 grants until the separate authority switch commits. */
export function planSweetfunCutoverCredentials(state, occupancy, manifest) {
  if (manifest?.projectRef !== projectRef ||
    ![manifest.propertyId, manifest.workspaceId, manifest.sourceGrantId,
      manifest.sourceCredentialId, manifest.osCredentialId,
      manifest.sourceClientId, manifest.osClientId].every(value => uuid.test(value ?? "")) ||
    manifest.sourceCredentialId === manifest.osCredentialId ||
    !sha256.test(manifest.expectedSourceHash ?? "") ||
    state?.propertyId !== manifest.propertyId ||
    state.workspaceId !== manifest.workspaceId || state.authorityEpoch !== 0 ||
    state.readOnly !== true || state.version !== manifest.expectedVersion ||
    state.sweetfunImport?.sourceHash !== manifest.expectedSourceHash ||
    state.sweetfunImport?.sourceId !== manifest.sourceAccount ||
    state.sweetfunImport?.uncontainedReviewRows !== 0 ||
    !sweetfunReviewResolved(state) ||
    !Array.isArray(state.sourceLinks) || !state.sourceLinks.length ||
    state.sourceGrants?.length !== 0 || state.operations?.length !== 0 ||
    state.receipts?.length !== 0 ||
    state.manualBlocks?.length !== 0 ||
    !checkPropertyIntegrity(state, occupancy).ok)
    throw Error("SWEETFUN_CREDENTIAL_PREFLIGHT_FAILED");
  const unlinked = structuredClone(state);
  unlinked.sourceLinks = [];
  const recomputed = prepareSweetfunSourceLinks(unlinked, sourceSystem,
    manifest.sourceAccount);
  if (!isDeepStrictEqual(state.sourceLinks, recomputed.state.sourceLinks) ||
    recomputed.summary.activeLinks !== state.bookings.filter(booking =>
      booking.status === "confirmed").length)
    throw Error("SWEETFUN_CREDENTIAL_LINKS_INCOMPLETE");

  const common = { workspaceId: manifest.workspaceId,
    propertyId: manifest.propertyId, authorityEpoch: 1 };
  const source = { ...common, credentialId: manifest.sourceCredentialId,
    clientId: manifest.sourceClientId, subjectId: "gmail-order-handler",
    origin: "source", actions: ["source:write"], fields: [],
    grantId: manifest.sourceGrantId, sourceSystem,
    sourceAccount: manifest.sourceAccount };
  const os = { ...common, credentialId: manifest.osCredentialId,
    clientId: manifest.osClientId, subjectId: "sweetfun-os",
    origin: "os", actions: ["booking:read", "occupancy:aggregate"],
    fields: ["guest_name"] };
  validateGrant(source, manifest.expiresAt);
  validateGrant(os, manifest.expiresAt);
  return { source, os, expiresAt: manifest.expiresAt };
}

function adminDatabaseUrl(config) {
  if (config?.projectRef !== projectRef || typeof config.url !== "string")
    throw Error("INVALID_SWEETFUN_ADMIN_DATABASE");
  validateDatabaseTransport(config.url);
  const url = new URL(config.url);
  if (url.hostname !== "aws-0-ap-northeast-1.pooler.supabase.com" ||
    url.port !== "6543" || url.pathname !== "/postgres" ||
    decodeURIComponent(url.username) !== `postgres.${projectRef}` ||
    !url.password || [...url.searchParams.keys()].join() !== "sslmode" ||
    url.searchParams.get("sslmode") !== "verify-full")
    throw Error("INVALID_SWEETFUN_ADMIN_DATABASE");
  url.searchParams.set("sslrootcert", fileURLToPath(
    new URL("../certs/prod-ca-2021.crt", import.meta.url)));
  return url.toString();
}

/** A pre-created private output file is the recovery record if COMMIT outcome
 * is unknown. Never rerun after an error without reading credential rows. */
export async function stageSweetfunCutoverCredentials(pool, manifest, outputPath) {
  const output = resolve(outputPath);
  if (!["/private/tmp", tmpdir()].some(root => output.startsWith(resolve(root) + sep)))
    throw Error("SWEETFUN_CREDENTIAL_OUTPUT_MUST_BE_PRIVATE_TEMP");
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
    if (selected.rows.length !== 1) throw Error("SWEETFUN_CREDENTIAL_STATE_MISSING");
    const occupancy = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1
      ORDER BY room_id, night`, [manifest.propertyId]);
    const planned = planSweetfunCutoverCredentials(selected.rows[0].state_json,
      occupancy.rows, manifest);
    const sourceToken = randomBytes(32).toString("base64url");
    const osToken = randomBytes(32).toString("base64url");
    for (const [grant, token] of [[planned.source, sourceToken], [planned.os, osToken]]) {
      await client.query(`INSERT INTO iron_gate.credentials
        (token_hash, credential_id, property_id, grant_json, expires_at)
        VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
      [tokenHash(token), grant.credentialId, grant.propertyId,
        JSON.stringify(grant), planned.expiresAt]);
    }
    const readback = await client.query(`SELECT credential_id::text, token_hash,
      grant_json, active FROM iron_gate.credentials
      WHERE credential_id = ANY($1::uuid[]) ORDER BY credential_id`,
    [[planned.source.credentialId, planned.os.credentialId]]);
    const expected = new Map([
      [planned.source.credentialId, { hash: tokenHash(sourceToken), grant: planned.source }],
      [planned.os.credentialId, { hash: tokenHash(osToken), grant: planned.os }],
    ]);
    if (readback.rows.length !== 2 ||
      !readback.rows.every(row => {
        const item = expected.get(row.credential_id);
        return row.active === true && item && row.token_hash === item.hash &&
          isDeepStrictEqual(row.grant_json, item.grant);
      }))
      throw Error("SWEETFUN_CREDENTIAL_READBACK_MISMATCH");
    file = await open(output, "wx", 0o600);
    await file.writeFile(JSON.stringify({ projectRef, propertyId: manifest.propertyId,
      expectedSourceHash: manifest.expectedSourceHash,
      source: { credentialId: planned.source.credentialId, token: sourceToken },
      osCalendarGrant: { credentialId: planned.os.credentialId,
        clientId: planned.os.clientId, workspaceId: planned.os.workspaceId,
        propertyId: planned.os.propertyId, token: osToken },
      expiresAt: planned.expiresAt }) + "\n");
    await file.sync();
    await client.query("COMMIT");
    return { sourceCredentialId: planned.source.credentialId,
      osCredentialId: planned.os.credentialId, authorityEpoch: 1,
      outputPath: output, status: "staged_inactive" };
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
    const result = await stageSweetfunCutoverCredentials(pool, manifest, process.argv[4]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? "SWEETFUN_CREDENTIAL_STAGE_FAILED"}\n`);
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
