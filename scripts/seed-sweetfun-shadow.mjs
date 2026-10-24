import { readFileSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { prepareSweetfunShadow, verifySweetfunShadow } from "../src/sweetfun-shadow.mjs";
import { planSweetfunAdditiveShadow, planSweetfunCancellationShadow,
  planSweetfunMixedShadow, planSweetfunRetainedCancellation } from
  "../src/sweetfun-shadow-advance.mjs";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";
import { nightsFor } from "../src/service.ts";
import { assertRuntimeDatabase, validateDatabaseTransport } from "../src/runtime-safety.mjs";

const targetProjectRef = "brcszrkwkgiwatrxevkf";
const expectedLogin = "iron_gate_shadow_import";

function occupiedRows(state) {
  return state.bookings.filter((booking) => booking.status !== "cancelled")
    .flatMap((booking) => nightsFor(booking.stays, state.roomIds)
    .map((cell) => ({ room_id: cell.roomId, night: cell.date, booking_id: booking.id })));
}

/** Retain one owner-confirmed cancelled source row while freeing its occupied night. */
export async function cancelRetainedSweetfunShadow(pool, snapshot, config, decision,
  { expectedDatabaseName = "postgres" } = {}) {
  if (config?.sourceCopyId === config?.sourceId ||
    typeof config?.sourceCopyId !== "string" || !config.sourceCopyId ||
    config?.capturedAt !== config?.sourceCopyCreatedAt || config?.authorityEpoch !== 0)
    throw Error("INVALID_SHADOW_MANIFEST");
  await assertRuntimeDatabase(pool);
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== expectedLogin ||
    identity.rows[0]?.database_name !== expectedDatabaseName)
    throw Error("WRONG_SHADOW_DATABASE_LOGIN");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('iron_gate.property_id', $1, true)", [config.propertyId]);
    const existing = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1 FOR UPDATE`, [config.propertyId]);
    if (existing.rows.length !== 1) throw Error("SHADOW_TARGET_NOT_SEEDED");
    const current = existing.rows[0].state_json;
    const actual = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [config.propertyId]);
    if (!checkPropertyIntegrity(current, actual.rows).ok)
      throw Error("SHADOW_TARGET_INTEGRITY_CONFLICT");
    if (current.version === config.inventoryVersion &&
      verifySweetfunShadow(snapshot, config, current).matches) {
      await client.query("COMMIT");
      return { action: "unchanged", sourceHash: config.expectedSourceHash,
        retainedSourceRows: 1, occupiedRoomNights: actual.rows.length,
        paymentEventsCreated: 0, canCutover: false };
    }
    const plan = planSweetfunRetainedCancellation(current, snapshot, config, decision);
    const updated = await client.query(`UPDATE iron_gate.property_state SET
      inventory_version = $2, state_json = $3::jsonb, updated_at = now()
      WHERE property_id = $1 AND inventory_version = $4 AND authority_epoch = 0`,
    [config.propertyId, plan.state.version, JSON.stringify(plan.state), current.version]);
    if (updated.rowCount !== 1) throw Error("SHADOW_TARGET_VERSION_CONFLICT");
    const deleted = await client.query(`DELETE FROM iron_gate.occupied_room_nights AS occupied
      USING jsonb_to_recordset($2::jsonb) AS x(room_id uuid, night date, booking_id uuid)
      WHERE occupied.property_id = $1 AND occupied.room_id = x.room_id
        AND occupied.night = x.night AND occupied.booking_id = x.booking_id`,
    [config.propertyId, JSON.stringify(plan.removedOccupancy)]);
    if (deleted.rowCount !== plan.removedOccupancy.length)
      throw Error("SHADOW_TARGET_OCCUPANCY_CONFLICT");
    const readback = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1`, [config.propertyId]);
    const occupancy = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [config.propertyId]);
    if (readback.rows.length !== 1 ||
      !verifySweetfunShadow(snapshot, config, readback.rows[0].state_json).matches ||
      !checkPropertyIntegrity(readback.rows[0].state_json, occupancy.rows).ok ||
      occupancy.rows.length !== actual.rows.length - plan.removedOccupancy.length)
      throw Error("SHADOW_READBACK_MISMATCH");
    await client.query("COMMIT");
    return { action: "cancelled_retained", ...plan.summary };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

