#!/usr/bin/env node
// Prepare a private, one-time connector configuration transaction. This file
// never connects to PostgreSQL; an operator applies the reviewed SQL at cutover.
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT_REF = 'brcszrkwkgiwatrxevkf';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SYSTEMS = ['os_manual', 'line_finance', 'os_legacy_payment'];
const FINANCE_TABLES = [
  'finance_account','finance_allocation','finance_category','finance_change',
  'finance_change_event','finance_connector','finance_connector_config_history',
  'finance_document','finance_event','finance_evidence_assertion',
  'finance_expense_attribution','finance_import_catalog','finance_import_issue',
  'finance_legacy_settlement','finance_operational_status','finance_outbox',
  'finance_payment_ownership','finance_payout_rule','finance_recurring_rule',
  'finance_request_receipt','finance_revision','finance_settlement',
  'finance_settlement_link','finance_source_alias','finance_source_link',
  'finance_write_scope',
];
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const fail = () => { throw Error('OFFLAND_FINANCE_CONNECTOR_INPUT_INVALID'); };

function checkedConnector(candidate, system) {
  const rows = candidate.connectors.filter(row => row?.source_system === system);
  if (rows.length !== 1 || !UUID.test(rows[0].source_instance_id ?? '') ||
    rows[0].enabled !== false || rows[0].cutover_at !== null ||
    rows[0].source_watermark !== null ||
    typeof rows[0].source_account_ref !== 'string' ||
    !rows[0].source_account_ref || rows[0].source_account_ref.length > 128 ||
    /[\x00-\x1f\x7f]/.test(rows[0].source_account_ref)) fail();
  return rows[0];
}

