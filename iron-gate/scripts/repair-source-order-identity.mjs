import { readFileSync } from 'node:fs';

// Private manifests/SQL contain production identifiers. Never commit them.
const PROPERTY = '95ae9bd1-5e6d-4386-be5b-6af3c5668a16';
const SOURCE = 'sweetfun-calendar-sheet';
const ACCOUNT = '1ZU1aJ4mLgysBz1UM84GLzljuWly8saF0p1HaNmAIBWc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateIdentityRepair(m) {
  if (!m || Object.keys(m).sort().join(',') !==
    'bookingId,expectedBookingVersion,expectedInventoryVersion,expectedSourceVersion,expectedTotalCents,externalOrderId,orderId,propertyId,requestKey,schema' ||
    m.schema !== 1 || m.propertyId !== PROPERTY || !UUID.test(m.bookingId) || !UUID.test(m.requestKey) ||
    !/^L:OBE[A-Z0-9]+$/.test(m.externalOrderId) || !/^\d{8,11}$/.test(m.orderId) ||
    !/^gmail-v1:[1-9]\d{12}:[0-9a-f]{64}$/.test(m.expectedSourceVersion) ||
    !['expectedBookingVersion','expectedInventoryVersion','expectedTotalCents'].every(k =>
      Number.isSafeInteger(m[k]) && m[k] > 0)) throw Error('INVALID_IDENTITY_REPAIR');
  return m;
}

