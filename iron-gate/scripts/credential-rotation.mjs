#!/usr/bin/env node
/** Operator-only OFFLAND calendar/source rotation. This module never connects to a database. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { tokenHash, validCredentialId, validateGrantShape } from "../src/credential-grant.mjs";

const PROJECT_REF = "brcszrkwkgiwatrxevkf";
const DAY_MS = 86_400_000;
const MAX_SNAPSHOT_AGE_MS = 15 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MANIFEST_KEYS = ["projectRef", "propertyId", "workspaceId", "authorityEpoch", "replacements"];
const REPLACEMENT_KEYS = ["oldCredentialId", "newCredentialId", "expectedOrigin", "expectedExpiresAt", "expiresAt"];
const fail = (reason) => { throw Error(`CREDENTIAL_ROTATION_${reason}`); };
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonLiteral = (value) => `${literal(JSON.stringify(value))}::jsonb`;

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function iso(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) fail("TIMESTAMP_INVALID");
  return new Date(timestamp).toISOString();
}

function validateManifest(manifest) {
  if (!exactKeys(manifest, MANIFEST_KEYS) || manifest.projectRef !== PROJECT_REF ||
    !validCredentialId(manifest.propertyId) || !validCredentialId(manifest.workspaceId) ||
    !Number.isSafeInteger(manifest.authorityEpoch) || manifest.authorityEpoch < 1 ||
    !Array.isArray(manifest.replacements) || manifest.replacements.length < 1 ||
    manifest.replacements.length > 2) fail("MANIFEST_INVALID");
  const ids = new Set(), origins = new Set();
  for (const entry of manifest.replacements) {
    if (!exactKeys(entry, REPLACEMENT_KEYS) ||
      !validCredentialId(entry.oldCredentialId) || !validCredentialId(entry.newCredentialId) ||
      !["os", "source"].includes(entry.expectedOrigin) || origins.has(entry.expectedOrigin) ||
      ids.has(entry.oldCredentialId) || ids.has(entry.newCredentialId) ||
      entry.oldCredentialId === entry.newCredentialId ||
      iso(entry.expectedExpiresAt) !== entry.expectedExpiresAt || iso(entry.expiresAt) !== entry.expiresAt)
      fail("MANIFEST_INVALID");
    ids.add(entry.oldCredentialId); ids.add(entry.newCredentialId); origins.add(entry.expectedOrigin);
  }
}

function checkScope(grant, expectedOrigin) {
  validateGrantShape(grant);
  if (grant.origin !== expectedOrigin) fail("ORIGIN_CHANGED");
  if (grant.origin === "source") {
    if (!isDeepStrictEqual(grant.actions, ["source:write"]) || grant.fields.length !== 0 ||
      grant.sourceSystem !== "offland-calendar-sheet") fail("UNSUPPORTED_SCOPE");
  } else if (!grant.actions.includes("booking:read") ||
    grant.actions.some(value => !["booking:read", "occupancy:aggregate"].includes(value)) ||
    grant.fields.some(value => !["guest_name", "payment_status", "money"].includes(value))) {
    fail("UNSUPPORTED_SCOPE");
  }
}

/** Snapshot contains only property metadata and the exact old grants; no token hashes or bookings. */
export function planCredentialRotation(snapshot, manifest, nowMs = Date.now()) {
  validateManifest(manifest);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("CLOCK_INVALID");
  const capturedMs = Date.parse(snapshot?.capturedAt);
  const property = snapshot?.property;
  if (snapshot?.projectRef !== PROJECT_REF || !Number.isFinite(capturedMs) ||
    capturedMs > nowMs + 2000 || nowMs - capturedMs > MAX_SNAPSHOT_AGE_MS ||
    property?.propertyId !== manifest.propertyId || property.workspaceId !== manifest.workspaceId ||
    Number(property.authorityEpoch) !== manifest.authorityEpoch || property.readOnly !== false ||
    !Array.isArray(snapshot.credentials) || snapshot.credentials.length !== manifest.replacements.length)
    fail("SNAPSHOT_INVALID");
  const replacements = manifest.replacements.map(entry => {
    const rows = snapshot.credentials.filter(row => row.credentialId === entry.oldCredentialId);
    if (rows.length !== 1) fail("OLD_CREDENTIAL_NOT_UNIQUE");
    const row = rows[0], grant = row.grant;
    if (row.active !== true || row.propertyId !== manifest.propertyId ||
      iso(row.expiresAt) !== entry.expectedExpiresAt || grant?.credentialId !== entry.oldCredentialId ||
      grant.propertyId !== manifest.propertyId || grant.workspaceId !== manifest.workspaceId ||
      grant.authorityEpoch !== manifest.authorityEpoch) fail("OLD_CREDENTIAL_CHANGED");
    checkScope(grant, entry.expectedOrigin);
    const expiryMs = Date.parse(entry.expiresAt);
    if (expiryMs <= nowMs || expiryMs > nowMs + 30 * DAY_MS ||
      expiryMs <= Date.parse(entry.expectedExpiresAt)) fail("EXPIRY_INVALID");
    // This is deliberately a copy of the complete stored grant, not a reconstructed allowlist.
    const newGrant = { ...structuredClone(grant), credentialId: entry.newCredentialId };
    checkScope(newGrant, entry.expectedOrigin);
    return { oldCredentialId: entry.oldCredentialId, newCredentialId: entry.newCredentialId,
      oldExpiresAt: entry.expectedExpiresAt, expiresAt: entry.expiresAt,
      oldGrant: structuredClone(grant), newGrant };
  });
  return canonical({ version: 1, projectRef: PROJECT_REF, propertyId: manifest.propertyId,
    workspaceId: manifest.workspaceId, authorityEpoch: manifest.authorityEpoch,
    replacements: replacements.sort((a, b) => a.oldCredentialId.localeCompare(b.oldCredentialId)) });
}

