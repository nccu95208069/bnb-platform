import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Pool } from "pg";
import { auditSweetfunFinanceSources } from "./audit-sweetfun-finance-sources.mjs";
import { validateDatabaseTransport } from "../src/runtime-safety.mjs";

const targetProjectRef = "brcszrkwkgiwatrxevkf";
const expectedLogin = "iron_gate_evidence_import_login";
const kinds = ["os_redis", "line_firestore", "sheet_finance_map",
  "sheet_finance_projection"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{64}$/;

function privateText(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size < 2 || stat.size > 2_000_000)
    throw Error("UNSAFE_PRIVATE_INPUT");
  return readFileSync(path, "utf8");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function databaseUrl(credentials) {
  if (credentials?.projectRef !== targetProjectRef ||
    credentials?.login !== expectedLogin ||
    credentials?.host !== "aws-0-ap-northeast-1.pooler.supabase.com" ||
    !sha.test(credentials?.password ?? ""))
    throw Error("INVALID_EVIDENCE_DATABASE_CREDENTIAL");
  const url = new URL("postgresql://aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres");
  url.username = `${credentials.login}.${credentials.projectRef}`;
  url.password = credentials.password;
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert",
    fileURLToPath(new URL("../certs/prod-ca-2021.crt", import.meta.url)));
  validateDatabaseTransport(url.toString());
  return url.toString();
}

function validateManifest(manifest) {
  if (!uuid.test(manifest?.captureId ?? "") ||
    !uuid.test(manifest?.propertyId ?? "") ||
    !sha.test(manifest?.sheetSourceHash ?? "") ||
    !sha.test(manifest?.normalizedSourceHash ?? "") ||
    typeof manifest?.sourceCopyId !== "string" || !manifest.sourceCopyId ||
    typeof manifest?.sourceCopyCreatedAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.sourceCopyCreatedAt)) ||
    typeof manifest?.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.capturedAt)))
    throw Error("INVALID_EVIDENCE_MANIFEST");
}

function checkSheetMapAgainstShadow(sheetMap, state, manifest) {
  if (state?.propertyId !== manifest.propertyId || state?.readOnly !== true ||
    state?.authorityEpoch !== 0 || state?.channel?.ready !== false ||
    state?.channel?.websiteSalesEnabled !== false ||
    state?.sweetfunImport?.sourceHash !== manifest.sheetSourceHash ||
    state?.sweetfunImport?.capturedAt !== manifest.sourceCopyCreatedAt ||
    state?.sweetfunImport?.sourceId !== sheetMap.sourceId ||
    !Array.isArray(state.bookings) ||
    state.bookings.some((booking) => !Array.isArray(booking.paymentEvents) ||
      booking.paymentEvents.length))
    throw Error("EVIDENCE_SHADOW_VERSION_MISMATCH");
  const rows = [...(state.bookings ?? []).flatMap((booking) =>
    booking.sweetfunSnapshot?.rows ?? []),
  ...(state.sweetfunImport.quarantined ?? []).flatMap((group) => group.rows ?? [])];
  const shadow = new Map();
  for (const row of rows) {
    const sourceJ = row.values?.[9];
    if (typeof sourceJ !== "string" || !sourceJ || shadow.has(sourceJ))
      throw Error("EVIDENCE_SHADOW_ROW_MISMATCH");
    shadow.set(sourceJ, { sourceJ, parentL: row.values?.[11] ?? "",
      markerH: row.values?.[7] ?? "", noteH: row.notes?.[7] ?? "" });
  }
  if (shadow.size !== sheetMap.rows?.length) throw Error("EVIDENCE_SHADOW_ROW_MISMATCH");
  for (const row of sheetMap.rows) if (!isDeepStrictEqual(shadow.get(row.sourceJ), row))
    throw Error("EVIDENCE_SHADOW_ROW_MISMATCH");
}

