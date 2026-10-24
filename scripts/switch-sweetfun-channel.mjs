import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";
import { planSweetfunChannelActivation, planSweetfunChannelNoWriteRollback } from
  "../src/sweetfun-channel-activation.mjs";
import { privateJson } from "./seed-sweetfun-shadow.mjs";
import { adminDatabaseUrl } from "./stage-sweetfun-line-read-grant.mjs";

/** Run only while every GCO ingress is paused and drained. An unknown commit
 * outcome must be resolved by a read-only state check, never a blind retry. */
export async function switchSweetfunChannel(pool, action, manifest, snapshot,
  now = new Date()) {
  if (!["activate", "rollback-before-write"].includes(action))
    throw Error("EXPLICIT_SWEETFUN_CHANNEL_ACTION_REQUIRED");
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== "postgres" ||
    identity.rows[0]?.database_name !== "postgres")
    throw Error("WRONG_SWEETFUN_CHANNEL_ADMIN");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const selected = await client.query(`SELECT state_json, authority_epoch, inventory_version
      FROM iron_gate.property_state WHERE property_id = $1 FOR UPDATE`, [manifest.propertyId]);
    if (selected.rows.length !== 1) throw Error("SWEETFUN_CHANNEL_STATE_MISSING");
    const before = selected.rows[0].state_json;
    const occupancy = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1
      ORDER BY room_id, night`, [manifest.propertyId]);
    const planned = action === "activate"
      ? planSweetfunChannelActivation(before, occupancy.rows, manifest, snapshot, now)
      : planSweetfunChannelNoWriteRollback(before, occupancy.rows, manifest);
    const updated = await client.query(`UPDATE iron_gate.property_state SET
      state_json = $2::jsonb, inventory_version = $3, updated_at = now()
      WHERE property_id = $1 AND authority_epoch = $4 AND inventory_version = $5`,
    [manifest.propertyId, JSON.stringify(planned.state), planned.state.version,
      before.authorityEpoch, before.version]);
    if (updated.rowCount !== 1) throw Error("SWEETFUN_CHANNEL_CONCURRENT_CHANGE");
    const auditId = randomUUID();
    await client.query(`INSERT INTO iron_gate.audit_log
      (audit_id, property_id, audit_json) VALUES ($1, $2, $3::jsonb)`,
    [auditId, manifest.propertyId, JSON.stringify({ auditId,
      kind: "sweetfun.channel." + action, propertyId: manifest.propertyId,
      at: now.toISOString(), ...planned.summary })]);
    const readback = await client.query(`SELECT state_json, authority_epoch, inventory_version
      FROM iron_gate.property_state WHERE property_id = $1`, [manifest.propertyId]);
    const occupiedAfter = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1 ORDER BY room_id, night`,
    [manifest.propertyId]);
    if (readback.rows.length !== 1 ||
      !isDeepStrictEqual(readback.rows[0].state_json, planned.state) ||
      Number(readback.rows[0].authority_epoch) !== planned.state.authorityEpoch ||
      Number(readback.rows[0].inventory_version) !== planned.state.version ||
      !isDeepStrictEqual(occupiedAfter.rows, occupancy.rows) ||
      !checkPropertyIntegrity(planned.state, occupiedAfter.rows).ok)
      throw Error("SWEETFUN_CHANNEL_READBACK_MISMATCH");
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
    const action = process.argv[2]?.replace(/^--/, "");
    if (!["activate", "rollback-before-write"].includes(action) ||
      process.argv.length !== (action === "activate" ? 6 : 5))
      throw Error("EXPLICIT_SWEETFUN_CHANNEL_ACTION_REQUIRED");
    const manifest = privateJson(process.argv[3]);
    const admin = privateJson(process.argv[4]);
    const snapshot = action === "activate" ? privateJson(process.argv[5]) : null;
    pool = new Pool({ connectionString: adminDatabaseUrl(admin), max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    process.stdout.write(JSON.stringify(await switchSweetfunChannel(
      pool, action, manifest, snapshot)) + "\n");
  } catch (error) {
    process.stderr.write((error?.message ?? "SWEETFUN_CHANNEL_SWITCH_FAILED") + "\n");
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
