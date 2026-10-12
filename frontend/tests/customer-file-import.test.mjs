import test from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";
import { parseImportFile, stageImportFile } from "../src/lib/customer-workspaces/file-import.ts";
import { sourceFor } from "../src/lib/customer-workspaces/customer-google.ts";
import { previewImport, commitImport } from "../src/lib/customer-workspaces/sheet-import.ts";

function fixture() {
  const data = new Map();
  for (const tenant of ["a", "b"]) {
    const workspace = {
      id: `workspace-${tenant}`, slug: `tenant-${tenant}`, name: `Tenant ${tenant}`, version: 1,
      members: [{ accountId: `owner-${tenant}`, role: "owner", active: true, allProperties: true, propertyIds: [] }],
      properties: [{
        id: `property-${tenant}`, name: `Property ${tenant}`, kind: "rooms", sourceMode: "native",
        rooms: [{ id: `room-${tenant}`, name: "101" }], villaRoomIds: [],
      }],
      bookings: [], audit: [],
    };
    data.set(`slug:tenant-${tenant}`, JSON.stringify(workspace.id));
    data.set(`workspace:workspace-${tenant}`, JSON.stringify(workspace));
  }
  const store = {
    read: async (key) => ({ raw: data.get(key) ?? null, value: JSON.parse(data.get(key) ?? "null") }),
    commit: async (changes) => {
      if (changes.some((c) => (data.get(c.key) ?? null) !== c.before)) throw Error("VERSION_CONFLICT");
      for (const change of changes) data.set(change.key, JSON.stringify(change.after));
    },
  };
  return { store, data };
}

const rows = "入住日期,退房日期,房間,姓名,訂單編號\n2026-10-20,2026-10-22,101,Example,OTA-1\n";
const mapping = {
  headerRow: 1,
  columns: { checkIn: 0, checkOut: 1, rooms: 2, guestName: 3, externalId: 4, total: -1, received: -1 },
  roomMap: { "101": ["room-a"] }, granularity: "order", amountBasis: "none",
  receivedMeaning: "none", currency: "TWD", from: "2026-10-12",
};

test("CSV file source stays inside its tenant, previews, commits and exact retry deduplicates", async () => {
  const { store } = fixture();
  const args = [store, "owner-a", "tenant-a", "property-a"];
  const staged = await stageImportFile(...args, Buffer.from(rows), "bookings.csv");
  assert.equal(staged.tabs.length, 1);
  const source = await sourceFor(...args, staged.tabs[0].sourceId);
  assert.equal(source.rows[1][0], "2026-10-20");
  await assert.rejects(sourceFor(store, "owner-b", "tenant-b", "property-b", staged.tabs[0].sourceId), /NOT_FOUND/);
  const preview = await previewImport(...args, source, mapping);
  assert.equal(preview.rows[0].issues.length, 0);
  const batch = await commitImport(...args, preview.id, [preview.rows[0].row]);
  assert.equal(batch.bookingIds.length, 1);
  assert.deepEqual(await commitImport(...args, preview.id, [preview.rows[0].row]), batch);
  const updated = await stageImportFile(...args, Buffer.from(rows), "bookings.csv");
  const repeat = await previewImport(...args, await sourceFor(...args, updated.tabs[0].sourceId), mapping);
  assert.match(repeat.rows[0].issues.join(" "), /已匯入/);
  const direct = await stageImportFile(...args, Buffer.from(rows.replace("OTA-1", "DIRECT-2")), "direct.csv");
  const clash = await previewImport(...args, await sourceFor(...args, direct.tabs[0].sourceId), mapping);
  assert.match(clash.rows[0].issues.join(" "), /現有訂房衝突/);
  const other = await stageImportFile(store, "owner-b", "tenant-b", "property-b", Buffer.from(rows), "bookings.csv");
  const otherSource = await sourceFor(store, "owner-b", "tenant-b", "property-b", other.tabs[0].sourceId);
  assert.notEqual(otherSource.spreadsheetId, source.spreadsheetId);
});

test("Excel tabs are bounded and preserve displayed dates; invalid files are rejected", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["入住日期", "退房日期", "房間"], ["2026-10-20", "2026-10-22", "101"],
  ]), "Reservations");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const parsed = await parseImportFile(bytes, "orders.xlsx");
  assert.equal(parsed.tabs[0].rows[1][0], "2026-10-20");
  const forged = Buffer.from(bytes);
  let altered = false;
  for (let offset = 0; offset + 46 < forged.length; offset++) {
    if (forged.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = forged.readUInt16LE(offset + 28);
    const name = forged.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (!name.startsWith("xl/worksheets/")) continue;
    forged.writeUInt32LE(1, offset + 24); // Forge an undersized central-directory claim.
    altered = true;
    break;
  }
  assert.equal(altered, true);
  await assert.rejects(parseImportFile(forged, "forged.xlsx"), /FILE_IMPORT_(SIZE|FORMAT)/);
  await assert.rejects(parseImportFile(Buffer.from("not an xlsx"), "orders.xlsx"), /FILE_IMPORT_FORMAT/);
  await assert.rejects(parseImportFile(Buffer.from(rows), "orders.xls"), /FILE_IMPORT_FORMAT/);
});
