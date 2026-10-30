import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PROJECT_REF, planOfflandLineBookingGrant, planOfflandLineBookingActivation }
  from './stage-offland-line-booking-grant.mjs';
import { validateGrantShape } from '../src/credential-grant.mjs';
import { checkPropertyIntegrity } from '../src/property-integrity.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/;
const fail = name => { throw Error(`OFFLAND_LINE_SQL_${name}`); };
const instant = value => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
const exactly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const PROPERTY_KEYS = ['property_id', 'workspace_id', 'authority_epoch', 'inventory_version', 'updated_at'];
const CREDENTIAL_KEYS = ['token_hash', 'credential_id', 'property_id', 'grant_json', 'expires_at', 'active'];
const STAGE_KEYS = ['projectRef', 'propertyId', 'workspaceId', 'expectedVersion', 'credentialId',
  'grantId', 'clientId', 'sourceAccount', 'groupId', 'actorIds', 'channelPolicy', 'expiresAt',
  'requestKey', 'authorizationRef'];
const SWITCH_KEYS = ['projectRef', 'propertyId', 'workspaceId', 'expectedVersion', 'credentialId',
  'grantId', 'requestKey', 'authorizationRef'];
const REQUEST_KEYS = ['schema', 'kind', 'action', 'manifest', 'evidence', 'targetBefore', 'targetAfter', 'result'];

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hashText = value => createHash('sha256').update(value, 'utf8').digest('hex');
const hash = value => hashText(canonical(value));
const valueSql = value => `convert_from(decode('${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}',` +
  `'base64'),'UTF8')::jsonb`;
const dateSignature = value => `${Date.parse(value)}:${(/\.(\d{1,6})/.exec(value)?.[1] ?? '').padEnd(6, '0').slice(3)}`;

function identity(manifest) {
  if (!manifest || manifest.projectRef !== PROJECT_REF ||
    ![manifest.propertyId, manifest.workspaceId, manifest.credentialId, manifest.grantId,
      manifest.requestKey].every(value => UUID.test(value ?? '')) ||
    !Number.isSafeInteger(manifest.expectedVersion) || manifest.expectedVersion < 1 ||
    !/^[A-Za-z0-9:_-]{8,128}$/.test(manifest.authorizationRef ?? '')) fail('MANIFEST_INVALID');
}

function checkedSnapshot(snapshot, manifest) {
  if (!exactly(snapshot, ['schema', 'projectRef', 'capturedAt', 'property',
    'stateJsonText', 'occupancyJsonText', 'credentialsJsonText']) ||
    snapshot.schema !== 1 || snapshot.projectRef !== PROJECT_REF || !instant(snapshot.capturedAt) ||
    Date.now() - Date.parse(snapshot.capturedAt) > 15 * 60_000 ||
    Date.parse(snapshot.capturedAt) > Date.now() + 60_000 ||
    !exactly(snapshot.property, PROPERTY_KEYS) || !instant(snapshot.property.updated_at) ||
    ['stateJsonText', 'occupancyJsonText', 'credentialsJsonText'].some(key => typeof snapshot[key] !== 'string'))
    fail('SNAPSHOT_INVALID');
  let state, occupancy, credentials;
  try {
    state = JSON.parse(snapshot.stateJsonText);
    occupancy = JSON.parse(snapshot.occupancyJsonText);
    credentials = JSON.parse(snapshot.credentialsJsonText);
  } catch { fail('SNAPSHOT_INVALID'); }
  const p = snapshot.property;
  if (!state || p.property_id !== manifest.propertyId || p.workspace_id !== manifest.workspaceId ||
    state.propertyId !== p.property_id || state.workspaceId !== p.workspace_id ||
    p.authority_epoch !== state.authorityEpoch || p.inventory_version !== state.version ||
    state.version !== manifest.expectedVersion || !Number.isSafeInteger(state.version) ||
    !Number.isSafeInteger(state.authorityEpoch) || state.authorityEpoch < 0) fail('SNAPSHOT_IDENTITY');
  if (!Array.isArray(occupancy) || occupancy.some(row => !exactly(row, ['room_id', 'night', 'booking_id']) ||
    !UUID.test(row.room_id ?? '') || !UUID.test(row.booking_id ?? '') ||
    !/^\d{4}-\d\d-\d\d$/.test(row.night ?? '')) ||
    !checkPropertyIntegrity(state, occupancy).ok) fail('SNAPSHOT_INTEGRITY');
  if (!Array.isArray(credentials)) fail('SNAPSHOT_CREDENTIALS');
  const ids = new Set(), hashes = new Set();
  for (const c of credentials) {
    if (!exactly(c, CREDENTIAL_KEYS) || !UUID.test(c.credential_id ?? '') ||
      c.property_id !== state.propertyId || !HASH.test(c.token_hash ?? '') ||
      typeof c.active !== 'boolean' || !instant(c.expires_at) ||
      c.grant_json?.credentialId !== c.credential_id || c.grant_json.propertyId !== c.property_id ||
      ids.has(c.credential_id) || hashes.has(c.token_hash)) fail('SNAPSHOT_CREDENTIALS');
    ids.add(c.credential_id); hashes.add(c.token_hash);
  }
  // Hash exact UTF-8 DB text, never a JS reserialization. Parsed objects are
  // only for planner/integrity checks; unrelated older grants stay unchanged.
  const evidence = { capturedAt: snapshot.capturedAt, property: structuredClone(p),
    stateHash: hashText(snapshot.stateJsonText), occupancyHash: hashText(snapshot.occupancyJsonText),
    credentialScopeHash: hashText(snapshot.credentialsJsonText) };
  return { state, occupancy, credentials, evidence };
}

