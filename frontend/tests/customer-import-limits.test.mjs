import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { importRowsTooLarge } from "../src/lib/customer-workspaces/import-limits.ts";
import { previewImport, commitImport } from "../src/lib/customer-workspaces/sheet-import.ts";
import { parseImportFile } from "../src/lib/customer-workspaces/file-import.ts";
import { customerPasswordProblem, passwordProblem, createCustomerPasswordCredential, credentialMatches } from "../src/lib/owner-password.ts";

function fixture() {
  const workspace = {
    id: "synthetic-workspace", slug: "synthetic", name: "Synthetic", version: 1,
    members: [{ accountId: "owner", role: "owner", active: true, allProperties: true, propertyIds: [] }],
    properties: [{ id: "property", name: "Synthetic property", kind: "rooms", sourceMode: "native", rooms: [{ id: "room", name: "101" }], villaRoomIds: [] }],
    bookings: [], audit: [],
  };
  const data = new Map([
    ["slug:synthetic", JSON.stringify(workspace.id)],
    ["workspace:synthetic-workspace", JSON.stringify(workspace)],
  ]);
  const store = {
    read: async (key) => ({ raw: data.get(key) ?? null, value: JSON.parse(data.get(key) ?? "null") }),
    commit: async (changes) => {
      if (changes.some((change) => (data.get(change.key) ?? null) !== change.before)) throw Error("VERSION_CONFLICT");
      for (const change of changes) data.set(change.key, JSON.stringify(change.after));
    },
  };
  return { store, data };
}

function source(count) {
  const rows = [["入住日期", "退房日期", "房間", "訂單編號"]];
  for (let i = 0; i < count; i++) {
    const date = (n) => new Date(Date.UTC(2026, 9, 20 + n)).toISOString().slice(0, 10);
    rows.push([date(i), date(i + 1), "101", `TEST-${i}`]);
  }
  return { spreadsheetId: "synthetic-sheet", sheetId: 1, title: "Synthetic reservations", rows };
}
const mapping = {
  headerRow: 1,
  columns: { checkIn: 0, checkOut: 1, rooms: 2, guestName: -1, externalId: 3, total: -1, received: -1 },
  roomMap: { "101": ["room"] }, granularity: "order", amountBasis: "none", receivedMeaning: "none", currency: "TWD", from: "2026-10-12",
};

test("customer password allows eight characters with all three required classes; owner rule stays separate", async () => {
  assert.equal(customerPasswordProblem("Abcdef1!"), null);
  for (const value of ["Abcde1!", "abcdefgh", "abcdefgh1", "abcdefgh!", "1234567!"])
    assert.ok(customerPasswordProblem(value), value);
  assert.ok(passwordProblem("Abcdef1!"));
  const credential = await createCustomerPasswordCredential("Abcdef1!");
  assert.equal(await credentialMatches("Abcdef1!", credential), true);
});

test("3,000 data rows can be previewed and committed; row 3,001 is rejected", async () => {
  const { store, data } = fixture();
  const input = source(3000);
  assert.equal(importRowsTooLarge(input.rows), false);
  assert.equal(importRowsTooLarge(source(3001).rows), true);
  const args = [store, "owner", "synthetic", "property"];
  const started = performance.now();
  const preview = await previewImport(...args, input, mapping);
  assert.equal(preview.rows.length, 3000);
  assert.equal(preview.rows.filter((row) => row.issues.length).length, 0);
  const batch = await commitImport(...args, preview.id, preview.rows.map((row) => row.row));
  assert.equal(batch.bookingIds.length, 3000);
  assert.equal(JSON.parse(data.get("workspace:synthetic-workspace")).bookings.length, 3000);
  assert.deepEqual(await commitImport(...args, preview.id, preview.rows.map((row) => row.row)), batch);
  assert.ok(performance.now() - started < 60000, "3,000-row import exceeds the server request budget");
});

test("CSV upload accepts the same 3,001 total-row boundary", async () => {
  const csv = (count) => Buffer.from(source(count).rows.map((row) => row.join(",")).join("\n") + "\n");
  const parsed = await parseImportFile(csv(3000), "synthetic.csv");
  assert.equal(parsed.tabs[0].rows.length, 3001);
  await assert.rejects(parseImportFile(csv(3001), "synthetic.csv"), /FILE_IMPORT_SIZE/);
});
