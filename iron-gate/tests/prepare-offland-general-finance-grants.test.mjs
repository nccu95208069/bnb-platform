import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tokenHash } from '../src/credential-grant.mjs';
import { offlandGeneralFinanceGrantPackage,
  prepareOfflandGeneralFinanceGrantFiles } from
  '../scripts/prepare-offland-general-finance-grants.mjs';

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
    enabled:false,cutover_at:null })) });
const authority = () => ({ project_ref:'brcszrkwkgiwatrxevkf',
  property_id:propertyId,workspace_id:workspaceId,authority_epoch:1,read_only:false });
const lineAuthority = () => ({
  existing_credential_id:'66666666-6666-4666-8666-666666666666',
  existing_property_id:'95ae9bd1-5e6d-4386-be5b-6af3c5668a16',
  existing_grant_id:'88888888-8888-4888-8888-888888888888',
  group_id:'verified-group',actor_ids:['approved-actor-a','approved-actor-b'],
});

test('OS and LINE packages bind distinct Offland connectors and store no plaintext token in SQL', () => {
  const plan = offlandGeneralFinanceGrantPackage(candidate(),authority(),lineAuthority());
  assert.equal(plan.items.length,2);
  const os = plan.items.find(item => item.name==='os');
  const line = plan.items.find(item => item.name==='line');
  for (const item of plan.items) {
    assert.equal(item.grant.propertyId,propertyId);
    assert.equal(item.grant.workspaceId,workspaceId);
    assert.equal(item.grant.authorityEpoch,1);
    assert.equal(item.grant.financeGeneralEntriesOnly,true);
    assert.equal(item.environment.token.length,43);
    assert.equal(item.tokenHash,tokenHash(item.token));
    assert.ok(!plan.sql.includes(item.token));
    assert.ok(plan.sql.includes(item.tokenHash));
  }
  assert.equal(os.grant.origin,'os');
  assert.equal(os.grant.financeSourceInstanceId,sourceIds.os_manual);
  assert.equal(os.grant.actions.includes('finance:import'),false);
  assert.equal(os.grant.actions.includes('finance:link'),false);
  assert.equal(line.grant.origin,'line');
  assert.equal(line.grant.financeSourceInstanceId,sourceIds.line_finance);
  assert.equal(line.grant.lineGroupId,'verified-group');
  assert.deepEqual(line.grant.lineActorIds,['approved-actor-a','approved-actor-b']);
  assert.equal(line.grant.lineFinanceEnabled,true);
  assert.notEqual(os.grant.credentialId,line.grant.credentialId);
  assert.match(plan.sql,/source\.enabled IS DISTINCT FROM true/);
  assert.match(plan.sql,/source\.cutover_at IS NULL/);
  assert.match(plan.sql,/OFFLAND_FINANCE_AUTHORITY_CHANGED/);
  assert.match(plan.sql,/OFFLAND_FINANCE_CREDENTIAL_ALREADY_ACTIVE/);
  assert.match(plan.sql,/OFFLAND_LINE_GROUP_NOT_VERIFIED/);
  assert.match(plan.sql,/line-staff-manage-all/);
  assert.match(plan.sql,/actual\.grant_json<>expected\.grant_json/);
});

test('OS package can be prepared alone while LINE group authority is unavailable', () => {
  const plan = offlandGeneralFinanceGrantPackage(candidate(),authority());
  assert.deepEqual(plan.items.map(item => item.name),['os']);
  assert.ok(!plan.sql.includes('OFFLAND_LINE_GROUP_NOT_VERIFIED'));
});

test('rejects wrong property, stale authority, reused connector, and unverified LINE group', () => {
  assert.throws(() => offlandGeneralFinanceGrantPackage(
    {...candidate(),property_key:'sweetfun'},authority()),
  /OFFLAND_FINANCE_GRANT_INPUT_INVALID/);
  assert.throws(() => offlandGeneralFinanceGrantPackage(candidate(),
    {...authority(),authority_epoch:0}),/OFFLAND_FINANCE_GRANT_INPUT_INVALID/);
  assert.throws(() => offlandGeneralFinanceGrantPackage(candidate(),
    {...authority(),read_only:true}),/OFFLAND_FINANCE_GRANT_INPUT_INVALID/);
  const duplicate = candidate();
  duplicate.connectors[1].source_instance_id=sourceIds.os_manual;
  assert.throws(() => offlandGeneralFinanceGrantPackage(duplicate,authority()),
    /OFFLAND_FINANCE_GRANT_INPUT_INVALID/);
  const enabled = candidate();
  enabled.connectors[0].enabled=true;
  assert.throws(() => offlandGeneralFinanceGrantPackage(enabled,authority()),
    /OFFLAND_FINANCE_GRANT_INPUT_INVALID/);
  assert.throws(() => offlandGeneralFinanceGrantPackage(candidate(),authority(),
    {...lineAuthority(),actor_ids:[]}),/OFFLAND_FINANCE_GRANT_INPUT_INVALID/);
  assert.throws(() => offlandGeneralFinanceGrantPackage(candidate(),authority(),
    {...lineAuthority(),existing_property_id:propertyId}),
  /OFFLAND_FINANCE_GRANT_INPUT_INVALID/);
});

test('private package uses exclusive 0600 files and never overwrites an uncertain issuance', async () => {
  const inputDir=await mkdtemp('/private/tmp/offland-grant-input-');
  const outputDir=`/private/tmp/offland-grant-output-${randomUUID()}`;
  try {
    const candidatePath=`${inputDir}/candidate.json`;
    const authorityPath=`${inputDir}/authority.json`;
    await writeFile(candidatePath,JSON.stringify(candidate()),{mode:0o600});
    await writeFile(authorityPath,JSON.stringify(authority()),{mode:0o600});
    const result=await prepareOfflandGeneralFinanceGrantFiles(
      candidatePath,authorityPath,outputDir);
    assert.equal(result.grantCount,1);
    assert.equal((await stat(outputDir)).mode & 0o077,0);
    for (const file of ['os.json','issue.sql','manifest.json'])
      assert.equal((await stat(`${outputDir}/${file}`)).mode & 0o077,0);
    const grant=JSON.parse(await readFile(`${outputDir}/os.json`,'utf8'));
    const sql=await readFile(`${outputDir}/issue.sql`,'utf8');
    const manifest=await readFile(`${outputDir}/manifest.json`,'utf8');
    assert.ok(!sql.includes(grant.token));
    assert.ok(!manifest.includes(grant.token));
    await assert.rejects(prepareOfflandGeneralFinanceGrantFiles(
      candidatePath,authorityPath,outputDir));
  } finally {
    await rm(inputDir,{recursive:true,force:true});
    await rm(outputDir,{recursive:true,force:true});
  }
});