/** Offline only: no database, filesystem or randomness. SQL carries the target
 * grant and hashes; guest records remain in the separate private snapshot. */
export function planOfflandLineBookingAdminSql(action, manifest, snapshot, stageTokenHash = null) {
  if (!['stage', 'activate', 'revoke'].includes(action)) fail('ACTION_INVALID');
  identity(manifest);
  if (!exactly(manifest, action === 'revoke' ? SWITCH_KEYS : STAGE_KEYS)) fail('MANIFEST_FIELDS');
  const { state, occupancy, credentials, evidence } = checkedSnapshot(snapshot, manifest);
  const existing = credentials.find(c => c.credential_id === manifest.credentialId);
  if (action !== 'revoke' && credentials.some(c => c.credential_id !== manifest.credentialId &&
    c.grant_json.grantId === manifest.grantId)) fail('GRANT_ID_CONFLICT');
  let afterState = structuredClone(state), targetAfter;
  if (action === 'stage') {
    if (!HASH.test(stageTokenHash ?? '') || existing ||
      credentials.some(c => c.token_hash === stageTokenHash)) fail('STAGE_CREDENTIAL_CONFLICT');
    const planned = planOfflandLineBookingGrant(state, manifest);
    if (credentials.some(c => Date.parse(c.expires_at) > Date.now() && c.grant_json.origin === 'line' &&
      (c.grant_json.lineCreateEnabled === true || c.grant_json.lineManageAllEnabled === true))) fail('OTHER_WRITER');
    targetAfter = { token_hash: stageTokenHash, credential_id: planned.grant.credentialId,
      property_id: planned.grant.propertyId, grant_json: planned.grant,
      expires_at: planned.expiresAt, active: false };
  } else {
    if (stageTokenHash !== null || !existing || existing.grant_json.grantId !== manifest.grantId ||
      existing.grant_json.workspaceId !== manifest.workspaceId || existing.grant_json.origin !== 'line' ||
      existing.grant_json.lineProviderFreeEnabled !== true) fail('TARGET_CREDENTIAL_MISMATCH');
    validateGrantShape(existing.grant_json);
    if (action === 'activate') {
      const planned = planOfflandLineBookingActivation(state, manifest);
      if (existing.active || !isDeepStrictEqual(existing.grant_json, planned.grant) ||
        dateSignature(existing.expires_at) !== dateSignature(planned.expiresAt)) fail('TARGET_CREDENTIAL_MISMATCH');
      if (credentials.some(c => c.credential_id !== manifest.credentialId && c.active &&
        Date.parse(c.expires_at) > Date.now() && c.grant_json.origin === 'line' &&
        (c.grant_json.lineCreateEnabled === true || c.grant_json.lineManageAllEnabled === true))) fail('OTHER_WRITER');
      afterState = planned.state;
    } else {
      if (!state.channel || state.channel.lineBookingGrantId !== undefined &&
        state.channel.lineBookingGrantId !== manifest.grantId ||
        state.channel.lineBookingMode !== undefined && state.channel.lineBookingMode !== 'provider_free')
        fail('TARGET_POLICY_MISMATCH');
      delete afterState.channel.lineBookingGrantId;
      delete afterState.channel.lineBookingMode;
      afterState.version++;
    }
    targetAfter = { ...existing, active: action === 'activate' };
  }
  if (!checkPropertyIntegrity(afterState, occupancy).ok) fail('NEXT_STATE_INTEGRITY');
  const result = { action, propertyId: manifest.propertyId, credentialId: manifest.credentialId,
    grantId: manifest.grantId, active: action === 'activate', inventoryVersion: afterState.version,
    bookingMode: action === 'activate' ? 'provider_free' : 'disabled' };
  const request = { schema: 1, kind: 'offland-line-booking-admin-sql', action,
    manifest: structuredClone(manifest), evidence, targetBefore: existing ?? null, targetAfter, result };
  const requestHash = hash(request), audit = expectedAudit(request, requestHash);
  const plan = { ...request, requestHash, audit };
  return { plan, applySql: applyStatement(plan, false), dryRunSql: applyStatement(plan, true),
    readbackSql: offlandLineBookingReadbackSql(plan) };
}

