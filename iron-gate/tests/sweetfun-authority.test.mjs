import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SWEETFUN_HEADERS } from "../src/sweetfun-sheet-audit.mjs";
import { prepareSweetfunGroups } from "../src/sweetfun-sheet-candidate.mjs";
import { prepareSweetfunShadow } from "../src/sweetfun-shadow.mjs";
import { prepareSweetfunSourceLinks } from "../src/sweetfun-source-links.mjs";
import { planSweetfunAuthorityActivation, planSweetfunNoWriteRollback } from
  "../src/sweetfun-authority.mjs";
import { planSweetfunCutoverCredentials, stageSweetfunCutoverCredentials } from
  "../scripts/stage-sweetfun-cutover-credentials.mjs";
import { nightsFor } from "../src/service.ts";

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture() {
  const names = ["101", "102", "201", "202", "301", "302"];
  const roomIds = Object.fromEntries(names.map((name, i) => [name, uid(i + 10)]));
  const values = Array(19).fill("");
  Object.assign(values, { 0: "101", 1: "Synthetic guest", 2: "AI",
    3: "2026/11/01", 4: "2026/11/02", 5: "2026/10/01", 6: "1200",
    7: "not_yet", 8: "OK", 9: "synthetic-j", 11: "synthetic-ota" });
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: [
    { rowNumber: 2, values, notes: Array(19).fill(null) }] };
  const config = { workspaceId: uid(1), propertyId: uid(2), roomIds,
    sourceId: "synthetic-sheet", capturedAt: "2026-10-20T00:00:00.000Z",
    expectedSourceHash: prepareSweetfunGroups(snapshot).sourceHash,
    inventoryVersion: 8, authorityEpoch: 0,
    bookingIds: { "L:synthetic-ota": uid(100) } };
  const state = prepareSweetfunSourceLinks(prepareSweetfunShadow(snapshot, config).state,
    "sweetfun-calendar-sheet", config.sourceId).state;
  const occupancy = state.bookings.flatMap((booking) =>
    nightsFor(booking.stays, state.roomIds).map((cell) =>
      ({ room_id: cell.roomId, night: cell.date, booking_id: booking.id })));
  const manifest = { propertyId: state.propertyId, workspaceId: state.workspaceId,
    sourceSystem: "sweetfun-calendar-sheet", sourceAccount: config.sourceId,
    expectedSourceHash: config.expectedSourceHash, expectedVersion: 8,
    grantId: uid(200), legacyFrozenAt: "2026-10-19T23:00:00.000Z",
    gmailDrainedAt: "2026-10-19T23:30:00.000Z",
    cutoverTimestampMs: Date.parse("2026-10-19T23:29:00.000Z"),
    authorizedAt: "2026-10-20T00:01:00.000Z" };
  return { state, occupancy, manifest };
}

test("a complete frozen source can activate, then roll back before any write", () => {
  const { state, occupancy, manifest } = fixture();
  const planned = planSweetfunAuthorityActivation(state, occupancy, manifest);
  assert.equal(state.readOnly, true);
  assert.equal(planned.state.readOnly, false);
  assert.equal(planned.state.authorityEpoch, 1);
  assert.equal(planned.state.version, 9);
  assert.equal(planned.state.sourceGrants[0].grantId, manifest.grantId);
  const rolled = planSweetfunNoWriteRollback(planned.state, occupancy,
    { ...manifest, rolledBackAt: "2026-10-20T00:02:00.000Z" });
  assert.equal(rolled.state.readOnly, true);
  assert.equal(rolled.state.authorityEpoch, 2);
  assert.equal(rolled.state.sourceGrants[0].active, false);
});

