import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStandardWorkbook,
  standardContentHash,
  normalizedTable,
  toGoogleCell,
  fromGoogleCell,
} from "../src/lib/customer-workspaces/standard-sheet.ts";
import { STANDARD_SHEET_TABS } from "../src/lib/customer-workspaces/standard-sheet-schema.ts";
import { standardWriteRequests } from "../src/lib/customer-workspaces/standard-sheet-google.ts";
import {
  bindStandardSheet,
  createStandardSheet,
  standardSheetStatus,
  standardWorkbookForOwner,
  syncStandardSheet,
} from "../src/lib/customer-workspaces/standard-sheet-sync.ts";

const destination = "standard-synthetic-destination-0001";
function fixture() {
  const workspace = {
    id: "standard-synthetic-workspace",
    slug: "standard-synthetic",
    name: "標準帳本合成範例",
    version: 1,
    members: [
      {
        accountId: "owner",
        role: "owner",
        active: true,
        allProperties: true,
        propertyIds: [],
      },
      {
        accountId: "admin",
        role: "admin",
        active: true,
        allProperties: true,
        propertyIds: [],
      },
      {
        accountId: "viewer",
        role: "viewer_no_price",
        active: true,
        allProperties: true,
        propertyIds: [],
      },
    ],
    properties: [
      {
        id: "p1",
        name: "示範館",
        kind: "mixed",
        sourceMode: "native",
        rooms: [
          { id: "r1", name: "101" },
          { id: "r2", name: "102" },
        ],
        villaRoomIds: ["r1", "r2"],
      },
    ],
    bookings: [
      {
        id: "b1",
        propertyId: "p1",
        guestName: "=literal guest",
        status: "confirmed",
        version: 1,
        checkIn: "2026-10-10",
        checkOut: "2026-10-12",
        roomIds: ["r1", "r2"],
        total: 12000,
        payments: [],
        importedFinance: {
          receivedMeaning: "source",
          sourcePaid: 3000,
          propertyReceived: null,
          guestPaid: null,
        },
        imported: {
          batchId: "batch1",
          row: 2,
          sourceRows: [2, 3, 4, 5],
          references: [2, 3, 4, 5].map((row) => ({ row })),
          externalId: "A",
          fingerprint: "synthetic",
          normalizationVersion: 1,
        },
      },
    ],
    importBatches: [
      {
        id: "batch1",
        source: { spreadsheetId: "synthetic-source-0001", sheetId: 7 },
      },
    ],
    audit: [],
  };
  workspace.bookings[0].entry = "sheet";
  const data = new Map([
    ["slug:standard-synthetic", JSON.stringify(workspace.id)],
    [`workspace:${workspace.id}`, JSON.stringify(workspace)],
  ]);
  const store = {
    read: async (key) => ({
      raw: data.get(key) ?? null,
      value: JSON.parse(data.get(key) ?? "null"),
    }),
    commit: async (changes) => {
      if (changes.some((c) => (data.get(c.key) ?? null) !== c.before))
        throw Error("VERSION_CONFLICT");
      for (const c of changes) data.set(c.key, JSON.stringify(c.after));
    },
    limit: async () => {},
  };
  const snapshot = (book) => ({
    spreadsheetId: destination,
    url: `https://docs.google.com/spreadsheets/d/${destination}/edit`,
    tables: structuredClone(book.tables),
    sheets: Object.fromEntries(
      STANDARD_SHEET_TABS.map((t, i) => [
        t.key,
        {
          id: i + 100,
          rows: 1000,
          columns: t.columns.length,
          tableId: `table${i}`,
        },
      ]),
    ),
  });
  let current = snapshot(buildStandardWorkbook(null));
  const gateway = {
    reads: [],
    writes: [],
    read: async (id) => {
      gateway.reads.push(id);
      return structuredClone(current);
    },
    write: async (before, book) => {
      gateway.writes.push(structuredClone(book));
      current = snapshot(book);
    },
  };
  return {
    workspace,
    data,
    store,
    gateway,
    args: [store, "owner", workspace.slug],
    snapshot,
    get: () => current,
    set: (v) => {
      current = v;
    },
    save: () =>
      data.set(`workspace:${workspace.id}`, JSON.stringify(workspace)),
  };
}
const bind = (f) => bindStandardSheet(...f.args, destination, f.gateway);
const sync = (f) => syncStandardSheet(...f.args, f.gateway);