export function identityRepairSql(manifest, dryRun = true) {
  const encoded = Buffer.from(JSON.stringify(validateIdentityRepair(manifest))).toString('base64');
  return `BEGIN ISOLATION LEVEL SERIALIZABLE;
DO $repair$
DECLARE
  m jsonb := convert_from(decode('${encoded}','base64'),'UTF8')::jsonb;
  s jsonb; booking jsonb; link jsonb; source_key text;
  next_inventory integer; next_booking integer; at_iso text; event_json jsonb; audit_json jsonb;
BEGIN
  PERFORM set_config('lock_timeout','5000ms',true);
  SELECT state_json INTO STRICT s FROM iron_gate.property_state
    WHERE property_id='${PROPERTY}'::uuid AND authority_epoch=1 AND
      inventory_version=(m->>'expectedInventoryVersion')::integer FOR UPDATE;
  next_inventory := (m->>'expectedInventoryVersion')::integer + 1;
  next_booking := (m->>'expectedBookingVersion')::integer + 1;
  source_key := jsonb_build_array('${SOURCE}','${ACCOUNT}',m->>'externalOrderId')::text;
  SELECT b INTO STRICT booking FROM jsonb_array_elements(s->'bookings') b
    WHERE b->>'id'=m->>'bookingId';
  SELECT l INTO STRICT link FROM jsonb_array_elements(s->'sourceLinks') l
    WHERE l->>'sourceSystem'='${SOURCE}' AND l->>'sourceAccount'='${ACCOUNT}' AND
      l->>'externalOrderId'=m->>'externalOrderId';
  IF s->>'propertyId' IS DISTINCT FROM '${PROPERTY}' OR s->>'readOnly' IS DISTINCT FROM 'false' OR
    (s->>'version')::integer IS DISTINCT FROM (m->>'expectedInventoryVersion')::integer OR
    (s->>'authorityEpoch')::integer IS DISTINCT FROM 1 OR
    booking->>'source' IS DISTINCT FROM 'external' OR booking->>'status' IS DISTINCT FROM 'confirmed' OR
    (booking->>'version')::integer IS DISTINCT FROM (m->>'expectedBookingVersion')::integer OR
    (booking->>'totalCents')::bigint IS DISTINCT FROM (m->>'expectedTotalCents')::bigint OR
    booking->'sourceCalendar'->>'platform' IS DISTINCT FROM 'booking' OR
    booking->'sourceCalendar'->>'externalOrderNo' IS NOT NULL OR
    booking->>'channelSyncState' IS DISTINCT FROM 'not_required' OR
    booking->>'channelOperationKey' IS NOT NULL OR
    coalesce(booking->>'lineOverridePending','false') <> 'false' OR
    coalesce(booking->>'osDirectOverride','false') <> 'false' OR
    jsonb_array_length(coalesce(booking->'paymentEvents','[]'::jsonb)) <> 0 OR
    jsonb_array_length(coalesce(booking->'cardChargeResults','[]'::jsonb)) <> 0 OR
    link->>'bookingId' IS DISTINCT FROM m->>'bookingId' OR
    (link->>'key')::jsonb IS DISTINCT FROM source_key::jsonb OR
    (booking->>'sourceKey' IS NOT NULL AND (booking->>'sourceKey')::jsonb IS DISTINCT FROM source_key::jsonb) OR
    (SELECT count(*) FROM jsonb_array_elements(s->'sourceLinks') l
      WHERE l->>'bookingId'=m->>'bookingId') <> 1 OR
    link->>'sourceVersion' IS DISTINCT FROM m->>'expectedSourceVersion' OR
    link->>'diverged' IS DISTINCT FROM 'false' OR
    (link->>'lastAppliedBookingVersion')::integer IS DISTINCT FROM (m->>'expectedBookingVersion')::integer OR
    coalesce(jsonb_array_length(link->'tombstoneNights'),-1) <> 0 OR
    booking->'sweetfunSnapshot'->>'groupKey' IS DISTINCT FROM m->>'externalOrderId' OR
    coalesce(jsonb_array_length(booking->'sweetfunSnapshot'->'rows'),0) < 1 OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(booking->'sweetfunSnapshot'->'rows') r
      WHERE lower(trim(coalesce(r->'values'->>2,''))) NOT IN ('booking','booking.com') OR
        r->'values'->>11 IS DISTINCT FROM substring(m->>'externalOrderId' from 3) OR
        r->'values'->>13 IS DISTINCT FROM m->>'orderId') OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(s->'bookings') b WHERE b->>'id' <> m->>'bookingId' AND
      (b->'sourceCalendar'->>'externalOrderNo'=m->>'orderId' OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(b->'sweetfunSnapshot'->'rows','[]'::jsonb)) r
          WHERE r->'values'->>13=m->>'orderId'))) OR
    EXISTS (SELECT 1 FROM iron_gate.audit_log a WHERE a.property_id='${PROPERTY}'::uuid AND
      a.audit_json->>'requestKey'=m->>'requestKey') THEN
    RAISE EXCEPTION 'IDENTITY_REPAIR_TARGET_DRIFT';
  END IF;
  s := jsonb_set(s,'{bookings}',(SELECT jsonb_agg(CASE WHEN b->>'id'=m->>'bookingId' THEN
    jsonb_set(b,'{sourceCalendar,externalOrderNo}',m->'orderId') || jsonb_build_object('version',next_booking)
    ELSE b END ORDER BY ordinal) FROM jsonb_array_elements(s->'bookings') WITH ORDINALITY AS rows(b,ordinal)));
  s := jsonb_set(s,'{sourceLinks}',(SELECT jsonb_agg(CASE WHEN l->>'bookingId'=m->>'bookingId' THEN
    l || jsonb_build_object('lastAppliedBookingVersion',next_booking) ELSE l END ORDER BY ordinal)
    FROM jsonb_array_elements(s->'sourceLinks') WITH ORDINALITY AS rows(l,ordinal)));
  s := jsonb_set(s,'{version}',to_jsonb(next_inventory));
  at_iso := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  event_json := jsonb_build_object('eventId',gen_random_uuid()::text,'at',at_iso,
    'type','source.facts_enriched','propertyId','${PROPERTY}','bookingId',m->>'bookingId',
    'bookingVersion',next_booking,'inventoryVersion',next_inventory);
  audit_json := jsonb_build_object('auditId',gen_random_uuid()::text,'at',at_iso,
    'type','source.facts_enriched','workspaceId',s->>'workspaceId','propertyId','${PROPERTY}',
    'bookingId',m->>'bookingId','bookingVersion',next_booking,'bookingStatus',booking->>'status',
    'inventoryVersion',next_inventory,'actorOrigin','system','actorClientId','maintenance',
    'actorSubjectId','owner-authorized-source-identity-repair','actorGrantId',NULL,
    'requestKey',m->>'requestKey','repairKind','missing_ota_identity_from_exact_import');
  INSERT INTO iron_gate.outbox(event_id,property_id,event_json)
    VALUES ((event_json->>'eventId')::uuid,'${PROPERTY}'::uuid,event_json);
  INSERT INTO iron_gate.audit_log(audit_id,property_id,audit_json)
    VALUES ((audit_json->>'auditId')::uuid,'${PROPERTY}'::uuid,audit_json);
  UPDATE iron_gate.property_state SET state_json=s,inventory_version=next_inventory,updated_at=now()
    WHERE property_id='${PROPERTY}'::uuid AND inventory_version=(m->>'expectedInventoryVersion')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDENTITY_REPAIR_VERSION_DRIFT'; END IF;
END $repair$;
SELECT inventory_version FROM iron_gate.property_state WHERE property_id='${PROPERTY}'::uuid;
${dryRun ? 'ROLLBACK;' : 'COMMIT;'}`;
}

if (process.argv[1]?.endsWith('repair-source-order-identity.mjs')) {
  const [mode, path] = process.argv.slice(2);
  if (!['dry-run','apply'].includes(mode) || !path) throw Error('MODE_AND_PRIVATE_MANIFEST_REQUIRED');
  process.stdout.write(identityRepairSql(JSON.parse(readFileSync(path,'utf8')),mode === 'dry-run'));
}