/** Read-only metadata query. Use the project selected in the manifest, never a guessed database. */
export function rotationSnapshotSql(manifest) {
  validateManifest(manifest);
  const ids = manifest.replacements.map(entry => `${literal(entry.oldCredentialId)}::uuid`).join(", ");
  return `SELECT jsonb_build_object(
  'projectRef', ${literal(PROJECT_REF)}, 'capturedAt', now(),
  'property', (SELECT jsonb_build_object('propertyId', property_id, 'workspaceId', workspace_id,
    'authorityEpoch', authority_epoch, 'readOnly', state_json->'readOnly')
    FROM iron_gate.property_state WHERE property_id = ${literal(manifest.propertyId)}::uuid),
  'credentials', (SELECT coalesce(jsonb_agg(jsonb_build_object('credentialId', credential_id,
    'propertyId', property_id, 'active', active, 'expiresAt', expires_at, 'grant', grant_json)
    ORDER BY credential_id), '[]'::jsonb) FROM iron_gate.credentials
    WHERE credential_id = ANY(ARRAY[${ids}]) AND property_id = ${literal(manifest.propertyId)}::uuid)
) AS snapshot;\n`;
}

function propertyGuard(plan) {
  return `PERFORM property_id FROM iron_gate.property_state
    WHERE property_id = ${literal(plan.propertyId)}::uuid
      AND workspace_id = ${literal(plan.workspaceId)}::uuid
      AND authority_epoch = ${plan.authorityEpoch}
      AND state_json->'readOnly' = 'false'::jsonb FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDENTIAL_ROTATION_AUTHORITY_CHANGED'; END IF;`;
}

function existingCredentialWhere(plan, entry, replacement) {
  return `credential_id = ${literal(replacement ? entry.newCredentialId : entry.oldCredentialId)}::uuid
      AND property_id = ${literal(plan.propertyId)}::uuid
      AND grant_json = ${jsonLiteral(replacement ? entry.newGrant : entry.oldGrant)}
      AND expires_at = ${literal(replacement ? entry.expiresAt : entry.oldExpiresAt)}::timestamptz`;
}