function expectedAudit(request, requestHash) {
  const { manifest, action, evidence, result } = request;
  return { auditId: manifest.requestKey, propertyId: manifest.propertyId, workspaceId: manifest.workspaceId,
    type: `line.provider_free.${action === 'stage' ? 'staged' : action === 'activate' ? 'activated' : 'revoked'}`,
    actorOrigin: 'service', actorSubjectId: 'offland-line-booking-release', authorizationRef: manifest.authorizationRef,
    requestHash, beforeStateHash: evidence.stateHash, beforeCredentialScopeHash: evidence.credentialScopeHash,
    occupancyHash: evidence.occupancyHash, beforeInventoryVersion: evidence.property.inventory_version, response: result };
}

function validEnvelope(plan) {
  if (!exactly(plan, [...REQUEST_KEYS, 'requestHash', 'audit'])) fail('READBACK_PLAN_INVALID');
  identity(plan.manifest);
  const request = Object.fromEntries(REQUEST_KEYS.map(key => [key, plan[key]]));
  if (!HASH.test(plan.requestHash ?? '') || hash(request) !== plan.requestHash ||
    !isDeepStrictEqual(plan.audit, expectedAudit(request, plan.requestHash))) fail('READBACK_PLAN_INVALID');
}

const digest = text => `encode(sha256(convert_to(${text},'UTF8')),'hex')`;
const credentialRows = `(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.credential_id),'[]'::jsonb)
      FROM iron_gate.credentials c WHERE c.property_id=(p->'manifest'->>'propertyId')::uuid)`;
const occupancyRows = `(SELECT coalesce(jsonb_agg(jsonb_build_object('room_id',n.room_id::text,
      'night',n.night::text,'booking_id',n.booking_id::text) ORDER BY n.room_id,n.night,n.booking_id),'[]'::jsonb)
      FROM iron_gate.occupied_room_nights n WHERE n.property_id=(p->'manifest'->>'propertyId')::uuid)`;
const credentialHash = digest(`${credentialRows}::text`);
const occupancyHash = digest(`${occupancyRows}::text`);
const auditMatches = `coalesce(a.audit_json - 'at' - 'afterStateHash' - 'afterCredentialScopeHash'=p->'audit'
  AND a.audit_json->>'at' IS NOT NULL AND a.audit_json->>'afterStateHash' ~ '^[0-9a-f]{64}$'
  AND a.audit_json->>'afterCredentialScopeHash' ~ '^[0-9a-f]{64}$',false)`;

/** Execute on manifest.projectRef; save the single snapshot cell privately.
 * Raw JSONB text is necessary to hash without changing PostgreSQL encoding. */
