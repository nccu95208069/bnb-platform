import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFLAND_HEADERS, auditOfflandSnapshot } from "../src/offland-sheet-audit.mjs";
import { prepareOfflandShadow } from "../src/offland-shadow.mjs";
import { planOfflandAuthorityActivation, planOfflandNoWriteRollback } from
  "../src/offland-authority.mjs";
import { planOfflandCutoverCredentials, stageOfflandCutoverCredentials } from
  "../scripts/stage-offland-cutover-credentials.mjs";
import { switchOfflandAuthority } from "../scripts/switch-offland-authority.mjs";
import { nightsFor } from "../src/service.ts";

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-25T00:10:00.000Z";

function fixture() {
  const values = ["OFFLAND", "Synthetic Guest", "Booking", "2026-11-01",
    "2026-11-02", "2026-10-01", "NT$6,400", "", "OK", "night-001",
    "", "2", "", "", "", "", "order-001"];
  const snapshot = { headers: [...OFFLAND_HEADERS], rows: [
    { rowNumber: 2, values, entered: [...values], notes: Array(17).fill(null) }] };
  const config = { workspaceId: uid(1), propertyId: uid(2), roomId: uid(3),
    inventoryVersion: 1, authorityEpoch: 0,
    expectedSourceHash: auditOfflandSnapshot(snapshot).sourceHash,
    sourceId: "private-source-sheet", sourceCopyId: "private-initial-copy",
    sourceCopyCreatedAt: at, capturedAt: at,
    bookingIds: { "Q:order-001": uid(100) } };
  const state = prepareOfflandShadow(snapshot, config).state;
  const occupancy = state.bookings.flatMap((booking) =>
    nightsFor(booking.stays, state.roomIds).map((cell) =>
      ({ room_id: cell.roomId, night: cell.date, booking_id: booking.id })));
  const manifest = { propertyId: state.propertyId, workspaceId: state.workspaceId,
    sourceSystem: "offland-calendar-sheet", sourceAccount: config.sourceId,
    expectedSourceHash: config.expectedSourceHash, expectedVersion: 1,
    finalSourceCopyId: "private-final-copy",
    finalSourceCopyCreatedAt: "2026-10-25T01:00:00.000Z",
    finalCapturedAt: "2026-10-25T01:00:00.000Z",
    grantId: uid(200), cutoverTimestampMs: Date.parse("2026-10-25T00:29:00.000Z"),
    legacyFrozenAt: "2026-10-25T00:30:00.000Z",
    appsScriptFrozenAt: "2026-10-25T00:31:00.000Z",
    humanEditsFrozenAt: "2026-10-25T00:32:00.000Z",
    osWritesFrozenAt: "2026-10-25T00:33:00.000Z",
    lineDrainedAt: "2026-10-25T00:40:00.000Z",
    gmailDrainedAt: "2026-10-25T00:50:00.000Z",
    authorizedAt: "2026-10-25T01:01:00.000Z" };
  return { snapshot, config, state, occupancy, manifest };
}

test("Offland activates only exact final shadow and can roll back before a write", () => {
  const { snapshot, config, state, occupancy, manifest } = fixture();
  const activated = planOfflandAuthorityActivation(state, occupancy, snapshot,
    config, manifest);
  assert.equal(state.readOnly, true);
  assert.equal(activated.state.authorityEpoch, 1);
  assert.equal(activated.state.version, 2);
  assert.equal(activated.state.sourceGrants[0].sourceSystem, "offland-calendar-sheet");
  assert.equal(activated.state.offlandAuthority.finalSourceCopyId, "private-final-copy");
  const rolled = planOfflandNoWriteRollback(activated.state, occupancy,
    { ...manifest, rolledBackAt: "2026-10-25T01:02:00.000Z" });
  assert.equal(rolled.state.readOnly, true);
  assert.equal(rolled.state.authorityEpoch, 2);
  assert.equal(rolled.state.sourceGrants[0].active, false);
});

test("Offland activation rejects drift, missing writer freeze, and wrong source proof", () => {
  const { snapshot, config, state, occupancy, manifest } = fixture();
  const changed = structuredClone(state);
  changed.bookings[0].guestName = "Altered";
  assert.throws(() => planOfflandAuthorityActivation(changed, occupancy, snapshot,
    config, manifest), /OFFLAND_AUTHORITY_PREFLIGHT_FAILED/);
  assert.throws(() => planOfflandAuthorityActivation(state, occupancy, snapshot,
    config, { ...manifest, appsScriptFrozenAt: undefined }),
  /OFFLAND_AUTHORITY_PREFLIGHT_FAILED/);
  assert.throws(() => planOfflandAuthorityActivation(state, occupancy, snapshot,
    config, { ...manifest, finalSourceCopyId: config.sourceCopyId }),
  /OFFLAND_AUTHORITY_PREFLIGHT_FAILED/);
  assert.throws(() => planOfflandAuthorityActivation(state, occupancy, snapshot,
    config, { ...manifest, legacyFrozenAt: "2026-10-25T01:01:00.000Z" }),
  /OFFLAND_AUTHORITY_PREFLIGHT_FAILED/);
  const modified = structuredClone(snapshot);
  modified.rows[0].values[6] = "NT$6,500";
  assert.throws(() => planOfflandAuthorityActivation(state, occupancy, modified,
    config, manifest), /OFFLAND_SOURCE_HASH_MISMATCH/);
});