export function offlandGeneralFinanceConnectorPlan(candidate, authority, cutoverAt) {
  if (candidate?.schema !== 1 || candidate.property_key !== 'offland' ||
    candidate.status !== 'candidate_only_no_production_change' ||
    !UUID.test(candidate.property_id ?? '') ||
    !Array.isArray(candidate.connectors) || candidate.connectors.length !== 3 ||
    authority?.project_ref !== PROJECT_REF ||
    authority.property_id !== candidate.property_id ||
    !UUID.test(authority.workspace_id ?? '') ||
    authority.authority_epoch !== 1 || authority.read_only !== false ||
    typeof cutoverAt !== 'string' || !UTC.test(cutoverAt) ||
    !Number.isFinite(Date.parse(cutoverAt)) ||
    new Date(cutoverAt).toISOString().slice(0,19) !== cutoverAt.slice(0,19) ||
    new Date(cutoverAt).getUTCFullYear() < 2026) fail();
  const bySystem = Object.fromEntries(SYSTEMS.map(system =>
    [system, checkedConnector(candidate, system)]));
  if (new Set(candidate.connectors.map(row => row.source_instance_id)).size !== 3 ||
    new Set(candidate.connectors.map(row => row.source_account_ref)).size !== 3) fail();
  const cutover = new Date(cutoverAt).toISOString();
  const active = [bySystem.os_manual, bySystem.line_finance];
  const sourceIds = active.map(row => `${quote(row.source_instance_id)}::uuid`).join(', ');
  const expected = active.map(row => `(${quote(row.source_instance_id)}::uuid,
    ${quote(row.source_system)}, ${quote(row.source_account_ref)})`).join(',\n    ');
  const propertyId = quote(candidate.property_id);
  const sql = `-- Offland new general entries only. Run once after migrations 005-018,
-- with old OS/LINE Offland writers paused and uncertain requests drained.
-- No historical cash, booking receipt or Sweetfun connector is inserted here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL iron_gate.actor_ref = 'release:offland-general-finance';
DO $provision$
DECLARE
  authority record;
  expected record;
  actual record;
  history jsonb;
  finance_table_name text;
  occupied boolean;
BEGIN
  SELECT workspace_id,authority_epoch,state_json->>'readOnly' AS read_only
    INTO STRICT authority FROM iron_gate.property_state
    WHERE property_id=${propertyId}::uuid FOR SHARE;
  IF authority.workspace_id<>${quote(authority.workspace_id)}::uuid OR
    authority.authority_epoch<>${authority.authority_epoch} OR
    authority.read_only IS DISTINCT FROM 'false'
    THEN RAISE EXCEPTION 'OFFLAND_FINANCE_AUTHORITY_CHANGED'; END IF;
  IF ${quote(cutover)}::timestamptz < now()-interval '1 hour' OR
    ${quote(cutover)}::timestamptz > now()+interval '1 day'
    THEN RAISE EXCEPTION 'OFFLAND_FINANCE_CUTOVER_STALE'; END IF;
  -- Refuse a partial or future schema. Lock every finance table before checking
  -- emptiness so an unrelated writer cannot add a row between check and insert.
  IF (SELECT array_agg(tablename::text ORDER BY tablename::text)
      FROM pg_tables WHERE schemaname='iron_gate'
        AND left(tablename::text,8)='finance_') IS DISTINCT FROM
      ARRAY[${FINANCE_TABLES.map(quote).join(',')} ]::text[]
    THEN RAISE EXCEPTION 'OFFLAND_FINANCE_SCHEMA_NOT_READY'; END IF;
  LOCK TABLE iron_gate.credentials IN SHARE ROW EXCLUSIVE MODE;
  FOR finance_table_name IN SELECT tablename FROM pg_tables
    WHERE schemaname='iron_gate' AND left(tablename::text,8)='finance_'
    ORDER BY tablename LOOP
    EXECUTE format('LOCK TABLE iron_gate.%I IN SHARE ROW EXCLUSIVE MODE',finance_table_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM iron_gate.credentials c
    WHERE c.property_id=${propertyId}::uuid AND
      (c.grant_json ? 'financeSourceInstanceId' OR
       EXISTS (SELECT 1 FROM jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(c.grant_json->'actions')='array'
           THEN c.grant_json->'actions' ELSE '[]'::jsonb END) a(value)
         WHERE a.value LIKE 'finance:%')))
    THEN RAISE EXCEPTION 'OFFLAND_FINANCE_CREDENTIAL_ALREADY_PRESENT'; END IF;
  FOR finance_table_name IN SELECT tablename FROM pg_tables
    WHERE schemaname='iron_gate' AND left(tablename::text,8)='finance_'
      AND tablename NOT IN ('finance_connector','finance_connector_config_history',
        'finance_write_scope')
    ORDER BY tablename LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='iron_gate' AND table_name=finance_table_name
        AND column_name='property_id')
      THEN RAISE EXCEPTION 'OFFLAND_FINANCE_SCHEMA_NOT_READY'; END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM iron_gate.%I WHERE property_id=$1)',
      finance_table_name) INTO occupied USING ${propertyId}::uuid;
    IF occupied THEN RAISE EXCEPTION 'OFFLAND_FINANCE_STATE_NOT_EMPTY: %',finance_table_name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM iron_gate.finance_connector
    WHERE property_id=${propertyId}::uuid AND source_instance_id NOT IN (${sourceIds}))
    THEN RAISE EXCEPTION 'OFFLAND_FINANCE_CONNECTOR_CONFLICT'; END IF;
  IF EXISTS (SELECT 1 FROM iron_gate.finance_connector
    WHERE source_instance_id IN (${sourceIds}) AND property_id<>${propertyId}::uuid)
    THEN RAISE EXCEPTION 'OFFLAND_FINANCE_CONNECTOR_CONFLICT'; END IF;
  IF EXISTS (SELECT 1 FROM iron_gate.finance_write_scope
    WHERE property_id<>${propertyId}::uuid OR mode<>'general_only' OR
      actor_ref<>'release:offland-general-finance')
    THEN RAISE EXCEPTION 'OFFLAND_FINANCE_WRITE_SCOPE_CONFLICT'; END IF;
  INSERT INTO iron_gate.finance_write_scope(property_id,mode)
    VALUES (${propertyId}::uuid,'general_only')
    ON CONFLICT (property_id) DO NOTHING;
  IF (SELECT count(*) FROM iron_gate.finance_write_scope)<>1 OR
    NOT EXISTS (SELECT 1 FROM iron_gate.finance_write_scope
      WHERE property_id=${propertyId}::uuid AND mode='general_only' AND
        actor_ref='release:offland-general-finance')
    THEN RAISE EXCEPTION 'OFFLAND_FINANCE_WRITE_SCOPE_MISMATCH'; END IF;
  FOR expected IN SELECT * FROM (VALUES ${expected}) AS x
    (source_instance_id,source_system,source_account_ref) LOOP
    INSERT INTO iron_gate.finance_connector
      (source_instance_id,property_id,source_system,source_account_ref,
       enabled,cutover_at,watermark,confirm_policy)
    VALUES (expected.source_instance_id,${propertyId}::uuid,
      expected.source_system,expected.source_account_ref,true,
      ${quote(cutover)}::timestamptz,NULL,'manual')
    ON CONFLICT (source_instance_id) DO NOTHING;
    SELECT * INTO STRICT actual FROM iron_gate.finance_connector
      WHERE source_instance_id=expected.source_instance_id;
    IF actual.property_id<>${propertyId}::uuid OR
      actual.source_system<>expected.source_system OR
      actual.source_account_ref IS DISTINCT FROM expected.source_account_ref OR
      actual.enabled IS DISTINCT FROM true OR
      actual.cutover_at IS DISTINCT FROM ${quote(cutover)}::timestamptz OR
      actual.watermark IS NOT NULL OR actual.confirm_policy<>'manual' OR
      actual.version<>1 OR actual.adapter_key IS NOT NULL OR
      actual.source_sheet_ref IS NOT NULL OR actual.credential_ref IS NOT NULL
      THEN RAISE EXCEPTION 'OFFLAND_FINANCE_CONNECTOR_READBACK_MISMATCH'; END IF;
    SELECT h.config_json INTO STRICT history
      FROM iron_gate.finance_connector_config_history h
      WHERE h.property_id=${propertyId}::uuid AND
        h.source_instance_id=expected.source_instance_id AND h.version=1;
    IF history->>'source_system'<>expected.source_system OR
      history->>'source_account_ref'<>expected.source_account_ref OR
      history->>'enabled'<>'true' OR
      (history->>'cutover_at')::timestamptz<>
        ${quote(cutover)}::timestamptz
      THEN RAISE EXCEPTION 'OFFLAND_FINANCE_CONNECTOR_AUDIT_MISMATCH'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM iron_gate.finance_connector
    WHERE property_id=${propertyId}::uuid)<>2 OR
    (SELECT count(*) FROM iron_gate.finance_connector_config_history
     WHERE property_id=${propertyId}::uuid)<>2
    THEN RAISE EXCEPTION 'OFFLAND_FINANCE_CONNECTOR_READBACK_MISMATCH'; END IF;
END $provision$;
COMMIT;
SELECT source_instance_id,property_id,source_system,source_account_ref,
  enabled,cutover_at,version FROM iron_gate.finance_connector
  WHERE property_id=${propertyId}::uuid ORDER BY source_system;
SELECT source_instance_id,version,actor_ref,config_json
  FROM iron_gate.finance_connector_config_history
  WHERE property_id=${propertyId}::uuid ORDER BY source_instance_id,version;
SELECT property_id,mode,actor_ref FROM iron_gate.finance_write_scope;
`;
  return { projectRef: PROJECT_REF, propertyId: candidate.property_id,
    cutoverAt: cutover, connectorCount: 2, sql,
    sqlSha256: createHash('sha256').update(sql).digest('hex') };
}