test("standard ledger records one total and cumulative deposit for four room nights, with no invented payment date or nightly price", () => {
  const f = fixture(),
    book = buildStandardWorkbook(f.workspace);
  assert.equal(book.tables.orders.length, 2);
  assert.equal(book.tables.nights.length, 5);
  assert.equal(book.tables.payments.length, 2);
  assert.equal(book.tables.sources.length, 5);
  assert.deepEqual(book.tables.orders[1].slice(8, 17), [
    4,
    12000,
    3000,
    0,
    0,
    9000,
    null,
    null,
    "TWD",
  ]);
  assert.deepEqual(book.tables.payments[1].slice(3, 8), [
    "來源累計已付",
    3000,
    null,
    null,
    null,
  ]);
  assert.ok(book.tables.nights.slice(1).every((r) => r[8] === null));
  assert.equal(new Set(book.tables.nights.slice(1).map((r) => r[0])).size, 4);
});
test("known opening amounts and actual payments retain their distinct dates and cash meaning", () => {
  const f = fixture(),
    booking = f.workspace.bookings[0];
  booking.openingReceived = {
    amount: 3000,
    asOf: "2026-10-03",
    note: "confirmed",
    confirmedAt: "2026-10-03T00:00:00Z",
    confirmedBy: "owner",
  };
  booking.payments = [
    {
      id: "pay1",
      kind: "balance",
      amount: 9000,
      receivedAt: "2026-10-11T01:02:03.004Z",
      method: "cash",
      note: "",
    },
    {
      id: "refund1",
      kind: "refund",
      amount: 1000,
      receivedAt: "2026-10-12T00:00:00Z",
      method: "cash",
    },
  ];
  const book = buildStandardWorkbook(f.workspace);
  assert.equal(book.tables.payments.length, 5);
  assert.deepEqual(
    book.tables.orders[1].slice(11, 16),
    [9000, 1000, 9000, 11000, 1000],
  );
  const roundTrip = Object.fromEntries(
    STANDARD_SHEET_TABS.map((tab) => [
      tab.key,
      normalizedTable(
        book.tables[tab.key].map((row, i) =>
          row.map((value, c) => {
            const entered = toGoogleCell(
              value,
              i ? tab.columns[c] : undefined,
            ).userEnteredValue;
            return entered?.numberValue ?? entered?.stringValue;
          }),
        ),
        tab.key,
      ),
    ]),
  );
  assert.equal(standardContentHash(roundTrip), book.contentHash);
});

