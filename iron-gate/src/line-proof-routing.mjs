import { createLineOperatorProofVerifier } from './line-operator-proof.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Dedicated booking proofs are selected by stored credential identity, never
 * by request content and never by trying another key after verification fails. */
export function createRuntimeLineProof(env, production = false, clock = Date.now) {
  const prefix = production ? 'IRON_GATE_PRODUCTION_' : 'IRON_GATE_';
  const linePreviewSecret = env[`${prefix}LINE_PROOF_SECRET`] || null;
  const names = ['PROOF_SECRET', 'CREDENTIAL_ID', 'GRANT_ID', 'PROPERTY_ID'];
  const values = names.map(name => env[`${prefix}OFFLAND_LINE_BOOKING_${name}`]);
  const configured = values.some(value => value !== undefined && value !== '');
  let dedicated = null;
  if (configured) {
    const [secret, credentialId, grantId, propertyId] = values;
    const otherSecrets = [linePreviewSecret, env[`${prefix}OS_PROOF_SECRET`],
      env[`${prefix}OFFLAND_LINE_FINANCE_PROOF_SECRET`]];
    if (!SECRET.test(secret ?? '') || !SECRET.test(linePreviewSecret ?? '') ||
      ![credentialId, grantId, propertyId].every(value => UUID.test(value ?? '')) ||
      otherSecrets.some(value => value && value === secret))
      throw Error('OFFLAND_LINE_BOOKING_PROOF_CONFIGURATION_INVALID');
    dedicated = { credentialId, grantId, propertyId,
      verify: createLineOperatorProofVerifier(secret, clock) };
  }
  const shared = linePreviewSecret ? createLineOperatorProofVerifier(linePreviewSecret, clock) : null;
  const verifyLineOperator = shared || dedicated ? async (request, grant) => {
    const dedicatedIdentity = dedicated && (grant?.credentialId === dedicated.credentialId ||
      grant?.grantId === dedicated.grantId);
    if (grant?.lineProviderFreeEnabled === true || dedicatedIdentity) {
      if (!dedicated || grant?.lineProviderFreeEnabled !== true ||
        grant.credentialId !== dedicated.credentialId || grant.grantId !== dedicated.grantId ||
        grant.propertyId !== dedicated.propertyId) return null;
      return dedicated.verify(request, grant);
    }
    return shared ? shared(request, grant) : null;
  } : null;
  return { verifyLineOperator, linePreviewSecret };
}
