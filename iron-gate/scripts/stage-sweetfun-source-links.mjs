import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { prepareSweetfunSourceLinks } from "../src/sweetfun-source-links.mjs";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";
import { assertRuntimeDatabase } from "../src/runtime-safety.mjs";
import { databaseUrl, privateJson } from "./seed-sweetfun-shadow.mjs";

const projectRef = "brcszrkwkgiwatrxevkf";
const expectedLogin = "iron_gate_shadow_import";
const sourceSystem = "sweetfun-calendar-sheet";
const sha256 = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function manifestValid(manifest) {
  return manifest?.projectRef === projectRef && uuid.test(manifest.propertyId ?? "") &&
    uuid.test(manifest.workspaceId ?? "") && manifest.authorityEpoch === 0 &&
    Number.isSafeInteger(manifest.expectedVersion) && manifest.expectedVersion > 0 &&
    typeof manifest.sourceId === "string" && manifest.sourceId.length > 0 &&
    typeof manifest.sourceCopyId === "string" && manifest.sourceCopyId.length > 0 &&
    manifest.sourceCopyId !== manifest.sourceId &&
    typeof manifest.sourceCopyCreatedAt === "string" &&
    Number.isFinite(Date.parse(manifest.sourceCopyCreatedAt)) &&
    sha256.test(manifest.expectedSourceHash ?? "");
}

function sameSource(state, manifest) {
  return state?.propertyId === manifest.propertyId &&
    state.workspaceId === manifest.workspaceId &&
    state.version === manifest.expectedVersion && state.authorityEpoch === 0 &&
    state.readOnly === true && state.sweetfunImport?.sourceId === manifest.sourceId &&
    state.sweetfunImport?.sourceHash === manifest.expectedSourceHash &&
    state.sweetfunImport?.capturedAt === manifest.sourceCopyCreatedAt;
}

/**
 * Add only source identity links to a frozen, read-only Sweetfun shadow.
 * The final Sheet copy and occupancy reconciliation must precede this step.
 * No source credential, authority epoch, booking or room night is changed.
 */
export async function stageSweetfunSourceLinks(pool, manifest,
  { expectedDatabaseName = "postgres" } = {}) {
  if (!manifestValid(manifest)) throw Error("INVALID_SOURCE_LINK_MANIFEST");
  await assertRuntimeDatabase(pool);
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== expectedLogin ||
    identity.rows[0]?.database_name !== expectedDatabaseName)
    throw Error("WRONG_SOURCE_LINK_DATABASE_LOGIN");

  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('iron_gate.property_id', $1, true)",
      [manifest.propertyId]);
    const result = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1 FOR UPDATE`, [manifest.propertyId]);
    if (result.rows.length !== 1 || !sameSource(result.rows[0].state_json, manifest))
      throw Error("SOURCE_LINK_TARGET_DRIFT");
    const current = result.rows[0].state_json;
    const occupied = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [manifest.propertyId]);
    if (!checkPropertyIntegrity(current, occupied.rows).ok)
      throw Error("SOURCE_LINK_OCCUPANCY_DRIFT");

    // For an idempotent repeat, recompute from the same immutable source rows;
    // any changed link or grant is a conflict, not a successful rerun.
    const source = structuredClone(current);
    source.sourceLinks = [];
    const planned = prepareSweetfunSourceLinks(source, sourceSystem, manifest.sourceId);
    const already = current.sourceLinks.length > 0;
    if (already && !isDeepStrictEqual(current.sourceLinks, planned.state.sourceLinks))
      throw Error("SOURCE_LINK_TARGET_CONFLICT");
    if (!already) {
      const updated = await client.query(`UPDATE iron_gate.property_state
        SET state_json = $2::jsonb, updated_at = now()
        WHERE property_id = $1 AND inventory_version = $3 AND authority_epoch = 0
          AND state_json->'sourceLinks' = '[]'::jsonb
          AND state_json->'sweetfunImport'->>'sourceHash' = $4`,
      [manifest.propertyId, JSON.stringify(planned.state), manifest.expectedVersion,
        manifest.expectedSourceHash]);
      if (updated.rowCount !== 1) throw Error("SOURCE_LINK_TARGET_VERSION_CONFLICT");
    }
    const readback = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1`, [manifest.propertyId]);
    const occupiedAfter = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [manifest.propertyId]);
    if (readback.rows.length !== 1 ||
      !isDeepStrictEqual(readback.rows[0].state_json, planned.state) ||
      !checkPropertyIntegrity(readback.rows[0].state_json, occupiedAfter.rows).ok ||
      occupiedAfter.rows.length !== occupied.rows.length)
      throw Error("SOURCE_LINK_READBACK_MISMATCH");
    await client.query("COMMIT");
    return { action: already ? "unchanged" : "linked", sourceHash: manifest.expectedSourceHash,
      activeLinks: planned.summary.activeLinks,
      cancelledLinks: planned.summary.cancelledLinks,
      paymentEventsCreated: 0, readOnly: true, canCutover: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let pool;
  try {
    if (process.argv.length !== 5 || process.argv[2] !== "--read-only-source-links")
      throw Error("EXPLICIT_SOURCE_LINK_SCOPE_REQUIRED");
    const manifest = privateJson(process.argv[3]);
    const credentials = privateJson(process.argv[4]);
    pool = new Pool({ connectionString: databaseUrl(credentials), max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    const result = await stageSweetfunSourceLinks(pool, manifest);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? "SOURCE_LINK_STAGE_FAILED"}\n`);
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