test("Offland rollback refuses any write or changed booking", () => {
  const { snapshot, config, state, occupancy, manifest } = fixture();
  const activated = planOfflandAuthorityActivation(state, occupancy, snapshot,
    config, manifest).state;
  const rollback = { ...manifest, rolledBackAt: "2026-10-25T01:02:00.000Z" };
  const versionChanged = structuredClone(activated);
  versionChanged.version++;
  assert.throws(() => planOfflandNoWriteRollback(versionChanged, occupancy, rollback),
    /OFFLAND_NO_WRITE_ROLLBACK_UNSAFE/);
  const changed = structuredClone(activated);
  changed.bookings[0].guestName = "Altered";
  assert.throws(() => planOfflandNoWriteRollback(changed, occupancy, rollback),
    /OFFLAND_NO_WRITE_ROLLBACK_UNSAFE/);
});

test("Offland cutover credentials stay inactive until epoch 1 and include calendar fields", () => {
  const { snapshot, config, state, occupancy, manifest } = fixture();
  const input = { ...manifest, projectRef: "brcszrkwkgiwatrxevkf",
    sourceGrantId: manifest.grantId, sourceCredentialId: uid(201),
    osCredentialId: uid(202), sourceClientId: uid(203), osClientId: uid(204),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  const planned = planOfflandCutoverCredentials(state, occupancy, snapshot,
    config, input);
  assert.equal(planned.source.authorityEpoch, 1);
  assert.equal(planned.source.sourceSystem, "offland-calendar-sheet");
  assert.deepEqual(planned.os.fields, ["guest_name", "payment_status", "money"]);
  const altered = structuredClone(state);
  altered.sourceLinks = [];
  assert.throws(() => planOfflandCutoverCredentials(altered, occupancy, snapshot,
    config, input), /OFFLAND_CREDENTIAL_PREFLIGHT_FAILED/);
});

test("Offland credential stage reads back both grants and writes tokens only privately", async () => {
  const { snapshot, config, state, occupancy, manifest } = fixture();
  const input = { ...manifest, projectRef: "brcszrkwkgiwatrxevkf",
    sourceGrantId: manifest.grantId, sourceCredentialId: uid(201),
    osCredentialId: uid(202), sourceClientId: uid(203), osClientId: uid(204),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  const saved = [], queries = [];
  const client = { release() {}, async query(sql, values = []) {
    queries.push(sql);
    if (sql.includes("FROM iron_gate.property_state"))
      return { rows: [{ state_json: state }] };
    if (sql.includes("FROM iron_gate.occupied_room_nights"))
      return { rows: occupancy };
    if (sql.includes("INSERT INTO iron_gate.credentials")) {
      saved.push({ credential_id: values[1], token_hash: values[0],
        grant_json: JSON.parse(values[3]), active: true });
      return { rowCount: 1 };
    }
    if (sql.includes("FROM iron_gate.credentials")) return { rows: saved };
    return { rows: [] };
  } };
  const pool = { async query() { return { rows: [{ login: "postgres",
    database_name: "postgres" }] }; }, async connect() { return client; } };
  const dir = await mkdtemp(join(tmpdir(), "offland-grants-"));
  const output = join(dir, "tokens.json");
  try {
    const result = await stageOfflandCutoverCredentials(pool, snapshot, config,
      input, output);
    const privateResult = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.status, "staged_inactive");
    assert.equal((await stat(output)).mode & 0o077, 0);
    assert.match(privateResult.source.token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(privateResult.osCalendarGrant.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(queries.at(-1), "COMMIT");
    assert.equal(saved.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Offland authority switch locks, updates, and reads back one property", async () => {
  const { snapshot, config, state, occupancy, manifest } = fixture();
  const input = { ...manifest, projectRef: "brcszrkwkgiwatrxevkf" };
  let stored = structuredClone(state);
  const queries = [];
  const client = { release() {}, async query(sql, values = []) {
    queries.push(sql);
    if (sql.includes("SELECT state_json, authority_epoch, inventory_version"))
      return { rows: [{ state_json: structuredClone(stored),
        authority_epoch: stored.authorityEpoch, inventory_version: stored.version }] };
    if (sql.includes("FROM iron_gate.occupied_room_nights"))
      return { rows: occupancy };
    if (sql.includes("UPDATE iron_gate.property_state")) {
      assert.equal(values[0], state.propertyId);
      assert.equal(values[7], config.expectedSourceHash);
      stored = JSON.parse(values[1]);
      return { rowCount: 1 };
    }
    return { rows: [] };
  } };
  const pool = { async query(sql) {
    if (sql.includes("FROM pg_roles")) return { rows: [{ rolsuper: false,
      rolbypassrls: false, runtime_member: true, schema_ready: true,
      property_rls: true, occupancy_rls: true, outbox_rls: true,
      can_change_schema: false, can_change_credentials: false,
      can_read_or_change_audit: false, can_change_events: false }] };
    return { rows: [{ login: "iron_gate_shadow_import", database_name: "postgres" }] };
  }, async connect() { return client; } };
  const result = await switchOfflandAuthority(pool, "activate", snapshot, config, input);
  assert.equal(result.authorityEpoch, 1);
  assert.equal(stored.readOnly, false);
  assert.equal(queries.at(-1), "COMMIT");
});
