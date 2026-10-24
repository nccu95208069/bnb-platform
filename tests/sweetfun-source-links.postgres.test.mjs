import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { PostgresPropertyRepository } from "../src/postgres-repository.mjs";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { prepareSweetfunGroups } from "../src/sweetfun-sheet-candidate.mjs";
import { prepareSweetfunShadow } from "../src/sweetfun-shadow.mjs";
import { stageSweetfunSourceLinks } from "../scripts/stage-sweetfun-source-links.mjs";

const scopedUrl = process.env.IRON_GATE_PG_SOURCE_LINK_TEST_URL;
const adminUrl = process.env.IRON_GATE_PG_SOURCE_LINK_ADMIN_URL;
function localTestUrl(value, user) {
  if (!value) return false;
  const url = new URL(value);
  return url.hostname === "127.0.0.1" && url.port &&
    url.pathname === "/iron_gate_test" && url.username === user;
}
const allowed = localTestUrl(scopedUrl, "iron_gate_shadow_import") &&
  localTestUrl(adminUrl, "postgres");

function row(j, l, room) {
  const values = Array(19).fill("");
  Object.assign(values, { 0: room, 1: "Synthetic Guest", 2: "AI",
    3: "2027/01/02", 4: "2027/01/03", 5: "2026/10/21", 6: "1200",
    7: "not_yet", 8: "OK", 9: j, 11: l });
  return { rowNumber: 2, values, notes: Array(19).fill(null) };
}

test("Postgres stores scoped Sweetfun links without changing occupancy or authority",
  { skip: !scopedUrl && !adminUrl }, async () => {
    if (!allowed) throw Error("SOURCE_LINK_TEST_REQUIRES_LOCAL_DATABASE");
    const runtime = new Pool({ connectionString: scopedUrl, max: 1 });
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    const workspaceId = crypto.randomUUID(), propertyId = crypto.randomUUID();
    const roomIds = Object.fromEntries(["101", "102", "201", "202", "301", "302"]
      .map((name) => [name, crypto.randomUUID()]));
    const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [row("synthetic-j", "synthetic-l", "101")] };
    const capturedAt = "2026-10-21T00:00:00.000Z";
    const manifest = { projectRef: "brcszrkwkgiwatrxevkf", workspaceId, propertyId,
      authorityEpoch: 0, expectedVersion: 1, sourceId: "synthetic-sheet",
      sourceCopyId: "synthetic-private-copy", sourceCopyCreatedAt: capturedAt,
      expectedSourceHash: prepareSweetfunGroups(snapshot).sourceHash };
    const state = prepareSweetfunShadow(snapshot, { ...manifest, roomIds,
      inventoryVersion: 1, capturedAt,
      bookingIds: { "L:synthetic-l": crypto.randomUUID() } }).state;
    try {
      await new PostgresPropertyRepository(runtime).seed(state);
      const first = await stageSweetfunSourceLinks(runtime, manifest,
        { expectedDatabaseName: "iron_gate_test" });
      assert.equal(first.action, "linked");
      assert.equal(first.activeLinks, 1);
      assert.equal(first.canCutover, false);
      const second = await stageSweetfunSourceLinks(runtime, manifest,
        { expectedDatabaseName: "iron_gate_test" });
      assert.equal(second.action, "unchanged");
      const observed = await new PostgresPropertyRepository(runtime).read(propertyId);
      assert.equal(observed.readOnly, true);
      assert.equal(observed.version, 1);
      assert.equal(observed.sourceGrants.length, 0);
      assert.equal(observed.sourceLinks.length, 1);
      assert.equal(observed.sourceLinks[0].key,
        JSON.stringify(["sweetfun-calendar-sheet", "synthetic-sheet", "L:synthetic-l"]));
      assert.equal(observed.sourceLinks[0].key.includes("\u0000"), false);
      await assert.rejects(stageSweetfunSourceLinks(runtime,
        { ...manifest, expectedSourceHash: "a".repeat(64) },
        { expectedDatabaseName: "iron_gate_test" }), /SOURCE_LINK_TARGET_DRIFT/);
      await assert.rejects(stageSweetfunSourceLinks(admin, manifest,
        { expectedDatabaseName: "iron_gate_test" }), /UNSAFE_DATABASE_ROLE_OR_SCHEMA/);
    } finally {
      await admin.query("DELETE FROM iron_gate.occupied_room_nights WHERE property_id = $1",
        [propertyId]);
      await admin.query("DELETE FROM iron_gate.property_state WHERE property_id = $1",
        [propertyId]);
      await runtime.end(); await admin.end();
    }
  });
