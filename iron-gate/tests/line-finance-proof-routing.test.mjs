import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeLineProof } from '../src/line-proof-routing.mjs';
import { signLineOperatorProof } from '../src/line-operator-proof.mjs';
import { validateGrantShape } from '../src/credential-grant.mjs';
import { key } from './retained-fixture.mjs';

const sharedSecret = 's'.repeat(43), osSecret = 'o'.repeat(43);
const financeSecret = 'f'.repeat(43), bookingSecret = 'b'.repeat(43);
const finance = { credentialId: key(), grantId: key(), propertyId: key(), workspaceId: key(),
  clientId: 'synthetic-finance', subjectId: 'synthetic-finance', origin: 'line', authorityEpoch: 1,
  lineGroupId: 'synthetic-finance-group', lineActorIds: ['synthetic-finance-actor'],
  lineFinanceEnabled: true, financeGeneralEntriesOnly: true, financeSourceInstanceId: key(),
  actions: ['finance:read', 'finance:record_receipt', 'finance:record_expense', 'finance:correct'],
  fields: ['money'] };
const booking = { ...finance, credentialId: key(), grantId: key(),
  lineFinanceEnabled: undefined, financeGeneralEntriesOnly: undefined,
  financeSourceInstanceId: undefined, lineProviderFreeEnabled: true,
  lineCreateEnabled: true, lineManageAllEnabled: true,
  actions: ['booking:read', 'booking:create', 'booking:amend', 'booking:cancel', 'booking:manage_all'],
  fields: ['guest_name', 'contact', 'notes', 'money'] };
const env = { IRON_GATE_LINE_PROOF_SECRET: sharedSecret, IRON_GATE_OS_PROOF_SECRET: osSecret,
  IRON_GATE_OFFLAND_LINE_FINANCE_PROOF_SECRET: financeSecret,
  IRON_GATE_OFFLAND_LINE_FINANCE_CREDENTIAL_ID: finance.credentialId,
  IRON_GATE_OFFLAND_LINE_FINANCE_GRANT_ID: finance.grantId,
  IRON_GATE_OFFLAND_LINE_FINANCE_PROPERTY_ID: finance.propertyId,
  IRON_GATE_OFFLAND_LINE_BOOKING_PROOF_SECRET: bookingSecret,
  IRON_GATE_OFFLAND_LINE_BOOKING_CREDENTIAL_ID: booking.credentialId,
  IRON_GATE_OFFLAND_LINE_BOOKING_GRANT_ID: booking.grantId,
  IRON_GATE_OFFLAND_LINE_BOOKING_PROPERTY_ID: booking.propertyId };
const request = async (secret, grant = finance, path = 'finance/ledger?limit=10') => {
  const unsigned = new Request(`https://iron.invalid/v1/properties/${grant.propertyId}/${path}`);
  const proof = await signLineOperatorProof(secret, unsigned, grant,
    { active: true, groupId: grant.lineGroupId, actorId: grant.lineActorIds[0] });
  return new Request(unsigned, { headers: { 'x-iron-gate-line-proof': proof } });
};

test('independent finance proof authenticates the exact current general-only grant and preserves preview key', async () => {
  validateGrantShape(finance);
  const runtime = createRuntimeLineProof(env);
  const principal = await runtime.verifyLineOperator(await request(financeSecret), finance);
  assert.ok(principal);
  assert.deepEqual(principal.actions, finance.actions);
  assert.deepEqual(principal.fields, ['money']);
  assert.equal(runtime.linePreviewSecret, sharedSecret);
  const withoutBooking = Object.fromEntries(Object.entries(env).filter(([key]) => !key.includes('BOOKING')));
  assert.ok(await createRuntimeLineProof(withoutBooking).verifyLineOperator(await request(financeSecret), finance));
});

test('finance proofs never accept shared, OS or booking signatures and preserve exact request binding', async () => {
  const runtime = createRuntimeLineProof(env);
  for (const secret of [sharedSecret, osSecret, bookingSecret])
    assert.equal(await runtime.verifyLineOperator(await request(secret), finance), null);
  const signed = await request(financeSecret);
  const changed = new Request(signed.url.replace('limit=10', 'limit=11'), { headers: signed.headers });
  assert.equal(await runtime.verifyLineOperator(changed, finance), null);
});

for (const field of ['credentialId', 'grantId', 'propertyId'])
  test(`finance route refuses a changed ${field} with dedicated or shared key`, async () => {
    const runtime = createRuntimeLineProof(env), wrong = { ...finance, [field]: key() };
    for (const secret of [financeSecret, sharedSecret])
      assert.equal(await runtime.verifyLineOperator(await request(secret, wrong), wrong), null);
  });

test('finance stored markers fail closed even without a configured tuple', async () => {
  const absent = createRuntimeLineProof({ IRON_GATE_LINE_PROOF_SECRET: sharedSecret });
  assert.equal(await absent.verifyLineOperator(await request(sharedSecret), finance), null);
  const missingFinanceMarker = { ...finance }; delete missingFinanceMarker.lineFinanceEnabled;
  assert.equal(await absent.verifyLineOperator(await request(sharedSecret, missingFinanceMarker), missingFinanceMarker), null);
  const runtime = createRuntimeLineProof(env);
  for (const field of ['lineFinanceEnabled', 'financeGeneralEntriesOnly']) {
    for (const value of [undefined, false, 'true']) {
      const changed = { ...finance, [field]: value };
      for (const secret of [financeSecret, sharedSecret])
        assert.equal(await runtime.verifyLineOperator(await request(secret, changed), changed), null);
    }
  }
});

