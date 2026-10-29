import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeLineProof } from '../src/line-proof-routing.mjs';
import { signLineOperatorProof } from '../src/line-operator-proof.mjs';
import { validateGrantShape } from '../src/credential-grant.mjs';
import { key } from './retained-fixture.mjs';

const grant = { credentialId: key(), grantId: key(), propertyId: key(), workspaceId: key(),
  clientId: 'synthetic', subjectId: 'synthetic', origin: 'line', authorityEpoch: 1,
  lineGroupId: 'synthetic-group', lineActorIds: ['synthetic-actor'],
  lineCreateEnabled: true, lineManageAllEnabled: true, lineProviderFreeEnabled: true,
  actions: ['booking:read', 'booking:create', 'booking:amend', 'booking:cancel', 'booking:manage_all'],
  fields: ['guest_name', 'contact', 'notes', 'money'] };
const env = { IRON_GATE_LINE_PROOF_SECRET: 's'.repeat(43), IRON_GATE_OS_PROOF_SECRET: 'o'.repeat(43),
  IRON_GATE_OFFLAND_LINE_BOOKING_PROOF_SECRET: 'b'.repeat(43),
  IRON_GATE_OFFLAND_LINE_BOOKING_CREDENTIAL_ID: grant.credentialId,
  IRON_GATE_OFFLAND_LINE_BOOKING_GRANT_ID: grant.grantId,
  IRON_GATE_OFFLAND_LINE_BOOKING_PROPERTY_ID: grant.propertyId };
async function request(secret, scoped = grant) {
  const unsigned = new Request(`https://iron.invalid/v1/properties/${scoped.propertyId}/line-capabilities`);
  const proof = await signLineOperatorProof(secret, unsigned, scoped,
    { active: true, groupId: scoped.lineGroupId, actorId: scoped.lineActorIds[0] });
  return new Request(unsigned, { headers: { 'x-iron-gate-line-proof': proof } });
}

test('dedicated booking proof selects one exact stored grant and never falls back to the shared key', async () => {
  const configured = createRuntimeLineProof(env);
  assert.equal(configured.linePreviewSecret, env.IRON_GATE_LINE_PROOF_SECRET);
  assert.ok(await configured.verifyLineOperator(await request('b'.repeat(43)), grant));
  assert.equal(await configured.verifyLineOperator(await request('s'.repeat(43)), grant), null);
  for (const field of ['credentialId', 'grantId', 'propertyId']) {
    const wrong = { ...grant, [field]: key() };
    assert.equal(await configured.verifyLineOperator(await request('b'.repeat(43), wrong), wrong), null);
    assert.equal(await configured.verifyLineOperator(await request('s'.repeat(43), wrong), wrong), null);
  }
  const ordinary = { ...grant, credentialId: key(), grantId: key(), propertyId: key() };
  delete ordinary.lineProviderFreeEnabled;
  assert.ok(await configured.verifyLineOperator(await request('s'.repeat(43), ordinary), ordinary));
  assert.equal(await configured.verifyLineOperator(await request('b'.repeat(43), ordinary), ordinary), null);
  const unmarked = { ...grant }; delete unmarked.lineProviderFreeEnabled;
  assert.equal(await configured.verifyLineOperator(await request('s'.repeat(43), unmarked), unmarked), null);
  const absent = createRuntimeLineProof({ IRON_GATE_LINE_PROOF_SECRET: 's'.repeat(43) });
  assert.equal(await absent.verifyLineOperator(await request('s'.repeat(43)), grant), null);
});

test('dedicated proof startup rejects incomplete, malformed and shared secrets without affecting absent rollout', () => {
  for (const field of Object.keys(env).filter(x => x.includes('OFFLAND_LINE_BOOKING'))) {
    const missing = { ...env }; delete missing[field];
    assert.throws(() => createRuntimeLineProof(missing), { message: 'OFFLAND_LINE_BOOKING_PROOF_CONFIGURATION_INVALID' });
  }
  for (const secret of ['short', 'x'.repeat(42), 's'.repeat(43), 'o'.repeat(43), '!'.repeat(43)]) {
    assert.throws(() => createRuntimeLineProof({ ...env, IRON_GATE_OFFLAND_LINE_BOOKING_PROOF_SECRET: secret }),
      { message: 'OFFLAND_LINE_BOOKING_PROOF_CONFIGURATION_INVALID' });
  }
  assert.throws(() => createRuntimeLineProof({ ...env, IRON_GATE_OFFLAND_LINE_FINANCE_PROOF_SECRET: 'b'.repeat(43) }),
    { message: 'OFFLAND_LINE_BOOKING_PROOF_CONFIGURATION_INVALID' });
  assert.equal(createRuntimeLineProof({}).verifyLineOperator, null);
});

test('production dedicated proof reads only production configuration, never preview fallback', async () => {
  const production = Object.fromEntries(Object.entries(env).map(([name, value]) =>
    [name.replace('IRON_GATE_', 'IRON_GATE_PRODUCTION_'), value]));
  for (const name of Object.keys(env)) Object.defineProperty(production, name, {
    get() { throw Error('preview configuration must not be accessed in production'); },
  });
  const configured = createRuntimeLineProof(production, true);
  assert.ok(await configured.verifyLineOperator(await request('b'.repeat(43)), grant));
  assert.equal(createRuntimeLineProof(env, true).verifyLineOperator, null);
});

test('dedicated stored grant marker cannot carry inventory, finance or a non-LINE origin', () => {
  assert.doesNotThrow(() => validateGrantShape(grant));
  for (const changed of [
    { ...grant, lineProviderFreeEnabled: false },
    { ...grant, origin: 'os' },
    { ...grant, lineInventoryEnabled: true, actions: [...grant.actions, 'inventory:write'] },
    { ...grant, lineFinanceEnabled: true },
  ]) assert.throws(() => validateGrantShape(changed));
});
