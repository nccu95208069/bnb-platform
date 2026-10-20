import { readFileSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { prepareSweetfunShadow, verifySweetfunShadow } from "../src/sweetfun-shadow.mjs";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";
import { nightsFor } from "../src/service.ts";
import { assertRuntimeDatabase, validateDatabaseTransport } from "../src/runtime-safety.mjs";

const targetProjectRef = "brcszrkwkgiwatrxevkf";
const expectedLogin = "iron_gate_shadow_import";

function occupiedRows(state) {
  return state.bookings.flatMap((booking) => nightsFor(booking.stays, state.roomIds)
    .map((cell) => ({ room_id: cell.roomId, night: cell.date, booking_id: booking.id })));
}

function privateJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 4_000_000)
    throw Error("UNSAFE_PRIVATE_INPUT");
  return JSON.parse(readFileSync(path, "utf8"));
}

function databaseUrl(credentials) {
  if (!credentials || credentials.projectRef !== targetProjectRef ||
    credentials.login !== expectedLogin || typeof credentials.password !== "string" ||
    !/^[0-9a-f]{64}$/.test(credentials.password) ||
    credentials.host !== "aws-0-ap-northeast-1.pooler.supabase.com")
    throw Error("INVALID_SHADOW_DATABASE_CREDENTIAL");
  const url = new URL("postgresql://aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres");
  url.username = `${credentials.login}.${credentials.projectRef}`;
  url.password = credentials.password;
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", fileURLToPath(new URL("../certs/prod-ca-2021.crt", import.meta.url)));
  validateDatabaseTransport(url.toString());
  return url.toString();
}

/** Bookings-only shadow import. The target stays read-only and creates no cash events. */
export async function seedSweetfunShadow(pool, snapshot, config,
  { expectedDatabaseName = "postgres" } = {}) {
  if (config?.sourceCopyId === config?.sourceId ||
    typeof config?.sourceCopyId !== "string" || !config.sourceCopyId ||
    config?.capturedAt !== config?.sourceCopyCreatedAt ||
    config?.authorityEpoch !== 0) throw Error("INVALID_SHADOW_MANIFEST");
  const prepared = prepareSweetfunShadow(snapshot, config);
  const { state, summary } = prepared;
  const expectedOccupancy = occupiedRows(state);
  if (state.readOnly !== true || state.channel.ready || state.channel.websiteSalesEnabled ||
    state.bookings.some((booking) => booking.paymentEvents?.length) ||
    !checkPropertyIntegrity(state, expectedOccupancy).ok)
    throw Error("UNSAFE_SWEETFUN_SHADOW");
  await assertRuntimeDatabase(pool);
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== expectedLogin ||
    identity.rows[0]?.database_name !== expectedDatabaseName)
    throw Error("WRONG_SHADOW_DATABASE_LOGIN");

  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('iron_gate.property_id', $1, true)", [state.propertyId]);
    const existing = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1 FOR UPDATE`, [state.propertyId]);
    if (existing.rows.length) {
      const actualOccupancy = await client.query(`SELECT room_id::text, night::text, booking_id::text
        FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [state.propertyId]);
      if (!verifySweetfunShadow(snapshot, config, existing.rows[0].state_json).matches ||
        !checkPropertyIntegrity(existing.rows[0].state_json, actualOccupancy.rows).ok)
        throw Error("SHADOW_TARGET_CONFLICT");
      await client.query("COMMIT");
      return { action: "unchanged", sourceHash: prepared.sourceHash,
        acceptedGroups: summary.acceptedGroups, acceptedRows: summary.acceptedRows,
        quarantinedRows: summary.quarantinedRows, fencedRoomNights: summary.fencedRoomNights,
        paymentEventsCreated: 0, canCutover: false };
    }

    await client.query(`INSERT INTO iron_gate.property_state
      (property_id, workspace_id, authority_epoch, inventory_version, state_json)
      VALUES ($1, $2, $3, $4, $5::jsonb)`, [state.propertyId, state.workspaceId,
      state.authorityEpoch, state.version, JSON.stringify(state)]);
    if (expectedOccupancy.length) await client.query(`INSERT INTO iron_gate.occupied_room_nights
      (property_id, room_id, night, booking_id)
      SELECT $1::uuid, x.room_id, x.night, x.booking_id
      FROM jsonb_to_recordset($2::jsonb) AS x(room_id uuid, night date, booking_id uuid)`,
    [state.propertyId, JSON.stringify(expectedOccupancy)]);
    const readback = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1`, [state.propertyId]);
    const occupancy = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [state.propertyId]);
    if (readback.rows.length !== 1 ||
      !verifySweetfunShadow(snapshot, config, readback.rows[0].state_json).matches ||
      !checkPropertyIntegrity(readback.rows[0].state_json, occupancy.rows).ok ||
      occupancy.rows.length !== expectedOccupancy.length) throw Error("SHADOW_READBACK_MISMATCH");
    await client.query("COMMIT");
    return { action: "inserted", sourceHash: prepared.sourceHash,
      acceptedGroups: summary.acceptedGroups, acceptedRows: summary.acceptedRows,
      quarantinedRows: summary.quarantinedRows, fencedRoomNights: summary.fencedRoomNights,
      paymentEventsCreated: 0, canCutover: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let pool;
  try {
    if (process.argv[2] !== "--bookings-only-shadow" || process.argv.length !== 6)
      throw Error("EXPLICIT_SHADOW_SCOPE_REQUIRED");
    const source = privateJson(process.argv[3]);
    const config = privateJson(process.argv[4]);
    const credentials = privateJson(process.argv[5]);
    pool = new Pool({ connectionString: databaseUrl(credentials), max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    const result = await seedSweetfunShadow(pool, source, config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("Sweetfun shadow import failed; no source data was printed\n");
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
