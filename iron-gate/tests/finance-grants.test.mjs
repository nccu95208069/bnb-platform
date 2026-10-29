import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGrantShape } from '../src/credential-grant.mjs';
import { createGrantAuthenticator } from '../src/authenticator.mjs';

const id = n => `30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const base = { credentialId:id(1),workspaceId:id(2),propertyId:id(3),
  authorityEpoch:1,clientId:'synthetic-client',subjectId:'synthetic-operator',
  actions:['finance:read','finance:record_receipt'],fields:['money'],
  financeSourceInstanceId:id(4) };

test('finance write grants bind one connector and require the original operator proof', () => {
  assert.doesNotThrow(() => validateGrantShape({ ...base, origin:'os' }));
  assert.throws(() => validateGrantShape({ ...base, origin:'os',
    financeSourceInstanceId:undefined }), /INVALID_FINANCE_CONNECTOR_SCOPE/);
  const line = { ...base, origin:'line',grantId:id(5),lineGroupId:'synthetic-group',
    lineActorIds:['synthetic-actor'],lineFinanceEnabled:true };
  assert.doesNotThrow(() => validateGrantShape(line));
  assert.throws(() => validateGrantShape({ ...line,lineFinanceEnabled:false }),
    /INVALID_LINE_SCOPE/);
  assert.throws(() => validateGrantShape({ ...base,origin:'finance',
    actions:['card:sync','finance:record_receipt'] }), /INVALID_CARD_SCOPE/);
  assert.throws(() => validateGrantShape({ ...base,origin:'guest' }),
    /INVALID_GUEST_SCOPE/);
});

test('general finance marker survives operator proof intersection and rejects broader grants', async () => {
  const marked = { ...base, origin:'os', financeGeneralEntriesOnly:true,
    actions:['finance:read','finance:record_receipt','finance:record_expense',
      'finance:correct','finance:plan'] };
  assert.doesNotThrow(() => validateGrantShape(marked));
  assert.throws(() => validateGrantShape({ ...marked, financeGeneralEntriesOnly:false }),
    /INVALID_GENERAL_FINANCE_SCOPE/);
  assert.throws(() => validateGrantShape({ ...marked, financeGeneralEntriesOnly:'true' }),
    /INVALID_GENERAL_FINANCE_SCOPE/);
  assert.throws(() => validateGrantShape({ ...marked, actions:[...marked.actions,'finance:refund'] }),
    /INVALID_GENERAL_FINANCE_SCOPE/);
  assert.throws(() => validateGrantShape({ ...marked, actions:[...marked.actions,'booking:read'] }),
    /INVALID_GENERAL_FINANCE_SCOPE/);
  const token = 'a'.repeat(43);
  const request = new Request('https://iron.invalid/v1/finance',
    { headers:{authorization:`Bearer ${token}`} });
  const directory = { lookup:async supplied => supplied === token ? marked : null };
  const repository = { read:async () => ({workspaceId:marked.workspaceId,
    authorityEpoch:marked.authorityEpoch}) };
  const os = createGrantAuthenticator(directory,repository,async () => ({
    workspaceId:marked.workspaceId,subjectId:'verified-os-member',
    propertyIds:[marked.propertyId],actions:marked.actions,fields:marked.fields,
    financeGeneralEntriesOnly:false }));
  const principal = await os(request);
  assert.equal(principal.financeGeneralEntriesOnly,true);
  assert.equal(principal.subjectId,'verified-os-member');
  const lineGrant = { ...marked, origin:'line',grantId:id(5),
    lineGroupId:'synthetic-group',lineActorIds:['synthetic-actor'],
    lineFinanceEnabled:true };
  const line = createGrantAuthenticator({lookup:async () => lineGrant},repository,null,
    async () => ({workspaceId:lineGrant.workspaceId,groupId:lineGrant.lineGroupId,
      subjectId:'verified-line-actor',propertyIds:[lineGrant.propertyId],
      actions:lineGrant.actions,fields:lineGrant.fields,
      financeGeneralEntriesOnly:false}));
  assert.equal((await line(request)).financeGeneralEntriesOnly,true);
});
