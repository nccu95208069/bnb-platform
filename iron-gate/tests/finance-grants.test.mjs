import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGrantShape } from '../src/credential-grant.mjs';

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
