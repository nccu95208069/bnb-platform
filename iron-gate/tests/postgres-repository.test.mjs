import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { PostgresPropertyRepository } from "../src/postgres-repository.mjs";
import { PostgresCredentialDirectory } from "../src/postgres-auth.mjs";
import { IronGateService } from "../src/service.ts";
import { createPostgresIronGateHandler } from "../src/node-server.mjs";
import { inspectProperty } from "../scripts/check-property-integrity.mjs";

const connectionString = process.env.IRON_GATE_PG_TEST_URL;
const adminConnectionString = process.env.IRON_GATE_PG_ADMIN_URL;
const allowed = connectionString && (() => {
  const url = new URL(connectionString);
  return ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.pathname === "/iron_gate_test";
})();
const adminAllowed = adminConnectionString && (() => {
  const url = new URL(adminConnectionString);
  return ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.pathname === "/iron_gate_test";
})();

test("Postgres commits one last-room winner and outbox, with RLS property isolation",
  { skip: !connectionString }, async () => {
    if (!allowed) throw Error("POSTGRES_TEST_REQUIRES_LOCAL_IRON_GATE_TEST_DATABASE");
    const pool = new Pool({ connectionString, max: 4 });
    const repository = new PostgresPropertyRepository(pool);
    const workspaceId = crypto.randomUUID(), propertyId = crypto.randomUUID();
    const otherPropertyId = crypto.randomUUID(), roomId = crypto.randomUUID();
    const state = (id) => ({ workspaceId, propertyId: id, roomIds: [roomId], version: 1,
      authorityEpoch: 7, channel: { mode: "none", ready: false,
        websiteSalesEnabled: false, grantId: null, websiteBindingId: null },
      sourceGrants: [], bookings: [], sourceLinks: [], operations: [], fences: [],
      manualBlocks: [], receipts: [] });
    const principal = { clientId: "synthetic-os", subjectId: "synthetic-member", origin: "os",
      workspaceId, propertyIds: [propertyId], authorityEpoch: 7,
      actions: ["booking:create", "event:read"], fields: [] };
    const input = { expectedInventoryVersion: 1,
      stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }],
      guestName: null, contact: null, notes: null, totalCents: null,
      bookedAt: null, source: "os" };
    try {
      await repository.seed(state(propertyId));
      await repository.seed(state(otherPropertyId));
      const service = new IronGateService(repository);
      const results = await Promise.allSettled([
        service.createBooking(principal, propertyId, crypto.randomUUID(), input),
        service.createBooking(principal, propertyId, crypto.randomUUID(), input),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal((await repository.read(propertyId)).bookings.length, 1);
      assert.equal((await repository.events(propertyId, 0, 10)).length, 1);
      const integrity = await inspectProperty(pool, propertyId);
      assert.equal(integrity.ok, true);
      assert.equal(integrity.counts.expectedRoomNights, 1);
      await assert.rejects(pool.query("SELECT audit_id FROM iron_gate.audit_log"),
        (error) => error.code === "42501");
      if (adminAllowed) {
        const adminPool = new Pool({ connectionString: adminConnectionString });
        try {
          const audit = await adminPool.query(
            "SELECT audit_json FROM iron_gate.audit_log WHERE property_id = $1", [propertyId]);
          assert.equal(audit.rows.length, 1);
          assert.equal(audit.rows[0].audit_json.actorSubjectId, principal.subjectId);
        } finally { await adminPool.end(); }
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SELECT set_config('iron_gate.property_id', $1, true)", [propertyId]);
        const hidden = await client.query(
          "SELECT property_id FROM iron_gate.property_state WHERE property_id = $1", [otherPropertyId]);
        assert.equal(hidden.rows.length, 0);
        await client.query("COMMIT");
      } finally { client.release(); }
    } finally { await pool.end(); }
  });

test("Postgres runtime looks up but cannot enumerate credentials; revocation is immediate",
  { skip: !connectionString || !adminConnectionString }, async () => {
    if (!allowed || !adminAllowed) throw Error("POSTGRES_TEST_REQUIRES_LOCAL_IRON_GATE_TEST_DATABASE");
    const runtimePool = new Pool({ connectionString });
    const adminPool = new Pool({ connectionString: adminConnectionString });
    const propertyId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    const directory = new PostgresCredentialDirectory(runtimePool, adminPool);
    try {
      await new PostgresPropertyRepository(runtimePool).seed({ workspaceId, propertyId,
        roomIds: [], version: 1, authorityEpoch: 1,
        channel: { mode: "none", ready: false, websiteSalesEnabled: false,
          grantId: null, websiteBindingId: null }, sourceGrants: [], bookings: [],
        sourceLinks: [], operations: [], fences: [], manualBlocks: [], receipts: [] });
      const grant = { credentialId, workspaceId, propertyId, authorityEpoch: 1,
        clientId: "synthetic-consumer", subjectId: "synthetic-service", origin: "service",
        actions: ["event:read"], fields: [] };
      const token = await directory.issue(grant, new Date(Date.now() + 60_000).toISOString());
      assert.deepEqual(await directory.lookup(token), grant);
      await assert.rejects(runtimePool.query("SELECT token_hash FROM iron_gate.credentials"),
        (error) => error.code === "42501");
      assert.equal(await directory.revoke(credentialId), true);
      assert.equal(await directory.lookup(token), null);
      assert.equal(await directory.revoke(credentialId), false);
    } finally { await runtimePool.end(); await adminPool.end(); }
  });

test("shared PostgreSQL handler enforces a live credential on every request",
  { skip: !connectionString || !adminConnectionString }, async () => {
    if (!allowed || !adminAllowed) throw Error("POSTGRES_TEST_REQUIRES_LOCAL_IRON_GATE_TEST_DATABASE");
    const runtimePool = new Pool({ connectionString });
    const adminPool = new Pool({ connectionString: adminConnectionString });
    const propertyId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
    const directory = new PostgresCredentialDirectory(runtimePool, adminPool);
    try {
      await new PostgresPropertyRepository(runtimePool).seed({ workspaceId, propertyId,
        roomIds: [], version: 1, authorityEpoch: 1,
        channel: { mode: "none", ready: false, websiteSalesEnabled: false,
          grantId: null, websiteBindingId: null }, sourceGrants: [], bookings: [],
        sourceLinks: [], operations: [], fences: [], manualBlocks: [], receipts: [] });
      const credentialId = crypto.randomUUID();
      const token = await directory.issue({ credentialId, workspaceId, propertyId,
        authorityEpoch: 1, clientId: "synthetic-consumer", subjectId: "synthetic-service",
        origin: "service", actions: ["event:read"], fields: [] },
      new Date(Date.now() + 60_000).toISOString());
      const handler = createPostgresIronGateHandler(runtimePool, null, connectionString);
      const request = () => new Request(
        `https://iron-gate.example/v1/properties/${propertyId}/events`,
        { headers: { authorization: `Bearer ${token}` } });
      const accepted = await handler(request());
      assert.equal(accepted.status, 200);
      assert.deepEqual(await accepted.json(), { propertyId, events: [],
        nextCursor: 0, hasMore: false });
      await directory.revoke(credentialId);
      const rejected = await handler(request());
      assert.equal(rejected.status, 401);
    } finally { await runtimePool.end(); await adminPool.end(); }
  });