export function privateJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 4_000_000)
    throw Error("UNSAFE_PRIVATE_INPUT");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function databaseUrl(credentials) {
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

/** Advance a seeded shadow only when every source row change is an addition. */
export async function advanceSweetfunShadow(pool, snapshot, config,
  { expectedDatabaseName = "postgres" } = {}) {
  if (config?.sourceCopyId === config?.sourceId ||
    typeof config?.sourceCopyId !== "string" || !config.sourceCopyId ||
    config?.capturedAt !== config?.sourceCopyCreatedAt ||
    config?.authorityEpoch !== 0) throw Error("INVALID_SHADOW_MANIFEST");
  await assertRuntimeDatabase(pool);
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== expectedLogin ||
    identity.rows[0]?.database_name !== expectedDatabaseName)
    throw Error("WRONG_SHADOW_DATABASE_LOGIN");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('iron_gate.property_id', $1, true)", [config.propertyId]);
    const existing = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1 FOR UPDATE`, [config.propertyId]);
    if (existing.rows.length !== 1) throw Error("SHADOW_TARGET_NOT_SEEDED");
    const current = existing.rows[0].state_json;
    const actual = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [config.propertyId]);
    if (!checkPropertyIntegrity(current, actual.rows).ok)
      throw Error("SHADOW_TARGET_INTEGRITY_CONFLICT");
    if (current.sweetfunImport?.sourceHash === config.expectedSourceHash) {
      if (!verifySweetfunShadow(snapshot, config, current).matches)
        throw Error("SHADOW_TARGET_CONFLICT");
      await client.query("COMMIT");
      return { action: "unchanged", sourceHash: config.expectedSourceHash,
        acceptedGroups: current.bookings.length, occupiedRoomNights: actual.rows.length,
        paymentEventsCreated: 0, canCutover: false };
    }
    const plan = planSweetfunAdditiveShadow(current, snapshot, config);
    const updated = await client.query(`UPDATE iron_gate.property_state SET
      inventory_version = $2, state_json = $3::jsonb, updated_at = now()
      WHERE property_id = $1 AND inventory_version = $4 AND authority_epoch = 0`,
    [config.propertyId, plan.state.version, JSON.stringify(plan.state), current.version]);
    if (updated.rowCount !== 1) throw Error("SHADOW_TARGET_VERSION_CONFLICT");
    if (plan.addedOccupancy.length) await client.query(`INSERT INTO iron_gate.occupied_room_nights
      (property_id, room_id, night, booking_id)
      SELECT $1::uuid, x.room_id, x.night, x.booking_id
      FROM jsonb_to_recordset($2::jsonb) AS x(room_id uuid, night date, booking_id uuid)`,
    [config.propertyId, JSON.stringify(plan.addedOccupancy)]);
    const readback = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1`, [config.propertyId]);
    const occupancy = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [config.propertyId]);
    if (readback.rows.length !== 1 ||
      !verifySweetfunShadow(snapshot, config, readback.rows[0].state_json).matches ||
      !checkPropertyIntegrity(readback.rows[0].state_json, occupancy.rows).ok ||
      occupancy.rows.length !== actual.rows.length + plan.addedOccupancy.length)
      throw Error("SHADOW_READBACK_MISMATCH");
    await client.query("COMMIT");
    return { action: "advanced", sourceHash: plan.summary.afterHash,
      addedRows: plan.summary.addedRows, addedBookings: plan.summary.addedBookings,
      addedRoomNights: plan.summary.addedRoomNights,
      paymentEventsCreated: 0, canCutover: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

/** Remove one owner-attested booking and all of its nights from the read-only shadow only. */
export async function cancelSweetfunShadow(pool, snapshot, config, ownerDecision,
  { expectedDatabaseName = "postgres" } = {}) {
  if (config?.sourceCopyId === config?.sourceId ||
    typeof config?.sourceCopyId !== "string" || !config.sourceCopyId ||
    config?.capturedAt !== config?.sourceCopyCreatedAt ||
    config?.authorityEpoch !== 0) throw Error("INVALID_SHADOW_MANIFEST");
  await assertRuntimeDatabase(pool);
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== expectedLogin ||
    identity.rows[0]?.database_name !== expectedDatabaseName)
    throw Error("WRONG_SHADOW_DATABASE_LOGIN");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('iron_gate.property_id', $1, true)", [config.propertyId]);
    const existing = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1 FOR UPDATE`, [config.propertyId]);
    if (existing.rows.length !== 1) throw Error("SHADOW_TARGET_NOT_SEEDED");
    const current = existing.rows[0].state_json;
    const actual = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [config.propertyId]);
    if (!checkPropertyIntegrity(current, actual.rows).ok)
      throw Error("SHADOW_TARGET_INTEGRITY_CONFLICT");
    if (current.sweetfunImport?.sourceHash === config.expectedSourceHash) {
      if (!verifySweetfunShadow(snapshot, config, current).matches)
        throw Error("SHADOW_TARGET_CONFLICT");
      await client.query("COMMIT");
      return { action: "unchanged", sourceHash: config.expectedSourceHash,
        acceptedGroups: current.bookings.length, occupiedRoomNights: actual.rows.length,
        paymentEventsCreated: 0, canCutover: false };
    }
    const plan = planSweetfunCancellationShadow(current, snapshot, config, ownerDecision);
    const updated = await client.query(`UPDATE iron_gate.property_state SET
      inventory_version = $2, state_json = $3::jsonb, updated_at = now()
      WHERE property_id = $1 AND inventory_version = $4 AND authority_epoch = 0`,
    [config.propertyId, plan.state.version, JSON.stringify(plan.state), current.version]);
    if (updated.rowCount !== 1) throw Error("SHADOW_TARGET_VERSION_CONFLICT");
    const deleted = await client.query(`DELETE FROM iron_gate.occupied_room_nights AS occupied
      USING jsonb_to_recordset($2::jsonb) AS x(room_id uuid, night date, booking_id uuid)
      WHERE occupied.property_id = $1 AND occupied.room_id = x.room_id
        AND occupied.night = x.night AND occupied.booking_id = x.booking_id`,
    [config.propertyId, JSON.stringify(plan.removedOccupancy)]);
    if (deleted.rowCount !== plan.removedOccupancy.length)
      throw Error("SHADOW_TARGET_OCCUPANCY_CONFLICT");
    const readback = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1`, [config.propertyId]);
    const occupancy = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [config.propertyId]);
    if (readback.rows.length !== 1 ||
      !verifySweetfunShadow(snapshot, config, readback.rows[0].state_json).matches ||
      !checkPropertyIntegrity(readback.rows[0].state_json, occupancy.rows).ok ||
      occupancy.rows.length !== actual.rows.length - plan.removedOccupancy.length)
      throw Error("SHADOW_READBACK_MISMATCH");
    await client.query("COMMIT");
    return { action: "cancelled", sourceHash: plan.summary.afterHash,
      removedRows: plan.summary.removedRows,
      removedBookings: plan.summary.removedBookings,
      removedRoomNights: plan.summary.removedRoomNights,
      sourceNoteRowsChanged: plan.summary.sourceNoteRowsChanged,
      ownerConfirmedCancelled: plan.summary.ownerConfirmedCancelled,
      writerReceiptVerified: false,
      paymentEventsCreated: 0, canCutover: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

/** Reconcile accepted additions and attested cancellations in one read-only transaction. */
export async function reconcileSweetfunShadow(pool, snapshot, config, ownerDecisions,
  { expectedDatabaseName = "postgres" } = {}) {
  if (config?.sourceCopyId === config?.sourceId ||
    typeof config?.sourceCopyId !== "string" || !config.sourceCopyId ||
    config?.capturedAt !== config?.sourceCopyCreatedAt ||
    config?.authorityEpoch !== 0) throw Error("INVALID_SHADOW_MANIFEST");
  await assertRuntimeDatabase(pool);
  const identity = await pool.query("SELECT current_user AS login, current_database() AS database_name");
  if (identity.rows[0]?.login !== expectedLogin ||
    identity.rows[0]?.database_name !== expectedDatabaseName)
    throw Error("WRONG_SHADOW_DATABASE_LOGIN");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('iron_gate.property_id', $1, true)", [config.propertyId]);
    const existing = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1 FOR UPDATE`, [config.propertyId]);
    if (existing.rows.length !== 1) throw Error("SHADOW_TARGET_NOT_SEEDED");
    const current = existing.rows[0].state_json;
    const actual = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [config.propertyId]);
    if (!checkPropertyIntegrity(current, actual.rows).ok)
      throw Error("SHADOW_TARGET_INTEGRITY_CONFLICT");
    if (current.sweetfunImport?.sourceHash === config.expectedSourceHash) {
      if (!verifySweetfunShadow(snapshot, config, current).matches)
        throw Error("SHADOW_TARGET_CONFLICT");
      await client.query("COMMIT");
      return { action: "unchanged", sourceHash: config.expectedSourceHash,
        acceptedGroups: current.bookings.length, occupiedRoomNights: actual.rows.length,
        paymentEventsCreated: 0, canCutover: false };
    }
    const plan = planSweetfunMixedShadow(current, snapshot, config, ownerDecisions);
    const updated = await client.query(`UPDATE iron_gate.property_state SET
      inventory_version = $2, state_json = $3::jsonb, updated_at = now()
      WHERE property_id = $1 AND inventory_version = $4 AND authority_epoch = 0`,
    [config.propertyId, plan.state.version, JSON.stringify(plan.state), current.version]);
    if (updated.rowCount !== 1) throw Error("SHADOW_TARGET_VERSION_CONFLICT");
    const deleted = await client.query(`DELETE FROM iron_gate.occupied_room_nights AS occupied
      USING jsonb_to_recordset($2::jsonb) AS x(room_id uuid, night date, booking_id uuid)
      WHERE occupied.property_id = $1 AND occupied.room_id = x.room_id
        AND occupied.night = x.night AND occupied.booking_id = x.booking_id`,
    [config.propertyId, JSON.stringify(plan.removedOccupancy)]);
    if (deleted.rowCount !== plan.removedOccupancy.length)
      throw Error("SHADOW_TARGET_OCCUPANCY_CONFLICT");
    const inserted = await client.query(`INSERT INTO iron_gate.occupied_room_nights
      (property_id, room_id, night, booking_id)
      SELECT $1::uuid, x.room_id, x.night, x.booking_id
      FROM jsonb_to_recordset($2::jsonb) AS x(room_id uuid, night date, booking_id uuid)`,
    [config.propertyId, JSON.stringify(plan.addedOccupancy)]);
    if (inserted.rowCount !== plan.addedOccupancy.length)
      throw Error("SHADOW_TARGET_OCCUPANCY_CONFLICT");
    const readback = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1`, [config.propertyId]);
    const occupancy = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [config.propertyId]);
    if (readback.rows.length !== 1 ||
      !verifySweetfunShadow(snapshot, config, readback.rows[0].state_json).matches ||
      !checkPropertyIntegrity(readback.rows[0].state_json, occupancy.rows).ok ||
      occupancy.rows.length !== actual.rows.length - plan.removedOccupancy.length +
        plan.addedOccupancy.length)
      throw Error("SHADOW_READBACK_MISMATCH");
    await client.query("COMMIT");
    return { action: "reconciled", sourceHash: plan.summary.afterHash,
      addedRows: plan.summary.addedRows, addedBookings: plan.summary.addedBookings,
      addedRoomNights: plan.summary.addedRoomNights,
      removedRows: plan.summary.removedRows,
      removedBookings: plan.summary.removedBookings,
      removedRoomNights: plan.summary.removedRoomNights,
      sourceNoteRowsChanged: plan.summary.sourceNoteRowsChanged,
      ownerConfirmedCancelled: plan.summary.ownerConfirmedCancelled,
      writerReceiptVerified: false, paymentEventsCreated: 0, canCutover: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let pool;
  try {
    if (!["--bookings-only-shadow", "--additive-advance",
      "--cancellation-advance", "--mixed-advance", "--retained-cancellation"].includes(process.argv[2]) ||
      process.argv.length !== (["--cancellation-advance", "--mixed-advance",
        "--retained-cancellation"]
        .includes(process.argv[2]) ? 7 : 6))
      throw Error("EXPLICIT_SHADOW_SCOPE_REQUIRED");
    const source = privateJson(process.argv[3]);
    const config = privateJson(process.argv[4]);
    const credentials = privateJson(process.argv[5]);
    pool = new Pool({ connectionString: databaseUrl(credentials), max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    const result = process.argv[2] === "--retained-cancellation"
      ? await cancelRetainedSweetfunShadow(pool, source, config, privateJson(process.argv[6]))
      : process.argv[2] === "--mixed-advance"
      ? await reconcileSweetfunShadow(pool, source, config, privateJson(process.argv[6]))
      : process.argv[2] === "--cancellation-advance"
        ? await cancelSweetfunShadow(pool, source, config, privateJson(process.argv[6]))
      : process.argv[2] === "--additive-advance"
        ? await advanceSweetfunShadow(pool, source, config)
        : await seedSweetfunShadow(pool, source, config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const safeErrors = new Set(["INVALID_SHADOW_MANIFEST", "UNSAFE_PRIVATE_INPUT",
      "INVALID_SHADOW_DATABASE_CREDENTIAL", "UNSAFE_DATABASE_ROLE_OR_SCHEMA",
      "WRONG_SHADOW_DATABASE_LOGIN", "SHADOW_TARGET_NOT_SEEDED",
      "SHADOW_TARGET_INTEGRITY_CONFLICT", "SHADOW_TARGET_CONFLICT",
      "SHADOW_TARGET_VERSION_CONFLICT", "SHADOW_READBACK_MISMATCH",
      "SHADOW_TARGET_OCCUPANCY_CONFLICT",
      "UNSAFE_SWEETFUN_SHADOW_ADVANCE", "SWEETFUN_SHADOW_NON_ADDITIVE_SOURCE",
      "SWEETFUN_SHADOW_BOOKING_ID_DRIFT", "SWEETFUN_SHADOW_OCCUPANCY_DRIFT",
      "SWEETFUN_SHADOW_ADDITIVE_COVERAGE_MISMATCH",
      "UNSAFE_SWEETFUN_SHADOW_CANCELLATION",
      "SWEETFUN_SHADOW_CANCELLATION_SOURCE_DRIFT",
      "SWEETFUN_SHADOW_CANCELLATION_DECISION_DRIFT",
      "SWEETFUN_SHADOW_CANCELLATION_BOOKING_CONFLICT",
      "SWEETFUN_SHADOW_CANCELLATION_OCCUPANCY_DRIFT",
      "UNSAFE_SWEETFUN_SHADOW_MIXED_ADVANCE",
      "SWEETFUN_SHADOW_MIXED_SOURCE_DRIFT",
      "SWEETFUN_SHADOW_MIXED_DECISION_DRIFT",
      "SWEETFUN_SHADOW_MIXED_BOOKING_DRIFT",
      "SWEETFUN_SHADOW_MIXED_QUARANTINE_DRIFT",
      "SWEETFUN_SHADOW_MIXED_OCCUPANCY_DRIFT",
      "INVALID_SWEETFUN_CANCELLATION_TOMBSTONES",
      "INVALID_SWEETFUN_CANCELLATION_DECISION",
      "CANCELLATION_SOURCE_ID_NOT_UNIQUE_DISAPPEARANCE",
      "INVALID_SWEETFUN_RETAINED_CANCELLATION_DECISION",
      "UNSAFE_SWEETFUN_RETAINED_CANCELLATION",
      "SWEETFUN_RETAINED_CANCELLATION_SOURCE_DRIFT",
      "SWEETFUN_RETAINED_CANCELLATION_BOOKING_CONFLICT",
      "SWEETFUN_RETAINED_CANCELLATION_OCCUPANCY_DRIFT"]);
    const safeCode = safeErrors.has(error?.message) ? error.message :
      /^[A-Z0-9]{5}$/.test(error?.code ?? "") ? error.code : "REDACTED_ERROR";
    process.stderr.write(`Sweetfun shadow import failed: ${safeCode}\n`);
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