test("standard ledger marks legacy onboarding incompleteness without treating missing source orders as empty", () => {
  const f = fixture();
  f.workspace.onboarding = { unresolvedCount: 2 };
  const book = buildStandardWorkbook(f.workspace);
  assert.equal(
    Object.fromEntries(book.tables.meta.slice(1)).pending_properties,
    "示範館",
  );
});
test("Google values round-trip typed dates, milliseconds and numbers while text cannot become a formula", () => {
  for (const [value, column] of [
    ["2028-02-29", { type: "date" }],
    ["2026-10-10T23:00:00.123Z", { type: "datetime" }],
    [0, { type: "money" }],
    [1234.56, { type: "money" }],
  ]) {
    const cell = toGoogleCell(value, column);
    assert.equal(typeof cell.userEnteredValue.numberValue, "number");
    assert.equal(
      fromGoogleCell(cell.userEnteredValue.numberValue, column),
      value,
    );
  }
  assert.deepEqual(toGoogleCell('=IMPORTXML("x")'), {
    userEnteredValue: { stringValue: '=IMPORTXML("x")' },
  });
  assert.deepEqual(toGoogleCell(null), {});
});
test("atomic write is restricted to the eight observed sheet IDs, clears stale records and updates table ranges", () => {
  const f = fixture(),
    snapshot = f.snapshot(buildStandardWorkbook(f.workspace)),
    book = buildStandardWorkbook(null);
  const requests = standardWriteRequests(snapshot, book),
    updates = requests.filter((r) => r.updateCells).map((r) => r.updateCells);
  assert.equal(updates.length, 8);
  assert.deepEqual(
    updates.map((r) => r.range.sheetId),
    [100, 101, 102, 103, 104, 105, 106, 107],
  );
  assert.equal(updates[1].range.endRowIndex, 5);
  assert.equal(updates[1].fields, "userEnteredValue");
  assert.ok(
    updates.every((r) =>
      r.rows
        .flatMap((row) => row.values)
        .every((c) => !c.userEnteredValue?.formulaValue),
    ),
  );
  assert.equal(requests.filter((r) => r.updateTable).length, 8);
  const lastResize = requests.findIndex(
    (r) => r.updateTable?.table.tableId === "table0",
  );
  const dateFormat = requests.findIndex(
    (r) =>
      r.repeatCell?.range.sheetId === 100 &&
      r.repeatCell?.cell.userEnteredFormat.numberFormat?.type === "DATE",
  );
  assert.ok(
    dateFormat > lastResize,
    "date formatting must follow table resizing",
  );
  assert.ok(
    requests.some(
      (r) =>
        r.repeatCell?.cell.userEnteredFormat.textFormat?.foregroundColorStyle
          ?.rgbColor.red === 0,
    ),
  );
});
test("binding refuses source files, template masters, occupied targets and cross-workspace claims", async () => {
  const f = fixture();
  await assert.rejects(
    bindStandardSheet(...f.args, "synthetic-source-0001", f.gateway),
    /STANDARD_SOURCE_IS_TARGET/,
  );
  assert.equal(f.gateway.reads.length, 0);
  f.set(f.snapshot(buildStandardWorkbook(f.workspace)));
  await assert.rejects(bind(f), /STANDARD_TARGET_NOT_EMPTY/);
  f.set(f.snapshot(buildStandardWorkbook(null)));
  f.data.set(
    `standard-target:${destination}`,
    JSON.stringify({ workspaceId: "other" }),
  );
  await assert.rejects(bind(f), /STANDARD_TARGET_CONFLICT/);
  assert.equal(f.gateway.writes.length, 0);
});
test("only the unrestricted owner may see, download, bind or synchronize the complete workbook", async () => {
  const f = fixture();
  for (const account of ["admin", "viewer", "stranger"]) {
    const error = account === "stranger" ? /NOT_FOUND/ : /FORBIDDEN/;
    for (const fn of [standardSheetStatus, standardWorkbookForOwner])
      await assert.rejects(fn(f.store, account, f.workspace.slug), error);
    await assert.rejects(
      bindStandardSheet(
        f.store,
        account,
        f.workspace.slug,
        destination,
        f.gateway,
      ),
      error,
    );
    await assert.rejects(
      syncStandardSheet(f.store, account, f.workspace.slug, f.gateway),
      error,
    );
  }
  assert.equal(f.gateway.reads.length, 0);
});
test("successful synchronization reads back, retries without another write, and marks later edits pending", async () => {
  const f = fixture();
  await bind(f);
  await sync(f);
  assert.equal((await standardSheetStatus(...f.args)).state, "synced");
  assert.equal(f.gateway.writes.length, 1);
  await sync(f);
  assert.equal(f.gateway.writes.length, 1);
  f.workspace.version++;
  f.save();
  assert.equal((await standardSheetStatus(...f.args)).state, "pending");
  await sync(f);
  assert.equal(f.gateway.writes.length, 2);
  assert.ok(f.gateway.reads.every((id) => id === destination));
});
test("lost write replies recover the pending generation even after another workspace change", async () => {
  const f = fixture();
  await bind(f);
  const original = f.gateway.write;
  f.gateway.write = async (...args) => {
    await original(...args);
    throw Error("network reply lost");
  };
  await assert.rejects(sync(f), /STANDARD_WRITE_UNCONFIRMED/);
  assert.equal((await standardSheetStatus(...f.args)).state, "error");
  f.workspace.version++;
  f.workspace.bookings[0].guestName = "Updated guest";
  f.save();
  f.gateway.write = original;
  await sync(f);
  assert.equal((await standardSheetStatus(...f.args)).state, "synced");
  assert.equal(f.get().tables.orders[1][4], "Updated guest");
  assert.equal(f.get().tables.orders.length, 2);
});
test("a success response with no actual Sheet write stays unconfirmed and is safely retried", async () => {
  const f = fixture();
  await bind(f);
  const original = f.gateway.write;
  f.gateway.write = async () => {};
  await assert.rejects(sync(f), /STANDARD_WRITE_UNCONFIRMED/);
  f.gateway.write = original;
  await sync(f);
  assert.equal((await standardSheetStatus(...f.args)).state, "synced");
});
test("manual edits and modified schema prevent overwrite", async () => {
  const f = fixture();
  await bind(f);
  await sync(f);
  f.get().tables.orders[1][4] = "External change";
  await assert.rejects(sync(f), /STANDARD_EXTERNAL_CHANGE/);
  assert.equal(f.gateway.writes.length, 1);
  const blank = fixture();
  blank.get().tables.meta[1][1] = "another format";
  await assert.rejects(bind(blank), /STANDARD_LAYOUT_CHANGED/);
});
test("a concurrent workspace edit is coalesced after the first verified export", async () => {
  const f = fixture();
  await bind(f);
  const original = f.gateway.write;
  f.gateway.write = async (...args) => {
    await original(...args);
    if (f.gateway.writes.length === 1) {
      f.workspace.version++;
      f.workspace.bookings[0].guestName = "Concurrent edit";
      f.save();
    }
  };
  await sync(f);
  assert.equal(f.gateway.writes.length, 2);
  assert.equal(f.get().tables.orders[1][4], "Concurrent edit");
  assert.equal((await standardSheetStatus(...f.args)).state, "synced");
});
test("an active writer lease prevents a competing write", async () => {
  const f = fixture();
  await bind(f);
  f.data.set(
    `standard-lock:${f.workspace.id}`,
    JSON.stringify({ token: "other", expiresAt: Date.now() + 60000 }),
  );
  await assert.rejects(sync(f), /STANDARD_SYNC_BUSY/);
  assert.equal(f.gateway.writes.length, 0);
});
test("uncertain creation is looked up on retry without issuing a second copy", async () => {
  const f = fixture(),
    attempts = [];
  f.gateway.create = async (_id, _name, options) => {
    attempts.push(options.lookupOnly);
    if (!options.lookupOnly) throw Error("STANDARD_CREATE_UNCERTAIN");
    if (attempts.length === 2) throw Error("STANDARD_SHEET_UNAVAILABLE");
    return destination;
  };
  await assert.rejects(
    createStandardSheet(...f.args, f.gateway),
    /STANDARD_CREATE_UNCERTAIN/,
  );
  await assert.rejects(
    createStandardSheet(...f.args, f.gateway),
    /STANDARD_SHEET_UNAVAILABLE/,
  );
  assert.equal(
    (await createStandardSheet(...f.args, f.gateway)).spreadsheetId,
    destination,
  );
  await createStandardSheet(...f.args, f.gateway);
  assert.deepEqual(attempts, [false, true, true]);
});

