import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { financeGrantPackage, cardSyncGrantPackage, prepareFinanceGrantFiles } from '../scripts/prepare-sweetfun-finance-grants.mjs';
const nativeSourceId='10000000-0000-4000-8000-000000000001';
const cardSourceId='10000000-0000-4000-8000-000000000002';

test('card issuance has only one scoped money grant and never includes plaintext in SQL',()=>{
  const plan=cardSyncGrantPackage(cardSourceId);
  assert.equal(plan.items.length,1);
  const item=plan.items[0];
  assert.equal(item.grant.origin,'finance');
  assert.deepEqual(item.grant.actions,['card:sync']);
  assert.deepEqual(item.grant.fields,['money']);
  assert.equal(item.grant.financeSourceInstanceId,cardSourceId);
  assert.match(plan.sql,/sweetfun_card/);
  assert.equal(plan.sql.includes(item.environment.token),false);
  assert.equal(plan.sql.includes(item.tokenHash),true);
});

test('issuance SQL contains only hashes and two distinct current-property OS money scopes', () => {
  const start = Date.now(), plan = financeGrantPackage(nativeSourceId,start);
  assert.equal(Date.parse(plan.expiresAt) - start, 28 * 86_400_000);
  assert.deepEqual(plan.items.map(item => item.grant.actions), [['finance:ledger'], ['booking:read', 'payment:write']]);
  assert.equal(new Set(plan.items.map(item => item.grant.credentialId)).size, 2);
  assert.equal(new Set(plan.items.map(item => item.grant.clientId)).size, 2);
  for (const item of plan.items) {
    assert.equal(item.grant.origin, 'os'); assert.equal(item.grant.authorityEpoch, 1);
    assert.deepEqual(item.grant.fields, ['money']);
    assert.equal(item.grant.propertyId, '95ae9bd1-5e6d-4386-be5b-6af3c5668a16');
    assert.equal(item.grant.financeSourceInstanceId,nativeSourceId);
    assert.equal(plan.sql.includes(item.environment.token), false);
    assert.equal(plan.sql.includes(item.tokenHash), true);
  }
  assert.match(plan.sql, /FOR SHARE/); assert.match(plan.sql, /ON CONFLICT \(credential_id\) DO NOTHING/);
  assert.match(plan.sql, /FINANCE_CREDENTIAL_ALREADY_ACTIVE/);
  assert.match(plan.sql, /FINANCE_CREDENTIAL_READBACK_MISMATCH/);
  assert.match(plan.sql, /FINANCE_CONNECTOR_SCOPE_MISMATCH/);
  assert.doesNotMatch(plan.sql, /UPDATE iron_gate\.(property_state|credentials)|DELETE|TRUNCATE/);
});

test('grant preparation requires the registered source connector ID',()=>{
  assert.throws(()=>financeGrantPackage(),/FINANCE_CONNECTOR_ID_REQUIRED/);
  assert.throws(()=>cardSyncGrantPackage('other'),/FINANCE_CONNECTOR_ID_REQUIRED/);
});

test('private credential package refuses overwrite and never emits a token in its summary', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'finance-grants-test-'));
  try {
    const dir = join(parent, 'new'); const summary = await prepareFinanceGrantFiles(dir,nativeSourceId);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    for (const name of ['finance', 'payment']) {
      const path = join(dir, `${name}.json`);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const grant = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(JSON.stringify(summary).includes(grant.token), false);
      assert.equal('financeSourceInstanceId' in grant,false);
      assert.equal((await readFile(join(dir, 'manifest.json'), 'utf8')).includes(grant.token), false);
    }
    await assert.rejects(prepareFinanceGrantFiles(dir,nativeSourceId));
  } finally { await rm(parent, { recursive: true, force: true }); }
});
