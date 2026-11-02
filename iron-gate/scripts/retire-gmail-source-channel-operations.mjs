import { readFileSync } from "node:fs";

// Generates one private, guarded transaction. The manifest and resulting SQL
// contain production identifiers and must never enter Git or public CI logs.
const PROPERTY = "95ae9bd1-5e6d-4386-be5b-6af3c5668a16";
const SOURCE = "sweetfun-calendar-sheet";
const ACCOUNT = "1ZU1aJ4mLgysBz1UM84GLzljuWly8saF0p1HaNmAIBWc";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^gmail-v1:[1-9]\d{12}:[0-9a-f]{64}$/;

export function validateRetirementManifest(manifest) {
  if (manifest?.schema !== 1 || manifest.propertyId !== PROPERTY ||
    manifest.expectedAuthorityEpoch !== 1 ||
    !Number.isSafeInteger(manifest.expectedCurrentVersion) ||
    manifest.expectedCurrentVersion < 1 || !Array.isArray(manifest.targets) ||
    manifest.targets.length < 1 || manifest.targets.length > 4)
    throw Error("INVALID_RETIREMENT_MANIFEST");
  const seen = new Set();
  for (const target of manifest.targets) {
    if (!target || Object.keys(target).sort().join(",") !==
      "bookingId,expectedDiverged,expectedSourceVersion,externalOrderId,operationKey" ||
      !UUID.test(target.bookingId) || !UUID.test(target.operationKey) ||
      !/^L:OBE[A-Z0-9]+$/.test(target.externalOrderId) ||
      !VERSION.test(target.expectedSourceVersion) ||
      typeof target.expectedDiverged !== "boolean" ||
      seen.has(target.bookingId) || seen.has(target.operationKey) ||
      seen.has(target.externalOrderId)) throw Error("INVALID_RETIREMENT_TARGET");
    seen.add(target.bookingId);
    seen.add(target.operationKey);
    seen.add(target.externalOrderId);
  }
  return manifest;
}

