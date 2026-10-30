import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateJson } from './seed-sweetfun-shadow.mjs';
import { tokenHash } from '../src/credential-grant.mjs';
import { offlandLineBookingSnapshotSql, planOfflandLineBookingAdminSql,
  offlandLineBookingReadbackSql, verifyOfflandLineBookingCommittedReadback }
  from './offland-line-booking-admin-sql.mjs';

async function privateDestination(path) {
  const target = resolve(path), parent = await realpath(dirname(target));
  const candidates = process.platform === 'darwin' ? ['/private/tmp', tmpdir()] : [tmpdir()];
  const roots = await Promise.all(candidates.map(root => realpath(root)));
  if (!roots.some(root => parent === root || parent.startsWith(root + sep)))
    throw Error('OFFLAND_LINE_SQL_OUTPUT_MUST_BE_PRIVATE_TEMP');
  return resolve(parent, target.split(sep).at(-1));
}

async function writePrivate(path, content) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}

/** Local preparation only. No database or network calls. Never overwrites a
 * package: preserve its credential file across unknown execution outcomes. */
export async function prepareOfflandLineBookingSql(action, manifestPath, snapshotPath, outputDirectory) {
  const manifest = privateJson(manifestPath), snapshot = privateJson(snapshotPath);
  const token = action === 'stage' ? randomBytes(32).toString('base64url') : null;
  const bundle = planOfflandLineBookingAdminSql(action, manifest, snapshot, token === null ? null : tokenHash(token));
  const output = await privateDestination(outputDirectory);
  await mkdir(output, { mode: 0o700 });
  // Persist the only plaintext token before making executable SQL available.
  if (token !== null) await writePrivate(`${output}/credential.private.json`, JSON.stringify({
    projectRef: manifest.projectRef, propertyId: manifest.propertyId, workspaceId: manifest.workspaceId,
    credentialId: manifest.credentialId, grantId: manifest.grantId, clientId: manifest.clientId,
    groupId: manifest.groupId, actorIds: manifest.actorIds, token, expiresAt: manifest.expiresAt,
    active: false, channelPolicy: 'provider_free', issuanceStatus: 'prepared_not_applied',
  }, null, 2) + '\n');
  const files = { 'plan.json': JSON.stringify(bundle.plan, null, 2) + '\n',
    'apply.sql': bundle.applySql, 'dry-run.sql': bundle.dryRunSql, 'readback.sql': bundle.readbackSql };
  for (const [name, content] of Object.entries(files)) await writePrivate(`${output}/${name}`, content);
  const hashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name,
    createHash('sha256').update(content).digest('hex')]));
  const summary = { schema: 1, status: 'prepared_not_applied', action, requestHash: bundle.plan.requestHash,
    inventoryVersionBefore: manifest.expectedVersion, inventoryVersionAfter: bundle.plan.result.inventoryVersion,
    credentialFile: token === null ? null : 'credential.private.json', hashes };
  await writePrivate(`${output}/package.json`, JSON.stringify(summary, null, 2) + '\n');
  return { ...summary, outputDirectory: output };
}

async function main(args) {
  const [action, ...paths] = args;
  if (action === 'snapshot' && paths.length === 2) {
    const sql = offlandLineBookingSnapshotSql(privateJson(paths[0]));
    const output = await privateDestination(paths[1]);
    await writePrivate(output, sql);
    return { status: 'snapshot_query_prepared', outputPath: output };
  }
  if (['stage', 'activate', 'revoke'].includes(action) && paths.length === 3)
    return prepareOfflandLineBookingSql(action, ...paths);
  if (action === 'readback' && paths.length === 2) {
    const sql = offlandLineBookingReadbackSql(privateJson(paths[0]));
    const output = await privateDestination(paths[1]);
    await writePrivate(output, sql);
    return { status: 'readback_query_prepared', outputPath: output };
  }
  if (action === 'verify' && paths.length === 2)
    return verifyOfflandLineBookingCommittedReadback(privateJson(paths[0]), privateJson(paths[1]));
  throw Error('OFFLAND_LINE_SQL_EXPLICIT_ACTION_AND_PRIVATE_PATHS_REQUIRED');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.stdout.write(JSON.stringify(await main(process.argv.slice(2))) + '\n'); }
  catch (error) {
    const message = typeof error?.message === 'string' &&
      /^(?:OFFLAND_|INVALID_|UNSAFE_PRIVATE_)[A-Z0-9_]+$/.test(error.message)
      ? error.message : 'OFFLAND_LINE_SQL_PREPARATION_FAILED';
    process.stderr.write(message + '\n'); process.exitCode = 1;
  }
}