async function privateJson(path) {
  const resolved = await realpath(path);
  const roots = await privateRoots();
  if (!roots.some(root => resolved.startsWith(`${root}/`))) fail();
  const metadata = await stat(resolved);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) fail();
  return JSON.parse(await readFile(resolved, 'utf8'));
}

async function privateRoots() {
  const roots = await Promise.all(['/private/tmp',tmpdir()].map(root =>
    realpath(root).catch(() => null)));
  return [...new Set(roots.filter(Boolean))];
}

export async function prepareOfflandGeneralFinanceConnectorFiles(candidatePath,
  authorityPath, cutoverAt, outputPath) {
  const output = resolve(outputPath);
  const allowedParents = await privateRoots();
  if (!allowedParents.includes(await realpath(dirname(output)))) fail();
  const candidate = await privateJson(candidatePath);
  const authority = await privateJson(authorityPath);
  const plan = offlandGeneralFinanceConnectorPlan(candidate, authority, cutoverAt);
  await mkdir(output, { mode: 0o700 });
  await writeFile(`${output}/provision.sql`, plan.sql, { flag: 'wx', mode: 0o600 });
  await writeFile(`${output}/manifest.json`, JSON.stringify({
    projectRef: plan.projectRef, propertyId: plan.propertyId,
    cutoverAt: plan.cutoverAt, connectorCount: plan.connectorCount,
    writeScopeMode: 'general_only',
    writeScopeActorRef: 'release:offland-general-finance',
    sqlSha256: plan.sqlSha256 }, null, 2), { flag: 'wx', mode: 0o600 });
  return { output, connectorCount: plan.connectorCount,
    cutoverAt: plan.cutoverAt, sqlSha256: plan.sqlSha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 6)
    throw Error('USAGE: prepare-offland-general-finance-connectors.mjs CANDIDATE_JSON AUTHORITY_JSON CUTOVER_UTC NEW_PRIVATE_DIRECTORY');
  try {
    process.stdout.write(JSON.stringify(await prepareOfflandGeneralFinanceConnectorFiles(
      process.argv[2],process.argv[3],process.argv[4],process.argv[5]))+'\n');
  } catch {
    process.stderr.write('OFFLAND_FINANCE_CONNECTOR_PREPARATION_FAILED: preserve any existing private package for recovery.\n');
    process.exitCode=1;
  }
}