function rotationSql(plan, dryRun = false) {
  const guards = plan.replacements.map(entry => `
  IF ${literal(entry.expiresAt)}::timestamptz <= now()
    OR ${literal(entry.expiresAt)}::timestamptz > now() + interval '30 days'
    THEN RAISE EXCEPTION 'CREDENTIAL_ROTATION_EXPIRY_INVALID'; END IF;
  PERFORM credential_id FROM iron_gate.credentials
    WHERE ${existingCredentialWhere(plan, entry, false)} AND active = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDENTIAL_ROTATION_OLD_CREDENTIAL_CHANGED'; END IF;
  IF EXISTS (SELECT 1 FROM iron_gate.credentials
    WHERE property_id = ${literal(plan.propertyId)}::uuid AND active = true AND expires_at > now()
      AND (grant_json - 'credentialId') = (${jsonLiteral(entry.oldGrant)} - 'credentialId')
      AND credential_id NOT IN (${literal(entry.oldCredentialId)}::uuid, ${literal(entry.newCredentialId)}::uuid))
    THEN RAISE EXCEPTION 'CREDENTIAL_ROTATION_OTHER_REPLACEMENT_EXISTS'; END IF;
  IF EXISTS (SELECT 1 FROM iron_gate.credentials WHERE credential_id = ${literal(entry.newCredentialId)}::uuid) THEN
    PERFORM credential_id FROM iron_gate.credentials WHERE ${existingCredentialWhere(plan, entry, true)}
      AND active = true AND token_hash = ${literal(entry.tokenHash)};
    IF NOT FOUND THEN RAISE EXCEPTION 'CREDENTIAL_ROTATION_NEW_CREDENTIAL_CONFLICT'; END IF;
  ELSE
    INSERT INTO iron_gate.credentials (token_hash, credential_id, property_id, grant_json, expires_at)
      VALUES (${literal(entry.tokenHash)}, ${literal(entry.newCredentialId)}::uuid,
        ${literal(plan.propertyId)}::uuid, ${jsonLiteral(entry.newGrant)}, ${literal(entry.expiresAt)}::timestamptz);
  END IF;
  IF iron_gate.lookup_credential(${literal(entry.tokenHash)}) IS DISTINCT FROM ${jsonLiteral(entry.newGrant)}
    THEN RAISE EXCEPTION 'CREDENTIAL_ROTATION_READBACK_FAILED'; END IF;`).join("\n");
  const body = `BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres'
    THEN RAISE EXCEPTION 'CREDENTIAL_ROTATION_ADMIN_IDENTITY_INVALID'; END IF;
  ${propertyGuard(plan)}
  -- Bounded credential-only lock also prevents duplicate concurrent replacement packages.
  LOCK TABLE iron_gate.credentials IN SHARE ROW EXCLUSIVE MODE;
  ${guards}
END;`;
  // A fixed dollar-quote delimiter could occur inside a stored string field.
  let tag = "$credential_rotation$";
  while (body.includes(tag)) tag = `$rotation_${randomUUID().replaceAll("-", "")}$`;
  return `-- Operator-only, exact project ${PROJECT_REF}. No booking or permission changes.
-- Reuse this same complete package after an uncertain commit; never generate another token.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
DO ${tag}\n${body}\n${tag};
${dryRun ? "ROLLBACK;\nSELECT 'dry_run_rolled_back' AS status;\n" : "COMMIT;\n" + rotationVerifySql(plan)}`;
}

export function rotationVerifySql(plan) {
  return plan.replacements.map(entry => `SELECT ${literal(entry.newCredentialId)}::uuid AS credential_id,
  ${literal(entry.newGrant.origin)} AS origin,
  EXISTS (SELECT 1 FROM iron_gate.credentials WHERE ${existingCredentialWhere(plan, entry, true)}
    AND active = true AND token_hash = ${literal(entry.tokenHash)} AND expires_at > now()) AS replacement_matches,
  iron_gate.lookup_credential(${literal(entry.tokenHash)}) = ${jsonLiteral(entry.newGrant)} AS lookup_matches,
  EXISTS (SELECT 1 FROM iron_gate.credentials WHERE ${existingCredentialWhere(plan, entry, false)}
    AND active = true) AS previous_unchanged,
  ${literal(entry.expiresAt)}::timestamptz AS expires_at`).join("\nUNION ALL\n") + ";\n";
}

export function credentialExpiryMonitorSql(propertyId) {
  if (!validCredentialId(propertyId)) fail("PROPERTY_INVALID");
  return `-- Read-only metadata; no token, hash, guest or financial data.
SELECT credential_id, grant_json->>'origin' AS origin, grant_json->>'subjectId' AS subject,
  expires_at, expires_at AT TIME ZONE 'Asia/Taipei' AS expires_at_taipei,
  expires_at <= now() AS expired,
  expires_at <= now() + interval '7 days' AS renewal_due
FROM iron_gate.credentials WHERE property_id = ${literal(propertyId)}::uuid AND active = true
ORDER BY expires_at, credential_id;\n`;
}

export async function readPrivateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 262_144 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("INPUT_NOT_PRIVATE");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

async function writeNewPrivate(path, content) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}