test('dedicated finance identity cannot carry booking, inventory, provider, or broader financial rights', async () => {
  const runtime = createRuntimeLineProof(env);
  const invalid = [
    { ...finance, actions: [...finance.actions, 'booking:read'] },
    { ...finance, actions: [...finance.actions, 'inventory:write'] },
    { ...finance, actions: [...finance.actions, 'finance:refund'] },
    { ...finance, actions: [] },
    { ...finance, actions: null },
    { ...finance, fields: ['money', 'guest_name'] },
    { ...finance, fields: null },
    ...['lineCreateEnabled', 'lineManageAllEnabled', 'lineInventoryEnabled', 'lineProviderFreeEnabled']
      .map(field => ({ ...finance, [field]: true })),
  ];
  for (const grant of invalid) {
    for (const secret of [financeSecret, sharedSecret])
      assert.equal(await runtime.verifyLineOperator(await request(secret, grant), grant), null);
  }
  const validRequest = await request(financeSecret);
  assert.equal(await runtime.verifyLineOperator(validRequest, { ...finance, origin: 'os' }), null);
});

test('finance, provider-free booking and legacy Sweetfun grants keep separate single-key routes', async () => {
  const runtime = createRuntimeLineProof(env);
  const legacy = { ...finance, credentialId: key(), grantId: key(), propertyId: key() };
  delete legacy.financeGeneralEntriesOnly;
  validateGrantShape(legacy);
  assert.ok(await runtime.verifyLineOperator(await request(sharedSecret, legacy), legacy));
  assert.equal(await runtime.verifyLineOperator(await request(financeSecret, legacy), legacy), null);
  assert.equal(await runtime.verifyLineOperator(await request(bookingSecret, legacy), legacy), null);
  validateGrantShape(booking);
  assert.ok(await runtime.verifyLineOperator(await request(bookingSecret, booking, 'line-capabilities'), booking));
  for (const secret of [financeSecret, sharedSecret])
    assert.equal(await runtime.verifyLineOperator(await request(secret, booking, 'line-capabilities'), booking), null);
});

test('finance tuple startup refuses partial settings, malformed identity and key reuse', () => {
  const error = { message: 'OFFLAND_LINE_FINANCE_PROOF_CONFIGURATION_INVALID' };
  for (const field of Object.keys(env).filter(key => key.includes('OFFLAND_LINE_FINANCE'))) {
    const missing = { ...env }; delete missing[field];
    assert.throws(() => createRuntimeLineProof(missing), error);
  }
  for (const secret of ['short', '!'.repeat(43), 'f'.repeat(42), sharedSecret, osSecret])
    assert.throws(() => createRuntimeLineProof({ ...env, IRON_GATE_OFFLAND_LINE_FINANCE_PROOF_SECRET: secret }), error);
  // The existing booking validation already rejects this cross-lane collision.
  assert.throws(() => createRuntimeLineProof({ ...env, IRON_GATE_OFFLAND_LINE_FINANCE_PROOF_SECRET: bookingSecret }),
    /OFFLAND_LINE_(?:BOOKING|FINANCE)_PROOF_CONFIGURATION_INVALID/);
  for (const field of ['CREDENTIAL_ID', 'GRANT_ID', 'PROPERTY_ID'])
    assert.throws(() => createRuntimeLineProof({ ...env, [`IRON_GATE_OFFLAND_LINE_FINANCE_${field}`]: 'wrong' }), error);
  for (const field of ['CREDENTIAL_ID', 'GRANT_ID'])
    assert.throws(() => createRuntimeLineProof({ ...env,
      [`IRON_GATE_OFFLAND_LINE_FINANCE_${field}`]: env[`IRON_GATE_OFFLAND_LINE_BOOKING_${field}`] }), error);
  const noShared = { ...env }; delete noShared.IRON_GATE_LINE_PROOF_SECRET;
  assert.throws(() => createRuntimeLineProof(noShared), /OFFLAND_LINE_(?:BOOKING|FINANCE)_PROOF_CONFIGURATION_INVALID/);
});

test('finance production configuration never reads preview values or silently uses shared fallback', async () => {
  const production = Object.fromEntries(Object.entries(env).map(([key, value]) =>
    [key.replace('IRON_GATE_', 'IRON_GATE_PRODUCTION_'), value]));
  for (const name of Object.keys(env)) Object.defineProperty(production, name, {
    get() { throw Error('preview configuration must not be read in production'); },
  });
  assert.ok(await createRuntimeLineProof(production, true).verifyLineOperator(await request(financeSecret), finance));
  const previewOnly = { ...env, IRON_GATE_PRODUCTION_LINE_PROOF_SECRET: sharedSecret };
  assert.equal(await createRuntimeLineProof(previewOnly, true).verifyLineOperator(await request(sharedSecret), finance), null);
});
