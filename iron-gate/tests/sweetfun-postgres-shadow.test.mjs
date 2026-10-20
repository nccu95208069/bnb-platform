import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { prepareSweetfunGroups } from "../src/sweetfun-sheet-candidate.mjs";
import { seedSweetfunShadow, advanceSweetfunShadow } from "../scripts/seed-sweetfun-shadow.mjs";
import { PostgresPropertyRepository } from "../src/postgres-repository.mjs";
import { IronGateService } from "../src/service.ts";

const runtimeUrl = process.env.IRON_GATE_PG_SHADOW_TEST_URL;
const adminUrl = process.env.IRON_GATE_PG_ADMIN_URL;
const isLocalTest = (value) => {
  if (!value) return false;
  const url = new URL(value);
  return ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.pathname === "/iron_gate_test";
};

test("Sweetfun bookings-only shadow seeds once, reads back exactly, and stays read-only",
  { skip: !runtimeUrl || !adminUrl }, async () => {
    if (!isLocalTest(runtimeUrl) || !isLocalTest(adminUrl))
      throw Error("SHADOW_TEST_REQUIRES_LOCAL_IRON_GATE_TEST_DATABASE");
    const values = Array(19).fill("");
    Object.assign(values, { 0: "101", 1: "Synthetic guest", 2: "Synthetic OTA",
      3: "2026/11/01", 4: "2026/11/02", 5: "2026/10/01", 6: "1200.50",
      7: "done", 8: "OK", 9: "synthetic-row", 11: "synthetic-parent" });
    const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [
      { rowNumber: 2, values, notes: Array(19).fill(null) }] };
    const groupKey = prepareSweetfunGroups(snapshot).candidates[0].key;
    const workspaceId = crypto.randomUUID(), propertyId = crypto.randomUUID();
    const roomIds = Object.fromEntries(["101", "102", "201", "202", "301", "302"]
      .map((room) => [room, crypto.randomUUID()]));
    const bookingId = crypto.randomUUID();
    const config = { sourceId: "synthetic-original", sourceCopyId: "synthetic-copy",
      sourceCopyCreatedAt: "2026-10-20T00:00:00.000Z",
      capturedAt: "2026-10-20T00:00:00.000Z",
      expectedSourceHash: prepareSweetfunGroups(snapshot).sourceHash,
      workspaceId, propertyId, roomIds, bookingIds: { [groupKey]: bookingId },
      inventoryVersion: 1, authorityEpoch: 0 };
    const pool = new Pool({ connectionString: runtimeUrl });
    const admin = new Pool({ connectionString: adminUrl });
    const localDatabase = { expectedDatabaseName: "iron_gate_test" };
    try {
      const first = await seedSweetfunShadow(pool, snapshot, config, localDatabase);
      assert.equal(first.action, "inserted");
      assert.equal(first.acceptedRows, 1);
      assert.equal(first.paymentEventsCreated, 0);
      assert.equal(first.canCutover, false);
      const again = await seedSweetfunShadow(pool, snapshot, config, localDatabase);
      assert.equal(again.action, "unchanged");
      const stored = await new PostgresPropertyRepository(pool).read(propertyId);
      assert.equal(stored.readOnly, true);
      assert.equal(stored.bookings.length, 1);
      assert.deepEqual(stored.bookings[0].paymentEvents, []);
      const actor = { clientId: "synthetic-os", subjectId: "synthetic-owner", origin: "os",
        workspaceId, propertyIds: [propertyId], authorityEpoch: 0,
        actions: ["booking:create"], fields: [] };
      await assert.rejects(new IronGateService(new PostgresPropertyRepository(pool))
        .createBooking(actor, propertyId, crypto.randomUUID(), {
          expectedInventoryVersion: 1,
          stays: [{ checkIn: "2026-11-03", checkOut: "2026-11-04", roomIds: [roomIds["101"]] }],
          guestName: null, contact: null, notes: null, totalCents: null,
          bookedAt: null, source: "os",
        }), (error) => error?.code === "PROPERTY_READ_ONLY");
      await assert.rejects(seedSweetfunShadow(pool, snapshot, { ...config,
        bookingIds: { [groupKey]: crypto.randomUUID() } }, localDatabase),
      /SHADOW_TARGET_CONFLICT/);
      snapshot.rows[0].values[6] = "1201.50";
      await assert.rejects(seedSweetfunShadow(pool, snapshot, config, localDatabase),
        /SWEETFUN_SOURCE_HASH_MISMATCH/);
      assert.equal((await new PostgresPropertyRepository(pool).read(propertyId))
        .bookings[0].id, bookingId);
    } finally {
      await admin.query("DELETE FROM iron_gate.occupied_room_nights WHERE property_id=$1", [propertyId]);
      await admin.query("DELETE FROM iron_gate.property_state WHERE property_id=$1", [propertyId]);
      await pool.end(); await admin.end();
    }
  });

