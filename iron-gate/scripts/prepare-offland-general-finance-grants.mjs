#!/usr/bin/env node
// Prepare private credentials only. An administrator applies issue.sql after
// the scoped connectors and production runtime have been independently checked.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tokenHash, validCredentialId, validateGrant } from '../src/credential-grant.mjs';

const PROJECT_REF = 'brcszrkwkgiwatrxevkf';
// This is the existing verified OA group grant, not an Offland authority grant.
const SWEETFUN_PROPERTY_ID = '95ae9bd1-5e6d-4386-be5b-6af3c5668a16';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_LINE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const fail = () => { throw Error('OFFLAND_FINANCE_GRANT_INPUT_INVALID'); };

function connector(candidate, sourceSystem) {
  const rows = candidate.connectors.filter(row => row?.source_system === sourceSystem);
  if (rows.length !== 1 || !UUID.test(rows[0].source_instance_id ?? '') ||
    rows[0].enabled !== false || rows[0].cutover_at !== null ||
    typeof rows[0].source_account_ref !== 'string' ||
    !rows[0].source_account_ref || rows[0].source_account_ref.length > 128 ||
    /[\x00-\x1f\x7f]/.test(rows[0].source_account_ref)) fail();
  return rows[0];
}

export function offlandGeneralFinanceGrantPackage(candidate, authority,
  lineAuthority = null, now = Date.now()) {
  if (candidate?.schema !== 1 || candidate?.property_key !== 'offland' ||
    candidate.status !== 'candidate_only_no_production_change' ||
    !UUID.test(candidate.property_id ?? '') ||
    !Array.isArray(candidate.connectors) || candidate.connectors.length !== 3 ||
    authority?.project_ref !== PROJECT_REF ||
    authority.property_id !== candidate.property_id ||
    !UUID.test(authority.workspace_id ?? '') ||
    authority.authority_epoch !== 1 || authority.read_only !== false ||
    !Number.isFinite(now)) fail();
  const os = connector(candidate, 'os_manual');
  const line = connector(candidate, 'line_finance');
  connector(candidate, 'os_legacy_payment');
  if (new Set(candidate.connectors.map(row => row.source_instance_id)).size !== 3)
    fail();
  if (lineAuthority !== null && (!UUID.test(lineAuthority.existing_credential_id ?? '') ||
    lineAuthority.existing_property_id !== SWEETFUN_PROPERTY_ID ||
    !UUID.test(lineAuthority.existing_grant_id ?? '') ||
    !SAFE_LINE_ID.test(lineAuthority.group_id ?? '') ||
    !Array.isArray(lineAuthority.actor_ids) ||
    lineAuthority.actor_ids.length < 1 || lineAuthority.actor_ids.length > 32 ||
    lineAuthority.actor_ids.some(id => !SAFE_LINE_ID.test(id)) ||
    new Set(lineAuthority.actor_ids).size !== lineAuthority.actor_ids.length)) fail();

  const expiresAt = new Date(now + 28 * 86_400_000).toISOString();
  const common = { propertyId: candidate.property_id,
    workspaceId: authority.workspace_id,
    authorityEpoch: authority.authority_epoch,
    fields: ['money'], financeGeneralEntriesOnly: true };
  const definitions = [
    { name: 'os', source: os, grant: { ...common, credentialId: randomUUID(),
      clientId: randomUUID(), subjectId: 'offland-os-general-finance',
      origin: 'os', financeSourceInstanceId: os.source_instance_id,
      actions: ['finance:read', 'finance:record_receipt',
        'finance:record_expense', 'finance:correct', 'finance:plan'] } },
  ];
  if (lineAuthority !== null) definitions.push({ name: 'line', source: line,
    grant: { ...common, credentialId: randomUUID(), clientId: randomUUID(),
      subjectId: 'offland-line-general-finance', origin: 'line',
      financeSourceInstanceId: line.source_instance_id,
      actions: ['finance:read', 'finance:record_receipt', 'finance:record_expense'],
      grantId: randomUUID(), lineGroupId: lineAuthority.group_id,
      lineActorIds: lineAuthority.actor_ids, lineFinanceEnabled: true } });
  const items = definitions.map(({ name, source, grant }) => {
    validateGrant(grant, expiresAt);
    const token = randomBytes(32).toString('base64url');
    return { name, source, grant, token, tokenHash: tokenHash(token), expiresAt,
      environment: { credentialId: grant.credentialId, clientId: grant.clientId,
        propertyId: grant.propertyId, workspaceId: grant.workspaceId, token } };
  });
  const expected = items.map(item => `(${quote(item.tokenHash)},
    ${quote(item.grant.credentialId)}::uuid,
    ${quote(item.grant.propertyId)}::uuid,
    ${quote(item.source.source_instance_id)}::uuid,
    ${quote(item.source.source_system)},
    ${quote(item.source.source_account_ref)},
    ${quote(JSON.stringify(item.grant))}::jsonb,
    ${quote(item.expiresAt)}::timestamptz)`).join(',\n    ');
  const lineCheck = lineAuthority === null ? '' : `
  IF NOT EXISTS (SELECT 1 FROM iron_gate.credentials existing
    WHERE existing.credential_id=${quote(lineAuthority.existing_credential_id)}::uuid
      AND existing.property_id=${quote(lineAuthority.existing_property_id)}::uuid
      AND existing.active AND existing.expires_at>now()
      AND existing.grant_json->>'origin'='line'
      AND existing.grant_json->>'subjectId'='line-staff-manage-all'
      AND existing.grant_json->>'lineManageAllEnabled'='true'
      AND existing.grant_json->>'grantId'=${quote(lineAuthority.existing_grant_id)}
      AND existing.grant_json->>'lineGroupId'=${quote(lineAuthority.group_id)}
      AND existing.grant_json->'lineActorIds'=
        ${quote(JSON.stringify(lineAuthority.actor_ids))}::jsonb)
    THEN RAISE EXCEPTION 'OFFLAND_LINE_GROUP_NOT_VERIFIED'; END IF;`;
  const sql = `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
DO $issue$
DECLARE authority record; source record; actual record; expected record;
BEGIN
  SELECT workspace_id,authority_epoch,state_json->>'readOnly' AS read_only
    INTO STRICT authority FROM iron_gate.property_state
    WHERE property_id=${quote(candidate.property_id)}::uuid FOR SHARE;
  IF authority.workspace_id<>${quote(authority.workspace_id)}::uuid OR
    authority.authority_epoch<>${authority.authority_epoch} OR
    authority.read_only IS DISTINCT FROM 'false'
    THEN RAISE EXCEPTION 'OFFLAND_FINANCE_AUTHORITY_CHANGED'; END IF;
  LOCK TABLE iron_gate.finance_write_scope IN SHARE ROW EXCLUSIVE MODE;
  IF (SELECT count(*) FROM iron_gate.finance_write_scope)<>1 OR
    NOT EXISTS (SELECT 1 FROM iron_gate.finance_write_scope
      WHERE property_id=${quote(candidate.property_id)}::uuid AND
        mode='general_only' AND actor_ref='release:offland-general-finance')
    THEN RAISE EXCEPTION 'OFFLAND_FINANCE_WRITE_SCOPE_MISMATCH'; END IF;${lineCheck}
  FOR expected IN SELECT * FROM (VALUES ${expected}) AS x
    (token_hash,credential_id,property_id,source_instance_id,source_system,
     source_account_ref,grant_json,expires_at)
  LOOP
    SELECT source_system,source_account_ref,enabled,cutover_at INTO STRICT source
      FROM iron_gate.finance_connector
      WHERE property_id=expected.property_id AND
        source_instance_id=expected.source_instance_id FOR SHARE;
    IF source.source_system<>expected.source_system OR
      source.source_account_ref IS DISTINCT FROM expected.source_account_ref OR
      source.enabled IS DISTINCT FROM true OR source.cutover_at IS NULL OR
      source.cutover_at>now() OR
      expected.grant_json->>'financeGeneralEntriesOnly' IS DISTINCT FROM 'true' OR
      expected.grant_json->>'financeSourceInstanceId'<>
        expected.source_instance_id::text
      THEN RAISE EXCEPTION 'OFFLAND_FINANCE_CONNECTOR_MISMATCH'; END IF;
    IF EXISTS (SELECT 1 FROM iron_gate.finance_document d
      WHERE d.property_id=expected.property_id AND
        d.source_instance_id=expected.source_instance_id) AND
      NOT EXISTS (SELECT 1 FROM iron_gate.credentials issued
        WHERE issued.credential_id=expected.credential_id AND
          issued.property_id=expected.property_id AND
          issued.token_hash=expected.token_hash AND
          issued.grant_json=expected.grant_json AND
          issued.expires_at=expected.expires_at AND issued.active)
      THEN RAISE EXCEPTION 'OFFLAND_FINANCE_CONNECTOR_NOT_EMPTY'; END IF;
    IF expected.expires_at<=now() OR
      expected.expires_at>now()+interval '30 days'
      THEN RAISE EXCEPTION 'OFFLAND_FINANCE_CREDENTIAL_EXPIRY_INVALID'; END IF;
    IF EXISTS (SELECT 1 FROM iron_gate.credentials c
      WHERE c.property_id=expected.property_id AND c.active AND
        c.expires_at>now() AND
        c.grant_json->>'subjectId'=expected.grant_json->>'subjectId' AND
        c.credential_id<>expected.credential_id)
      THEN RAISE EXCEPTION 'OFFLAND_FINANCE_CREDENTIAL_ALREADY_ACTIVE'; END IF;
    INSERT INTO iron_gate.credentials
      (token_hash,credential_id,property_id,grant_json,expires_at)
      VALUES (expected.token_hash,expected.credential_id,
        expected.property_id,expected.grant_json,expected.expires_at)
      ON CONFLICT (credential_id) DO NOTHING;
    SELECT * INTO STRICT actual FROM iron_gate.credentials
      WHERE credential_id=expected.credential_id;
    IF actual.token_hash<>expected.token_hash OR
      actual.property_id<>expected.property_id OR
      actual.grant_json<>expected.grant_json OR
      actual.expires_at<>expected.expires_at OR actual.active IS DISTINCT FROM true
      THEN RAISE EXCEPTION 'OFFLAND_FINANCE_CREDENTIAL_READBACK_MISMATCH'; END IF;
  END LOOP;
END $issue$;
COMMIT;
SELECT credential_id,property_id,grant_json,active,expires_at
  FROM iron_gate.credentials WHERE credential_id IN
  (${items.map(item => `${quote(item.grant.credentialId)}::uuid`).join(',')});
`;
  return { projectRef: PROJECT_REF, items, expiresAt, sql };
}

