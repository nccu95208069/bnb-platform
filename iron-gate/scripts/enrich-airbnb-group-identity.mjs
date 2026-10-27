import { readFileSync } from 'node:fs';

// Operator-reviewed evidence and full before-images stay in a private manifest.
const PROPERTY = '95ae9bd1-5e6d-4386-be5b-6af3c5668a16';
const SOURCE = 'sweetfun-calendar-sheet';
const ACCOUNT = '1ZU1aJ4mLgysBz1UM84GLzljuWly8saF0p1HaNmAIBWc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^HM[A-Z0-9]{8}$/;
const keys = (o, expected) => o && Object.keys(o).sort().join(',') === expected.split(',').sort().join(',');
const positive = n => Number.isSafeInteger(n) && n > 0;

export function validateAirbnbIdentityManifest(m) {
  const fail = () => { throw Error('INVALID_AIRBNB_IDENTITY_MANIFEST'); };
  if (!keys(m, 'schema,propertyId,requestKey,expectedInventoryVersion,targets,evidence') ||
    m.schema !== 1 || m.propertyId !== PROPERTY || !UUID.test(m.requestKey) ||
    !positive(m.expectedInventoryVersion) || !Array.isArray(m.targets) || m.targets.length !== 5) fail();
  const e = m.evidence;
  if (!keys(e, 'orderId,cancelledOrderId,confirmationMessageId,cancellationMessageId,mailEvidenceSha256,verifiedAt,reservationUrl,platformPayoutCents,internalTotalCents') ||
    !CODE.test(e.orderId) || !CODE.test(e.cancelledOrderId) || e.orderId === e.cancelledOrderId ||
    !/^[0-9a-f]{16}$/.test(e.confirmationMessageId) || !/^[0-9a-f]{16}$/.test(e.cancellationMessageId) ||
    !/^[0-9a-f]{64}$/.test(e.mailEvidenceSha256) || !Number.isFinite(Date.parse(e.verifiedAt)) ||
    e.reservationUrl !== `https://www.airbnb.com.tw/hosting/stay/${e.orderId}` ||
    !positive(e.platformPayoutCents) || !positive(e.internalTotalCents)) fail();
  const ids = new Set(), groups = new Set(), rooms = new Set(), guests = new Set(), dates = new Set();
  let total = 0;
  for (const target of m.targets) {
    if (!keys(target, 'booking,link')) fail();
    const b = target.booking, l = target.link, rows = b?.sweetfunSnapshot?.rows;
    if (!b || !l || !UUID.test(b.id) || b.propertyId !== PROPERTY || b.source !== 'external' ||
      b.status !== 'confirmed' || !positive(b.version) || b.sourceCalendar != null || b.sourceIdentityEnrichment != null ||
      b.sourceKey != null || b.currency !== 'TWD' || !positive(b.totalCents) ||
      typeof b.guestName !== 'string' || !b.guestName.trim() ||
      b.channelSyncState !== 'not_required' || b.channelOperationKey != null ||
      b.lineOverridePending || b.osDirectOverride || b.paymentEvents?.length !== 0 ||
      (b.cardChargeResults?.length ?? 0) !== 0 || !Array.isArray(b.stays) || b.stays.length !== 1 ||
      b.stays[0].roomIds?.length !== 1 || !Array.isArray(rows) || rows.length !== 1 ||
      rows[0].platform !== 'Airbnb' || rows[0].values?.[2] !== 'Airbnb' ||
      rows[0].values?.[13] !== '' || rows[0].values?.[11] !== '' ||
      rows[0].values?.[1] !== b.guestName || rows[0].roomFeeCents !== b.totalCents ||
      rows[0].checkIn !== b.stays[0].checkIn || rows[0].checkOut !== b.stays[0].checkOut ||
      !/^J:\d{14}$/.test(l.externalOrderId) || l.externalOrderId !== b.sweetfunSnapshot.groupKey ||
      l.externalOrderId !== `J:${rows[0].values?.[9]}` || l.bookingId !== b.id ||
      l.sourceSystem !== SOURCE || l.sourceAccount !== ACCOUNT ||
      !/^sheet-v1:[0-9a-f]{64}$/.test(l.sourceVersion) ||
      l.lastAppliedBookingVersion !== b.version || l.diverged !== false ||
      l.tombstoneNights?.length !== 0 ||
      l.key !== JSON.stringify([SOURCE, ACCOUNT, l.externalOrderId])) fail();
    ids.add(b.id); groups.add(l.externalOrderId); rooms.add(b.stays[0].roomIds[0]);
    guests.add(b.guestName); dates.add(`${b.stays[0].checkIn}/${b.stays[0].checkOut}`);
    total += b.totalCents;
  }
  if (ids.size !== 5 || groups.size !== 5 || rooms.size !== 5 || guests.size !== 1 || dates.size !== 1 ||
    total !== e.internalTotalCents) fail();
  return m;
}

