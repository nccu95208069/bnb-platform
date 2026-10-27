import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The private manifest holds guest names and exact order evidence. Never add it
// to Git or print the generated SQL in a public build or CI log.
const PROPERTY = "95ae9bd1-5e6d-4386-be5b-6af3c5668a16";
const SOURCE_SYSTEM = "sweetfun-calendar-sheet";
const SOURCE_ACCOUNT = "1ZU1aJ4mLgysBz1UM84GLzljuWly8saF0p1HaNmAIBWc";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const SOURCE_VERSION = /^gmail-v1:([1-9]\d{12}):([0-9a-f]{64})$/;

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function nights(stay) {
  const from = Date.parse(`${stay.checkIn}T00:00:00.000Z`);
  const to = Date.parse(`${stay.checkOut}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) ||
    new Date(from).toISOString().slice(0, 10) !== stay.checkIn ||
    new Date(to).toISOString().slice(0, 10) !== stay.checkOut ||
    to <= from || to - from > 7 * 86_400_000) throw Error("INVALID_STAY");
  return Array.from({ length: (to - from) / 86_400_000 }, (_, index) => ({
    roomId: stay.roomIds[0], date: new Date(from + index * 86_400_000).toISOString().slice(0, 10),
  }));
}

export function validateManifest(manifest) {
  if (manifest?.schema !== 1 || manifest.propertyId !== PROPERTY ||
    manifest.expectedAuthorityEpoch !== 1 ||
    !Number.isSafeInteger(manifest.expectedCurrentVersion) ||
    manifest.expectedCurrentVersion < 1 ||
    !Array.isArray(manifest.orders) || manifest.orders.length < 1 ||
    manifest.orders.length > 10) throw Error("INVALID_REPAIR_MANIFEST");
  const allIds = new Set(), allNights = new Set(), allAliases = new Set();
  const orders = manifest.orders.map((order) => {
    const event = order?.event;
    const owlJourney = /^L:OWJ[A-Z0-9]+$/.test(event?.externalOrderId ?? "");
    const expectedKeys = ["bookedAt", "currency", "expectedInventoryVersion",
      "externalOrderId", "guestName", "kind", "platform", "previousSourceVersion",
      "propertyId", "sourceAccount", "sourceSystem", "sourceVersion", "stays", "totalCents",
      ...(!owlJourney ? ["externalOrderNo"] : [])].sort().join(",");
    if (!event || Object.keys(event).sort().join(",") !== expectedKeys ||
      event.propertyId !== PROPERTY || event.sourceSystem !== SOURCE_SYSTEM ||
      event.sourceAccount !== SOURCE_ACCOUNT || event.kind !== "upsert" ||
      event.previousSourceVersion !== null || event.bookedAt !== null ||
      !(owlJourney || /^L:OBE[A-Z0-9]+$/.test(event.externalOrderId)) ||
      !SOURCE_VERSION.test(event.sourceVersion) ||
      !(owlJourney ? event.platform === "owljourney" :
        ["booking", "agoda", "airbnb", "ctrip"].includes(event.platform) &&
        /^[A-Za-z0-9-]{1,64}$/.test(event.externalOrderNo ?? "")) ||
      typeof event.guestName !== "string" || !event.guestName.trim() ||
      event.guestName.length > 200 ||
      !Number.isSafeInteger(event.totalCents) || event.totalCents < 0 ||
      event.currency !== "TWD" || !Array.isArray(event.stays) ||
      event.stays.length !== 1 || !Array.isArray(event.stays[0].roomIds) ||
      event.stays[0].roomIds.length !== 1 || !UUID.test(event.stays[0].roomIds[0]) ||
      !Number.isSafeInteger(order.originalReceiptVersion) ||
      event.expectedInventoryVersion !== order.originalReceiptVersion - 1 ||
      order.originalReceiptVersion > manifest.expectedCurrentVersion ||
      !UUID.test(order.originalRequestKey ?? "") ||
      !HEX.test(order.originalRequestHash ?? "") ||
      !/^[0-9a-f]{16}$/.test(order.sourceMessageId ?? "") ||
      ![order.bookingId, order.repairRequestKey].every((id) => UUID.test(id ?? "")) ||
      order.providerStatus !== "confirmed" ||
      (owlJourney && (typeof order.providerGuestName !== "string" ||
        !order.providerGuestName.trim() || order.providerGuestName.length > 200 ||
        !order.providerGuestName.replace(/\s+/g, "").startsWith(
          event.guestName.replace(/[\s*]/g, "")))) ||
      (!owlJourney && order.providerGuestName !== undefined) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(order.providerCheckedAt ?? ""))
      throw Error("INVALID_REPAIR_ORDER");
    const match = SOURCE_VERSION.exec(event.sourceVersion);
    if (match[2] !== sha256(order.sourceMessageId) ||
      sha256(canonical({ action: "source:write", input: event })) !== order.originalRequestHash)
      throw Error("ORIGINAL_SOURCE_REQUEST_MISMATCH");
    const cells = nights(event.stays[0]);
    const effectiveTotalCents = order.providerTotalCents ?? event.totalCents;
    if (!Number.isSafeInteger(effectiveTotalCents) || effectiveTotalCents < 0 ||
      (order.providerTotalCents !== undefined &&
        ((owlJourney ? event.totalCents !== effectiveTotalCents :
          event.totalCents - effectiveTotalCents !== 50) ||
          !Array.isArray(order.providerNightTotalsCents) ||
          order.providerNightTotalsCents.length !== cells.length ||
          order.providerNightTotalsCents.some((amount) =>
            !Number.isSafeInteger(amount) || amount < 0) ||
          order.providerNightTotalsCents.reduce((sum, amount) => sum + amount, 0) !==
            effectiveTotalCents))) throw Error("PROVIDER_AMOUNT_MISMATCH");
    const sourceKey = JSON.stringify([SOURCE_SYSTEM, SOURCE_ACCOUNT, event.externalOrderId]);
    const receivedAt = new Date(Number(match[1])).toISOString();
    if (!Number.isFinite(Date.parse(order.providerCheckedAt)) ||
      new Date(order.providerCheckedAt).toISOString() !== order.providerCheckedAt ||
      Date.parse(order.providerCheckedAt) < Number(match[1]))
      throw Error("PROVIDER_CHECK_BEFORE_NOTICE");
    for (const id of [order.originalRequestKey, order.bookingId,
      order.repairRequestKey, sourceKey]) {
      if (allIds.has(id)) throw Error("DUPLICATE_REPAIR_ID");
      allIds.add(id);
    }
    for (const cell of cells) {
      const key = `${cell.roomId}|${cell.date}`;
      if (allNights.has(key)) throw Error("OVERLAPPING_REPAIR_ORDERS");
      allNights.add(key);
    }
    if (!owlJourney) {
      if (allAliases.has(event.externalOrderNo)) throw Error("DUPLICATE_OTA_ALIAS");
      allAliases.add(event.externalOrderNo);
    }
    return { ...order, cells, sourceKey, receivedAt, effectiveTotalCents };
  });
  return { ...manifest, orders };
}

export function repairSql(manifest, dryRun = true) {
  const checked = validateManifest(manifest);
  const encoded = Buffer.from(JSON.stringify(checked), "utf8").toString("base64");
  return `BEGIN;
DO $repair$
DECLARE
  m jsonb := convert_from(decode('${encoded}', 'base64'), 'UTF8')::jsonb;
  s jsonb;
  o jsonb;
  e jsonb;
  cells jsonb;
  original jsonb;
  source_key text;
  review_key text;
  booking jsonb;
  link jsonb;
  receipt jsonb;
  event_json jsonb;
  audit_json jsonb;
  at_iso text;
  next_version integer;
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
    s->'channel'->>'ready' IS DISTINCT FROM 'true' OR
    s->'channel'->>'sourceReadbackEnabled' IS DISTINCT FROM 'true' OR
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'sourceGrants') g
      WHERE g->>'sourceSystem'='${SOURCE_SYSTEM}' AND
        g->>'sourceAccount'='${SOURCE_ACCOUNT}' AND g->>'active'='true') THEN
    RAISE EXCEPTION 'REPAIR_PROPERTY_STATE_CHANGED';
  END IF;
  FOR o IN SELECT value FROM jsonb_array_elements(m->'orders') LOOP
    e := o->'event';
    cells := o->'cells';
    source_key := o->>'sourceKey';
    review_key := 'review:' || source_key;
    at_iso := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    IF (clock_timestamp() - (o->>'providerCheckedAt')::timestamptz) > interval '30 minutes' OR
      (o->>'providerCheckedAt')::timestamptz > clock_timestamp() + interval '1 minute' THEN
      RAISE EXCEPTION 'REPAIR_PROVIDER_EVIDENCE_STALE';
    END IF;
    SELECT r INTO STRICT original FROM jsonb_array_elements(s->'receipts') r
      WHERE r->>'key'=o->>'originalRequestKey';
    IF original->>'requestHash' IS DISTINCT FROM o->>'originalRequestHash' OR
      original->>'action' IS DISTINCT FROM 'source:write' OR
      original->'response'->>'state' IS DISTINCT FROM 'review_required' OR
      original->'response'->>'reason' IS DISTINCT FROM 'SOURCE_IDENTITY_UNVERIFIED' OR
      original->'response'->>'bookingId' IS NOT NULL OR
      (original->'response'->>'inventoryVersion')::integer IS DISTINCT FROM
        (o->>'originalReceiptVersion')::integer OR
      original->>'subjectId' IS DISTINCT FROM 'gmail-order-handler' OR
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'sourceGrants') g
        WHERE g->>'grantId'=original->>'grantId' AND g->>'active'='true' AND
          g->>'sourceSystem'='${SOURCE_SYSTEM}' AND
          g->>'sourceAccount'='${SOURCE_ACCOUNT}') THEN
      RAISE EXCEPTION 'REPAIR_ORIGINAL_RECEIPT_CHANGED';
    END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(s->'fences') f
        WHERE f->>'key'=review_key AND f->>'reason'='source_review' AND
          jsonb_array_length(f->'cells')=jsonb_array_length(cells) AND
          (f->'cells') @> cells AND cells @> (f->'cells')) <> 1 OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(s->'fences') f,
        jsonb_array_elements(f->'cells') fc, jsonb_array_elements(cells) c
        WHERE f->>'key'<>review_key AND fc=c) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(s->'manualBlocks') b,
        jsonb_array_elements(cells) c WHERE b=c) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(s->'sourceLinks') l
        WHERE l->>'key'=source_key OR l->>'externalOrderId'=e->>'externalOrderId') OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(s->'bookings') b
        WHERE b->>'sourceKey'=source_key OR b->>'id'=o->>'bookingId' OR
          (b->>'status' IN ('confirmed','held') AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(b->'stays') stay,
              jsonb_array_elements(cells) c
            WHERE stay->>'checkIn'<=c->>'date' AND
              stay->>'checkOut'>c->>'date' AND
              stay->'roomIds' ? (c->>'roomId'))) OR
          (e ? 'externalOrderNo' AND
            b->'sourceCalendar'->>'externalOrderNo'=e->>'externalOrderNo') OR
          EXISTS (SELECT 1 FROM jsonb_array_elements(
            coalesce(b->'sweetfunSnapshot'->'rows','[]'::jsonb)) row
            WHERE (e ? 'externalOrderNo' AND
              row->'values'->>13=e->>'externalOrderNo') OR
              row->'values'->>11=substring(e->>'externalOrderId' from 3))) OR
      EXISTS (SELECT 1 FROM iron_gate.occupied_room_nights n,
        jsonb_array_elements(cells) c WHERE n.property_id='${PROPERTY}'::uuid AND
          n.room_id=(c->>'roomId')::uuid AND n.night=(c->>'date')::date) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(s->'operations') op,
        jsonb_array_elements(op->'cells') oc, jsonb_array_elements(cells) c
        WHERE op->>'state' IN ('sync_pending','review_required') AND
          oc->>'roomId'=c->>'roomId' AND oc->>'date'=c->>'date') OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(s->'receipts') r
        WHERE r->>'key'=o->>'repairRequestKey') THEN
      RAISE EXCEPTION 'REPAIR_TARGET_DRIFT';
    END IF;
    next_version := next_version + 1;
    booking := jsonb_build_object(
      'id',o->>'bookingId','workspaceId',s->>'workspaceId','propertyId','${PROPERTY}',
      'version',1,'status','confirmed','channelSyncState','not_required',
      'channelOperationKey',NULL,'stays',e->'stays',
      'guestName',coalesce(o->>'providerGuestName',e->>'guestName'),'contact',NULL,'notes',NULL,
      'totalCents',(o->>'effectiveTotalCents')::integer,'currency','TWD','bookedAt',NULL,
      'createdAt',at_iso,'source','external','sourceKey',source_key,
      'sourceCalendar',jsonb_build_object('platform',e->'platform',
        'externalOrderNo',e->'externalOrderNo'));
    link := jsonb_build_object('key',source_key,
      'sourceSystem','${SOURCE_SYSTEM}','sourceAccount','${SOURCE_ACCOUNT}',
      'externalOrderId',e->>'externalOrderId','bookingId',o->>'bookingId',
      'sourceVersion',e->>'sourceVersion','lastAppliedBookingVersion',1,
      'diverged',false,'tombstoneNights','[]'::jsonb,
      'firstNewOrderNotification',jsonb_build_object('schema',1,
        'receivedAt',o->>'receivedAt','sourceVersion',e->>'sourceVersion',
        'requestKey',o->>'repairRequestKey'));
    receipt := jsonb_build_object('key',o->>'repairRequestKey',
      'clientId',original->>'clientId','subjectId',original->>'subjectId',
      'grantId',original->>'grantId','propertyId','${PROPERTY}',
      'action','source:write','requestHash',o->>'originalRequestHash',
      'response',jsonb_build_object('state','applied','bookingId',o->>'bookingId',
        'bookingVersion',1,'inventoryVersion',next_version,
        'reconciledFromRequestKey',o->>'originalRequestKey'));
    s := jsonb_set(s,'{fences}',
      (SELECT coalesce(jsonb_agg(f),'[]'::jsonb) FROM jsonb_array_elements(s->'fences') f
        WHERE f->>'key'<>review_key));
    s := jsonb_set(s,'{bookings}',s->'bookings' || jsonb_build_array(booking));
    s := jsonb_set(s,'{sourceLinks}',s->'sourceLinks' || jsonb_build_array(link));
    s := jsonb_set(s,'{receipts}',s->'receipts' || jsonb_build_array(receipt));
    INSERT INTO iron_gate.occupied_room_nights(property_id,room_id,night,booking_id)
      SELECT '${PROPERTY}'::uuid,(c->>'roomId')::uuid,(c->>'date')::date,
        (o->>'bookingId')::uuid FROM jsonb_array_elements(cells) c;
    event_json := jsonb_build_object('eventId',gen_random_uuid()::text,
      'at',at_iso,'type','source.applied','propertyId','${PROPERTY}',
      'bookingId',o->>'bookingId','bookingVersion',1,'inventoryVersion',next_version);
    INSERT INTO iron_gate.outbox(event_id,property_id,event_json)
      VALUES ((event_json->>'eventId')::uuid,'${PROPERTY}'::uuid,event_json);
    audit_json := jsonb_build_object('auditId',gen_random_uuid()::text,
      'at',at_iso,'type','source.applied','workspaceId',s->>'workspaceId',
      'propertyId','${PROPERTY}','bookingId',o->>'bookingId',
      'bookingVersion',1,'bookingStatus','confirmed','inventoryVersion',next_version,
      'actorOrigin','source','actorClientId',original->>'clientId',
      'actorSubjectId',original->>'subjectId','actorGrantId',original->>'grantId',
      'requestKey',o->>'repairRequestKey');
    IF (o->>'effectiveTotalCents')::integer <> (e->>'totalCents')::integer THEN
      audit_json := audit_json || jsonb_build_object(
        'sourceNoticeTotalCents',(e->>'totalCents')::integer,
        'providerVerifiedTotalCents',(o->>'effectiveTotalCents')::integer,
        'providerNightTotalsCents',o->'providerNightTotalsCents',
        'amountReconciliation','owlnest_half_unit_rounding');
    END IF;
    INSERT INTO iron_gate.audit_log(audit_id,property_id,audit_json)
      VALUES ((audit_json->>'auditId')::uuid,'${PROPERTY}'::uuid,audit_json);
  END LOOP;
  s := jsonb_set(s,'{version}',to_jsonb(next_version));
  UPDATE iron_gate.property_state SET state_json=s,inventory_version=next_version,
    updated_at=now() WHERE property_id='${PROPERTY}'::uuid AND
      inventory_version=(m->>'expectedCurrentVersion')::integer AND authority_epoch=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'REPAIR_VERSION_DRIFT'; END IF;
END $repair$;
SELECT inventory_version,
  (SELECT count(*) FROM jsonb_array_elements(state_json->'sourceLinks') l
    WHERE l->>'externalOrderId' LIKE 'L:OBE%' OR
      l->>'externalOrderId' LIKE 'L:OWJ%') AS provider_source_links,
  (SELECT count(*) FROM jsonb_array_elements(state_json->'fences') f
    WHERE f->>'key' LIKE 'review:%L:OBE%' OR
      f->>'key' LIKE 'review:%L:OWJ%') AS provider_review_fences
FROM iron_gate.property_state WHERE property_id='${PROPERTY}'::uuid;
${dryRun ? "ROLLBACK;" : "COMMIT;"}`;
}

if (process.argv[1]?.endsWith("reconcile-sweetfun-unverified-notices.mjs")) {
  const [mode, path] = process.argv.slice(2);
  if (!["dry-run", "apply"].includes(mode) || !path)
    throw Error("MODE_AND_PRIVATE_MANIFEST_REQUIRED");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  process.stdout.write(repairSql(manifest, mode === "dry-run"));
}