test("activation refuses missing links, occupancy drift, unfrozen source and review rows", () => {
  const { state, occupancy, manifest } = fixture();
  const missing = structuredClone(state);
  missing.sourceLinks = [];
  assert.throws(() => planSweetfunAuthorityActivation(missing, occupancy, manifest));
  assert.throws(() => planSweetfunAuthorityActivation(state, [], manifest));
  assert.throws(() => planSweetfunAuthorityActivation(state, occupancy,
    { ...manifest, legacyFrozenAt: "2026-10-20T00:02:00.000Z" }));
  assert.throws(() => planSweetfunAuthorityActivation(state, occupancy,
    { ...manifest, cutoverTimestampMs: Date.parse("2026-10-20T00:02:00.000Z") }));
  const review = structuredClone(state);
  review.sweetfunImport.quarantined.push({ reason: "synthetic" });
  assert.throws(() => planSweetfunAuthorityActivation(review, occupancy, manifest));
});

test("rollback refuses a changed version or booking even with no operation marker", () => {
  const { state, occupancy, manifest } = fixture();
  const activated = planSweetfunAuthorityActivation(state, occupancy, manifest).state;
  const rollback = { ...manifest, rolledBackAt: "2026-10-20T00:02:00.000Z" };
  const written = structuredClone(activated);
  written.version++;
  assert.throws(() => planSweetfunNoWriteRollback(written, occupancy, rollback));
  const changed = structuredClone(activated);
  changed.bookings[0].guestName = "Changed";
  assert.throws(() => planSweetfunNoWriteRollback(changed, occupancy, rollback));
});

test("cutover credentials are scoped to the next epoch and reject incomplete links", () => {
  const { state, occupancy, manifest } = fixture();
  const credentialManifest = { ...manifest, projectRef: "brcszrkwkgiwatrxevkf",
    sourceGrantId: manifest.grantId, sourceCredentialId: uid(201),
    osCredentialId: uid(202), sourceClientId: uid(203), osClientId: uid(204),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  const planned = planSweetfunCutoverCredentials(state, occupancy, credentialManifest);
  assert.equal(planned.source.authorityEpoch, 1);
  assert.equal(planned.source.grantId, manifest.grantId);
  assert.deepEqual(planned.source.actions, ["source:write"]);
  assert.equal(planned.os.authorityEpoch, 1);
  assert.deepEqual(planned.os.actions, ["booking:read", "occupancy:aggregate"]);
  const missing = structuredClone(state);
  missing.sourceLinks = [];
  assert.throws(() => planSweetfunCutoverCredentials(missing, occupancy,
    credentialManifest), /SWEETFUN_CREDENTIAL_PREFLIGHT_FAILED/);
  assert.throws(() => planSweetfunCutoverCredentials(state, occupancy,
    { ...credentialManifest, expectedVersion: 7 }),
  /SWEETFUN_CREDENTIAL_PREFLIGHT_FAILED/);
});

test("credential staging reads back both grants before commit and stores tokens privately", async () => {
  const { state, occupancy, manifest } = fixture();
  const input = { ...manifest, projectRef: "brcszrkwkgiwatrxevkf",
    sourceGrantId: manifest.grantId, sourceCredentialId: uid(201),
    osCredentialId: uid(202), sourceClientId: uid(203), osClientId: uid(204),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  const saved = [];
  const queries = [];
  const client = { release() {}, async query(sql, values = []) {
    queries.push(sql);
    if (sql.includes("FROM iron_gate.property_state")) return { rows: [{ state_json: state }] };
    if (sql.includes("FROM iron_gate.occupied_room_nights")) return { rows: occupancy };
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
  const dir = await mkdtemp(join(tmpdir(), "sweetfun-grants-"));
  const output = join(dir, "tokens.json");
  try {
    const result = await stageSweetfunCutoverCredentials(pool, input, output);
    const privateResult = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.status, "staged_inactive");
    assert.equal((await stat(output)).mode & 0o077, 0);
    assert.match(privateResult.source.token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(privateResult.osCalendarGrant.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(queries.at(-1), "COMMIT");
    assert.equal(saved.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