/** Creates local private artifacts only; never applies SQL, contacts a service, or reveals a token. */
export async function prepareCredentialRotation(snapshot, manifest, outputDirectory, nowMs = Date.now()) {
  const planned = planCredentialRotation(snapshot, manifest, nowMs);
  const output = resolve(outputDirectory);
  const parent = await lstat(dirname(output));
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail("OUTPUT_PARENT_INVALID");
  await mkdir(output, { mode: 0o700 }); // Existing packages are never overwritten.
  const privateTokens = [];
  const plan = { ...planned, replacements: planned.replacements.map(entry => {
    const token = randomBytes(32).toString("base64url");
    privateTokens.push({ credentialId: entry.newCredentialId, origin: entry.newGrant.origin,
      clientId: entry.newGrant.clientId, propertyId: planned.propertyId, expiresAt: entry.expiresAt, token });
    return { ...entry, tokenHash: tokenHash(token) };
  }) };
  const planText = JSON.stringify(plan, null, 2) + "\n";
  const applySql = rotationSql(plan), verifySql = rotationVerifySql(plan);
  const dryRunSql = rotationSql(plan, true);
  await writeNewPrivate(join(output, "credentials.private.json"), JSON.stringify({ projectRef: PROJECT_REF,
    propertyId: planned.propertyId, status: "prepared_not_applied", credentials: privateTokens }, null, 2) + "\n");
  await writeNewPrivate(join(output, "plan.private.json"), planText);
  await writeNewPrivate(join(output, "apply.private.sql"), applySql);
  await writeNewPrivate(join(output, "dry-run.private.sql"), dryRunSql);
  await writeNewPrivate(join(output, "verify.private.sql"), verifySql);
  await writeNewPrivate(join(output, "expiry-monitor.sql"), credentialExpiryMonitorSql(plan.propertyId));
  const receipt = { status: "prepared_not_applied", version: 1, projectRef: PROJECT_REF,
    propertyId: planned.propertyId, authorityEpoch: planned.authorityEpoch,
    planSha256: sha256(planText), applySha256: sha256(applySql), dryRunSha256: sha256(dryRunSql),
    verifySha256: sha256(verifySql),
    replacements: plan.replacements.map(entry => ({ oldCredentialId: entry.oldCredentialId,
      newCredentialId: entry.newCredentialId, origin: entry.newGrant.origin, expiresAt: entry.expiresAt })) };
  await writeNewPrivate(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  const folder = await open(output, constants.O_RDONLY);
  try { await folder.sync(); } finally { await folder.close(); }
  return { ...receipt, outputDirectory: output };
}

/** Recheck token/package consistency before passing the SQL to an authorized operator transport. */
export async function checkPreparedCredentialRotation(outputDirectory) {
  const directory = resolve(outputDirectory);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("OUTPUT_NOT_PRIVATE");
  const plan = await readPrivateJson(join(directory, "plan.private.json"));
  const secret = await readPrivateJson(join(directory, "credentials.private.json"));
  const receipt = await readPrivateJson(join(directory, "receipt.json"));
  if (plan.projectRef !== PROJECT_REF || secret.projectRef !== PROJECT_REF ||
    secret.propertyId !== plan.propertyId || !Array.isArray(plan.replacements) ||
    !Array.isArray(secret.credentials) || secret.credentials.length !== plan.replacements.length ||
    receipt.planSha256 !== sha256(JSON.stringify(plan, null, 2) + "\n")) fail("PACKAGE_CHANGED");
  for (const entry of plan.replacements) {
    const rows = secret.credentials.filter(row => row.credentialId === entry.newCredentialId);
    if (rows.length !== 1 || !TOKEN.test(rows[0].token) || tokenHash(rows[0].token) !== entry.tokenHash ||
      rows[0].propertyId !== plan.propertyId || rows[0].origin !== entry.newGrant.origin ||
      rows[0].clientId !== entry.newGrant.clientId || rows[0].expiresAt !== entry.expiresAt ||
      !isDeepStrictEqual(entry.newGrant, { ...entry.oldGrant, credentialId: entry.newCredentialId }))
      fail("PACKAGE_CHANGED");
  }
  // Read SQL as bytes with the same file ownership/no-symlink checks used for JSON inputs.
  for (const [filename, expected] of [["apply.private.sql", receipt.applySha256],
    ["dry-run.private.sql", receipt.dryRunSha256],
    ["verify.private.sql", receipt.verifySha256]]) {
    const handle = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 262_144 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
        sha256(await handle.readFile("utf8")) !== expected) fail("PACKAGE_CHANGED");
    } finally { await handle.close(); }
  }
  return { status: "package_verified_not_applied", projectRef: PROJECT_REF,
    propertyId: plan.propertyId, replacements: receipt.replacements };
}

export async function runCredentialRotationCli(args, io = process) {
  try {
    const [command, first, second, third, ...extra] = args;
    let result;
    if (command === "prepare" && first && second && third && extra.length === 0) {
      result = await prepareCredentialRotation(await readPrivateJson(first), await readPrivateJson(second), third);
    } else if (command === "check-package" && first && !second && !third && extra.length === 0) {
      result = await checkPreparedCredentialRotation(first);
    } else { fail("USAGE_INVALID"); }
    io.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch {
    // Errors may contain private input, tokens, or file contents. Print a fixed safe diagnostic only.
    io.stderr.write("CREDENTIAL_ROTATION_FAILED: preserve the existing package and verify its credential IDs before retrying.\n");
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runCredentialRotationCli(process.argv.slice(2));
}
