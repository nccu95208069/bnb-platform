import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { planSweetfunAuthorityActivation, planSweetfunNoWriteRollback } from
  "../src/sweetfun-authority.mjs";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";
import { assertRuntimeDatabase } from "../src/runtime-safety.mjs";
import { databaseUrl, privateJson } from "./seed-sweetfun-shadow.mjs";

const expectedLogin = "iron_gate_shadow_import";
const projectRef = "brcszrkwkgiwatrxevkf";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A single locked transition. An unknown outcome is resolved by a read-only
 * state check; callers must not blindly rerun a switch. */
export async function switchSweetfunAuthority(pool, action, manifest) {
  if (!["activate", "rollback-before-write"].includes(action) ||
    manifest?.projectRef !== projectRef || !uuid.test(manifest?.propertyId ?? "") ||
    !uuid.test(manifest?.workspaceId ?? ""))
    throw Error("INVALID_SWEETFUN_AUTHORITY_REQUEST");
  await assertRuntimeDatabase(pool);
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== expectedLogin ||
    identity.rows[0]?.database_name !== "postgres")
    throw Error("WRONG_SWEETFUN_AUTHORITY_DATABASE_LOGIN");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('iron_gate.property_id', $1, true)",
      [manifest.propertyId]);
    const selected = await client.query(`SELECT state_json, authority_epoch, inventory_version
      FROM iron_gate.property_state WHERE property_id = $1 FOR UPDATE`,
    [manifest.propertyId]);
    if (selected.rows.length !== 1) throw Error("SWEETFUN_AUTHORITY_STATE_MISSING");
    const before = selected.rows[0].state_json;
    const rows = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1
      ORDER BY room_id, night`, [manifest.propertyId]);
    const planned = action === "activate"
      ? planSweetfunAuthorityActivation(before, rows.rows, manifest)
      : planSweetfunNoWriteRollback(before, rows.rows, manifest);
    const updated = await client.query(`UPDATE iron_gate.property_state SET
      state_json = $2::jsonb, authority_epoch = $3, inventory_version = $4,
      updated_at = now()
      WHERE property_id = $1 AND authority_epoch = $5 AND inventory_version = $6
        AND state_json->>'readOnly' = $7
        AND state_json->'sweetfunImport'->>'sourceHash' = $8`,
    [manifest.propertyId, JSON.stringify(planned.state), planned.state.authorityEpoch,
      planned.state.version, before.authorityEpoch, before.version,
      String(before.readOnly), manifest.expectedSourceHash]);
    if (updated.rowCount !== 1) throw Error("SWEETFUN_AUTHORITY_CONCURRENT_CHANGE");
    const readback = await client.query(`SELECT state_json, authority_epoch, inventory_version
      FROM iron_gate.property_state WHERE property_id = $1`, [manifest.propertyId]);
    const occupiedAfter = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1
      ORDER BY room_id, night`, [manifest.propertyId]);
    if (readback.rows.length !== 1 ||
      !isDeepStrictEqual(readback.rows[0].state_json, planned.state) ||
      Number(readback.rows[0].authority_epoch) !== planned.state.authorityEpoch ||
      Number(readback.rows[0].inventory_version) !== planned.state.version ||
      !isDeepStrictEqual(occupiedAfter.rows, rows.rows) ||
      !checkPropertyIntegrity(planned.state, occupiedAfter.rows).ok)
      throw Error("SWEETFUN_AUTHORITY_READBACK_MISMATCH");
    await client.query("COMMIT");
    return { action, ...planned.summary };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let pool;
  try {
    if (process.argv.length !== 5 ||
      !["--activate", "--rollback-before-write"].includes(process.argv[2]))
      throw Error("EXPLICIT_SWEETFUN_AUTHORITY_ACTION_REQUIRED");
    const manifest = privateJson(process.argv[3]);
    const credentials = privateJson(process.argv[4]);
    pool = new Pool({ connectionString: databaseUrl(credentials), max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    const result = await switchSweetfunAuthority(pool, process.argv[2].slice(2), manifest);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? "SWEETFUN_AUTHORITY_SWITCH_FAILED"}\n`);
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