export function airbnbIdentitySql(manifest, dryRun = true) {
  const encoded = Buffer.from(JSON.stringify(validateAirbnbIdentityManifest(manifest))).toString('base64');
  return `BEGIN ISOLATION LEVEL SERIALIZABLE;
DO $repair$
DECLARE
  m jsonb := convert_from(decode('${encoded}','base64'),'UTF8')::jsonb;
  s jsonb; original jsonb; target jsonb; booking jsonb; link jsonb;
  next_inventory integer; next_booking integer; at_iso text; event_json jsonb; audit_json jsonb;
BEGIN
  PERFORM set_config('lock_timeout','5000ms',true);
  SELECT state_json INTO STRICT s FROM iron_gate.property_state
    WHERE property_id='${PROPERTY}'::uuid AND authority_epoch=1 AND
      inventory_version=(m->>'expectedInventoryVersion')::integer FOR UPDATE;
  original := s;
  next_inventory := (m->>'expectedInventoryVersion')::integer + 1;
  IF s->>'propertyId' IS DISTINCT FROM '${PROPERTY}' OR s->>'readOnly' IS DISTINCT FROM 'false' OR
    (s->>'version')::integer IS DISTINCT FROM (m->>'expectedInventoryVersion')::integer OR
    (s->>'authorityEpoch')::integer IS DISTINCT FROM 1 OR
    EXISTS (SELECT 1 FROM iron_gate.audit_log a WHERE a.property_id='${PROPERTY}'::uuid AND
      a.audit_json->>'requestKey'=m->>'requestKey') OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(s->'bookings') b WHERE
      b->'sourceCalendar'->>'externalOrderNo' IN (m->'evidence'->>'orderId',m->'evidence'->>'cancelledOrderId') OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(b->'sweetfunSnapshot'->'rows','[]'::jsonb)) r
        WHERE r->'values'->>13 IN (m->'evidence'->>'orderId',m->'evidence'->>'cancelledOrderId'))) THEN
    RAISE EXCEPTION 'AIRBNB_IDENTITY_CONFLICT';
  END IF;
  FOR target IN SELECT t FROM jsonb_array_elements(m->'targets') t LOOP
    SELECT b INTO STRICT booking FROM jsonb_array_elements(s->'bookings') b
      WHERE b->>'id'=target->'booking'->>'id';
    SELECT l INTO STRICT link FROM jsonb_array_elements(s->'sourceLinks') l
      WHERE l->>'bookingId'=target->'booking'->>'id';
    IF booking IS DISTINCT FROM target->'booking' OR link IS DISTINCT FROM target->'link' THEN
      RAISE EXCEPTION 'AIRBNB_IDENTITY_TARGET_DRIFT';
    END IF;
    next_booking := (booking->>'version')::integer + 1;
    s := jsonb_set(s,'{bookings}',(SELECT jsonb_agg(CASE WHEN b->>'id'=booking->>'id' THEN
      b || jsonb_build_object('version',next_booking,'sourceCalendar',
        jsonb_build_object('platform','airbnb','externalOrderNo',m->'evidence'->>'orderId'),
        'sourceIdentityEnrichment',jsonb_build_object('schema',1,'bookingVersion',next_booking,
          'sourceOrderRef',link->>'externalOrderId'))
      ELSE b END ORDER BY ordinal) FROM jsonb_array_elements(s->'bookings') WITH ORDINALITY AS rows(b,ordinal)));
    s := jsonb_set(s,'{sourceLinks}',(SELECT jsonb_agg(CASE WHEN l->>'bookingId'=booking->>'id' THEN
      l || jsonb_build_object('lastAppliedBookingVersion',next_booking) ELSE l END ORDER BY ordinal)
      FROM jsonb_array_elements(s->'sourceLinks') WITH ORDINALITY AS rows(l,ordinal)));
    at_iso := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    event_json := jsonb_build_object('eventId',gen_random_uuid()::text,'at',at_iso,
      'type','source.facts_enriched','propertyId','${PROPERTY}','bookingId',booking->>'id',
      'bookingVersion',next_booking,'inventoryVersion',next_inventory);
    audit_json := jsonb_build_object('auditId',gen_random_uuid()::text,'at',at_iso,
      'type','source.facts_enriched','workspaceId',s->>'workspaceId','propertyId','${PROPERTY}',
      'bookingId',booking->>'id','bookingVersion',next_booking,'bookingStatus',booking->>'status',
      'inventoryVersion',next_inventory,'actorOrigin','system','actorClientId','maintenance',
      'actorSubjectId','owner-authorized-source-identity-repair','actorGrantId',NULL,
      'requestKey',m->>'requestKey','repairKind','airbnb_group_identity_from_verified_evidence',
      'evidence',m->'evidence','financialChangeApplied',false,
      'amountDifferenceCents',(m->'evidence'->>'platformPayoutCents')::bigint -
        (m->'evidence'->>'internalTotalCents')::bigint);
    INSERT INTO iron_gate.outbox(event_id,property_id,event_json)
      VALUES ((event_json->>'eventId')::uuid,'${PROPERTY}'::uuid,event_json);
    INSERT INTO iron_gate.audit_log(audit_id,property_id,audit_json)
      VALUES ((audit_json->>'auditId')::uuid,'${PROPERTY}'::uuid,audit_json);
  END LOOP;
  s := jsonb_set(s,'{version}',to_jsonb(next_inventory));
  IF (s - 'bookings' - 'sourceLinks' - 'version') IS DISTINCT FROM
    (original - 'bookings' - 'sourceLinks' - 'version') THEN
    RAISE EXCEPTION 'AIRBNB_IDENTITY_UNEXPECTED_STATE_CHANGE';
  END IF;
  UPDATE iron_gate.property_state SET state_json=s,inventory_version=next_inventory,updated_at=now()
    WHERE property_id='${PROPERTY}'::uuid AND inventory_version=(m->>'expectedInventoryVersion')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'AIRBNB_IDENTITY_VERSION_DRIFT'; END IF;
END $repair$;
SELECT inventory_version FROM iron_gate.property_state WHERE property_id='${PROPERTY}'::uuid;
${dryRun ? 'ROLLBACK;' : 'COMMIT;'}`;
}

if (process.argv[1]?.endsWith('enrich-airbnb-group-identity.mjs')) {
  const [mode, path] = process.argv.slice(2);
  if (!['dry-run','apply'].includes(mode) || !path) throw Error('MODE_AND_PRIVATE_MANIFEST_REQUIRED');
  process.stdout.write(airbnbIdentitySql(JSON.parse(readFileSync(path,'utf8')),mode === 'dry-run'));
}