async function privateRoots() {
  const roots = await Promise.all(['/private/tmp', tmpdir()].map(root =>
    realpath(root).catch(() => null)));
  return [...new Set(roots.filter(Boolean))];
}

async function privateJson(path) {
  const resolved = await realpath(path);
  const roots = await privateRoots();
  if (!roots.some(root => resolved.startsWith(`${root}/`))) fail();
  const metadata = await stat(resolved);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) fail();
  return JSON.parse(await readFile(resolved, 'utf8'));
}

export async function prepareOfflandGeneralFinanceGrantFiles(candidatePath,
  authorityPath, outputPath, lineAuthorityPath = null) {
  const output = resolve(outputPath);
  const allowedParents = await privateRoots();
  if (!allowedParents.includes(await realpath(dirname(output)))) fail();
  const candidate = await privateJson(candidatePath);
  const authority = await privateJson(authorityPath);
  const lineAuthority = lineAuthorityPath === null ? null :
    await privateJson(lineAuthorityPath);
  const plan = offlandGeneralFinanceGrantPackage(candidate, authority, lineAuthority);
  await mkdir(output, { mode: 0o700 });
  for (const item of plan.items)
    await writeFile(`${output}/${item.name}.json`,
      JSON.stringify(item.environment), { flag: 'wx', mode: 0o600 });
  await writeFile(`${output}/issue.sql`, plan.sql, { flag: 'wx', mode: 0o600 });
  await writeFile(`${output}/manifest.json`, JSON.stringify({
    projectRef: plan.projectRef, expiresAt: plan.expiresAt,
    grants: plan.items.map(({ name, grant, tokenHash: digest }) =>
      ({ name, grant, tokenHash: digest })) }, null, 2),
  { flag: 'wx', mode: 0o600 });
  return { output, grantCount: plan.items.length, expiresAt: plan.expiresAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5 && process.argv.length !== 6)
    throw Error('USAGE: prepare-offland-general-finance-grants.mjs CANDIDATE_JSON AUTHORITY_JSON NEW_PRIVATE_DIRECTORY [LINE_AUTHORITY_JSON]');
  try {
    process.stdout.write(JSON.stringify(await prepareOfflandGeneralFinanceGrantFiles(
      process.argv[2], process.argv[3], process.argv[4], process.argv[5] ?? null))+'\n');
  } catch {
    process.stderr.write('OFFLAND_FINANCE_GRANT_PREPARATION_FAILED: preserve any existing private package for recovery.\n');
    process.exitCode = 1;
  }
}