export function offlandLineBookingSnapshotSql(manifest) {
  identity(manifest);
  const p = valueSql({ manifest: { projectRef: manifest.projectRef, propertyId: manifest.propertyId } });
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object('schema',1,'projectRef',p->'manifest'->>'projectRef',
  'capturedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'property',to_jsonb(s)-'state_json','stateJsonText',s.state_json::text,
  'occupancyJsonText',${occupancyRows}::text,'credentialsJsonText',${credentialRows}::text) AS snapshot
FROM iron_gate.property_state s CROSS JOIN (SELECT ${p} AS p) input
WHERE s.property_id=(p->'manifest'->>'propertyId')::uuid;
COMMIT;
`;
}

function readbackStatement(plan, executionMode) {
  return `WITH input AS (SELECT ${valueSql(plan)} AS p)
SELECT jsonb_build_object('executionMode','${executionMode}','requestHash',p->>'requestHash',
  'receiptCommitted',${auditMatches},'recordedResponse',a.audit_json->'response',
  'currentStateMatchesExpected',coalesce(${auditMatches} AND
    ${digest('s.state_json::text')}=a.audit_json->>'afterStateHash' AND
    s.inventory_version=(p->'result'->>'inventoryVersion')::bigint AND
    s.authority_epoch=(p->'evidence'->'property'->>'authority_epoch')::bigint AND
    s.workspace_id::text=p->'manifest'->>'workspaceId',false),
  'currentCredentialsMatchExpected',coalesce(${auditMatches} AND
    ${credentialHash}=a.audit_json->>'afterCredentialScopeHash',false),
  'currentOccupancyMatchesExpected',${occupancyHash}=p->'evidence'->>'occupancyHash',
  'currentTargetMatchesExpected',coalesce(to_jsonb(c)=to_jsonb(jsonb_populate_record(
    NULL::iron_gate.credentials,p->'targetAfter')),false),
  'currentInventoryVersion',s.inventory_version,'currentCredentialActive',c.active,
  'currentCredentialExpiresAt',c.expires_at,'currentBookingMode',s.state_json->'channel'->>'lineBookingMode',
  'currentBookingGrantId',s.state_json->'channel'->>'lineBookingGrantId') AS verification
FROM input LEFT JOIN iron_gate.audit_log a ON a.audit_id=(p->'manifest'->>'requestKey')::uuid
LEFT JOIN iron_gate.property_state s ON s.property_id=(p->'manifest'->>'propertyId')::uuid
LEFT JOIN iron_gate.credentials c ON c.credential_id=(p->'manifest'->>'credentialId')::uuid
  AND c.property_id=(p->'manifest'->>'propertyId')::uuid;
`;
}

export function offlandLineBookingReadbackSql(plan) {
  // Recovery works after expiry, but never trusts altered expected fields.
  validEnvelope(plan);
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${readbackStatement(plan, 'committed_readback')}COMMIT;\n`;
}

