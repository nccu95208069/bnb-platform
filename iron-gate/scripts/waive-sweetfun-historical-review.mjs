import { isDeepStrictEqual } from "node:util";
import { Pool } from "pg";
import { planSweetfunHistoricalReviewWaiver,
  sweetfunReviewResolved } from "../src/sweetfun-historical-review.mjs";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";
import { assertRuntimeDatabase } from "../src/runtime-safety.mjs";
import { databaseUrl, privateJson } from "./seed-sweetfun-shadow.mjs";

/** The restricted import role may record only this exact source-bound decision.
 * The source rows, review fences and occupied nights are never changed here. */
export async function recordSweetfunHistoricalReviewWaiver(pool, manifest) {
  await assertRuntimeDatabase(pool);
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== "iron_gate_shadow_import" ||
    identity.rows[0]?.database_name !== "postgres")
    throw Error("WRONG_SHADOW_DATABASE_LOGIN");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('iron_gate.property_id', $1, true)",
      [manifest.propertyId]);
    const selected = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1 FOR UPDATE`, [manifest.propertyId]);
    if (selected.rows.length !== 1) throw Error("SWEETFUN_SHADOW_MISSING");
    const before = selected.rows[0].state_json;
    if (before.propertyId !== manifest.propertyId) throw Error("SWEETFUN_PROPERTY_MISMATCH");
    const nights = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1
      ORDER BY room_id, night, booking_id`, [manifest.propertyId]);
    if (!checkPropertyIntegrity(before, nights.rows).ok)
      throw Error("SWEETFUN_SHADOW_INTEGRITY_CONFLICT");
    const planned = planSweetfunHistoricalReviewWaiver(before, manifest);
    const updated = await client.query(`UPDATE iron_gate.property_state SET
      inventory_version = $2, state_json = $3::jsonb, updated_at = now()
      WHERE property_id = $1 AND inventory_version = $4 AND authority_epoch = 0`,
    [manifest.propertyId, planned.state.version, JSON.stringify(planned.state),
      before.version]);
    if (updated.rowCount !== 1) throw Error("SWEETFUN_SHADOW_VERSION_CONFLICT");
    const readback = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1`, [manifest.propertyId]);
    const afterNights = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1
      ORDER BY room_id, night, booking_id`, [manifest.propertyId]);
    if (readback.rows.length !== 1 ||
      !isDeepStrictEqual(readback.rows[0].state_json, planned.state) ||
      !isDeepStrictEqual(nights.rows, afterNights.rows) ||
      !sweetfunReviewResolved(readback.rows[0].state_json) ||
      !checkPropertyIntegrity(readback.rows[0].state_json, afterNights.rows).ok)
      throw Error("SWEETFUN_HISTORICAL_REVIEW_READBACK_MISMATCH");
    await client.query("COMMIT");
    return planned.summary;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && process.argv[1].endsWith("waive-sweetfun-historical-review.mjs")) {
  const [manifestPath, credentialsPath] = process.argv.slice(2);
  if (!manifestPath || !credentialsPath) throw Error("PRIVATE_INPUTS_REQUIRED");
  const manifest = privateJson(manifestPath);
  const pool = new Pool({ connectionString: databaseUrl(privateJson(credentialsPath)),
    max: 1 });
  try {
    console.log(JSON.stringify(await recordSweetfunHistoricalReviewWaiver(pool, manifest)));
  } finally { await pool.end(); }
}
