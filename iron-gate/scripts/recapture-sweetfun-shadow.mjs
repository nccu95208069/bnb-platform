import { isDeepStrictEqual } from "node:util";
import { Pool } from "pg";
import { auditSweetfunSnapshot, verifySweetfunAudit } from
  "../src/sweetfun-sheet-audit.mjs";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";
import { assertRuntimeDatabase } from "../src/runtime-safety.mjs";
import { databaseUrl, privateJson } from "./seed-sweetfun-shadow.mjs";

function sourceRows(state) {
  return [...state.bookings.flatMap((booking) => booking.sweetfunSnapshot?.rows ?? []),
    ...(state.sweetfunImport?.quarantined ?? []).flatMap((group) => group.rows ?? [])]
    .map((row) => ({ rowNumber: row.rowNumber,
      values: row.values, notes: row.notes }))
    .sort((a, b) => a.rowNumber - b.rowNumber);
}

/** Bind an unchanged, post-drain owner-only copy to an existing read-only
 * shadow without rewriting bookings, source links, fences or occupied nights. */
export function planSweetfunVerifiedRecapture(state, snapshot, manifest) {
  const audit = auditSweetfunSnapshot(snapshot);
  if (!verifySweetfunAudit(snapshot, audit).matches ||
    !state || state.readOnly !== true || state.authorityEpoch !== 0 ||
    state.version !== manifest?.expectedVersion ||
    state.sweetfunImport?.sourceHash !== audit.sourceHash ||
    state.sweetfunImport?.sourceId !== manifest.sourceId ||
    manifest.expectedSourceHash !== audit.sourceHash ||
    manifest.sourceCopyId === manifest.sourceId ||
    !manifest.sourceCopyId ||
    manifest.capturedAt !== manifest.sourceCopyCreatedAt ||
    !Number.isFinite(Date.parse(manifest.capturedAt ?? "")) ||
    !Number.isFinite(Date.parse(manifest.legacyFrozenAt ?? "")) ||
    !Number.isFinite(Date.parse(manifest.gmailDrainedAt ?? "")) ||
    Date.parse(manifest.legacyFrozenAt) > Date.parse(manifest.gmailDrainedAt) ||
    Date.parse(manifest.gmailDrainedAt) > Date.parse(manifest.capturedAt) ||
    Date.parse(state.sweetfunImport.capturedAt) >= Date.parse(manifest.capturedAt) ||
    state.sourceGrants?.length !== 0 || state.operations?.length !== 0 ||
    state.receipts?.length !== 0 || state.manualBlocks?.length !== 0 ||
    !isDeepStrictEqual(snapshot.headers, state.sweetfunImport.headers) ||
    !isDeepStrictEqual(snapshot.rows, sourceRows(state)))
    throw Error("SWEETFUN_RECAPTURE_SOURCE_DRIFT");
  const next = structuredClone(state);
  next.version++;
  next.sweetfunImport.capturedAt = manifest.capturedAt;
  next.sweetfunImport.verifiedRecapture = {
    sourceCopyId: manifest.sourceCopyId,
    capturedAt: manifest.capturedAt,
    priorCapturedAt: state.sweetfunImport.capturedAt,
    sourceHash: audit.sourceHash,
    legacyFrozenAt: manifest.legacyFrozenAt,
    gmailDrainedAt: manifest.gmailDrainedAt };
  return { state: next, summary: { inventoryVersion: next.version,
    sourceRows: snapshot.rows.length, sourceHash: audit.sourceHash,
    changedRows: 0, occupiedNightsChanged: 0 } };
}

export async function recaptureSweetfunShadow(pool, snapshot, manifest) {
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
    if (selected.rows.length !== 1 ||
      selected.rows[0].state_json.propertyId !== manifest.propertyId)
      throw Error("SWEETFUN_SHADOW_MISSING");
    const before = selected.rows[0].state_json;
    const occupied = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1
      ORDER BY room_id, night, booking_id`, [manifest.propertyId]);
    if (!checkPropertyIntegrity(before, occupied.rows).ok)
      throw Error("SWEETFUN_SHADOW_INTEGRITY_CONFLICT");
    const planned = planSweetfunVerifiedRecapture(before, snapshot, manifest);
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
      !isDeepStrictEqual(occupied.rows, afterNights.rows) ||
      !checkPropertyIntegrity(readback.rows[0].state_json, afterNights.rows).ok)
      throw Error("SWEETFUN_RECAPTURE_READBACK_MISMATCH");
    await client.query("COMMIT");
    return planned.summary;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && process.argv[1].endsWith("recapture-sweetfun-shadow.mjs")) {
  const [snapshotPath, manifestPath, credentialsPath] = process.argv.slice(2);
  if (!snapshotPath || !manifestPath || !credentialsPath)
    throw Error("PRIVATE_INPUTS_REQUIRED");
  const pool = new Pool({ connectionString: databaseUrl(privateJson(credentialsPath)),
    max: 1 });
  try {
    console.log(JSON.stringify(await recaptureSweetfunShadow(pool,
      privateJson(snapshotPath), privateJson(manifestPath))));
  } finally { await pool.end(); }
}
