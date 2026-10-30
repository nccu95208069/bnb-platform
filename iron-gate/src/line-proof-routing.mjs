import { createLineOperatorProofVerifier } from './line-operator-proof.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const GENERAL_FINANCE_ACTIONS = new Set(['finance:read', 'finance:record_receipt',
  'finance:record_expense', 'finance:correct', 'finance:plan']);
const financeOnly = grant => grant?.origin === 'line' && grant.lineFinanceEnabled === true &&
  grant.financeGeneralEntriesOnly === true &&
  !['lineCreateEnabled', 'lineManageAllEnabled', 'lineInventoryEnabled', 'lineProviderFreeEnabled']
    .some(name => grant[name] === true) &&
  Array.isArray(grant.actions) && grant.actions.length > 0 &&
  grant.actions.every(action => GENERAL_FINANCE_ACTIONS.has(action)) &&
  Array.isArray(grant.fields) && grant.fields.every(field => field === 'money');
const identityMatches = (tuple, grant) => tuple && (grant?.credentialId === tuple.credentialId ||
  grant?.grantId === tuple.grantId);
const exactIdentity = (tuple, grant) => tuple && grant?.credentialId === tuple.credentialId &&
  grant?.grantId === tuple.grantId && grant?.propertyId === tuple.propertyId;

/** Dedicated proofs are selected by stored credential identity and scope, never
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
  const financeValues = names.map(name => env[`${prefix}OFFLAND_LINE_FINANCE_${name}`]);
  let finance = null;
  if (financeValues.some(value => value !== undefined && value !== '')) {
    const [secret, credentialId, grantId, propertyId] = financeValues;
    if (!SECRET.test(secret ?? '') || !SECRET.test(linePreviewSecret ?? '') ||
      ![credentialId, grantId, propertyId].every(value => UUID.test(value ?? '')) ||
      [linePreviewSecret, env[`${prefix}OS_PROOF_SECRET`], values[0]]
        .some(value => value && value === secret) ||
      dedicated && (dedicated.credentialId === credentialId || dedicated.grantId === grantId))
      throw Error('OFFLAND_LINE_FINANCE_PROOF_CONFIGURATION_INVALID');
    finance = { credentialId, grantId, propertyId,
      verify: createLineOperatorProofVerifier(secret, clock) };
  }
  const shared = linePreviewSecret ? createLineOperatorProofVerifier(linePreviewSecret, clock) : null;
  const verifyLineOperator = shared || dedicated || finance ? async (request, grant) => {
    const bookingScope = grant?.lineProviderFreeEnabled === true || identityMatches(dedicated, grant);
    // This existing stored marker distinguishes the general-only LINE lane.
    // Missing configuration or a removed finance marker cannot fall back to a
    // legacy shared signature, including before/after a dedicated rollout.
    const financeScope = grant?.origin === 'line' && grant?.financeGeneralEntriesOnly === true ||
      identityMatches(finance, grant);
    if (bookingScope && financeScope) return null;
    if (financeScope) {
      if (!exactIdentity(finance, grant) || !financeOnly(grant)) return null;
      return finance.verify(request, grant);
    }
    if (bookingScope) {
      if (!exactIdentity(dedicated, grant) || grant?.lineProviderFreeEnabled !== true) return null;
      return dedicated.verify(request, grant);
    }
    return shared ? shared(request, grant) : null;
  } : null;
  return { verifyLineOperator, linePreviewSecret };
}