test("Sweetfun shadow advances an additive snapshot atomically and idempotently",
  { skip: !runtimeUrl || !adminUrl }, async () => {
    if (!isLocalTest(runtimeUrl) || !isLocalTest(adminUrl))
      throw Error("SHADOW_TEST_REQUIRES_LOCAL_IRON_GATE_TEST_DATABASE");
    const makeRow = (rowNumber, room, sourceId, parentId, checkIn, checkOut) => {
      const values = Array(19).fill("");
      Object.assign(values, { 0: room, 1: "Synthetic guest", 2: "AI",
        3: checkIn, 4: checkOut, 5: "2026/10/01", 6: "1200",
        7: "not_yet", 8: "OK", 9: sourceId, 11: parentId });
      return { rowNumber, values, notes: Array(19).fill(null) };
    };
    const firstSnapshot = { headers: [...SWEETFUN_HEADERS], rows: [
      makeRow(2, "101", "synthetic-j1", "synthetic-l1", "2026/11/01", "2026/11/02") ] };
    const nextSnapshot = { headers: [...SWEETFUN_HEADERS], rows: [
      structuredClone(firstSnapshot.rows[0]),
      makeRow(3, "102", "synthetic-j2", "synthetic-l2", "2026/11/03", "2026/11/04") ] };
    const oldKey = prepareSweetfunGroups(firstSnapshot).candidates[0].key;
    const newKey = prepareSweetfunGroups(nextSnapshot).candidates[1].key;
    const workspaceId = crypto.randomUUID(), propertyId = crypto.randomUUID();
    const roomIds = Object.fromEntries(["101", "102", "201", "202", "301", "302"]
      .map((room) => [room, crypto.randomUUID()]));
    const firstConfig = { sourceId: "synthetic-original", sourceCopyId: "synthetic-copy-1",
      sourceCopyCreatedAt: "2026-10-20T00:00:00.000Z",
      capturedAt: "2026-10-20T00:00:00.000Z",
      expectedSourceHash: prepareSweetfunGroups(firstSnapshot).sourceHash,
      workspaceId, propertyId, roomIds, bookingIds: { [oldKey]: crypto.randomUUID() },
      inventoryVersion: 1, authorityEpoch: 0 };
    const nextConfig = { ...firstConfig, sourceCopyId: "synthetic-copy-2",
      sourceCopyCreatedAt: "2026-10-21T00:00:00.000Z",
      capturedAt: "2026-10-21T00:00:00.000Z",
      expectedSourceHash: prepareSweetfunGroups(nextSnapshot).sourceHash,
      bookingIds: { ...firstConfig.bookingIds, [newKey]: crypto.randomUUID() },
      inventoryVersion: 2 };
    const pool = new Pool({ connectionString: runtimeUrl });
    const admin = new Pool({ connectionString: adminUrl });
    const localDatabase = { expectedDatabaseName: "iron_gate_test" };
    try {
      await seedSweetfunShadow(pool, firstSnapshot, firstConfig, localDatabase);
      const advanced = await advanceSweetfunShadow(pool, nextSnapshot, nextConfig, localDatabase);
      assert.equal(advanced.action, "advanced");
      assert.equal(advanced.addedRows, 1);
      assert.equal(advanced.paymentEventsCreated, 0);
      assert.equal((await advanceSweetfunShadow(pool, nextSnapshot, nextConfig,
        localDatabase)).action, "unchanged");
      const stored = await new PostgresPropertyRepository(pool).read(propertyId);
      assert.equal(stored.bookings.length, 2);
      assert.equal(stored.version, 2);
      assert.equal(stored.readOnly, true);
      assert.deepEqual(stored.bookings.map((b) => b.paymentEvents), [[], []]);
      assert.equal((await admin.query(`SELECT count(*)::int AS n
        FROM iron_gate.occupied_room_nights WHERE property_id=$1`, [propertyId])).rows[0].n, 2);
      const changed = structuredClone(nextSnapshot);
      changed.rows[0].values[6] = "1201";
      await assert.rejects(advanceSweetfunShadow(pool, changed,
        { ...nextConfig, expectedSourceHash: prepareSweetfunGroups(changed).sourceHash,
          inventoryVersion: 3 }, localDatabase), /SWEETFUN_SHADOW_NON_ADDITIVE_SOURCE/);
      assert.equal((await new PostgresPropertyRepository(pool).read(propertyId)).version, 2);
    } finally {
      await admin.query("DELETE FROM iron_gate.occupied_room_nights WHERE property_id=$1", [propertyId]);
      await admin.query("DELETE FROM iron_gate.property_state WHERE property_id=$1", [propertyId]);
      await pool.end(); await admin.end();
    }
  });
