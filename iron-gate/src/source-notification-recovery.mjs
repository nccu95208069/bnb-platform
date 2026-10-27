import { createHash, randomUUID } from "node:crypto";
import { firstGmailNotification, GMAIL_NOTIFICATION_SOURCE, GMAIL_NOTIFICATION_SUBJECT } from "./source-notification.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MANIFEST_KEYS = new Set(["schema", "propertyId", "workspaceId", "authorityEpoch", "expectedInventoryVersion",
  "sourceAccount", "clientId", "subjectId", "grantId", "sourceVersions", "recoveryKey", "notificationCoverageFrom"]);
const ALLOWED_AUDITS = new Set(["source.applied", "source.facts_enriched", "channel.verified",
  "channel.review_required", "channel.source_operation_retired", "payment.recorded"]);
const fail = (reason) => { throw Error(`NOTIFICATION_RECOVERY_${reason}`); };

/** Pure preflight over a restricted projection. No guest, price, stay or raw mail is needed.
 * The generated transaction repeats the proof against locked authoritative JSON and audits. */
export function planSourceNotificationRecovery(snapshot, manifest, now = new Date()) {
  if (manifest?.schema !== 1 || snapshot?.schema !== 1 ||
    Object.keys(manifest).some((key) => !MANIFEST_KEYS.has(key)) ||
    !UUID.test(manifest.propertyId) || !UUID.test(manifest.workspaceId) ||
    !UUID.test(manifest.grantId) || !UUID.test(manifest.recoveryKey) ||
    typeof manifest.clientId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(manifest.clientId) ||
    manifest.subjectId !== GMAIL_NOTIFICATION_SUBJECT ||
    typeof manifest.sourceAccount !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(manifest.sourceAccount) ||
    !Number.isSafeInteger(manifest.authorityEpoch) || manifest.authorityEpoch < 1 ||
    !Number.isSafeInteger(manifest.expectedInventoryVersion) || manifest.expectedInventoryVersion < 1 ||
    !Array.isArray(manifest.sourceVersions) || !manifest.sourceVersions.length ||
    manifest.sourceVersions.length > 50 || new Set(manifest.sourceVersions).size !== manifest.sourceVersions.length)
    fail("MANIFEST_INVALID");
  const coverage = manifest.notificationCoverageFrom;
  const nextTaipeiDay = new Date(now.getTime() + (24 + 8) * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (typeof coverage !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(coverage) ||
    !Number.isFinite(Date.parse(`${coverage}T00:00:00Z`)) ||
    new Date(`${coverage}T00:00:00Z`).toISOString().slice(0, 10) !== coverage || coverage < nextTaipeiDay)
    fail("COVERAGE_DAY_INVALID");
  if (snapshot.reportingPolicy !== undefined && (snapshot.reportingPolicy?.schema !== 1 ||
    snapshot.reportingPolicy.authorityEpoch !== manifest.authorityEpoch ||
    snapshot.reportingPolicy.notificationCoverageFrom !== coverage)) fail("COVERAGE_POLICY_CONFLICT");
  if (snapshot.propertyId !== manifest.propertyId || snapshot.workspaceId !== manifest.workspaceId ||
    snapshot.authorityEpoch !== manifest.authorityEpoch || snapshot.inventoryVersion !== manifest.expectedInventoryVersion ||
    snapshot.readOnly !== false || !HASH.test(snapshot.stateSha256) || !HASH.test(snapshot.auditSha256))
    fail("SCOPE_CHANGED");
  for (const name of ["bookings", "sourceLinks", "receipts", "audits", "sourceGrants"])
    if (!Array.isArray(snapshot[name])) fail("PROJECTION_INVALID");
  if (snapshot.bookings.length !== manifest.sourceVersions.length ||
    snapshot.sourceLinks.length !== manifest.sourceVersions.length ||
    new Set(snapshot.bookings.map((booking) => booking.id)).size !== snapshot.bookings.length ||
    new Set(snapshot.sourceLinks.map((link) => link.key)).size !== snapshot.sourceLinks.length)
    fail("CANDIDATE_SET_MISMATCH");
  if (snapshot.sourceGrants.filter((grant) => grant.active === true && grant.grantId === manifest.grantId &&
    grant.sourceSystem === GMAIL_NOTIFICATION_SOURCE && grant.sourceAccount === manifest.sourceAccount).length !== 1)
    fail("GRANT_CHANGED");
  const candidateIds = new Set(snapshot.bookings.map((booking) => booking.id));
  if (snapshot.audits.some((audit) => !candidateIds.has(audit.bookingId) ||
    audit.propertyId !== manifest.propertyId || audit.workspaceId !== manifest.workspaceId) ||
    snapshot.receipts.some((receipt) => !candidateIds.has(receipt.response?.bookingId) ||
      receipt.propertyId !== manifest.propertyId)) fail("PROJECTION_SCOPE_INVALID");

  const entries = manifest.sourceVersions.map((sourceVersion) => {
    const links = snapshot.sourceLinks.filter((link) => link.sourceVersion === sourceVersion);
    if (links.length !== 1) fail("SOURCE_VERSION_AMBIGUOUS");
    const link = links[0];
    const booking = snapshot.bookings.find((value) => value.id === link.bookingId);
    if (!booking || !UUID.test(booking.id) || booking.source !== "external" || booking.status !== "confirmed" ||
      booking.bookedAt !== null || booking.hasSweetfunSnapshot !== false || booking.hasOsSnapshot !== false ||
      booking.hasSourceCalendar !== true || booking.lineOverridePending !== false ||
      !Number.isSafeInteger(booking.version) || booking.version < 1 ||
      link.sourceSystem !== GMAIL_NOTIFICATION_SOURCE || link.sourceAccount !== manifest.sourceAccount ||
      link.key !== JSON.stringify([link.sourceSystem, link.sourceAccount, link.externalOrderId]) ||
      link.key !== booking.sourceKey || link.diverged !== false || link.tombstoneNights?.length !== 0 ||
      link.lastAppliedBookingVersion !== booking.version || link.firstNewOrderNotification !== undefined)
      fail("BOOKING_OR_LINK_CHANGED");
    const audits = snapshot.audits.filter((audit) => audit.bookingId === booking.id);
    const applied = audits.filter((audit) => audit.type === "source.applied");
    if (applied.length !== 1 || audits.some((audit) => !ALLOWED_AUDITS.has(audit.type)))
      fail("SOURCE_HISTORY_AMBIGUOUS");
    const original = applied[0];
    if (original.bookingVersion !== 1 || original.bookingStatus !== "confirmed" ||
      original.actorOrigin !== "source" || original.actorClientId !== manifest.clientId ||
      original.actorSubjectId !== manifest.subjectId || original.actorGrantId !== manifest.grantId ||
      !Number.isSafeInteger(original.inventoryVersion) || original.inventoryVersion > snapshot.inventoryVersion)
      fail("ORIGINAL_EVENT_UNPROVEN");
    const notification = firstGmailNotification(link.sourceSystem, sourceVersion,
      original.requestKey, booking.createdAt);
    const created = Date.parse(booking.createdAt), recorded = Date.parse(original.at);
    if (!notification || !Number.isFinite(recorded) || recorded < created || recorded - created > 60_000)
      fail("NOTIFICATION_TIME_UNPROVEN");
    const originalReceipts = snapshot.receipts.filter((receipt) => receipt.key === original.requestKey &&
      receipt.action === "source:write" && receipt.clientId === manifest.clientId &&
      receipt.subjectId === manifest.subjectId && receipt.grantId === manifest.grantId &&
      HASH.test(receipt.requestHash) && receipt.response.state === "applied" &&
      receipt.response.bookingId === booking.id && receipt.response.bookingVersion === 1 &&
      receipt.response.inventoryVersion === original.inventoryVersion);
    if (originalReceipts.length !== 1) fail("ORIGINAL_RECEIPT_UNPROVEN");
    for (const receipt of snapshot.receipts.filter((value) => value.action === "source:write" &&
      value.response.bookingId === booking.id)) {
      if (receipt.response.state === "already_current") continue;
      const evidence = audits.filter((audit) => ["source.applied", "source.facts_enriched"].includes(audit.type) &&
        audit.requestKey === receipt.key && audit.actorClientId === receipt.clientId &&
        audit.actorSubjectId === receipt.subjectId && audit.actorGrantId === receipt.grantId &&
        audit.bookingVersion === receipt.response.bookingVersion && audit.inventoryVersion === receipt.response.inventoryVersion);
      if (receipt.response.state !== "applied" || evidence.length !== 1) fail("RECEIPT_HISTORY_UNPROVEN");
    }
    return { bookingId: booking.id, bookingVersion: booking.version, sourceVersion, notification,
      auditId: randomUUID(), eventId: randomUUID() };
  });
  const receivedDays = {};
  for (const { notification } of entries) {
    const day = new Date(Date.parse(notification.receivedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    receivedDays[day] = (receivedDays[day] ?? 0) + 1;
  }
  const proof = { ...manifest, stateSha256: snapshot.stateSha256, auditSha256: snapshot.auditSha256,
    policyAuditId: randomUUID(), policyEventId: randomUUID(), entries };
  const proofSha256 = createHash("sha256").update(JSON.stringify(proof)).digest("hex");
  return { proof, summary: { status: "prepared", candidates: entries.length,
    expectedInventoryVersion: snapshot.inventoryVersion, resultingInventoryVersion: snapshot.inventoryVersion + 1,
    authorityEpoch: snapshot.authorityEpoch, receivedDays, notificationCoverageFrom: coverage, proofSha256 } };
}

/** Generates a private, single-use transaction; it never opens a database connection. */
export function sourceNotificationRecoverySql(plan) {
  const encoded = Buffer.from(JSON.stringify(plan.proof)).toString("base64");
  return `-- Generated privately; do not commit this production manifest.
-- One guarded metadata transaction. No booking, payment, occupancy or channel mutation.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $notification_recovery$
DECLARE
  spec jsonb := convert_from(decode('${encoded}', 'base64'), 'UTF8')::jsonb;
  before_state jsonb; after_state jsonb; actual_audit_hash text;
  item jsonb; b jsonb; l jsonb; a jsonb; n integer; wanted integer; policy_added boolean;
  stamped text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  SELECT state_json INTO STRICT before_state FROM iron_gate.property_state
  WHERE property_id = (spec->>'propertyId')::uuid AND workspace_id = (spec->>'workspaceId')::uuid
    AND authority_epoch = (spec->>'authorityEpoch')::bigint
    AND inventory_version = (spec->>'expectedInventoryVersion')::bigint FOR UPDATE;
  IF COALESCE((before_state->'readOnly' IS DISTINCT FROM 'false'::jsonb OR
    encode(sha256(convert_to(before_state::text, 'UTF8')), 'hex') <> spec->>'stateSha256'), true)
    THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_STATE_CHANGED'; END IF;
  wanted := jsonb_array_length(spec->'entries');
  IF COALESCE((wanted < 1 OR wanted > 50 OR (SELECT count(DISTINCT e->>'bookingId') FROM jsonb_array_elements(spec->'entries') e) <> wanted), true)
    THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_TARGET_INVALID'; END IF;
  SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(audit_json ORDER BY audit_id), '[]'::jsonb)::text, 'UTF8')), 'hex')
  INTO actual_audit_hash FROM iron_gate.audit_log WHERE property_id = (spec->>'propertyId')::uuid
    AND audit_json->>'bookingId' IN (SELECT e->>'bookingId' FROM jsonb_array_elements(spec->'entries') e);
  IF actual_audit_hash IS DISTINCT FROM spec->>'auditSha256' THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_AUDIT_CHANGED'; END IF;
  IF COALESCE((spec->>'notificationCoverageFrom' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR
    (spec->>'notificationCoverageFrom')::date < (clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date + 1), true)
    THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_COVERAGE_DAY_INVALID'; END IF;
  policy_added := NOT (before_state ? 'reportingPolicy');
  IF NOT policy_added AND COALESCE((before_state->'reportingPolicy'->'schema' <> '1'::jsonb OR
    before_state->'reportingPolicy'->'authorityEpoch' <> spec->'authorityEpoch' OR
    before_state->'reportingPolicy'->>'notificationCoverageFrom' <> spec->>'notificationCoverageFrom' OR
    before_state->'reportingPolicy'->>'recordedAt' IS NULL), true)
    THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_COVERAGE_POLICY_CONFLICT'; END IF;
  SELECT count(*) INTO n FROM jsonb_array_elements(before_state->'sourceGrants') g
    WHERE g->>'grantId' = spec->>'grantId' AND g->'active' = 'true'::jsonb
      AND g->>'sourceSystem' = 'sweetfun-calendar-sheet' AND g->>'sourceAccount' = spec->>'sourceAccount';
  IF COALESCE((n <> 1 OR spec->>'subjectId' <> 'gmail-order-handler'), true) THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_GRANT_CHANGED'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(spec->'entries') LOOP
    SELECT count(*), jsonb_agg(value)->0 INTO n, b FROM jsonb_array_elements(before_state->'bookings')
      WHERE value->>'id' = item->>'bookingId';
    IF COALESCE((n <> 1 OR b->>'source' <> 'external' OR b->>'status' <> 'confirmed' OR b->'bookedAt' IS DISTINCT FROM 'null'::jsonb
      OR b ? 'sweetfunSnapshot' OR b ? 'osSnapshot' OR NOT b ? 'sourceCalendar'
      OR COALESCE((b->>'lineOverridePending')::boolean, false) OR b->'version' <> item->'bookingVersion'), true)
      THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_BOOKING_CHANGED'; END IF;
    SELECT count(*), jsonb_agg(value)->0 INTO n, l FROM jsonb_array_elements(before_state->'sourceLinks')
      WHERE value->>'key' = b->>'sourceKey';
    IF COALESCE((n <> 1 OR l->>'bookingId' <> b->>'id' OR l->>'sourceVersion' <> item->>'sourceVersion'
      OR l->>'sourceSystem' <> 'sweetfun-calendar-sheet' OR l->>'sourceAccount' <> spec->>'sourceAccount'
      OR l->'diverged' IS DISTINCT FROM 'false'::jsonb OR l->'tombstoneNights' IS DISTINCT FROM '[]'::jsonb
      OR l->'lastAppliedBookingVersion' <> b->'version' OR l ? 'firstNewOrderNotification'), true)
      THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_LINK_CHANGED'; END IF;
    SELECT count(*), jsonb_agg(audit_json)->0 INTO n, a FROM iron_gate.audit_log
      WHERE property_id = (spec->>'propertyId')::uuid AND audit_json->>'bookingId' = b->>'id'
        AND audit_json->>'type' = 'source.applied';
    IF COALESCE((n <> 1 OR a->>'workspaceId' <> spec->>'workspaceId' OR a->'bookingVersion' <> '1'::jsonb
      OR a->>'bookingStatus' <> 'confirmed' OR a->>'actorOrigin' <> 'source'
      OR a->>'actorClientId' <> spec->>'clientId' OR a->>'actorSubjectId' <> spec->>'subjectId'
      OR a->>'actorGrantId' <> spec->>'grantId' OR a->>'requestKey' <> item->'notification'->>'requestKey'
      OR (a->>'at')::timestamptz < (b->>'createdAt')::timestamptz
      OR (a->>'at')::timestamptz > (b->>'createdAt')::timestamptz + interval '60 seconds'), true)
      THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_ORIGINAL_EVENT_UNPROVEN'; END IF;
    IF EXISTS (SELECT 1 FROM iron_gate.audit_log WHERE property_id = (spec->>'propertyId')::uuid
      AND audit_json->>'bookingId' = b->>'id' AND (audit_json->>'type' IS NULL OR audit_json->>'type' NOT IN
        ('source.applied','source.facts_enriched','channel.verified','channel.review_required','payment.recorded')))
      THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_SOURCE_HISTORY_AMBIGUOUS'; END IF;
    SELECT count(*) INTO n FROM jsonb_array_elements(before_state->'receipts') r
      WHERE r->>'propertyId' = spec->>'propertyId' AND r->>'action' = 'source:write'
        AND r->>'key' = a->>'requestKey' AND r->>'clientId' = spec->>'clientId'
        AND r->>'subjectId' = spec->>'subjectId' AND r->>'grantId' = spec->>'grantId'
        AND r->'response'->>'state' = 'applied' AND r->'response'->>'bookingId' = b->>'id'
        AND r->'response'->'bookingVersion' = '1'::jsonb AND r->'response'->'inventoryVersion' = a->'inventoryVersion';
    IF n <> 1 THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_ORIGINAL_RECEIPT_UNPROVEN'; END IF;
    IF COALESCE((item->>'sourceVersion' !~ '^gmail-v1:[1-9][0-9]{12}:[0-9a-f]{64}$'
      OR item->'notification'->>'sourceVersion' <> item->>'sourceVersion' OR item->'notification'->'schema' <> '1'::jsonb
      OR item->'notification'->>'requestKey' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR (item->'notification'->>'receivedAt')::timestamptz <> to_timestamp(split_part(item->>'sourceVersion', ':', 2)::numeric / 1000)
      OR (item->'notification'->>'receivedAt')::timestamptz > (b->>'createdAt')::timestamptz), true)
      THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_TIME_UNPROVEN'; END IF;
  END LOOP;
  SELECT jsonb_set(before_state, '{sourceLinks}', jsonb_agg(
    CASE WHEN p.value IS NULL THEN l.value ELSE l.value || jsonb_build_object('firstNewOrderNotification', p.value->'notification') END
    ORDER BY l.ord)) INTO after_state
    FROM jsonb_array_elements(before_state->'sourceLinks') WITH ORDINALITY l(value, ord)
    LEFT JOIN LATERAL (SELECT e.value FROM jsonb_array_elements(spec->'entries') e(value)
      WHERE e.value->>'bookingId' = l.value->>'bookingId' AND e.value->>'sourceVersion' = l.value->>'sourceVersion'
        AND l.value->>'key' = (SELECT b2.value->>'sourceKey' FROM jsonb_array_elements(before_state->'bookings') b2(value)
          WHERE b2.value->>'id' = e.value->>'bookingId')) p ON true;
  after_state := jsonb_set(after_state, '{version}', to_jsonb((spec->>'expectedInventoryVersion')::bigint + 1));
  IF policy_added THEN after_state := jsonb_set(after_state, '{reportingPolicy}', jsonb_build_object(
    'schema',1,'authorityEpoch',spec->'authorityEpoch','notificationCoverageFrom',spec->>'notificationCoverageFrom','recordedAt',stamped)); END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(after_state->'sourceLinks') l2
      JOIN jsonb_array_elements(spec->'entries') e ON l2->>'bookingId' = e->>'bookingId'
        AND l2->'firstNewOrderNotification' = e->'notification') <> wanted
    THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_TARGET_COUNT_CHANGED'; END IF;
  IF after_state - 'sourceLinks' - 'version' - 'reportingPolicy' IS DISTINCT FROM before_state - 'sourceLinks' - 'version' - 'reportingPolicy'
    THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_UNRELATED_CHANGE'; END IF;
  UPDATE iron_gate.property_state SET state_json = after_state,
    inventory_version = (spec->>'expectedInventoryVersion')::bigint + 1, updated_at = now()
    WHERE property_id = (spec->>'propertyId')::uuid AND inventory_version = (spec->>'expectedInventoryVersion')::bigint
      AND authority_epoch = (spec->>'authorityEpoch')::bigint;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_VERSION_CONFLICT'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(spec->'entries') LOOP
    INSERT INTO iron_gate.audit_log(audit_id, property_id, audit_json) VALUES ((item->>'auditId')::uuid,
      (spec->>'propertyId')::uuid, jsonb_build_object('auditId', item->>'auditId', 'at', stamped,
        'type','source.notification_recorded','workspaceId',spec->>'workspaceId','propertyId',spec->>'propertyId',
        'bookingId',item->>'bookingId','bookingVersion',item->'bookingVersion','bookingStatus','confirmed',
        'inventoryVersion',(spec->>'expectedInventoryVersion')::bigint+1,'actorOrigin','service',
        'actorClientId','sean-dashboard-notification-recovery','actorSubjectId','authorized-maintenance',
        'actorGrantId',NULL,'requestKey',spec->>'recoveryKey'));
    INSERT INTO iron_gate.outbox(event_id, property_id, event_json) VALUES ((item->>'eventId')::uuid,
      (spec->>'propertyId')::uuid, jsonb_build_object('eventId',item->>'eventId','at',stamped,
        'type','source.notification_recorded','propertyId',spec->>'propertyId','bookingId',item->>'bookingId',
        'bookingVersion',item->'bookingVersion','inventoryVersion',(spec->>'expectedInventoryVersion')::bigint+1));
  END LOOP;
  IF policy_added THEN
    INSERT INTO iron_gate.audit_log(audit_id, property_id, audit_json) VALUES ((spec->>'policyAuditId')::uuid,
      (spec->>'propertyId')::uuid, jsonb_build_object('auditId',spec->>'policyAuditId','at',stamped,
        'type','reporting.policy_recorded','workspaceId',spec->>'workspaceId','propertyId',spec->>'propertyId',
        'bookingId',NULL,'bookingVersion',NULL,'bookingStatus',NULL,
        'inventoryVersion',(spec->>'expectedInventoryVersion')::bigint+1,'actorOrigin','service',
        'actorClientId','sean-dashboard-notification-recovery','actorSubjectId','authorized-maintenance',
        'actorGrantId',NULL,'requestKey',spec->>'recoveryKey'));
    INSERT INTO iron_gate.outbox(event_id, property_id, event_json) VALUES ((spec->>'policyEventId')::uuid,
      (spec->>'propertyId')::uuid, jsonb_build_object('eventId',spec->>'policyEventId','at',stamped,
        'type','reporting.policy_recorded','propertyId',spec->>'propertyId','bookingId',NULL,'bookingVersion',NULL,
        'inventoryVersion',(spec->>'expectedInventoryVersion')::bigint+1));
  END IF;
  IF (SELECT state_json FROM iron_gate.property_state WHERE property_id = (spec->>'propertyId')::uuid) IS DISTINCT FROM after_state
    OR (SELECT count(*) FROM iron_gate.audit_log WHERE audit_id::text IN
      (SELECT e->>'auditId' FROM jsonb_array_elements(spec->'entries') e)) <> wanted
    OR (SELECT count(*) FROM iron_gate.outbox WHERE event_id::text IN
      (SELECT e->>'eventId' FROM jsonb_array_elements(spec->'entries') e)) <> wanted
    OR (policy_added AND ((SELECT count(*) FROM iron_gate.audit_log WHERE audit_id = (spec->>'policyAuditId')::uuid) <> 1
      OR (SELECT count(*) FROM iron_gate.outbox WHERE event_id = (spec->>'policyEventId')::uuid) <> 1))
    THEN RAISE EXCEPTION 'NOTIFICATION_RECOVERY_READBACK_MISMATCH'; END IF;
END
$notification_recovery$;
COMMIT;
`;
}
