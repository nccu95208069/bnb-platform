import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const SOURCES = new Set(["sweetfun-calendar-sheet", "offland-calendar-sheet"]);
const fail = () => { throw Error("VERIFIED_DATE_REPAIR_INVALID"); };
const isoDay = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;

/** Offline operator: owner dates and original Gmail notice evidence are distinct.
 * Private snapshots/manifests and generated SQL must never enter source control. */
export function prepareVerifiedDates(snapshot, manifest) {
  if (!Array.isArray(snapshot) || manifest?.schema !== 1 || !UUID.test(manifest.repairKey)
    || !Array.isArray(manifest.entries) || manifest.entries.length < 1 || manifest.entries.length > 50) fail();
  const seen = new Set();
  const entries = manifest.entries.map(e => {
    if (!UUID.test(e.propertyId) || !UUID.test(e.bookingId) || seen.has(e.bookingId)) fail();
    seen.add(e.bookingId);
    const p = snapshot.find(p => p.property_id === e.propertyId);
    const t = p?.targets?.find(t => t.booking.id === e.bookingId), b = t?.booking;
    if (!p || !t || !HASH.test(t.bookingHash) || !HASH.test(p.state_hash) || !UUID.test(p.workspace_id)
      || p.authority_epoch < 1 || !Number.isSafeInteger(p.inventory_version)
      || b.status !== "confirmed" || b.bookedAt !== null || !Number.isSafeInteger(b.version)) fail();
    let notification = null, receipt = null;
    if (e.kind === "owner-booking-date") {
      if (b.source !== "os" || b.sourceKey !== null || t.link !== null || !isoDay(e.bookedAt)
        || e.bookedAt > b.stays.reduce((d,s) => s.checkIn < d ? s.checkIn : d, b.stays[0].checkIn)
        || e.evidenceType !== "owner_attestation" || typeof e.evidenceRef !== "string"
        || e.evidenceRef.length < 1 || e.evidenceRef.length > 200) fail();
    } else if (e.kind === "provider-booking-date") {
      const l = t.link;
      if (b.source !== "external" || b.sweetfunSnapshot || b.offlandSnapshot || b.osSnapshot
        || !l || !HASH.test(t.linkHash) || l.bookingId !== b.id || l.key !== b.sourceKey
        || l.key !== JSON.stringify([l.sourceSystem,l.sourceAccount,l.externalOrderId])
        || !SOURCES.has(l.sourceSystem) || l.diverged !== false || l.tombstoneNights.length
        || l.lastAppliedBookingVersion !== b.version || e.externalOrderId !== l.externalOrderId.slice(2)
        || e.providerPropertyId !== e.propertyId || e.providerStatus !== "active"
        || !isoDay(e.bookedAt) || !isoDay(e.providerCheckIn) || !isoDay(e.providerCheckOut)
        || e.providerCheckIn !== b.stays.reduce((d,s)=>s.checkIn<d?s.checkIn:d,b.stays[0].checkIn)
        || e.providerCheckOut !== b.stays.reduce((d,s)=>s.checkOut>d?s.checkOut:d,b.stays[0].checkOut)
        || e.bookedAt > e.providerCheckIn || e.evidenceType !== "owlnest_order_list"
        || !HASH.test(e.evidenceSha256) || typeof e.evidenceRef !== "string" || !e.evidenceRef
        || !Number.isFinite(Date.parse(e.checkedAt)) || e.bookedAt > e.checkedAt.slice(0,10)) fail();
    } else if (e.kind === "first-new-notice") {
      const l = t.link;
      if (b.source !== "external" || b.sweetfunSnapshot || b.offlandSnapshot || b.osSnapshot
        || !l || !HASH.test(t.linkHash) || l.bookingId !== b.id || l.key !== b.sourceKey
        || l.key !== JSON.stringify([l.sourceSystem,l.sourceAccount,l.externalOrderId])
        || !SOURCES.has(l.sourceSystem) || l.diverged !== false || l.tombstoneNights.length
        || l.lastAppliedBookingVersion !== b.version || l.firstNewOrderNotification
        || e.noticeKind !== "new" || !["owlnest@owlting.com","owljourney@owlting.com"].includes(e.sender)
        || !/^[0-9a-f]{16}$/.test(e.messageId) || !HASH.test(e.messageSha256)
        || !Number.isSafeInteger(e.internalDate) || e.internalDate > Date.parse(b.createdAt)
        || e.externalOrderId !== l.externalOrderId.slice(2)) fail();
      const version = `gmail-v1:${e.internalDate}:${createHash("sha256").update(e.messageId).digest("hex")}`;
      if (version !== l.sourceVersion) fail();
      const receipts = (t.receipts ?? []).filter(r => r.propertyId === e.propertyId && r.action === "source:write"
        && r.subjectId === "gmail-order-handler" && r.grantId !== null && UUID.test(r.key)
        && r.response?.state === "applied" && r.response.bookingId === b.id && r.response.bookingVersion === 1);
      if (receipts.length !== 1) fail();
      receipt = receipts[0];
      notification = {schema:1,receivedAt:new Date(e.internalDate).toISOString(),sourceVersion:version,requestKey:receipt.key};
    } else fail();
    return {...e,workspaceId:p.workspace_id,authorityEpoch:p.authority_epoch,expectedInventoryVersion:p.inventory_version,
      stateHash:p.state_hash,bookingHash:t.bookingHash,bookingVersion:b.version,linkHash:t.linkHash,
      notification,receipt,auditId:randomUUID(),eventId:randomUUID()};
  });
  return {schema:1,repairKey:manifest.repairKey,entries};
}