/** Append-only, evidence-only shadow. It does not create payment events. */
export async function stageSweetfunFinanceEvidence(pool, rawSources, manifest,
  { expectedDatabaseName = "postgres" } = {}) {
  validateManifest(manifest);
  if (!Array.isArray(rawSources) || rawSources.length !== kinds.length ||
    rawSources.some((value) => typeof value !== "string" ||
      Buffer.byteLength(value) < 2 || Buffer.byteLength(value) > 2_000_000))
    throw Error("INVALID_EVIDENCE_SOURCE_BUNDLE");
  const parsed = rawSources.map((value) => JSON.parse(value));
  const audit = auditSweetfunFinanceSources(...parsed);
  if (audit.report.sourceHash !== manifest.normalizedSourceHash ||
    audit.report.issueCodes.length || audit.report.paymentEventsCreated !== 0)
    throw Error("EVIDENCE_SOURCE_AUDIT_MISMATCH");
  const identity = await pool.query(`SELECT current_user AS login,
    current_database() AS database_name, rolsuper, rolbypassrls,
    pg_has_role(current_user, 'iron_gate_evidence_import', 'MEMBER') AS import_member,
    pg_has_role(current_user, 'iron_gate_runtime', 'MEMBER') AS runtime_member,
    row_security_active('iron_gate.migration_source_evidence') AS evidence_rls,
    has_schema_privilege(current_user, 'iron_gate', 'CREATE') AS can_change_schema,
    has_table_privilege(current_user, 'iron_gate.migration_source_evidence',
      'UPDATE, DELETE') AS can_change_evidence,
    has_table_privilege(current_user, 'iron_gate.property_state',
      'INSERT, UPDATE, DELETE') AS can_change_bookings,
    has_table_privilege(current_user, 'iron_gate.credentials',
      'SELECT, INSERT, UPDATE, DELETE') AS can_access_credentials,
    has_table_privilege(current_user, 'iron_gate.outbox',
      'SELECT, INSERT, UPDATE, DELETE') AS can_access_outbox,
    has_table_privilege(current_user, 'iron_gate.audit_log',
      'SELECT, INSERT, UPDATE, DELETE') AS can_access_audit
    FROM pg_roles WHERE rolname = current_user`);
  const role = identity.rows[0];
  if (!role || role.login !== expectedLogin ||
    role.database_name !== expectedDatabaseName || role.rolsuper ||
    role.rolbypassrls || !role.import_member || role.runtime_member ||
    !role.evidence_rls || role.can_change_schema || role.can_change_evidence ||
    role.can_change_bookings || role.can_access_credentials ||
    role.can_access_outbox || role.can_access_audit)
    throw Error("UNSAFE_EVIDENCE_DATABASE_ROLE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('iron_gate.property_id', $1, true)",
      [manifest.propertyId]);
    await client.query("SELECT set_config('iron_gate.evidence_capture_id', $1, true)",
      [manifest.captureId]);
    const shadow = await client.query(`SELECT state_json FROM iron_gate.property_state
      WHERE property_id = $1`, [manifest.propertyId]);
    if (shadow.rows.length !== 1) throw Error("EVIDENCE_SHADOW_NOT_FOUND");
    checkSheetMapAgainstShadow(parsed[2], shadow.rows[0].state_json, manifest);
    const sourceDigests = rawSources.map(digest);
    let inserted = 0;
    for (let i = 0; i < kinds.length; i++) {
      const result = await client.query(`INSERT INTO iron_gate.migration_source_evidence
        (capture_id, property_id, source_kind, source_sha256,
         normalized_sha256, sheet_source_sha256, source_copy_id,
         captured_at, payload_text)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (capture_id, source_kind) DO NOTHING`,
      [manifest.captureId, manifest.propertyId, kinds[i], sourceDigests[i],
        manifest.normalizedSourceHash, manifest.sheetSourceHash,
        manifest.sourceCopyId, manifest.capturedAt, rawSources[i]]);
      inserted += result.rowCount;
    }
    if (inserted !== 0 && inserted !== kinds.length)
      throw Error("EVIDENCE_PARTIAL_CAPTURE_CONFLICT");
    const readback = await client.query(`SELECT source_kind, source_sha256,
      normalized_sha256, sheet_source_sha256, source_copy_id, payload_text
      FROM iron_gate.migration_source_evidence
      WHERE capture_id = $1 AND property_id = $2`,
    [manifest.captureId, manifest.propertyId]);
    if (readback.rows.length !== kinds.length ||
      readback.rows.some((row) => {
        const i = kinds.indexOf(row.source_kind);
        return i < 0 || row.source_sha256 !== sourceDigests[i] ||
          row.normalized_sha256 !== manifest.normalizedSourceHash ||
          row.sheet_source_sha256 !== manifest.sheetSourceHash ||
          row.source_copy_id !== manifest.sourceCopyId ||
          row.payload_text !== rawSources[i];
      })) throw Error("EVIDENCE_READBACK_MISMATCH");
    await client.query("COMMIT");
    return { action: inserted ? "inserted" : "unchanged",
      captureId: manifest.captureId, sourceCount: kinds.length,
      normalizedSourceHash: manifest.normalizedSourceHash,
      paymentEventsCreated: 0, canCutover: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let pool;
  try {
    if (process.argv[2] !== "--private-evidence-only" || process.argv.length !== 9)
      throw Error("EXPLICIT_EVIDENCE_SCOPE_REQUIRED");
    const rawSources = process.argv.slice(3, 7).map(privateText);
    const manifest = JSON.parse(privateText(process.argv[7]));
    const credentials = JSON.parse(privateText(process.argv[8]));
    pool = new Pool({ connectionString: databaseUrl(credentials), max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    process.stdout.write(`${JSON.stringify(await stageSweetfunFinanceEvidence(
      pool, rawSources, manifest))}\n`);
  } catch (error) {
    const safe = new Set(["INVALID_EVIDENCE_MANIFEST", "INVALID_EVIDENCE_SOURCE_BUNDLE",
      "EVIDENCE_SOURCE_AUDIT_MISMATCH", "UNSAFE_EVIDENCE_DATABASE_ROLE",
      "EVIDENCE_SHADOW_NOT_FOUND", "EVIDENCE_SHADOW_VERSION_MISMATCH",
      "EVIDENCE_SHADOW_ROW_MISMATCH", "EVIDENCE_PARTIAL_CAPTURE_CONFLICT",
      "EVIDENCE_READBACK_MISMATCH"]);
    process.stderr.write(`Sweetfun evidence stage failed: ${safe.has(error?.message) ?
      error.message : "REDACTED_ERROR"}\n`);
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
