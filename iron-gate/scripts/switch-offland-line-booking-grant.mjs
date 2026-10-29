import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { planOfflandLineBookingActivation } from './stage-offland-line-booking-grant.mjs';
import { adminDatabaseUrl } from './stage-sweetfun-line-read-grant.mjs';
import { privateJson } from './seed-sweetfun-shadow.mjs';
import { validateGrantShape } from '../src/credential-grant.mjs';
import { checkPropertyIntegrity } from '../src/property-integrity.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_REF = 'brcszrkwkgiwatrxevkf';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Controlled release operation: exact inactive credential and property policy
 * become active in one transaction. Revoke removes both in one transaction.
 * No guest, booking, finance, source-link or provider state may change. */
export async function switchOfflandLineBookingGrant(pool, action, manifest) {
  if (!['activate', 'revoke'].includes(action) || manifest?.projectRef !== PROJECT_REF ||
    ![manifest.propertyId, manifest.workspaceId, manifest.credentialId,
      manifest.grantId, manifest.requestKey].every(value => UUID.test(value ?? '')) ||
    !Number.isSafeInteger(manifest.expectedVersion) || manifest.expectedVersion < 1 ||
    typeof manifest.authorizationRef !== 'string' ||
    !/^[A-Za-z0-9:_-]{8,128}$/.test(manifest.authorizationRef))
    throw Error('OFFLAND_LINE_BOOKING_SWITCH_MANIFEST_INVALID');
  const identity = await pool.query('SELECT current_user AS login, current_database() AS database_name');
  if (identity.rows[0]?.login !== 'postgres' || identity.rows[0]?.database_name !== 'postgres')
    throw Error('WRONG_OFFLAND_CREDENTIAL_ADMIN');
  const client = await pool.connect();
  const requestHash = fingerprint({ action, manifest });
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const selected = await client.query('SELECT state_json, authority_epoch, inventory_version ' +
      'FROM iron_gate.property_state WHERE property_id = $1 FOR UPDATE', [manifest.propertyId]);
    const before = selected.rows[0]?.state_json;
    if (selected.rows.length !== 1 || before?.propertyId !== manifest.propertyId ||
      before.workspaceId !== manifest.workspaceId ||
      Number(selected.rows[0].authority_epoch) !== before.authorityEpoch ||
      Number(selected.rows[0].inventory_version) !== before.version)
      throw Error('OFFLAND_LINE_BOOKING_STATE_MISSING');
    const previous = await client.query('SELECT audit_json FROM iron_gate.audit_log ' +
      'WHERE audit_id = $1 AND property_id = $2', [manifest.requestKey, manifest.propertyId]);
    if (previous.rows.length) {
      const saved = previous.rows[0].audit_json;
      if (saved.requestHash !== requestHash || !saved.response)
        throw Error('OFFLAND_LINE_BOOKING_SWITCH_IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');
      return { ...saved.response, alreadyApplied: true };
    }
    if (before.version !== manifest.expectedVersion)
      throw Error('OFFLAND_LINE_BOOKING_CONCURRENT_CHANGE');
    const occupied = await client.query('SELECT room_id::text, night::text, booking_id::text ' +
      'FROM iron_gate.occupied_room_nights WHERE property_id = $1 ORDER BY room_id, night, booking_id',
    [manifest.propertyId]);
    if (!checkPropertyIntegrity(before, occupied.rows).ok)
      throw Error('OFFLAND_LINE_BOOKING_INTEGRITY_FAILED');
    const selectedGrant = await client.query('SELECT grant_json, active, expires_at ' +
      'FROM iron_gate.credentials WHERE credential_id = $1 AND property_id = $2 FOR UPDATE',
    [manifest.credentialId, manifest.propertyId]);
    const record = selectedGrant.rows[0], grant = record?.grant_json;
    if (selectedGrant.rows.length !== 1 || grant?.credentialId !== manifest.credentialId ||
      grant.grantId !== manifest.grantId || grant.propertyId !== manifest.propertyId ||
      grant.workspaceId !== manifest.workspaceId || grant.origin !== 'line' ||
      grant.lineProviderFreeEnabled !== true)
      throw Error('OFFLAND_LINE_BOOKING_STAGED_GRANT_MISMATCH');
    validateGrantShape(grant);
    let next;
    if (action === 'activate') {
      const planned = planOfflandLineBookingActivation(before, manifest);
      if (record.active !== false || !isDeepStrictEqual(planned.grant, grant) ||
        new Date(record.expires_at).toISOString() !== planned.expiresAt)
        throw Error('OFFLAND_LINE_BOOKING_STAGED_GRANT_MISMATCH');
      const other = await client.query('SELECT credential_id FROM iron_gate.credentials ' +
        "WHERE property_id = $1 AND credential_id <> $2 AND active = true AND expires_at > now() " +
        "AND grant_json->>'origin' = 'line' AND (grant_json->>'lineCreateEnabled' = 'true' " +
        "OR grant_json->>'lineManageAllEnabled' = 'true') LIMIT 1", [manifest.propertyId, manifest.credentialId]);
      if (other.rows.length) throw Error('OFFLAND_LINE_WRITER_GRANT_ALREADY_PRESENT');
      next = planned.state;
    } else {
      if (before.channel.lineBookingGrantId !== undefined && before.channel.lineBookingGrantId !== grant.grantId ||
        before.channel.lineBookingMode !== undefined && before.channel.lineBookingMode !== 'provider_free')
        throw Error('OFFLAND_LINE_BOOKING_STAGED_GRANT_MISMATCH');
      next = structuredClone(before);
      delete next.channel.lineBookingMode;
      delete next.channel.lineBookingGrantId;
      next.version++;
    }
    const active = action === 'activate';
    const credentialUpdate = await client.query('UPDATE iron_gate.credentials SET active = $3 ' +
      'WHERE credential_id = $1 AND property_id = $2 AND active = $4 ' +
      (active ? 'AND expires_at > now()' : ''),
    [manifest.credentialId, manifest.propertyId, active, record.active]);
    const stateUpdate = await client.query('UPDATE iron_gate.property_state SET state_json = $2::jsonb, ' +
      'inventory_version = $3, updated_at = now() WHERE property_id = $1 ' +
      'AND inventory_version = $4 AND authority_epoch = $5',
    [manifest.propertyId, JSON.stringify(next), next.version, before.version, before.authorityEpoch]);
    if (credentialUpdate.rowCount !== 1 || stateUpdate.rowCount !== 1)
      throw Error('OFFLAND_LINE_BOOKING_CONCURRENT_CHANGE');
    const after = await client.query('SELECT state_json, authority_epoch, inventory_version ' +
      'FROM iron_gate.property_state WHERE property_id = $1', [manifest.propertyId]);
    const afterGrant = await client.query('SELECT grant_json, active FROM iron_gate.credentials ' +
      'WHERE credential_id = $1 AND property_id = $2', [manifest.credentialId, manifest.propertyId]);
    const occupiedAfter = await client.query('SELECT room_id::text, night::text, booking_id::text ' +
      'FROM iron_gate.occupied_room_nights WHERE property_id = $1 ORDER BY room_id, night, booking_id',
    [manifest.propertyId]);
    if (after.rows.length !== 1 || !isDeepStrictEqual(after.rows[0].state_json, next) ||
      Number(after.rows[0].inventory_version) !== next.version ||
      Number(after.rows[0].authority_epoch) !== before.authorityEpoch || afterGrant.rows.length !== 1 ||
      afterGrant.rows[0].active !== active || !isDeepStrictEqual(afterGrant.rows[0].grant_json, grant) ||
      !isDeepStrictEqual(occupiedAfter.rows, occupied.rows) || !checkPropertyIntegrity(next, occupiedAfter.rows).ok)
      throw Error('OFFLAND_LINE_BOOKING_SWITCH_READBACK_MISMATCH');
    const response = { action, propertyId: manifest.propertyId, credentialId: manifest.credentialId,
      grantId: manifest.grantId, active, inventoryVersion: next.version,
      bookingMode: active ? 'provider_free' : 'disabled' };
    const audit = { auditId: manifest.requestKey, propertyId: manifest.propertyId,
      workspaceId: manifest.workspaceId, at: new Date().toISOString(),
      type: active ? 'line.provider_free.activated' : 'line.provider_free.revoked',
      actorOrigin: 'service', actorSubjectId: 'offland-line-booking-release',
      authorizationRef: manifest.authorizationRef, requestHash, response };
    await client.query('INSERT INTO iron_gate.audit_log (audit_id, property_id, audit_json) ' +
      'VALUES ($1, $2, $3::jsonb)', [manifest.requestKey, manifest.propertyId, JSON.stringify(audit)]);
    const auditReadback = await client.query('SELECT audit_json FROM iron_gate.audit_log ' +
      'WHERE audit_id = $1 AND property_id = $2', [manifest.requestKey, manifest.propertyId]);
    if (auditReadback.rows.length !== 1 || !isDeepStrictEqual(auditReadback.rows[0].audit_json, audit))
      throw Error('OFFLAND_LINE_BOOKING_SWITCH_READBACK_MISMATCH');
    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let pool;
  try {
    if (process.argv.length !== 5 || !['--activate', '--revoke'].includes(process.argv[2]))
      throw Error('OFFLAND_LINE_BOOKING_EXPLICIT_SWITCH_REQUIRED');
    const manifest = privateJson(process.argv[3]);
    const admin = privateJson(process.argv[4]);
    pool = new Pool({ connectionString: adminDatabaseUrl(admin), max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    process.stdout.write(JSON.stringify(await switchOfflandLineBookingGrant(pool,
      process.argv[2].slice(2), manifest)) + '\n');
  } catch (error) {
    const safe = typeof error?.message === 'string' &&
      /^(?:OFFLAND_|WRONG_OFFLAND_|INVALID_)[A-Z0-9_]+$/.test(error.message);
    process.stderr.write((safe ? error.message : 'OFFLAND_LINE_BOOKING_SWITCH_FAILED') + '\n');
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