test("intact v1 workbook upgrades atomically with two new provenance/block tabs, without colliding with other sheet IDs", async () => {
  const f = fixture(),
    old = f.get();
  old.tables.calendarSources = [];
  old.tables.blocks = [];
  delete old.sheets.calendarSources;
  delete old.sheets.blocks;
  old.allSheetIds = [100, 101, 102, 103, 104, 105, 999];
  old.tables.orders = old.tables.orders.map((r) => r.slice(0, 18));
  old.tables.payments = old.tables.payments.map((r) => r.slice(0, 10));
  old.tables.meta.find((r) => r[0] === "schema_version")[1] = 1;
  old.tables.meta.find((r) => r[0] === "content_hash")[1] = standardContentHash(
    old.tables,
  );
  f.set(old);
  const requests = standardWriteRequests(
      old,
      buildStandardWorkbook(f.workspace),
    ),
    add = requests.filter((r) => r.addSheet).map((r) => r.addSheet.properties);
  assert.deepEqual(
    add.map((s) => s.sheetId),
    [1000, 1001],
  );
  assert.deepEqual(
    add.map((s) => s.title),
    ["日曆來源", "封房明細"],
  );
  await bind(f);
  await sync(f);
  assert.equal(
    f.get().tables.meta.find((r) => r[0] === "schema_version")[1],
    4,
  );
  assert.ok(f.get().tables.calendarSources.length);
  assert.ok(f.get().tables.blocks.length);
});
test("deleted v2 extension tab is an external layout change, never silently recreated", async () => {
  const f = fixture(),
    old = f.get();
  old.tables.blocks = [];
  delete old.sheets.blocks;
  old.tables.meta.find((r) => r[0] === "content_hash")[1] = standardContentHash(
    old.tables,
  );
  f.set(old);
  await assert.rejects(bind(f), /STANDARD_LAYOUT_CHANGED/);
  assert.equal(f.gateway.writes.length, 0);
});

test("intact v2 workbook appends order metadata and receipt allocation/account columns without treating old columns as an external edit", async () => {
  const f = fixture(),
    old = f.get();
  old.tables.orders = old.tables.orders.map((row) => row.slice(0, 18));
  old.tables.payments = old.tables.payments.map((row) => row.slice(0, 10));
  old.tables.meta.find((r) => r[0] === "schema_version")[1] = 2;
  old.tables.meta.find((r) => r[0] === "content_hash")[1] = standardContentHash(
    old.tables,
  );
  f.set(old);
  await bind(f);
  await sync(f);
  assert.equal(
    f.get().tables.meta.find((r) => r[0] === "schema_version")[1],
    4,
  );
  assert.equal(f.get().tables.orders[0].length, 28);
  assert.equal(f.get().tables.payments[0].length, 13);
});

test("v3 upgrades to hold columns only when workbook contents still match; edited data is protected", async () => {
  for (const edited of [false, true]) {
    const f = fixture(), old = f.get();
    old.tables.orders = old.tables.orders.map(row => row.slice(0, 23));
    old.tables.meta.find(r => r[0] === "schema_version")[1] = 3;
    old.tables.meta.find(r => r[0] === "content_hash")[1] = standardContentHash(old.tables);
    if (edited) old.tables.orders.push(["external edit"]);
    f.set(old);
    if (edited) { await assert.rejects(bind(f), /STANDARD_EXTERNAL_CHANGE/); assert.equal(f.gateway.writes.length, 0); }
    else { await bind(f); await sync(f); assert.equal(f.get().tables.orders[0].length, 28); assert.equal(f.get().tables.meta.find(r => r[0] === "schema_version")[1], 4); }
  }
});
