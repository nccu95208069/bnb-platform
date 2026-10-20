import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { prepareSweetfunGroups } from "../src/sweetfun-sheet-candidate.mjs";
import { seedSweetfunShadow } from "../scripts/seed-sweetfun-shadow.mjs";
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