export function retirementSql(manifest, dryRun = true) {
  const checked = validateRetirementManifest(manifest);
  const encoded = Buffer.from(JSON.stringify(checked), "utf8").toString("base64");
  return `BEGIN ISOLATION LEVEL SERIALIZABLE;
DO $retire$
DECLARE
  m jsonb := convert_from(decode('${encoded}', 'base64'), 'UTF8')::jsonb;
  s jsonb;
  target jsonb;
  booking jsonb;
  link jsonb;
  op jsonb;
  source_key text;
  next_version integer;
  at_iso text;
  event_json jsonb;
  audit_json jsonb;
BEGIN
  PERFORM set_config('lock_timeout', '5000ms', true);
  SELECT state_json INTO STRICT s FROM iron_gate.property_state
    WHERE property_id='${PROPERTY}'::uuid AND
      inventory_version=(m->>'expectedCurrentVersion')::integer AND
      authority_epoch=(m->>'expectedAuthorityEpoch')::integer FOR UPDATE;
  next_version := (m->>'expectedCurrentVersion')::integer;
  IF s->>'propertyId' IS DISTINCT FROM '${PROPERTY}' OR
    s->>'readOnly' IS DISTINCT FROM 'false' OR
    (s->>'version')::integer IS DISTINCT FROM next_version OR
    (s->>'authorityEpoch')::integer IS DISTINCT FROM 1 OR
    s->'channel'->>'mode' IS DISTINCT FROM 'owlnest' OR
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'sourceGrants') g
      WHERE g->>'sourceSystem'='${SOURCE}' AND
        g->>'sourceAccount'='${ACCOUNT}' AND g->>'active'='true') THEN
    RAISE EXCEPTION 'RETIREMENT_PROPERTY_CHANGED';
  END IF;
  FOR target IN SELECT value FROM jsonb_array_elements(m->'targets') LOOP
    source_key := '["${SOURCE}","${ACCOUNT}","' ||
      (target->>'externalOrderId') || '"]';
    SELECT b INTO STRICT booking FROM jsonb_array_elements(s->'bookings') b
      WHERE b->>'id'=target->>'bookingId';
    SELECT l INTO STRICT link FROM jsonb_array_elements(s->'sourceLinks') l
      WHERE l->>'key'=source_key;
    SELECT x INTO STRICT op FROM jsonb_array_elements(s->'operations') x
      WHERE x->>'key'=target->>'operationKey';
    IF booking->>'status' IS DISTINCT FROM 'confirmed' OR
      booking->>'source' IS DISTINCT FROM 'external' OR
      booking->>'sourceKey' IS DISTINCT FROM source_key OR
      booking->>'channelSyncState' IS DISTINCT FROM 'pending' OR
      booking->>'channelOperationKey' IS DISTINCT FROM target->>'operationKey' OR
      link->>'bookingId' IS DISTINCT FROM target->>'bookingId' OR
      link->>'sourceVersion' IS DISTINCT FROM target->>'expectedSourceVersion' OR
      link->>'diverged' IS DISTINCT FROM target->>'expectedDiverged' OR
      (link->>'lastAppliedBookingVersion')::integer IS DISTINCT FROM
        (booking->>'version')::integer OR
      op->>'bookingId' IS DISTINCT FROM target->>'bookingId' OR
      (op->>'bookingVersion')::integer IS DISTINCT FROM (booking->>'version')::integer OR
      op->>'state' IS DISTINCT FROM 'sync_pending' OR
      op->>'providerVersion' IS NOT NULL OR op->>'verifiedAt' IS NOT NULL OR
      op ? 'observations' OR op ? 'initialOpenPreflight' OR
      op ? 'lineGrantId' OR op ? 'manualInitialClose' OR
      s->'channelDispatch'->>'operationKey'=target->>'operationKey' OR
      (SELECT count(*) FROM jsonb_array_elements(s->'fences') f
        WHERE f->>'key'=target->>'operationKey' AND
          f->>'reason'='channel_pending') <> 1 OR
      (SELECT count(*) FROM jsonb_array_elements(s->'fences') f
        WHERE f->>'key'='review:' || source_key AND f->>'reason'='source_review') <>
          (CASE WHEN (target->>'expectedDiverged')::boolean THEN 1 ELSE 0 END) OR
      (SELECT count(*) FROM jsonb_array_elements(s->'receipts') r
        WHERE r->>'action'='source:write' AND
          r->>'subjectId'='gmail-order-handler' AND
          r->'response'->>'state'='applied' AND
          r->'response'->>'bookingId'=target->>'bookingId' AND
          r->'response'->>'operationKey'=target->>'operationKey') <> 1 OR
      jsonb_array_length(op->'cells') < 1 OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(op->'cells') c
        WHERE c->>'desired'<>'closed' OR NOT EXISTS (
          SELECT 1 FROM iron_gate.occupied_room_nights n
          WHERE n.property_id='${PROPERTY}'::uuid AND
            n.booking_id=(target->>'bookingId')::uuid AND
            n.room_id=(c->>'roomId')::uuid AND n.night=(c->>'date')::date)) OR
      (SELECT count(*) FROM iron_gate.occupied_room_nights n
        WHERE n.property_id='${PROPERTY}'::uuid AND
          n.booking_id=(target->>'bookingId')::uuid) <> jsonb_array_length(op->'cells') THEN
      RAISE EXCEPTION 'RETIREMENT_TARGET_DRIFT';
    END IF;
    s := jsonb_set(s,'{bookings}',(SELECT jsonb_agg(
      CASE WHEN b->>'id'=target->>'bookingId' THEN
        b || jsonb_build_object('channelSyncState','not_required','channelOperationKey',NULL)
      ELSE b END ORDER BY ordinal)
      FROM jsonb_array_elements(s->'bookings') WITH ORDINALITY AS rows(b,ordinal)));
    s := jsonb_set(s,'{operations}',(SELECT jsonb_agg(
      CASE WHEN x->>'key'=target->>'operationKey' THEN
        x || jsonb_build_object('state','retired_source_managed')
      ELSE x END ORDER BY ordinal)
      FROM jsonb_array_elements(s->'operations') WITH ORDINALITY AS rows(x,ordinal)));
    s := jsonb_set(s,'{fences}',(SELECT coalesce(jsonb_agg(f ORDER BY ordinal),'[]'::jsonb)
      FROM jsonb_array_elements(s->'fences') WITH ORDINALITY AS rows(f,ordinal)
      WHERE f->>'key'<>target->>'operationKey'));
    next_version := next_version + 1;
    at_iso := to_char(clock_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    event_json := jsonb_build_object('eventId',gen_random_uuid()::text,
      'at',at_iso,'type','channel.source_operation_retired','propertyId','${PROPERTY}',
      'bookingId',target->>'bookingId','bookingVersion',(booking->>'version')::integer,
      'inventoryVersion',next_version);
    INSERT INTO iron_gate.outbox(event_id,property_id,event_json)
      VALUES ((event_json->>'eventId')::uuid,'${PROPERTY}'::uuid,event_json);
    audit_json := jsonb_build_object('auditId',gen_random_uuid()::text,
      'at',at_iso,'type','channel.source_operation_retired',
      'workspaceId',s->>'workspaceId','propertyId','${PROPERTY}',
      'bookingId',target->>'bookingId','bookingVersion',(booking->>'version')::integer,
      'bookingStatus',booking->>'status','inventoryVersion',next_version,
      'actorOrigin','system','actorClientId','maintenance',
      'actorSubjectId','source-operation-retirement','actorGrantId',NULL,
      'requestKey',target->>'operationKey');
    INSERT INTO iron_gate.audit_log(audit_id,property_id,audit_json)
      VALUES ((audit_json->>'auditId')::uuid,'${PROPERTY}'::uuid,audit_json);
  END LOOP;
  s := jsonb_set(s,'{version}',to_jsonb(next_version));
  UPDATE iron_gate.property_state SET state_json=s,inventory_version=next_version,
    updated_at=now() WHERE property_id='${PROPERTY}'::uuid AND
      inventory_version=(m->>'expectedCurrentVersion')::integer AND authority_epoch=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETIREMENT_VERSION_DRIFT'; END IF;
END $retire$;
SELECT inventory_version,
  (SELECT count(*) FROM jsonb_array_elements(state_json->'operations') op
    WHERE op->>'state'='retired_source_managed') AS retired_source_operations
FROM iron_gate.property_state WHERE property_id='${PROPERTY}'::uuid;
${dryRun ? "ROLLBACK;" : "COMMIT;"}`;
}

if (process.argv[1]?.endsWith("retire-gmail-source-channel-operations.mjs")) {
  const [mode, path] = process.argv.slice(2);
  if (!["dry-run", "apply"].includes(mode) || !path)
    throw Error("MODE_AND_PRIVATE_MANIFEST_REQUIRED");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  process.stdout.write(retirementSql(manifest, mode === "dry-run"));
}
