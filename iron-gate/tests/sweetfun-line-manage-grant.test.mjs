import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSweetfunLineManageGrant, stageSweetfunLineManageGrant } from
  "../scripts/stage-sweetfun-line-manage-grant.mjs";

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
  channel: { mode: "owlnest", ready: true, sourceReadbackEnabled: true,
    websiteSalesEnabled: false, grantId: "77777777-7777-4777-8777-777777777777",
    websiteBindingId: null },
  roomIds: Array.from({ length: 6 }, (_, index) =>
    "00000000-0000-4000-8000-" + String(index + 10).padStart(12, "0")),
  sourceGrants: [{ active: true, sourceSystem: "sweetfun-calendar-sheet",
    sourceAccount: sourceId }] });

test("manage-all LINE grant requires current channel and only allows booking actions", () => {
  const planned = planSweetfunLineManageGrant(state(), manifest());
  assert.deepEqual(planned.grant.actions, ["booking:read", "booking:create", "booking:amend",
    "booking:cancel", "booking:manage_all"]);
  assert.equal(planned.grant.lineManageAllEnabled, true);
  assert.equal(planned.grant.origin, "line");
  for (const change of [
    { version: 18 }, { readOnly: true }, { authorityEpoch: 0 },
    { sourceGrants: [] }, { channel: { ...state().channel, mode: "none" } },
    { channel: { ...state().channel, sourceReadbackEnabled: false } },
    { channel: { ...state().channel, ready: false } },
  ]) assert.throws(() => planSweetfunLineManageGrant({ ...state(), ...change }, manifest()));
  assert.throws(() => planSweetfunLineManageGrant(state(),
    { ...manifest(), actorIds: [] }), /INVALID_LINE_SCOPE/);
});

test("manage grant staging rejects an existing writer and leaves database untouched", async () => {
  const output = join(tmpdir(), "synthetic-manage-grant-" + crypto.randomUUID() + ".json");
  const queries = [];
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.startsWith("SELECT state_json")) return { rows: [{ state_json: state() }] };
    if (sql.startsWith("SELECT credential_id")) return { rows: [{ credential_id: crypto.randomUUID() }] };
    return { rows: [] };
  }, release() {} };
  const pool = { async query() { return { rows: [{ login: "postgres", database_name: "postgres" }] }; },
    async connect() { return client; } };
  await assert.rejects(stageSweetfunLineManageGrant(pool, manifest(), "/not-private/secret.json"),
    /SWEETFUN_LINE_MANAGE_OUTPUT_MUST_BE_PRIVATE_TEMP/);
  await assert.rejects(stageSweetfunLineManageGrant(pool, manifest(), output),
    /SWEETFUN_LINE_WRITER_GRANT_ALREADY_ACTIVE/);
  assert.equal(queries.some((sql) => sql.startsWith("INSERT INTO iron_gate.credentials")), false);
  assert.equal(queries.includes("ROLLBACK"), true);
});
