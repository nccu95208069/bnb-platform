import test from "node:test";
import assert from "node:assert/strict";
import { validateDatabaseTransport } from "../src/main.mjs";
import { createPostgresIronGateHandler } from "../src/node-server.mjs";
import { restoreDrill } from "../scripts/pg-restore-drill.mjs";

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

test("restore drill refuses any nonlocal or non-test database", async () => {
  for (const url of [
    "postgresql://postgres@db.example.test/iron_gate_test",
    "postgresql://postgres@127.0.0.1:55432/production",
    "postgresql://postgres@127.0.0.1:55432/iron_gate_test?host=db.example.test",
  ]) await assert.rejects(restoreDrill({ IRON_GATE_PG_ADMIN_URL: url }),
    /RESTORE_DRILL_LOCAL_TEST_ONLY/);
});
