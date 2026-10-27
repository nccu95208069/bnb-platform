import { readFileSync } from 'node:fs';
import { validateAirbnbIdentityManifest } from './enrich-airbnb-group-identity.mjs';
import { reconciledAmount, reconciledFinanceAmounts } from '../src/source-amount-reconciliation.ts';

const PROPERTY = '95ae9bd1-5e6d-4386-be5b-6af3c5668a16';
// Whole-dollar largest remainder allocation preserves the original five-room weights.
export function allocateWholeTwd(totalCents, weights) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0 || totalCents % 100 ||
    weights.some(n => !Number.isSafeInteger(n) || n <= 0)) throw Error('INVALID_ALLOCATION');
  const sum = weights.reduce((a,b) => a+b,0), units = totalCents / 100;
  if (!Number.isSafeInteger(sum) || weights.some(n => !Number.isSafeInteger(units*n))) throw Error('INVALID_ALLOCATION');
  const parts = weights.map((n,i) => ({i,amount:Math.floor(units*n/sum),remainder:units*n%sum}));
  let left = units-parts.reduce((s,p) => s+p.amount,0);
  for (const p of [...parts].sort((a,b) => b.remainder-a.remainder || a.i-b.i)) if (left-- > 0) p.amount++;
  return parts.map(p => p.amount*100);
}
export function validateAirbnbAmountManifest(m) {
  const fail = () => { throw Error('INVALID_AIRBNB_AMOUNT_MANIFEST'); };
  try {
    const old = structuredClone(m), e = m.evidence;
    if (Object.keys(e).sort().join(',') !== ['orderId','cancelledOrderId','confirmationMessageId',
      'cancellationMessageId','mailEvidenceSha256','verifiedAt','reservationUrl','platformPayoutCents',
      'internalTotalCents','grossCents','hostFeeCents','taxCents','guestFeeCents','guestPaidCents',
      'platformEvidenceSha256','planEvidenceSha256'].sort().join(',') ||
      !/^[a-f0-9]{64}$/.test(e.platformEvidenceSha256) || !/^[a-f0-9]{64}$/.test(e.planEvidenceSha256)) fail();
    for (const key of ['grossCents','hostFeeCents','taxCents','guestFeeCents','guestPaidCents',
      'platformEvidenceSha256','planEvidenceSha256']) delete old.evidence[key];
    const weights = m.targets.map(t => t.booking.totalCents);
    const gross = allocateWholeTwd(e.grossCents,weights), net = allocateWholeTwd(e.platformPayoutCents,weights);
    for (const [i,t] of m.targets.entries()) {
      const b=t.booking, a=t.amount, prior=old.targets[i];
      if (Object.keys(t).sort().join(',') !== 'amount,booking,link' ||
        b.version !== 2 || b.sourceCalendar?.platform !== 'airbnb' ||
        b.sourceCalendar.externalOrderNo !== e.orderId || b.sourceAmountReconciliation ||
        b.sourceIdentityEnrichment?.schema !== 1 || b.sourceIdentityEnrichment.bookingVersion !== b.version ||
        b.sourceIdentityEnrichment.sourceOrderRef !== t.link.externalOrderId ||
        a.groupId !== m.requestKey || a.bookingVersion !== b.version+1 ||
        a.originalTotalCents !== b.totalCents || a.grossCents !== gross[i] || a.netCents !== net[i] ||
        a.hostFeeCents !== gross[i]-net[i] || a.groupOriginalCents !== e.internalTotalCents ||
        a.groupGrossCents !== e.grossCents || a.groupHostFeeCents !== e.hostFeeCents ||
        a.groupNetCents !== e.platformPayoutCents || a.groupTaxCents !== e.taxCents ||
        a.groupGuestFeeCents !== e.guestFeeCents || a.groupGuestPaidCents !== e.guestPaidCents) fail();
      reconciledAmount({...b,version:b.version+1,totalCents:a.netCents,sourceAmountReconciliation:a});
      delete prior.amount; delete prior.booking.sourceCalendar; delete prior.booking.sourceIdentityEnrichment;
    }
    validateAirbnbIdentityManifest(old);
    reconciledFinanceAmounts(m.targets.map(t => ({...t.booking,version:t.amount.bookingVersion,
      totalCents:t.amount.netCents,sourceAmountReconciliation:t.amount})));
  } catch { fail(); }
  return m;
}

export function airbnbAmountSql(manifest, dryRun = true) {
  const encoded = Buffer.from(JSON.stringify(validateAirbnbAmountManifest(manifest))).toString('base64');
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
      b->'sourceCalendar'->>'externalOrderNo'=m->'evidence'->>'orderId' AND NOT EXISTS
        (SELECT 1 FROM jsonb_array_elements(m->'targets') t WHERE t->'booking'->>'id'=b->>'id') OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(b->'sweetfunSnapshot'->'rows','[]'::jsonb)) r
        WHERE r->'values'->>13 IN (m->'evidence'->>'orderId',m->'evidence'->>'cancelledOrderId'))) THEN
    RAISE EXCEPTION 'AIRBNB_AMOUNT_CONFLICT';
  END IF;
  FOR target IN SELECT t FROM jsonb_array_elements(m->'targets') t LOOP
    SELECT b INTO STRICT booking FROM jsonb_array_elements(s->'bookings') b
      WHERE b->>'id'=target->'booking'->>'id';
    SELECT l INTO STRICT link FROM jsonb_array_elements(s->'sourceLinks') l
      WHERE l->>'bookingId'=target->'booking'->>'id';
    IF booking IS DISTINCT FROM target->'booking' OR link IS DISTINCT FROM target->'link' THEN
      RAISE EXCEPTION 'AIRBNB_AMOUNT_TARGET_DRIFT';
    END IF;
    next_booking := (booking->>'version')::integer + 1;
    s := jsonb_set(s,'{bookings}',(SELECT jsonb_agg(CASE WHEN b->>'id'=booking->>'id' THEN
      b || jsonb_build_object('version',next_booking,
        'totalCents',target->'amount'->'netCents','sourceAmountReconciliation',target->'amount',
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
      'actorSubjectId','owner-authorized-source-amount-reconciliation','actorGrantId',NULL,
      'requestKey',m->>'requestKey','repairKind','airbnb_group_amount_from_verified_evidence',
      'evidence',m->'evidence','financialChangeApplied',true,'paymentEventsCreated',false,
      'beforeTotalCents',booking->'totalCents','afterTotalCents',target->'amount'->'netCents',
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
    RAISE EXCEPTION 'AIRBNB_AMOUNT_UNEXPECTED_STATE_CHANGE';
  END IF;
  UPDATE iron_gate.property_state SET state_json=s,inventory_version=next_inventory,updated_at=now()
    WHERE property_id='${PROPERTY}'::uuid AND inventory_version=(m->>'expectedInventoryVersion')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'AIRBNB_AMOUNT_VERSION_DRIFT'; END IF;
END $repair$;
SELECT inventory_version FROM iron_gate.property_state WHERE property_id='${PROPERTY}'::uuid;
${dryRun ? 'ROLLBACK;' : 'COMMIT;'}`;
}

if (process.argv[1]?.endsWith('reconcile-airbnb-group-amount.mjs')) {
  const [mode, path] = process.argv.slice(2);
  if (!['dry-run','apply'].includes(mode) || !path) throw Error('MODE_AND_PRIVATE_MANIFEST_REQUIRED');
  process.stdout.write(airbnbAmountSql(JSON.parse(readFileSync(path,'utf8')),mode === 'dry-run'));
}
