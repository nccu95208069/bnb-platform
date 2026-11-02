import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateDatabaseTransport } from "../src/main.mjs";
import { createPostgresIronGateHandler } from "../src/node-server.mjs";
import { assertRuntimeDatabase } from "../src/runtime-safety.mjs";
import { restoreDrill } from "../scripts/pg-restore-drill.mjs";

test("finance audit emergency revoke restores the runtime role invariant", async () => {
  const grant = await readFile(new URL("../sql/013_finance_ssot_activity_read.sql",
    import.meta.url), "utf8");
  const revoke = await readFile(new URL("../sql/019_finance_audit_read_emergency_revoke.sql",
    import.meta.url), "utf8");
  assert.match(grant, /GRANT SELECT ON iron_gate\.audit_log TO iron_gate_runtime;/);
  assert.match(revoke, /REVOKE SELECT ON iron_gate\.audit_log FROM iron_gate_runtime;/);
  const identity = { rolsuper: false, rolbypassrls: false,
    runtime_member: true, schema_ready: true, property_rls: true,
    occupancy_rls: true, outbox_rls: true, can_change_schema: false,
    can_change_credentials: false, can_change_events: false };
  let auditSelect = true;
  const pool = { async query(sql) {
    assert.match(sql, /has_table_privilege\(current_user, 'iron_gate\.audit_log'/);
    return { rows: [{ ...identity, can_read_or_change_audit: auditSelect }] };
  } };
  await assert.rejects(assertRuntimeDatabase(pool), /UNSAFE_DATABASE_ROLE_OR_SCHEMA/);
  auditSelect = false;
  await assert.doesNotReject(assertRuntimeDatabase(pool));
});

test("remote booking database requires hostname-verified TLS", () => {
  assert.doesNotThrow(() => validateDatabaseTransport(
    "postgresql://user:secret@db.example.test/iron_gate?sslmode=verify-full"));
  assert.doesNotThrow(() => validateDatabaseTransport(
    "postgresql://user@127.0.0.1:55432/iron_gate_test"));
  for (const url of [
    "postgresql://user:secret@db.example.test/iron_gate",
    "postgresql://user:secret@db.example.test/iron_gate?sslmode=require",
    "postgresql://user:secret@db.example.test/iron_gate?sslmode=verify-full&ssl=no-verify",
    "postgresql://user@127.0.0.1/iron_gate_test?host=db.example.test",
    "postgresql://user:secret@db.example.test/iron_gate?sslmode=verify-full&sslmode=disable",
    "file:///private/tmp/iron_gate_test",
  ]) assert.throws(() => validateDatabaseTransport(url), /UNSAFE_DATABASE_TRANSPORT/);
});

test("shared HTTP handler refuses an unsafe database role before reading credentials", async () => {
  let checks = 0;
  const pool = {
    options: { connectionString: "postgresql://user@127.0.0.1:55432/iron_gate_test" },
    async query() {
      checks++;
      return { rows: [{ rolsuper: true, rolbypassrls: false,
        runtime_member: true, schema_ready: true, property_rls: true,
        occupancy_rls: true, outbox_rls: true, can_change_schema: false,
        can_change_credentials: false, can_read_or_change_audit: false,
        can_change_events: false }] };
    },
    async connect() { throw Error("CREDENTIAL_LOOKUP_MUST_NOT_RUN"); },
  };
  assert.throws(() => createPostgresIronGateHandler(pool), /UNSAFE_DATABASE_TRANSPORT/);
  assert.throws(() => createPostgresIronGateHandler(pool, null,
    "postgresql://user@db.example.test/iron_gate?sslmode=require"),
  /UNSAFE_DATABASE_TRANSPORT/);
  assert.throws(() => createPostgresIronGateHandler(pool, null,
    "postgresql://other@127.0.0.1:55432/iron_gate_test"),
  /UNSAFE_DATABASE_TRANSPORT/);
  assert.throws(() => createPostgresIronGateHandler({ ...pool,
    options: { ...pool.options, ssl: { rejectUnauthorized: false } } }, null,
  pool.options.connectionString), /UNSAFE_DATABASE_TRANSPORT/);
  const handle = createPostgresIronGateHandler(pool, null,
    "postgresql://user@127.0.0.1:55432/iron_gate_test");
  const request = new Request("http://iron-gate.internal/v1/properties/" +
    crypto.randomUUID() + "/bookings/" + crypto.randomUUID());
  const first = await handle(request);
  const second = await handle(request);
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { error: { code: "SERVICE_UNAVAILABLE" } });
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.equal(second.status, 503);
  assert.equal(checks, 1);
});

test("shared HTTP handler retries the role check after a transient database outage", async () => {
  let checks = 0;
  const connectionString = "postgresql://user@127.0.0.1:55432/iron_gate_test";
  const pool = {
    options: { connectionString },
    async query() {
      checks++;
      if (checks === 1) throw Object.assign(Error("temporary database outage"),
        { code: "ECONNREFUSED" });
      return { rows: [{ rolsuper: false, rolbypassrls: false,
        runtime_member: true, schema_ready: true, property_rls: true,
        occupancy_rls: true, outbox_rls: true, can_change_schema: false,
        can_change_credentials: false, can_read_or_change_audit: false,
        can_change_events: false }] };
    },
    async connect() { throw Error("CREDENTIAL_LOOKUP_MUST_NOT_RUN"); },
  };
  const handle = createPostgresIronGateHandler(pool, null, connectionString);
  const request = new Request("http://iron-gate.internal/v1/properties/" +
    crypto.randomUUID() + "/events");
  assert.equal((await handle(request)).status, 503);
  assert.equal((await handle(request)).status, 401);
  assert.equal(checks, 2);
});

test("restore drill refuses any nonlocal or non-test database", async () => {
  for (const url of [
    "postgresql://postgres@db.example.test/iron_gate_test",
    "postgresql://postgres@127.0.0.1:55432/production",
    "postgresql://postgres@127.0.0.1:55432/iron_gate_test?host=db.example.test",
  ]) await assert.rejects(restoreDrill({ IRON_GATE_PG_ADMIN_URL: url }),
    /RESTORE_DRILL_LOCAL_TEST_ONLY/);
});
