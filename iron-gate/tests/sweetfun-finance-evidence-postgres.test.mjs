import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { auditSweetfunFinanceSources } from "../scripts/audit-sweetfun-finance-sources.mjs";
import { stageSweetfunFinanceEvidence } from "../scripts/stage-sweetfun-finance-evidence.mjs";

const adminUrl = process.env.IRON_GATE_PG_ADMIN_URL;
const importUrl = process.env.IRON_GATE_PG_EVIDENCE_TEST_URL;
const local = (raw) => {
  if (!raw) return false;
  const url = new URL(raw);
  return ["127.0.0.1", "localhost"].includes(url.hostname) &&
    url.pathname === "/iron_gate_test";
};
const fs = (value) => {
  if (value && typeof value === "object") return { mapValue: { fields:
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fs(item)])) } };
  if (typeof value === "number") return { integerValue: String(value) };
  return { stringValue: String(value) };
};
const doc = (value) => ({ fields: Object.fromEntries(Object.entries(value)
  .map(([key, item]) => [key, fs(item)])) });

function fixture(propertyId, workspaceId, captureId) {
  const sourceJ = "synthetic-j", parentL = "synthetic-line-order";
  const sourceHash = "a".repeat(64);
  const row = { values: Array(19).fill(""), notes: Array(19).fill(null) };
  row.values[7] = "not_yet"; row.values[9] = sourceJ; row.values[11] = parentL;
  const state = { propertyId, workspaceId, authorityEpoch: 0, version: 1,
    readOnly: true, channel: { ready: false, websiteSalesEnabled: false },
    sweetfunImport: { sourceHash, sourceId: "synthetic-sheet-source",
      capturedAt: "2026-10-20T00:00:00.000Z", quarantined: [] },
    bookings: [{ paymentEvents: [], sweetfunSnapshot: { rows: [row] } }] };
  const entry = { entry_id: "synthetic-line-entry", order_id: parentL,
    kind: "deposit", status: "active", version: 1, amount: 1000,
    paid_on: "2026-10-21" };
  const operationId = "synthetic-operation";
  const sources = [
    { schema: 1, records: [{ key: "sweetfun-os:finance:v1:sweetfun:2026",
      raw: JSON.stringify({ entries: [], operations: [] }) }] },
    { schema: 1, collections: {
      entries: [doc(entry)], versions: [doc(entry)],
      operations: [doc({ confirmation: { id: operationId }, status: "recorded",
        result: { status: "recorded", entry, projection_sequence: 1 } })],
      events: [doc({ operation_id: operationId })],
      audit: [doc({ after: entry, operation_id: operationId, sequence: 1 })],
      outbox: [doc({ entry, operation_id: operationId, digest: "digest", sequence: 1 })],
      projection_receipts: [doc({ digest: "digest", sequence: 1 })],
    } },
    { sourceId: "synthetic-sheet-source", rows: [
      { sourceJ, parentL, markerH: "not_yet", noteH: "" }] },
    { entryId: entry.entry_id, orderId: parentL, kind: "deposit",
      status: "active", version: 1, amountCents: 100000 },
  ];
  const normalizedSourceHash = auditSweetfunFinanceSources(...sources).report.sourceHash;
  const manifest = { propertyId, captureId, sheetSourceHash: sourceHash,
    normalizedSourceHash, sourceCopyId: "synthetic-private-copy",
    sourceCopyCreatedAt: "2026-10-20T00:00:00.000Z",
    capturedAt: "2026-10-21T00:00:00.000Z" };
  return { state, sources: sources.map(JSON.stringify), manifest };
}

test("restricted finance evidence stages once and cannot alter booking or payment state",
  { skip: !adminUrl || !importUrl }, async () => {
    if (!local(adminUrl) || !local(importUrl))
      throw Error("EVIDENCE_TEST_REQUIRES_LOCAL_IRON_GATE_TEST_DATABASE");
    const admin = new Pool({ connectionString: adminUrl });
    const importer = new Pool({ connectionString: importUrl });
    const propertyId = randomUUID(), workspaceId = randomUUID(), captureId = randomUUID();
    const { state, sources, manifest } = fixture(propertyId, workspaceId, captureId);
    try {
      await admin.query(`INSERT INTO iron_gate.property_state
        (property_id, workspace_id, authority_epoch, inventory_version, state_json)
        VALUES ($1,$2,0,1,$3::jsonb)`, [propertyId, workspaceId, JSON.stringify(state)]);
      const options = { expectedDatabaseName: "iron_gate_test" };
      const first = await stageSweetfunFinanceEvidence(importer, sources, manifest, options);
      assert.equal(first.action, "inserted");
      assert.equal(first.sourceCount, 4);
      assert.equal(first.paymentEventsCreated, 0);
      assert.equal((await stageSweetfunFinanceEvidence(importer, sources,
        manifest, options)).action, "unchanged");
      const changedRaw = [...sources];
      changedRaw[0] += " ";
      await assert.rejects(stageSweetfunFinanceEvidence(importer, changedRaw,
        manifest, options), /EVIDENCE_READBACK_MISMATCH/);
      const changedMap = [...sources];
      const map = JSON.parse(changedMap[2]);
      map.rows[0].markerH = "done";
      changedMap[2] = JSON.stringify(map);
      const changedHash = auditSweetfunFinanceSources(...changedMap.map(JSON.parse))
        .report.sourceHash;
      await assert.rejects(stageSweetfunFinanceEvidence(importer, changedMap,
        { ...manifest, normalizedSourceHash: changedHash }, options),
      /EVIDENCE_SHADOW_ROW_MISMATCH/);
      const stored = await admin.query(`SELECT count(*)::int AS n FROM
        iron_gate.migration_source_evidence WHERE capture_id=$1`, [captureId]);
      assert.equal(stored.rows[0].n, 4);
      assert.equal((await importer.query(`SELECT count(*)::int AS n FROM
        iron_gate.migration_source_evidence WHERE capture_id=$1`,
      [captureId])).rows[0].n, 0);
      assert.equal((await admin.query(`SELECT state_json FROM iron_gate.property_state
        WHERE property_id=$1`, [propertyId])).rows[0].state_json.bookings[0]
        .paymentEvents.length, 0);
      await assert.rejects(importer.query(`UPDATE iron_gate.property_state
        SET inventory_version=2 WHERE property_id=$1`, [propertyId]),
      (error) => error?.code === "42501");
    } finally {
      await admin.query("DELETE FROM iron_gate.migration_source_evidence WHERE capture_id=$1",
        [captureId]);
      await admin.query("DELETE FROM iron_gate.property_state WHERE property_id=$1",
        [propertyId]);
      await importer.end(); await admin.end();
    }
  });
