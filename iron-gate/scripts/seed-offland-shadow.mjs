import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { prepareOfflandShadow, verifyOfflandShadow } from "../src/offland-shadow.mjs";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";
import { nightsFor } from "../src/service.ts";
import { assertRuntimeDatabase } from "../src/runtime-safety.mjs";
import { databaseUrl, privateJson } from "./seed-sweetfun-shadow.mjs";

const expectedLogin = "iron_gate_shadow_import";

function occupiedRows(state) {
  return state.bookings.filter(booking => booking.status === "confirmed")
    .flatMap(booking => nightsFor(booking.stays, state.roomIds).map(cell => ({
      room_id: cell.roomId, night: cell.date, booking_id: booking.id,
    })));
}

/** Import only a private, hash-bound, epoch-0 candidate. A changed target is
 * never overwritten by this entrypoint; recapture and reconcile separately. */
export async function seedOfflandShadow(pool, snapshot, config,
  { expectedDatabaseName = "postgres" } = {}) {
  const prepared = prepareOfflandShadow(snapshot, config);
  const { state, summary } = prepared;
  const expectedOccupancy = occupiedRows(state);
  if (state.readOnly !== true || state.authorityEpoch !== 0 ||
    state.channel.ready || state.channel.websiteSalesEnabled ||
    state.sourceGrants.length || state.receipts.length || state.operations.length ||
    state.bookings.some(booking => booking.paymentEvents.length) ||
    expectedOccupancy.length !== summary.occupiedVillaNights ||
    !checkPropertyIntegrity(state, expectedOccupancy).ok)
    throw Error("UNSAFE_OFFLAND_SHADOW");
  await assertRuntimeDatabase(pool);
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== expectedLogin ||
    identity.rows[0]?.database_name !== expectedDatabaseName)
    throw Error("WRONG_OFFLAND_SHADOW_DATABASE_LOGIN");

  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('iron_gate.property_id', $1, true)", [state.propertyId]);
    const existing = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1 FOR UPDATE`, [state.propertyId]);
    if (existing.rows.length) {
      const actual = await client.query(`SELECT room_id::text, night::text, booking_id::text
        FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [state.propertyId]);
      if (!verifyOfflandShadow(snapshot, config, existing.rows[0].state_json).matches ||
        !checkPropertyIntegrity(existing.rows[0].state_json, actual.rows).ok)
        throw Error("OFFLAND_SHADOW_TARGET_CONFLICT");
      await client.query("COMMIT");
      return { action: "unchanged", ...summary, sourceHash: prepared.sourceHash };
    }
    await client.query(`INSERT INTO iron_gate.property_state
      (property_id, workspace_id, authority_epoch, inventory_version, state_json)
      VALUES ($1, $2, 0, $3, $4::jsonb)`, [state.propertyId, state.workspaceId,
      state.version, JSON.stringify(state)]);
    await client.query(`INSERT INTO iron_gate.occupied_room_nights
      (property_id, room_id, night, booking_id)
      SELECT $1::uuid, x.room_id, x.night, x.booking_id
      FROM jsonb_to_recordset($2::jsonb) AS x(room_id uuid, night date, booking_id uuid)`,
    [state.propertyId, JSON.stringify(expectedOccupancy)]);
    const readback = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1`, [state.propertyId]);
    const occupancy = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [state.propertyId]);
    if (readback.rows.length !== 1 ||
      !verifyOfflandShadow(snapshot, config, readback.rows[0].state_json).matches ||
      !checkPropertyIntegrity(readback.rows[0].state_json, occupancy.rows).ok ||
      occupancy.rows.length !== expectedOccupancy.length)
      throw Error("OFFLAND_SHADOW_READBACK_MISMATCH");
    await client.query("COMMIT");
    return { action: "inserted", ...summary, sourceHash: prepared.sourceHash };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let pool;
  try {
    if (process.argv.length !== 5)
      throw Error("PRIVATE_OFFLAND_SNAPSHOT_MANIFEST_AND_DATABASE_CREDENTIAL_REQUIRED");
    const snapshot = privateJson(process.argv[2]);
    const manifest = privateJson(process.argv[3]);
    const credentials = privateJson(process.argv[4]);
    pool = new Pool({ connectionString: databaseUrl(credentials), max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    const result = await seedOfflandShadow(pool, snapshot, manifest);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? "OFFLAND_SHADOW_SEED_FAILED"}\n`);
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
