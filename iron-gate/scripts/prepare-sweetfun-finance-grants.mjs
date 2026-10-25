#!/usr/bin/env node
// Offline preparation only. Execute issue.sql through the approved project
// administrator, then send each private grant JSON only to OS Production.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tokenHash, validateGrant } from '../src/credential-grant.mjs';

const propertyId = '95ae9bd1-5e6d-4386-be5b-6af3c5668a16';
const workspaceId = '4273c91e-e067-4036-8719-29dd5810daf6';
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

export function financeGrantPackage(now = Date.now()) {
  // 28 days stays safely within the canonical maximum 30-day policy.
  const expiresAt = new Date(now + 28 * 86_400_000).toISOString();
  const items = [
    { name: 'finance', subjectId: 'sweetfun-os-finance-read', actions: ['finance:ledger'] },
    { name: 'payment', subjectId: 'sweetfun-os-direct-payments', actions: ['booking:read', 'payment:write'] },
  ].map(({ name, subjectId, actions }) => {
    const grant = { credentialId: randomUUID(), clientId: randomUUID(), subjectId,
      propertyId, workspaceId, authorityEpoch: 1, origin: 'os', actions, fields: ['money'] };
    validateGrant(grant, expiresAt);
    const token = randomBytes(32).toString('base64url');
    return { name, grant, tokenHash: tokenHash(token), expiresAt,
      environment: { credentialId: grant.credentialId, clientId: grant.clientId,
        propertyId, workspaceId, token } };
  });
  const rows = items.map(item => `(${quote(item.tokenHash)}, ${quote(item.grant.credentialId)}::uuid, ${quote(propertyId)}::uuid, ${quote(JSON.stringify(item.grant))}::jsonb, ${quote(expiresAt)}::timestamptz)`);
  const sql = `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
DO $issue$
DECLARE authority record; expected record; actual record;
BEGIN
  SELECT workspace_id, authority_epoch, state_json->>'readOnly' AS read_only
    INTO STRICT authority FROM iron_gate.property_state
    WHERE property_id = ${quote(propertyId)}::uuid FOR SHARE;
  IF authority.workspace_id <> ${quote(workspaceId)}::uuid OR
    authority.authority_epoch <> 1 OR authority.read_only IS DISTINCT FROM 'false'
    THEN RAISE EXCEPTION 'FINANCE_AUTHORITY_CHANGED'; END IF;
  FOR expected IN SELECT * FROM (VALUES ${rows.join(',\n    ')})
    AS x(token_hash, credential_id, property_id, grant_json, expires_at)
  LOOP
    IF expected.expires_at <= now() OR expected.expires_at > now() + interval '30 days'
      THEN RAISE EXCEPTION 'FINANCE_CREDENTIAL_EXPIRY_INVALID'; END IF;
    IF EXISTS (SELECT 1 FROM iron_gate.credentials WHERE property_id = expected.property_id
      AND grant_json->>'subjectId' = expected.grant_json->>'subjectId'
      AND active AND expires_at > now() AND credential_id <> expected.credential_id)
      THEN RAISE EXCEPTION 'FINANCE_CREDENTIAL_ALREADY_ACTIVE'; END IF;
    INSERT INTO iron_gate.credentials(token_hash, credential_id, property_id, grant_json, expires_at)
      VALUES(expected.token_hash, expected.credential_id, expected.property_id, expected.grant_json, expected.expires_at)
      ON CONFLICT (credential_id) DO NOTHING;
    SELECT * INTO STRICT actual FROM iron_gate.credentials WHERE credential_id = expected.credential_id;
    IF actual.token_hash <> expected.token_hash OR actual.property_id <> expected.property_id OR
      actual.grant_json <> expected.grant_json OR actual.expires_at <> expected.expires_at OR NOT actual.active
      THEN RAISE EXCEPTION 'FINANCE_CREDENTIAL_READBACK_MISMATCH'; END IF;
  END LOOP;
END $issue$;
COMMIT;
SELECT credential_id, property_id, grant_json, active, expires_at
FROM iron_gate.credentials WHERE credential_id IN (${items.map(item => quote(item.grant.credentialId) + '::uuid').join(',')});
`;
  return { projectRef: 'brcszrkwkgiwatrxevkf', expiresAt, items, sql };
}

export async function prepareFinanceGrantFiles(directory) {
  const output = resolve(directory);
  // A new private directory is mandatory; never overwrite an uncertain issuance.
  await mkdir(output, { mode: 0o700 });
  const plan = financeGrantPackage();
  for (const item of plan.items)
    await writeFile(`${output}/${item.name}.json`, JSON.stringify(item.environment), { flag: 'wx', mode: 0o600 });
  await writeFile(`${output}/issue.sql`, plan.sql, { flag: 'wx', mode: 0o600 });
  const summary = { projectRef: plan.projectRef, expiresAt: plan.expiresAt,
    grants: plan.items.map(({ name, grant, tokenHash }) => ({ name, ...grant, tokenHash })) };
  await writeFile(`${output}/manifest.json`, JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
  return { output, expiresAt: plan.expiresAt, credentialIds: plan.items.map(item => item.grant.credentialId) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('USAGE: prepare-sweetfun-finance-grants.mjs NEW_PRIVATE_DIRECTORY');
  try { process.stdout.write(JSON.stringify(await prepareFinanceGrantFiles(process.argv[2])) + '\n'); }
  catch { process.stderr.write('FINANCE_GRANT_PREPARATION_FAILED: preserve any existing package for recovery.\n'); process.exitCode = 1; }
}
