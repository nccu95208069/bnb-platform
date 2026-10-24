import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSweetfunLineReadGrant, stageSweetfunLineReadGrant } from
  "../scripts/stage-sweetfun-line-read-grant.mjs";

const propertyId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sourceId = "synthetic-sheet";
const manifest = () => ({ projectRef: "brcszrkwkgiwatrxevkf", propertyId, workspaceId,
  expectedVersion: 17, credentialId: "33333333-3333-4333-8333-333333333333",
  grantId: "44444444-4444-4444-8444-444444444444",
  clientId: "55555555-5555-4555-8555-555555555555",
  groupId: "synthetic-group", actorIds: ["synthetic-staff"],
  expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() });
const state = () => ({ propertyId, workspaceId, version: 17,
  authorityEpoch: 1, readOnly: false,
  sweetfunImport: { sourceId },
  channel: { mode: "none", ready: false, websiteSalesEnabled: false,
    grantId: null, websiteBindingId: null },
  roomIds: Array.from({ length: 6 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`),
  sourceGrants: [{ active: true, sourceSystem: "sweetfun-calendar-sheet",
    sourceAccount: sourceId }] });

test("LINE read issuance is confined to current Sweetfun authority and read scope", () => {
  const planned = planSweetfunLineReadGrant(state(), manifest());
  assert.deepEqual(planned.grant.actions, ["booking:read"]);
  assert.equal(planned.grant.origin, "line");
  assert.deepEqual(planned.grant.lineActorIds, ["synthetic-staff"]);
  for (const change of [
    { authorityEpoch: 0 }, { readOnly: true }, { version: 18 },
    { sourceGrants: [] }, { channel: { ...state().channel, mode: "owlnest" } },
    { channel: { ...state().channel, sourceReadbackEnabled: true } },
  ]) assert.throws(() => planSweetfunLineReadGrant({ ...state(), ...change }, manifest()));
  assert.throws(() => planSweetfunLineReadGrant(state(),
    { ...manifest(), actorIds: [] }), /INVALID_LINE_SCOPE/);
  assert.throws(() => planSweetfunLineReadGrant(state(),
    { ...manifest(), groupId: "other group" }), /INVALID_LINE_SCOPE/);
});

test("LINE read staging refuses non-private output and duplicate active grants", async () => {
  const output = join(tmpdir(), `synthetic-line-grant-${crypto.randomUUID()}.json`);
  let queries = [];
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.startsWith("SELECT state_json")) return { rows: [{ state_json: state() }] };
    if (sql.startsWith("SELECT credential_id")) return { rows: [{ credential_id: crypto.randomUUID() }] };
    return { rows: [] };
  }, release() {} };
  const pool = { async query() { return { rows: [{ login: "postgres", database_name: "postgres" }] }; },
    async connect() { return client; } };
  await assert.rejects(stageSweetfunLineReadGrant(pool, manifest(), "/not-private/secret.json"),
    /SWEETFUN_LINE_READ_OUTPUT_MUST_BE_PRIVATE_TEMP/);
  await assert.rejects(stageSweetfunLineReadGrant(pool, manifest(), output),
    /SWEETFUN_LINE_READ_GRANT_ALREADY_ACTIVE/);
  assert.equal(queries.some((sql) => sql.startsWith("INSERT INTO iron_gate.credentials")), false);
  assert.equal(queries.includes("ROLLBACK"), true);
});
