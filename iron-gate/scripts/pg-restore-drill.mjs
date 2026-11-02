import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { IronGateService } from "../src/service.ts";
import { PostgresPropertyRepository } from "../src/postgres-repository.mjs";
import { PostgresCredentialDirectory } from "../src/postgres-auth.mjs";
import { assertRuntimeDatabase } from "../src/runtime-safety.mjs";
import { inspectProperty } from "./check-property-integrity.mjs";

const run = promisify(execFile);
const tables = ["property_state", "occupied_room_nights", "outbox", "audit_log", "credentials"];

function localAdminUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error("RESTORE_DRILL_LOCAL_TEST_ONLY"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/iron_gate_test" || url.search || !url.username ||
    (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1)))
    throw Error("RESTORE_DRILL_LOCAL_TEST_ONLY");
  return url;
}

function databaseUrl(template, database, user = null) {
  const url = new URL(template);
  url.pathname = `/${database}`;
  if (user) { url.username = user; url.password = ""; }
  return url.toString();
}

async function snapshot(pool) {
  const result = {};
  for (const table of tables) {
    const rows = await pool.query(`SELECT * FROM iron_gate.${table}`);
    result[table] = rows.rows.map((row) => JSON.stringify(row)).sort();
  }
  const sequence = await pool.query("SELECT last_value, is_called FROM iron_gate.outbox_cursor_seq");
  result.sequence = sequence.rows;
  return result;
}

export async function restoreDrill(env = process.env) {
  const adminUrl = localAdminUrl(env.IRON_GATE_PG_ADMIN_URL);
  const runtimeUser = env.IRON_GATE_PG_RUNTIME_USER ?? "iron_gate_test_login";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeUser)) throw Error("INVALID_TEST_RUNTIME_USER");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const source = `ig_drill_src_${suffix}`, target = `ig_drill_dst_${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "iron-gate-restore-"));
  const dump = join(directory, "source.dump");
  const maintenance = new Pool({ connectionString: databaseUrl(adminUrl, "postgres"), max: 1 });
  const created = [];
  const binary = (name) => env.IRON_GATE_PG_BIN ? join(env.IRON_GATE_PG_BIN, name) : name;
  const processEnv = { ...process.env, PGHOST: adminUrl.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: adminUrl.port || "5432", PGUSER: decodeURIComponent(adminUrl.username),
    PGPASSWORD: decodeURIComponent(adminUrl.password), PGCONNECT_TIMEOUT: "5" };
  try {
    for (const database of [source, target]) {
      // Include an uncertain CREATE result in cleanup as well.
      created.push(database);
      await maintenance.query(`CREATE DATABASE "${database}"`);
    }
    const sourceAdmin = new Pool({ connectionString: databaseUrl(adminUrl, source), max: 1 });
    const sourceRuntime = new Pool({ connectionString: databaseUrl(adminUrl, source, runtimeUser), max: 2 });
    try {
      const sqlDirectory = join(dirname(fileURLToPath(import.meta.url)), "../sql");
      for (const filename of ["001_property_store.sql", "002_policy_plan_and_credential_index.sql"])
        await sourceAdmin.query(await readFile(join(sqlDirectory, filename), "utf8"));
      await assertRuntimeDatabase(sourceRuntime);
      const workspaceId = randomUUID(), propertyId = randomUUID(), roomId = randomUUID();
      const repository = new PostgresPropertyRepository(sourceRuntime);
      await repository.seed({ workspaceId, propertyId, roomIds: [roomId], version: 1,
        authorityEpoch: 1, channel: { mode: "none", ready: false,
          websiteSalesEnabled: false, grantId: null, websiteBindingId: null },
        sourceGrants: [], bookings: [], sourceLinks: [], operations: [], fences: [],
        manualBlocks: [], receipts: [] });
      await new IronGateService(repository).createBooking({ clientId: "restore-drill",
        subjectId: "synthetic-member", origin: "os", workspaceId, propertyIds: [propertyId],
        authorityEpoch: 1, actions: ["booking:create"], fields: [] }, propertyId,
      randomUUID(), { expectedInventoryVersion: 1,
        stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }],
        guestName: null, contact: null, notes: null, totalCents: null,
        bookedAt: null, source: "os" });
      const credentialId = randomUUID();
      await new PostgresCredentialDirectory(sourceRuntime, sourceAdmin).issue({
        credentialId, workspaceId, propertyId, authorityEpoch: 1,
        clientId: "restore-drill", subjectId: "synthetic-service", origin: "service",
        actions: ["event:read"], fields: [] }, new Date(Date.now() + 60_000).toISOString());
      const before = await snapshot(sourceAdmin);
      assert.equal((await inspectProperty(sourceRuntime, propertyId)).ok, true);
      assert.equal(before.property_state.length, 1);
      assert.equal(before.occupied_room_nights.length, 1);
      assert.equal(before.outbox.length, 1);
      assert.equal(before.audit_log.length, 1);
      assert.equal(before.credentials.length, 1);
      await run(binary("pg_dump"), ["--format=custom", "--schema=iron_gate",
        `--file=${dump}`, source], { env: processEnv, timeout: 30_000 });
      await run(binary("pg_restore"), ["--no-owner", "--exit-on-error",
        `--dbname=${target}`, dump], { env: processEnv, timeout: 30_000 });
      const targetAdmin = new Pool({ connectionString: databaseUrl(adminUrl, target), max: 1 });
      const targetRuntime = new Pool({ connectionString: databaseUrl(adminUrl, target, runtimeUser), max: 1 });
      try {
        assert.deepEqual(await snapshot(targetAdmin), before);
        await assertRuntimeDatabase(targetRuntime);
        const restored = await new PostgresPropertyRepository(targetRuntime).read(propertyId);
        assert.equal(restored.bookings.length, 1);
        assert.equal(restored.receipts[0].subjectId, "synthetic-member");
        assert.equal((await inspectProperty(targetRuntime, propertyId)).ok, true);
      } finally { await targetRuntime.end(); await targetAdmin.end(); }
    } finally { await sourceRuntime.end(); await sourceAdmin.end(); }
    return { tablesChecked: tables.length, runtimeRoleChecked: true };
  } finally {
    let cleanupError = null;
    for (const database of created.reverse()) {
      try { await maintenance.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); }
      catch (error) { cleanupError ??= error; }
    }
    try { await maintenance.end(); } catch (error) { cleanupError ??= error; }
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { cleanupError ??= error; }
    if (cleanupError) throw cleanupError;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await restoreDrill();
    process.stdout.write(`restore drill passed: ${result.tablesChecked} tables and runtime role\n`);
  } catch {
    process.stderr.write("restore drill failed\n");
    process.exitCode = 1;
  }
}