function applyStatement(plan, dryRun) {
  return `-- Private reviewed operator plan; execute only on manifest.projectRef.
-- Contains target grant + hashes, no bearer token or guest snapshot.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
DO $offland_line_booking$
DECLARE
  p jsonb := ${valueSql(plan)};
  current_property iron_gate.property_state%ROWTYPE;
  expected_property iron_gate.property_state%ROWTYPE;
  target iron_gate.credentials%ROWTYPE; prior_target iron_gate.credentials%ROWTYPE;
  saved jsonb; before_credentials jsonb; after_credentials jsonb; expected_credentials jsonb;
  next_state jsonb; audit jsonb; changed integer;
BEGIN
  IF current_user <> 'postgres' OR current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'OFFLAND_LINE_SQL_WRONG_ADMIN_DATABASE';
  END IF;
  SELECT * INTO STRICT current_property FROM iron_gate.property_state
    WHERE property_id=(p->'manifest'->>'propertyId')::uuid FOR UPDATE;
  SELECT audit_json INTO saved FROM iron_gate.audit_log
    WHERE audit_id=(p->'manifest'->>'requestKey')::uuid;
  IF FOUND THEN
    IF saved - 'at' - 'afterStateHash' - 'afterCredentialScopeHash' IS DISTINCT FROM p->'audit' OR
      saved->>'at' IS NULL OR coalesce(saved->>'afterStateHash','') !~ '^[0-9a-f]{64}$' OR
      coalesce(saved->>'afterCredentialScopeHash','') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'OFFLAND_LINE_SQL_IDEMPOTENCY_CONFLICT';
    END IF;
    -- Historical receipt only: never restage/reactivate after a later revoke.
    RETURN;
  END IF;
  IF clock_timestamp()-(p->'evidence'->>'capturedAt')::timestamptz > interval '15 minutes' OR
    (p->'evidence'->>'capturedAt')::timestamptz > clock_timestamp()+interval '1 minute' THEN
    RAISE EXCEPTION 'OFFLAND_LINE_SQL_SNAPSHOT_STALE';
  END IF;
  expected_property := jsonb_populate_record(NULL::iron_gate.property_state,p->'evidence'->'property');
  IF to_jsonb(current_property)-'state_json' IS DISTINCT FROM to_jsonb(expected_property)-'state_json' OR
    ${digest('current_property.state_json::text')} IS DISTINCT FROM p->'evidence'->>'stateHash' OR
    ${occupancyHash} IS DISTINCT FROM p->'evidence'->>'occupancyHash' THEN
    RAISE EXCEPTION 'OFFLAND_LINE_SQL_STATE_OR_OCCUPANCY_DRIFT';
  END IF;
  -- Bound credential insert/update phantoms during this short admin operation.
  LOCK TABLE iron_gate.credentials IN SHARE ROW EXCLUSIVE MODE;
  before_credentials := ${credentialRows};
  IF ${digest('before_credentials::text')} IS DISTINCT FROM p->'evidence'->>'credentialScopeHash' THEN
    RAISE EXCEPTION 'OFFLAND_LINE_SQL_CREDENTIAL_DRIFT';
  END IF;
  target := jsonb_populate_record(NULL::iron_gate.credentials,p->'targetAfter');
  IF p->'targetBefore'<>'null'::jsonb THEN
    prior_target := jsonb_populate_record(NULL::iron_gate.credentials,p->'targetBefore');
  END IF;
  IF p->>'action' IN ('stage','activate') AND
    (target.expires_at<=clock_timestamp() OR target.expires_at>clock_timestamp()+interval '30 days') THEN
    RAISE EXCEPTION 'OFFLAND_LINE_SQL_CREDENTIAL_EXPIRED';
  END IF;
  -- The backend proof router selects dedicated identity by grant ID as well
  -- as credential ID. Reusing any other grant could break its existing proof.
  IF p->>'action' IN ('stage','activate') AND EXISTS (
    SELECT 1 FROM iron_gate.credentials c WHERE c.credential_id<>target.credential_id AND
      c.grant_json->>'grantId'=p->'manifest'->>'grantId') THEN
    RAISE EXCEPTION 'OFFLAND_LINE_SQL_GRANT_ID_CONFLICT';
  END IF;
  IF p->>'action' IN ('stage','activate') AND EXISTS (
    SELECT 1 FROM iron_gate.credentials c WHERE c.property_id=target.property_id AND
      c.credential_id<>target.credential_id AND c.expires_at>clock_timestamp() AND
      (p->>'action'='stage' OR c.active) AND c.grant_json->>'origin'='line' AND
      (c.grant_json->'lineCreateEnabled'='true'::jsonb OR c.grant_json->'lineManageAllEnabled'='true'::jsonb)) THEN
    RAISE EXCEPTION 'OFFLAND_LINE_SQL_OTHER_WRITER';
  END IF;
  next_state := current_property.state_json;
  IF p->>'action'='stage' THEN
    IF target.active OR p->'targetBefore'<>'null'::jsonb THEN RAISE EXCEPTION 'OFFLAND_LINE_SQL_INVALID_STAGE'; END IF;
    INSERT INTO iron_gate.credentials SELECT target.*;
  ELSE
    IF to_jsonb(target)-'active' IS DISTINCT FROM to_jsonb(prior_target)-'active' OR
      target.active IS DISTINCT FROM (p->>'action'='activate') THEN
      RAISE EXCEPTION 'OFFLAND_LINE_SQL_INVALID_SWITCH';
    END IF;
    IF p->>'action'='activate' THEN
      IF prior_target.active OR next_state->'channel' ? 'lineBookingMode' OR
        next_state->'channel' ? 'lineBookingGrantId' THEN RAISE EXCEPTION 'OFFLAND_LINE_SQL_INVALID_SWITCH'; END IF;
      next_state := jsonb_set(next_state,'{channel,lineBookingMode}','"provider_free"'::jsonb);
      next_state := jsonb_set(next_state,'{channel,lineBookingGrantId}',p->'manifest'->'grantId');
    ELSE
      IF (next_state->'channel' ? 'lineBookingGrantId' AND next_state->'channel'->'lineBookingGrantId'
        IS DISTINCT FROM p->'manifest'->'grantId') OR
        (next_state->'channel' ? 'lineBookingMode' AND next_state->'channel'->'lineBookingMode'
        IS DISTINCT FROM '"provider_free"'::jsonb) THEN RAISE EXCEPTION 'OFFLAND_LINE_SQL_INVALID_SWITCH'; END IF;
      next_state := next_state #- '{channel,lineBookingMode}' #- '{channel,lineBookingGrantId}';
    END IF;
    next_state := jsonb_set(next_state,'{version}',to_jsonb(current_property.inventory_version+1));
    UPDATE iron_gate.credentials SET active=target.active WHERE credential_id=target.credential_id AND
      property_id=target.property_id AND token_hash=prior_target.token_hash AND
      grant_json=prior_target.grant_json AND expires_at=prior_target.expires_at AND active=prior_target.active;
    GET DIAGNOSTICS changed=ROW_COUNT;
    IF changed<>1 THEN RAISE EXCEPTION 'OFFLAND_LINE_SQL_TARGET_DRIFT'; END IF;
    UPDATE iron_gate.property_state SET state_json=next_state,
      inventory_version=inventory_version+1, updated_at=clock_timestamp()
      WHERE property_id=expected_property.property_id AND inventory_version=expected_property.inventory_version
        AND authority_epoch=expected_property.authority_epoch;
    GET DIAGNOSTICS changed=ROW_COUNT;
    IF changed<>1 THEN RAISE EXCEPTION 'OFFLAND_LINE_SQL_STATE_DRIFT'; END IF;
  END IF;
  SELECT coalesce(jsonb_agg(c ORDER BY c->>'credential_id'),'[]'::jsonb) INTO expected_credentials
    FROM (SELECT value c FROM jsonb_array_elements(before_credentials)
      WHERE value->>'credential_id'<>target.credential_id::text UNION ALL SELECT to_jsonb(target)) x;
  after_credentials := ${credentialRows};
  SELECT * INTO STRICT current_property FROM iron_gate.property_state
    WHERE property_id=(p->'manifest'->>'propertyId')::uuid;
  IF current_property.state_json IS DISTINCT FROM next_state OR
    current_property.inventory_version IS DISTINCT FROM (p->'result'->>'inventoryVersion')::bigint OR
    current_property.authority_epoch IS DISTINCT FROM expected_property.authority_epoch OR
    current_property.workspace_id IS DISTINCT FROM expected_property.workspace_id OR
    after_credentials IS DISTINCT FROM expected_credentials OR
    ${occupancyHash} IS DISTINCT FROM p->'evidence'->>'occupancyHash' OR
    (p->>'action'='stage' AND current_property.updated_at IS DISTINCT FROM expected_property.updated_at) THEN
    RAISE EXCEPTION 'OFFLAND_LINE_SQL_READBACK_MISMATCH';
  END IF;
  audit := (p->'audit') || jsonb_build_object('at',
    to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'afterStateHash',${digest('next_state::text')},'afterCredentialScopeHash',${digest('after_credentials::text')});
  INSERT INTO iron_gate.audit_log(audit_id,property_id,audit_json)
    VALUES((p->'manifest'->>'requestKey')::uuid,(p->'manifest'->>'propertyId')::uuid,audit);
  SELECT audit_json INTO STRICT saved FROM iron_gate.audit_log
    WHERE audit_id=(p->'manifest'->>'requestKey')::uuid;
  IF saved IS DISTINCT FROM audit THEN RAISE EXCEPTION 'OFFLAND_LINE_SQL_AUDIT_READBACK_MISMATCH'; END IF;
END
$offland_line_booking$;
${dryRun ? 'ROLLBACK' : 'COMMIT'};
-- Read after transaction completion; never use a dry-run response as proof.
${readbackStatement(plan, dryRun ? 'dry_run' : 'apply_postcommit')}`;
}

