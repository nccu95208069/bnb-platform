import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PROPERTY = "95ae9bd1-5e6d-4386-be5b-6af3c5668a16";
const ROOM = "3d678b7d-f32f-470e-b7c1-7201f73873a7";
const DATE = "2026-10-24";
const ORDER = "L:OBE06240618826102306";
const ORIGINAL_REQUEST = "6303a019-4461-5e1a-9bcc-5784dcaee090";
const ORIGINAL_HASH = "dae858f0d7c5164592d2ac9fe4ac86ef0d0a36cff83cb1b9a11b8da4ee1fd7a8";
const SOURCE_SYSTEM = "sweetfun-calendar-sheet";
const SOURCE_ACCOUNT = "1ZU1aJ4mLgysBz1UM84GLzljuWly8saF0p1HaNmAIBWc";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const parts = Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${parts.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateManifest(manifest) {
  const event = manifest?.event;
  if (!event || event.propertyId !== PROPERTY || event.sourceSystem !== SOURCE_SYSTEM ||
    event.sourceAccount !== SOURCE_ACCOUNT || event.externalOrderId !== ORDER ||
    event.kind !== "upsert" || event.previousSourceVersion !== null ||
    event.expectedInventoryVersion !== 47 || event.bookedAt !== null ||
    !/^gmail-v1:\d{13}:[0-9a-f]{64}$/.test(event.sourceVersion) ||
    !Array.isArray(event.stays) || event.stays.length !== 1 ||
    event.stays[0].checkIn !== DATE || event.stays[0].checkOut !== "2026-10-25" ||
    JSON.stringify(event.stays[0].roomIds) !== JSON.stringify([ROOM]) ||
    typeof event.guestName !== "string" || !event.guestName.trim() ||
    event.platform !== "agoda" ||
    !Number.isSafeInteger(event.totalCents) || event.totalCents < 0 ||
    event.currency !== "TWD" ||
    typeof event.externalOrderNo !== "string" ||
    manifest.originalRequestKey !== ORIGINAL_REQUEST ||
    manifest.expectedCurrentVersion !== 56 || manifest.expectedAuthorityEpoch !== 1 ||
    manifest.sourceMessageId !== "1a169e880749f9c9" ||
    !UUID.test(manifest.bookingId) || !UUID.test(manifest.operationKey) ||
    !UUID.test(manifest.repairRequestKey) ||
    new Set([manifest.bookingId, manifest.operationKey, manifest.repairRequestKey]).size !== 3) {
    throw Error("REPAIR_MANIFEST_MISMATCH");
  }
  const hash = createHash("sha256")
    .update(canonical({ action: "source:write", input: event })).digest("hex");
  if (hash !== ORIGINAL_HASH) throw Error("ORIGINAL_SOURCE_REQUEST_MISMATCH");
  return manifest;
}

export function repairSql(manifest, dryRun = true) {
  validateManifest(manifest);
  // Encoding the private source facts as a single literal avoids SQL injection
  // and keeps guest details out of the version-controlled repair script.
  const encoded = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
  return `BEGIN;
DO $repair$
DECLARE
  m jsonb := convert_from(decode('${encoded}', 'base64'), 'UTF8')::jsonb;
  e jsonb := m->'event';
  s jsonb;
  original jsonb;
  source_key text := '["${SOURCE_SYSTEM}","${SOURCE_ACCOUNT}","${ORDER}"]';
  review_key text := 'review:["${SOURCE_SYSTEM}","${SOURCE_ACCOUNT}","${ORDER}"]';
  cell jsonb := jsonb_build_object('roomId','${ROOM}','date','${DATE}');
  booking jsonb;
  link jsonb;
  operation jsonb;
  receipt jsonb;
  event_json jsonb;
  audit_json jsonb;
  at_iso text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  next_version integer := 57;
BEGIN
  PERFORM set_config('lock_timeout', '5000ms', true);
  SELECT state_json INTO STRICT s FROM iron_gate.property_state
    WHERE property_id='${PROPERTY}'::uuid AND inventory_version=56
      AND authority_epoch=1 FOR UPDATE;
  IF s->>'propertyId' <> '${PROPERTY}' OR s->>'readOnly' <> 'false' OR
    (s->>'version')::integer <> 56 OR (s->>'authorityEpoch')::integer <> 1 OR
    s->'channel'->>'mode' <> 'owlnest' OR
    s->'channel'->>'ready' <> 'true' OR
    s->'channel'->>'sourceReadbackEnabled' <> 'true' THEN
    RAISE EXCEPTION 'REPAIR_PROPERTY_STATE_CHANGED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'sourceGrants') g
    WHERE g->>'sourceSystem'='${SOURCE_SYSTEM}' AND
      g->>'sourceAccount'='${SOURCE_ACCOUNT}' AND g->>'active'='true') THEN
    RAISE EXCEPTION 'REPAIR_SOURCE_GRANT_CHANGED';
  END IF;
  SELECT r INTO STRICT original FROM jsonb_array_elements(s->'receipts') r
    WHERE r->>'key'='${ORIGINAL_REQUEST}';
  IF original->>'requestHash' <> '${ORIGINAL_HASH}' OR
    original->>'action' <> 'source:write' OR
    original->'response'->>'state' <> 'review_required' OR
    original->'response'->>'reason' <> 'ROOM_CONFLICT' OR
    original->'response'->>'bookingId' IS NOT NULL OR
    original->>'grantId' <> '8e5a435d-5b5f-4064-81d8-ca8930fa20eb' OR
    original->>'subjectId' <> 'gmail-order-handler' THEN
    RAISE EXCEPTION 'REPAIR_ORIGINAL_RECEIPT_CHANGED';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(s->'fences') f
      WHERE f->>'key'=review_key AND f->>'reason'='source_review' AND
        f->'cells'=jsonb_build_array(cell)) <> 1 OR
    (SELECT count(*) FROM jsonb_array_elements(s->'fences') f
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(f->'cells') c
        WHERE c=cell)) <> 1 OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(s->'manualBlocks') b WHERE b=cell) OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(s->'sourceLinks') l
      WHERE l->>'key'=source_key) OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(s->'bookings') b
      WHERE b->>'sourceKey'=source_key OR
        (b->>'status' IN ('confirmed','held') AND EXISTS
          (SELECT 1 FROM jsonb_array_elements(b->'stays') stay
            WHERE stay->>'checkIn'<='${DATE}' AND stay->>'checkOut'>'${DATE}'
              AND stay->'roomIds' ? '${ROOM}'))) OR
    EXISTS (SELECT 1 FROM iron_gate.occupied_room_nights o
      WHERE o.property_id='${PROPERTY}'::uuid AND o.room_id='${ROOM}'::uuid
        AND o.night='${DATE}'::date) OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(s->'operations') op
      WHERE op->>'state' IN ('sync_pending','review_required') AND EXISTS
        (SELECT 1 FROM jsonb_array_elements(op->'cells') c
          WHERE c->>'roomId'='${ROOM}' AND c->>'date'='${DATE}')) OR
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'operations') op
      WHERE op->>'state'='sync_verified' AND EXISTS
        (SELECT 1 FROM jsonb_array_elements(op->'cells') c
          WHERE c->>'roomId'='${ROOM}' AND c->>'date'='${DATE}'
            AND c->>'desired'='closed')) OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(s->'receipts') r
      WHERE r->>'key'=m->>'repairRequestKey') THEN
    RAISE EXCEPTION 'REPAIR_TARGET_DRIFT';
  END IF;
  booking := jsonb_build_object(
    'id',m->>'bookingId','workspaceId',s->>'workspaceId','propertyId','${PROPERTY}',
    'version',1,'status','confirmed','channelSyncState','pending',
    'channelOperationKey',m->>'operationKey','stays',e->'stays',
    'guestName',e->'guestName','contact',NULL,'notes',NULL,
    'totalCents',e->'totalCents','currency','TWD','bookedAt',e->'bookedAt',
    'createdAt',at_iso,'source','external','sourceKey',source_key,
    'sourceCalendar',jsonb_build_object('platform',e->'platform',
      'externalOrderNo',e->'externalOrderNo'));
  link := jsonb_build_object('key',source_key,'sourceSystem','${SOURCE_SYSTEM}',
    'sourceAccount','${SOURCE_ACCOUNT}','externalOrderId','${ORDER}',
    'bookingId',m->>'bookingId','sourceVersion',e->>'sourceVersion',
    'lastAppliedBookingVersion',1,'diverged',false,'tombstoneNights','[]'::jsonb);
  operation := jsonb_build_object('key',m->>'operationKey',
    'bookingId',m->>'bookingId','bookingVersion',1,'state','sync_pending',
    'cells',jsonb_build_array(cell || jsonb_build_object('desired','closed')),
    'createdAt',at_iso,'verifiedAt',NULL,'providerVersion',NULL);
  receipt := jsonb_build_object('key',m->>'repairRequestKey',
    'clientId',original->>'clientId','subjectId',original->>'subjectId',
    'grantId',original->>'grantId','propertyId','${PROPERTY}',
    'action','source:write','requestHash','${ORIGINAL_HASH}',
    'response',jsonb_build_object('state','applied','bookingId',m->>'bookingId',
      'bookingVersion',1,'inventoryVersion',next_version,
      'channelSyncState','pending','operationKey',m->>'operationKey',
      'reconciledFromRequestKey','${ORIGINAL_REQUEST}'));
  s := jsonb_set(s,'{fences}',
    (SELECT coalesce(jsonb_agg(f),'[]'::jsonb) FROM jsonb_array_elements(s->'fences') f
      WHERE f->>'key'<>review_key) ||
    jsonb_build_array(jsonb_build_object('key',m->>'operationKey',
      'cells',jsonb_build_array(cell),'reason','channel_pending')));
  s := jsonb_set(s,'{bookings}',s->'bookings' || jsonb_build_array(booking));
  s := jsonb_set(s,'{sourceLinks}',s->'sourceLinks' || jsonb_build_array(link));
  s := jsonb_set(s,'{operations}',s->'operations' || jsonb_build_array(operation));
  s := jsonb_set(s,'{receipts}',s->'receipts' || jsonb_build_array(receipt));
  s := jsonb_set(s,'{version}',to_jsonb(next_version));
  UPDATE iron_gate.property_state SET state_json=s,inventory_version=next_version,
    updated_at=now() WHERE property_id='${PROPERTY}'::uuid AND
      inventory_version=56 AND authority_epoch=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'REPAIR_VERSION_DRIFT'; END IF;
  INSERT INTO iron_gate.occupied_room_nights(property_id,room_id,night,booking_id)
    VALUES ('${PROPERTY}'::uuid,'${ROOM}'::uuid,'${DATE}'::date,(m->>'bookingId')::uuid);
  event_json := jsonb_build_object('eventId',gen_random_uuid()::text,
    'at',at_iso,'type','source.applied','propertyId','${PROPERTY}',
    'bookingId',m->>'bookingId','bookingVersion',1,'inventoryVersion',next_version);
  INSERT INTO iron_gate.outbox(event_id,property_id,event_json)
    VALUES ((event_json->>'eventId')::uuid,'${PROPERTY}'::uuid,event_json);
  audit_json := jsonb_build_object('auditId',gen_random_uuid()::text,
    'at',at_iso,'type','source.applied','workspaceId',s->>'workspaceId',
    'propertyId','${PROPERTY}','bookingId',m->>'bookingId',
    'bookingVersion',1,'bookingStatus','confirmed','inventoryVersion',next_version,
    'actorOrigin','source','actorClientId',original->>'clientId',
    'actorSubjectId',original->>'subjectId','actorGrantId',original->>'grantId',
    'requestKey',m->>'repairRequestKey');
  INSERT INTO iron_gate.audit_log(audit_id,property_id,audit_json)
    VALUES ((audit_json->>'auditId')::uuid,'${PROPERTY}'::uuid,audit_json);
END $repair$;
SELECT inventory_version,
  (SELECT count(*) FROM jsonb_array_elements(state_json->'fences') f
    WHERE f->>'key' LIKE '%OBE06240618826102306%') AS old_review_fences,
  (SELECT count(*) FROM jsonb_array_elements(state_json->'sourceLinks') l
    WHERE l->>'externalOrderId'='${ORDER}') AS source_links,
  (SELECT count(*) FROM jsonb_array_elements(state_json->'bookings') b
    WHERE b->>'sourceKey'='["${SOURCE_SYSTEM}","${SOURCE_ACCOUNT}","${ORDER}"]'
      AND b->>'status'='confirmed') AS confirmed_bookings,
  (SELECT count(*) FROM iron_gate.occupied_room_nights o
    WHERE o.property_id='${PROPERTY}'::uuid AND o.room_id='${ROOM}'::uuid
      AND o.night='${DATE}'::date) AS occupied_nights,
  (SELECT count(*) FROM jsonb_array_elements(state_json->'fences') f
    WHERE f->>'key'='${manifest.operationKey}' AND f->>'reason'='channel_pending') AS pending_fences
FROM iron_gate.property_state WHERE property_id='${PROPERTY}'::uuid;
${dryRun ? "ROLLBACK;" : "COMMIT;"}`;
}

if (process.argv[1]?.endsWith("reconcile-sweetfun-302-review.mjs")) {
  const [mode, path] = process.argv.slice(2);
  if (!["dry-run", "apply"].includes(mode) || !path) throw Error("MODE_AND_PRIVATE_MANIFEST_REQUIRED");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  process.stdout.write(repairSql(manifest, mode === "dry-run"));
}
