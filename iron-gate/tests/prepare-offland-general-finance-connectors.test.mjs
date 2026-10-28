import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  offlandGeneralFinanceConnectorPlan,
  prepareOfflandGeneralFinanceConnectorFiles,
} from '../scripts/prepare-offland-general-finance-connectors.mjs';

const propertyId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const sourceIds = {
  os_manual: '33333333-3333-4333-8333-333333333333',
  line_finance: '44444444-4444-4444-8444-444444444444',
  os_legacy_payment: '55555555-5555-4555-8555-555555555555',
};
const candidate = () => ({ schema:1, property_key:'offland', property_id:propertyId,
  status:'candidate_only_no_production_change',
  connectors:Object.entries(sourceIds).map(([source_system,source_instance_id]) => ({
    source_system,source_instance_id,source_account_ref:`scope:${source_system}`,
    enabled:false,cutover_at:null,source_watermark:null })) });
const authority = () => ({ project_ref:'brcszrkwkgiwatrxevkf',
  property_id:propertyId,workspace_id:workspaceId,authority_epoch:1,
  read_only:false });
const cutover = '2026-10-29T01:30:00Z';

test('SQL provisions only two general sources at one UTC cutover and rechecks empty state', () => {
  const plan=offlandGeneralFinanceConnectorPlan(candidate(),authority(),cutover);
  assert.equal(plan.projectRef,'brcszrkwkgiwatrxevkf');
  assert.equal(plan.connectorCount,2);
  assert.equal(plan.cutoverAt,'2026-10-29T01:30:00.000Z');
  assert.match(plan.sql,/BEGIN;[\s\S]*COMMIT;/);
  assert.match(plan.sql,/OFFLAND_FINANCE_AUTHORITY_CHANGED/);
  assert.match(plan.sql,/OFFLAND_FINANCE_CUTOVER_STALE/);
  assert.match(plan.sql,/OFFLAND_FINANCE_SCHEMA_NOT_READY/);
  assert.match(plan.sql,/OFFLAND_FINANCE_STATE_NOT_EMPTY/);
  assert.match(plan.sql,/OFFLAND_FINANCE_CREDENTIAL_ALREADY_PRESENT/);
  assert.match(plan.sql,/OFFLAND_FINANCE_CONNECTOR_CONFLICT/);
  assert.match(plan.sql,/OFFLAND_FINANCE_CONNECTOR_AUDIT_MISMATCH/);
  assert.match(plan.sql,/LOCK TABLE iron_gate\.credentials/);
  assert.match(plan.sql,/LOCK TABLE iron_gate\.%I IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(plan.sql,/finance_connector_config_history/);
  assert.match(plan.sql,/source_instance_id NOT IN/);
  assert.match(plan.sql,/WHERE property_id=/);
  assert.ok(plan.sql.includes(sourceIds.os_manual));
  assert.ok(plan.sql.includes(sourceIds.line_finance));
  assert.ok(!plan.sql.includes(sourceIds.os_legacy_payment));
  assert.equal((plan.sql.match(/ON CONFLICT \(source_instance_id\) DO NOTHING/g)??[]).length,1);
});

test('input validation rejects wrong authority, reused source, disabled cutover policy and invalid time', () => {
  assert.throws(() => offlandGeneralFinanceConnectorPlan(candidate(),
    {...authority(),read_only:true},cutover),/OFFLAND_FINANCE_CONNECTOR_INPUT_INVALID/);
  assert.throws(() => offlandGeneralFinanceConnectorPlan(candidate(),
    {...authority(),project_ref:'other-project'},cutover),
  /OFFLAND_FINANCE_CONNECTOR_INPUT_INVALID/);
  const reused=candidate();
  reused.connectors[1].source_instance_id=sourceIds.os_manual;
  assert.throws(() => offlandGeneralFinanceConnectorPlan(reused,authority(),cutover),
  /OFFLAND_FINANCE_CONNECTOR_INPUT_INVALID/);
  const preenabled=candidate();
  preenabled.connectors[0].enabled=true;
  assert.throws(() => offlandGeneralFinanceConnectorPlan(preenabled,authority(),cutover),
  /OFFLAND_FINANCE_CONNECTOR_INPUT_INVALID/);
  const oldWatermark=candidate();
  oldWatermark.connectors[2].source_watermark='prior-history';
  assert.throws(() => offlandGeneralFinanceConnectorPlan(oldWatermark,authority(),cutover),
  /OFFLAND_FINANCE_CONNECTOR_INPUT_INVALID/);
  for (const value of ['2026-10-29T09:30:00+08:00','2026-02-31T01:30:00Z',
    '2026-10-29T01:30:00Z; DROP TABLE x'])
    assert.throws(() => offlandGeneralFinanceConnectorPlan(candidate(),authority(),value),
    /OFFLAND_FINANCE_CONNECTOR_INPUT_INVALID/);
});

test('source reference is SQL quoted without changing the connector identity', () => {
  const input=candidate();
  input.connectors[0].source_account_ref="owner's os scope";
  const plan=offlandGeneralFinanceConnectorPlan(input,authority(),cutover);
  assert.match(plan.sql,/owner''s os scope/);
  assert.ok(!plan.sql.includes("owner's os scope"));
});

test('private package uses exclusive 0600 files and refuses uncertain overwrite', async () => {
  const inputDir=await mkdtemp(join(tmpdir(),'offland-connector-input-'));
  const outputDir=join(tmpdir(),`offland-connector-plan-${randomUUID()}`);
  try {
    const candidatePath=`${inputDir}/candidate.json`;
    const authorityPath=`${inputDir}/authority.json`;
    await writeFile(candidatePath,JSON.stringify(candidate()),{mode:0o600});
    await writeFile(authorityPath,JSON.stringify(authority()),{mode:0o600});
    const result=await prepareOfflandGeneralFinanceConnectorFiles(
      candidatePath,authorityPath,cutover,outputDir);
    assert.equal(result.connectorCount,2);
    const planSql=await readFile(`${outputDir}/provision.sql`,'utf8');
    const manifest=JSON.parse(await readFile(`${outputDir}/manifest.json`,'utf8'));
    assert.equal(manifest.sqlSha256,result.sqlSha256);
    assert.equal(manifest.cutoverAt,result.cutoverAt);
    assert.equal((await stat(outputDir)).mode & 0o077,0);
    for (const name of ['provision.sql','manifest.json'])
      assert.equal((await stat(`${outputDir}/${name}`)).mode & 0o077,0);
    assert.ok(planSql.includes(sourceIds.os_manual));
    await assert.rejects(prepareOfflandGeneralFinanceConnectorFiles(
      candidatePath,authorityPath,cutover,outputDir));
  } finally {
    await rm(inputDir,{recursive:true,force:true});
    await rm(outputDir,{recursive:true,force:true});
  }
});