export function verifiedDatesSql(plan, dryRun = true) {
  const encoded = Buffer.from(JSON.stringify(plan)).toString("base64");
  return `BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $dates$
DECLARE
 spec jsonb:=convert_from(decode('${encoded}','base64'),'UTF8')::jsonb;
 p jsonb; e jsonb; b jsonb; l jsonb; s jsonb; result jsonb; original jsonb; replacement jsonb;
 n integer; idx integer; linkidx integer; old_version bigint; stamp text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 IF EXISTS (SELECT 1 FROM iron_gate.audit_log WHERE audit_json->>'requestKey'=spec->>'repairKey') THEN
  IF (SELECT count(*) FROM iron_gate.audit_log WHERE audit_json->>'requestKey'=spec->>'repairKey') <> jsonb_array_length(spec->'entries') THEN
   RAISE EXCEPTION 'DATE_REPAIR_PARTIAL_REPLAY'; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(spec->'entries') LOOP
   SELECT state_json INTO STRICT s FROM iron_gate.property_state WHERE property_id=(e->>'propertyId')::uuid;
   IF e->>'kind' IN ('owner-booking-date','provider-booking-date') THEN
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'bookings') x WHERE x->>'id'=e->>'bookingId' AND x->>'bookedAt'=e->>'bookedAt') THEN RAISE EXCEPTION 'DATE_REPAIR_REPLAY_CHANGED'; END IF;
   ELSE
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'sourceLinks') x WHERE x->>'bookingId'=e->>'bookingId' AND x->'firstNewOrderNotification'=e->'notification') THEN RAISE EXCEPTION 'DATE_REPAIR_REPLAY_CHANGED'; END IF;
   END IF;
  END LOOP;
  RETURN;
 END IF;
 FOR p IN SELECT DISTINCT jsonb_build_object('id',x->>'propertyId','workspace',x->>'workspaceId','epoch',x->'authorityEpoch','version',x->'expectedInventoryVersion','hash',x->>'stateHash') FROM jsonb_array_elements(spec->'entries') x ORDER BY 1 LOOP
  SELECT state_json INTO STRICT s FROM iron_gate.property_state WHERE property_id=(p->>'id')::uuid
    AND workspace_id=(p->>'workspace')::uuid AND authority_epoch=(p->>'epoch')::bigint
    AND inventory_version=(p->>'version')::bigint FOR UPDATE;
  IF s->'readOnly' IS DISTINCT FROM 'false'::jsonb OR encode(sha256(convert_to(s::text,'UTF8')),'hex') IS DISTINCT FROM p->>'hash' THEN RAISE EXCEPTION 'DATE_REPAIR_STATE_CHANGED'; END IF;
  original:=s; old_version:=(p->>'version')::bigint;
  FOR e IN SELECT value FROM jsonb_array_elements(spec->'entries') WHERE value->>'propertyId'=p->>'id' LOOP
   SELECT count(*),min(ord)::integer-1,jsonb_agg(value)->0 INTO n,idx,b FROM jsonb_array_elements(s->'bookings') WITH ORDINALITY x(value,ord) WHERE value->>'id'=e->>'bookingId';
   IF n<>1 OR encode(sha256(convert_to(b::text,'UTF8')),'hex') IS DISTINCT FROM e->>'bookingHash'
      OR b->>'status'<>'confirmed' OR b->'bookedAt' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'DATE_REPAIR_BOOKING_CHANGED'; END IF;
   IF e->>'kind'='owner-booking-date' THEN
    IF b->>'source'<>'os' OR b->'sourceKey' IS DISTINCT FROM 'null'::jsonb OR e->>'evidenceType'<>'owner_attestation'
      OR e->>'bookedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR (e->>'bookedAt')::date > (SELECT min((x->>'checkIn')::date) FROM jsonb_array_elements(b->'stays') x) THEN RAISE EXCEPTION 'DATE_REPAIR_OWNER_EVIDENCE_INVALID'; END IF;
    replacement:=jsonb_set(jsonb_set(b,'{bookedAt}',e->'bookedAt'),'{version}',to_jsonb((b->>'version')::bigint+1));
    IF replacement-'bookedAt'-'version' IS DISTINCT FROM b-'bookedAt'-'version' THEN RAISE EXCEPTION 'DATE_REPAIR_UNRELATED_BOOKING_CHANGE'; END IF;
    s:=jsonb_set(s,ARRAY['bookings',idx::text],replacement);
   ELSIF e->>'kind'='provider-booking-date' THEN
    SELECT count(*),min(ord)::integer-1,jsonb_agg(value)->0 INTO n,linkidx,l FROM jsonb_array_elements(s->'sourceLinks') WITH ORDINALITY x(value,ord) WHERE value->>'key'=b->>'sourceKey' AND value->>'bookingId'=b->>'id';
    IF n<>1 OR encode(sha256(convert_to(l::text,'UTF8')),'hex') IS DISTINCT FROM e->>'linkHash'
      OR l->>'sourceSystem' NOT IN ('sweetfun-calendar-sheet','offland-calendar-sheet') OR l->'diverged' IS DISTINCT FROM 'false'::jsonb
      OR l->'tombstoneNights' IS DISTINCT FROM '[]'::jsonb OR l->'lastAppliedBookingVersion' <> b->'version'
      OR b->>'source'<>'external' OR b ? 'sweetfunSnapshot' OR b ? 'offlandSnapshot' OR b ? 'osSnapshot'
      OR e->>'providerPropertyId'<>p->>'id' OR e->>'providerStatus'<>'active' OR e->>'evidenceType'<>'owlnest_order_list'
      OR l->>'externalOrderId' NOT IN ('Q:'||(e->>'externalOrderId'),'L:'||(e->>'externalOrderId'))
      OR e->>'providerCheckIn'<>(SELECT min(x->>'checkIn') FROM jsonb_array_elements(b->'stays') x)
      OR e->>'providerCheckOut'<>(SELECT max(x->>'checkOut') FROM jsonb_array_elements(b->'stays') x)
      OR (e->>'bookedAt')::date>(e->>'providerCheckIn')::date
      OR (e->>'checkedAt')::timestamptz>clock_timestamp()+interval '1 minute'
      OR clock_timestamp()-(e->>'checkedAt')::timestamptz>interval '2 days' THEN RAISE EXCEPTION 'DATE_REPAIR_PROVIDER_EVIDENCE_CHANGED'; END IF;
    replacement:=jsonb_set(jsonb_set(b,'{bookedAt}',e->'bookedAt'),'{version}',to_jsonb((b->>'version')::bigint+1));
    IF replacement-'bookedAt'-'version' IS DISTINCT FROM b-'bookedAt'-'version' THEN RAISE EXCEPTION 'DATE_REPAIR_UNRELATED_BOOKING_CHANGE'; END IF;
    s:=jsonb_set(s,ARRAY['bookings',idx::text],replacement);
    s:=jsonb_set(s,ARRAY['sourceLinks',linkidx::text],jsonb_set(l,'{lastAppliedBookingVersion}',replacement->'version'));
   ELSIF e->>'kind'='first-new-notice' THEN
    SELECT count(*),min(ord)::integer-1,jsonb_agg(value)->0 INTO n,linkidx,l FROM jsonb_array_elements(s->'sourceLinks') WITH ORDINALITY x(value,ord) WHERE value->>'key'=b->>'sourceKey' AND value->>'bookingId'=b->>'id';
    IF n<>1 OR encode(sha256(convert_to(l::text,'UTF8')),'hex') IS DISTINCT FROM e->>'linkHash' OR l ? 'firstNewOrderNotification'
      OR l->>'sourceSystem' NOT IN ('sweetfun-calendar-sheet','offland-calendar-sheet') OR l->'diverged' IS DISTINCT FROM 'false'::jsonb
      OR l->'tombstoneNights' IS DISTINCT FROM '[]'::jsonb OR l->'lastAppliedBookingVersion' <> b->'version'
      OR b->>'source'<>'external' OR b ? 'sweetfunSnapshot' OR b ? 'offlandSnapshot' OR b ? 'osSnapshot'
      OR e->>'noticeKind'<>'new' OR e->>'sender' NOT IN ('owlnest@owlting.com','owljourney@owlting.com')
      OR l->>'externalOrderId' NOT IN ('Q:'||(e->>'externalOrderId'),'L:'||(e->>'externalOrderId'))
      OR l->>'sourceVersion' <> 'gmail-v1:'||(e->>'internalDate')||':'||encode(sha256(convert_to(e->>'messageId','UTF8')),'hex')
      OR (e->'notification'->>'receivedAt')::timestamptz <> to_timestamp((e->>'internalDate')::numeric/1000)
      OR (e->'notification'->>'receivedAt')::timestamptz > (b->>'createdAt')::timestamptz THEN RAISE EXCEPTION 'DATE_REPAIR_SOURCE_EVIDENCE_CHANGED'; END IF;
    SELECT count(*) INTO n FROM jsonb_array_elements(s->'receipts') r WHERE r=e->'receipt'
      AND r->>'propertyId'=p->>'id' AND r->>'action'='source:write' AND r->>'subjectId'='gmail-order-handler'
      AND r->>'grantId' IS NOT NULL AND r->'response'->>'state'='applied'
      AND r->'response'->>'bookingId'=b->>'id' AND r->'response'->'bookingVersion'='1'::jsonb
      AND r->>'key'=e->'notification'->>'requestKey';
    IF n<>1 THEN RAISE EXCEPTION 'DATE_REPAIR_RECEIPT_CHANGED'; END IF;
    s:=jsonb_set(s,ARRAY['sourceLinks',linkidx::text],l||jsonb_build_object('firstNewOrderNotification',e->'notification'));
   ELSE RAISE EXCEPTION 'DATE_REPAIR_KIND_INVALID'; END IF;
   INSERT INTO iron_gate.audit_log(audit_id,property_id,audit_json) VALUES ((e->>'auditId')::uuid,(p->>'id')::uuid,
    jsonb_build_object('auditId',e->>'auditId','at',stamp,'type',CASE WHEN e->>'kind'<>'first-new-notice' THEN 'booking.date_recorded' ELSE 'source.notification_recorded' END,
      'workspaceId',p->>'workspace','propertyId',p->>'id','bookingId',e->>'bookingId','bookingVersion',(e->>'bookingVersion')::bigint+CASE WHEN e->>'kind'<>'first-new-notice' THEN 1 ELSE 0 END,
      'bookingStatus','confirmed','inventoryVersion',old_version+1,'actorOrigin','service','actorClientId','verified-booking-date-maintenance',
      'actorSubjectId','authorized-maintenance','actorGrantId',NULL,'requestKey',spec->>'repairKey',
      'evidenceType',CASE WHEN e->>'kind'='owner-booking-date' THEN 'owner_attestation' WHEN e->>'kind'='provider-booking-date' THEN 'owlnest_order_list' ELSE 'original_gmail_new_order' END,
      'evidenceRef',e->>'evidenceRef','evidenceSha256',e->>'evidenceSha256','providerCheckedAt',e->>'checkedAt','messageSha256',e->>'messageSha256','recordedDate',coalesce(e->>'bookedAt',e->'notification'->>'receivedAt')));
   INSERT INTO iron_gate.outbox(event_id,property_id,event_json) VALUES ((e->>'eventId')::uuid,(p->>'id')::uuid,
    jsonb_build_object('eventId',e->>'eventId','at',stamp,'type',CASE WHEN e->>'kind'<>'first-new-notice' THEN 'booking.date_recorded' ELSE 'source.notification_recorded' END,
      'propertyId',p->>'id','bookingId',e->>'bookingId','bookingVersion',(e->>'bookingVersion')::bigint+CASE WHEN e->>'kind'<>'first-new-notice' THEN 1 ELSE 0 END,'inventoryVersion',old_version+1));
  END LOOP;
  result:=jsonb_set(s,'{version}',to_jsonb(old_version+1));
  IF result-'bookings'-'sourceLinks'-'version' IS DISTINCT FROM original-'bookings'-'sourceLinks'-'version' THEN RAISE EXCEPTION 'DATE_REPAIR_UNRELATED_STATE_CHANGE'; END IF;
  UPDATE iron_gate.property_state SET state_json=result,inventory_version=old_version+1,updated_at=now() WHERE property_id=(p->>'id')::uuid AND inventory_version=old_version;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 OR (SELECT state_json FROM iron_gate.property_state WHERE property_id=(p->>'id')::uuid) IS DISTINCT FROM result THEN RAISE EXCEPTION 'DATE_REPAIR_READBACK_FAILED'; END IF;
 END LOOP;
END $dates$;
${dryRun ? 'ROLLBACK' : 'COMMIT'};
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [snapshotPath,manifestPath,outputPath,mode] = process.argv.slice(2);
  if (!snapshotPath || !manifestPath || !outputPath || ![undefined,"apply"].includes(mode)) throw Error("USAGE_SNAPSHOT_MANIFEST_OUTPUT_OPTIONAL_APPLY");
  const plan=prepareVerifiedDates(JSON.parse(readFileSync(snapshotPath,"utf8")),JSON.parse(readFileSync(manifestPath,"utf8")));
  writeFileSync(outputPath,verifiedDatesSql(plan,mode!=="apply"),{mode:0o600,flag:"wx"});
  console.log(JSON.stringify({entries:plan.entries.length,mode:mode??"rollback",repairKey:plan.repairKey}));
}