export function verifyOfflandLineBookingCommittedReadback(plan, readback) {
  validEnvelope(plan);
  if (!readback || readback.executionMode !== 'committed_readback' || readback.requestHash !== plan.requestHash ||
    readback.receiptCommitted !== true || !isDeepStrictEqual(readback.recordedResponse, plan.result) ||
    readback.currentStateMatchesExpected !== true || readback.currentCredentialsMatchExpected !== true ||
    readback.currentOccupancyMatchesExpected !== true || readback.currentTargetMatchesExpected !== true ||
    readback.currentInventoryVersion !== plan.result.inventoryVersion ||
    readback.currentCredentialActive !== plan.result.active ||
    !instant(readback.currentCredentialExpiresAt) || plan.action !== 'revoke' &&
      Date.parse(readback.currentCredentialExpiresAt)<=Date.now() ||
    (plan.action === 'activate' ? readback.currentBookingMode !== 'provider_free' ||
      readback.currentBookingGrantId !== plan.manifest.grantId :
      readback.currentBookingMode !== null || readback.currentBookingGrantId !== null)) fail('COMMITTED_READBACK_MISMATCH');
  return { kind: 'offland_line_booking_committed', action: plan.action,
    requestHash: plan.requestHash, inventoryVersion: plan.result.inventoryVersion, active: plan.result.active };
}
