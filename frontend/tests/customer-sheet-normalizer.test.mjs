import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSheet,
  importFingerprint,
} from "../src/lib/customer-workspaces/sheet-normalizer.ts";
import {
  financeSummary,
  staysOf,
} from "../src/lib/customer-workspaces/domain.ts";
import {
  previewImport,
  commitImport,
  undoImport,
} from "../src/lib/customer-workspaces/sheet-import.ts";
import { view } from "../src/lib/customer-workspaces/service.ts";

const property = {
  id: "property-synthetic",
  name: "Synthetic Inn",
  kind: "mixed",
  sourceMode: "native",
  rooms: [
    { id: "r101", name: "101" },
    { id: "r102", name: "102" },
  ],
  villaRoomIds: ["r101", "r102"],
};
const source = (rows) => ({
  spreadsheetId: "synthetic-source-standard-0001",
  sheetId: 7,
  title: "Synthetic source",
  rows: [
    ["入住", "退房", "房間", "姓名", "訂單編號", "訂單總額", "已付"],
    ...rows,
  ],
});
const mapping = (overrides = {}) => ({
  headerRow: 1,
  columns: {
    checkIn: 0,
    checkOut: 1,
    rooms: 2,
    guestName: 3,
    externalId: 4,
    total: 5,
    received: 6,
  },
  roomMap: { 101: ["r101"], 102: ["r102"], 包棟: ["r101", "r102"] },
  granularity: "stay",
  amountBasis: "order",
  receivedMeaning: "source",
  currency: "TWD",
  from: "2026-10-01",
  ...overrides,
});
const line = (
  start,
  end,
  room = "101",
  id = "A",
  total = "12000",
  paid = "3000",
  guest = "Synthetic Guest",
) => [start, end, room, guest, id, total, paid];
function normalized(rows, config = mapping()) {
  return normalizeSheet(source(rows), config, property);
}
function ok(rows, config) {
  const result = normalized(rows, config);
  assert.ok(result.length);
  assert.deepEqual(
    result.flatMap((r) => r.issues),
    [],
  );
  return result;
}

test("two rooms and two nights with repeated order totals create one order, four nights and one source-paid summary", () => {
  const [order] = ok([
    line("2026-10-10", "2026-10-12", "101"),
    line("2026-10-10", "2026-10-12", "102"),
  ]);
  assert.equal(order.roomNightCount, 4);
  assert.equal(order.draft.total, 12000);
  assert.equal(order.draft.importedFinance.sourcePaid, 3000);
  assert.equal(order.draft.importedFinance.propertyReceived, null);
  assert.deepEqual(order.sourceRows, [2, 3]);
  assert.deepEqual(order.draft.stays, [
    {
      checkIn: "2026-10-10",
      checkOut: "2026-10-12",
      roomIds: ["r101", "r102"],
    },
  ]);
  assert.equal(order.draft.nightlyPrices, undefined);
});
test("one-night rows do not require checkout, merge across rooms and nights, and preserve gaps", () => {
  const config = mapping({
    granularity: "night",
    columns: { ...mapping().columns, checkOut: -1 },
  });
  const [order] = ok(
    [
      line("2026-10-10", "", "101"),
      line("2026-10-11", "", "101"),
      line("2026-10-10", "", "102"),
      line("2026-10-20", "", "101"),
    ],
    config,
  );
  assert.equal(order.roomNightCount, 4);
  assert.equal(order.draft.stays.length, 3);
  assert.equal(order.draft.checkIn, "2026-10-10");
  assert.equal(order.draft.checkOut, "2026-10-21");
  assert.equal(
    staysOf(order.draft).some(
      (s) => s.checkIn <= "2026-10-15" && s.checkOut > "2026-10-15",
    ),
    false,
  );
});
test("line, nightly group and per-room-night amounts use distinct multipliers; known nightly prices are never invented", () => {
  const rows = [line("2026-10-10", "2026-10-12", "包棟", "A", "1234.56", "0")];
  assert.equal(
    ok(rows, mapping({ amountBasis: "line" }))[0].draft.total,
    1234.56,
  );
  const nightly = ok(rows, mapping({ amountBasis: "night" }))[0];
  assert.equal(nightly.draft.total, 2469.12);
  assert.equal(nightly.draft.nightlyPrices, undefined);
  const perRoom = ok(rows, mapping({ amountBasis: "room-night" }))[0];
  assert.equal(perRoom.draft.total, 4938.24);
  assert.equal(perRoom.draft.nightlyPrices.length, 4);
  assert.ok(perRoom.draft.nightlyPrices.every((n) => n.amount === 1234.56));
});
test("single-appearance order money is retained, zero stays zero, and missing line amounts do not produce partial totals", () => {
  const rows = [
    line("2026-10-10", "2026-10-11", "101", "A", "12000", "0"),
    line("2026-10-11", "2026-10-12", "101", "A", "", ""),
  ];
  const [order] = ok(rows);
  assert.equal(order.draft.total, 12000);
  assert.equal(order.draft.importedFinance.sourcePaid, 0);
  assert.equal(ok(rows, mapping({ amountBasis: "line" }))[0].draft.total, null);
  assert.equal(
    ok([line("2026-10-10", "2026-10-11", "101", "A", "", "")])[0].draft
      .importedFinance.sourcePaid,
    null,
  );
});
test("conflicting totals or cumulative payments quarantine the entire order instead of summing or taking a maximum", () => {
  for (const [total, paid, message] of [
    ["13000", "3000", /總額不一致/],
    ["12000", "4000", /累計已付金額不一致/],
  ]) {
    const result = normalized([
      line("2026-10-10", "2026-10-11"),
      line("2026-10-11", "2026-10-12", "101", "A", total, paid),
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].draft, null);
    assert.match(result[0].issues.join(""), message);
  }
});
test("one bad date or room in an order prevents its other valid lines from being imported", () => {
  for (const bad of [
    line("10/11", "10/12"),
    line("2026-10-11", "2026-10-12", "unknown"),
  ]) {
    const [order] = normalized([line("2026-10-10", "2026-10-11"), bad]);
    assert.equal(order.draft, null);
    assert.deepEqual(order.sourceRows, [2, 3]);
    assert.ok(order.issues.length);
  }
});
test("same name without order IDs never joins nightly rows, and repeated room nights block an order", () => {
  const result = normalized([
    line("2026-10-10", "2026-10-11", "101", ""),
    line("2026-10-11", "2026-10-12", "101", ""),
  ]);
  assert.equal(result.length, 2);
  assert.ok(
    result.every(
      (r) => r.draft === null && r.issues.some((i) => i.includes("訂單編號")),
    ),
  );
  const duplicate = normalized([
    line("2026-10-10", "2026-10-12"),
    line("2026-10-11", "2026-10-12"),
  ])[0];
  assert.equal(duplicate.draft, null);
  assert.match(duplicate.issues.join(""), /重複占用/);
});
test("source row reordering preserves order fingerprints while provenance follows the actual source rows", () => {
  const rows = [
    line("2026-10-10", "2026-10-12", "101"),
    line("2026-10-20", "2026-10-21", "102"),
  ];
  const first = ok(rows)[0],
    second = ok([...rows].reverse())[0];
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint, importFingerprint(first.draft));
});
test("grid groups use explicit per-cell order IDs and never merge same guest names across orders", () => {
  const gridSource = {
    ...source([]),
    rows: [
      ["房號", "2026/10/10", "2026/10/11", "2026/10/20"],
      ["101", "Same Name", "Same Name", "Same Name"],
      ["102", "Same Name", "", ""],
    ],
  };
  const config = mapping({
    granularity: "grid",
    columns: {
      checkIn: -1,
      checkOut: -1,
      rooms: 0,
      guestName: -1,
      externalId: -1,
      total: -1,
      received: -1,
    },
    amountBasis: "none",
    receivedMeaning: "none",
    grid: {
      dateColumns: [1, 2, 3],
      cellMeaning: "guest-name",
      orderIds: { "2:2": "A", "2:3": "A", "2:4": "B", "3:2": "A" },
    },
  });
  const result = normalizeSheet(gridSource, config, property);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.flatMap((r) => r.issues),
    [],
  );
  assert.equal(result[0].roomNightCount, 3);
  assert.equal(result[1].roomNightCount, 1);
  assert.notEqual(result[0].row, result[1].row);
  assert.deepEqual(result[0].references, [
    { row: 2, column: 2 },
    { row: 2, column: 3 },
    { row: 3, column: 2 },
  ]);
  const missing = normalizeSheet(
    gridSource,
    { ...config, grid: { ...config.grid, orderIds: {} } },
    property,
  );
  assert.equal(missing.length, 4);
  assert.ok(missing.every((r) => r.draft === null && r.issues.length));
});
test("grid cells explicitly declared as order IDs coalesce dates; missing years and unsupported currency are rejected", () => {
  const gridSource = {
    ...source([]),
    rows: [
      ["房號", "2028/2/28", "2028/2/29"],
      ["101", "A", "A"],
    ],
  };
  const config = mapping({
    granularity: "grid",
    columns: {
      checkIn: -1,
      checkOut: -1,
      rooms: 0,
      guestName: -1,
      externalId: -1,
      total: -1,
      received: -1,
    },
    amountBasis: "none",
    receivedMeaning: "none",
    grid: { dateColumns: [1, 2], cellMeaning: "order-id", orderIds: {} },
  });
  const [order] = normalizeSheet(gridSource, config, property);
  assert.equal(order.draft.checkOut, "2028-03-01");
  gridSource.rows[0][2] = "2/29";
  assert.equal(normalizeSheet(gridSource, config, property)[0].draft, null);
  assert.throws(
    () => normalized([], mapping({ currency: "USD" })),
    /INVALID_INPUT/,
  );
});

function workspaceFixture() {
  const workspace = {
    id: "workspace-standard",
    slug: "standard-test",
    name: "Synthetic",
    version: 1,
    members: [
      {
        accountId: "owner",
        role: "owner",
        active: true,
        allProperties: true,
        propertyIds: [],
      },
    ],
    properties: [property],
    bookings: [],
    audit: [],
  };
  const data = new Map([
    ["slug:standard-test", JSON.stringify(workspace.id)],
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
  return {
    store,
    args: [store, "owner", workspace.slug, property.id],
    current: async () => (await store.read(`workspace:${workspace.id}`)).value,
  };
}
test("group preview commits once, excludes gap nights, hides nightly prices from no-price viewers and safely undoes an untouched import", async () => {
  const f = workspaceFixture();
  const preview = await previewImport(
    ...f.args,
    source([
      line("2026-10-10", "2026-10-12"),
      line("2026-10-20", "2026-10-21", "102"),
    ]),
    mapping({ amountBasis: "night" }),
  );
  const batch = await commitImport(...f.args, preview.id, [2]);
  assert.deepEqual(await commitImport(...f.args, preview.id, [2]), batch);
  const current = await f.current(),
    booking = current.bookings[0];
  assert.equal(current.bookings.length, 1);
  assert.equal(booking.payments.length, 0);
  assert.deepEqual(booking.imported.sourceRows, [2, 3]);
  assert.equal(financeSummary(booking).received, null);
  assert.equal(
    view(current, { role: "viewer_no_price", allProperties: true }).bookings[0]
      .nightlyPrices,
    undefined,
  );
  const undone = await undoImport(...f.args, batch.id, current.version);
  assert.deepEqual(undone.cancelled, [booking.id]);
  assert.equal((await f.current()).bookings[0].status, "cancelled");
});
test("a conflicting multi-line order cannot be partially selected by its second source row", async () => {
  const f = workspaceFixture();
  const preview = await previewImport(
    ...f.args,
    source([
      line("2026-10-10", "2026-10-12"),
      line("2026-10-20", "2026-10-21", "102", "A", "999"),
    ]),
    mapping(),
  );
  await assert.rejects(
    commitImport(...f.args, preview.id, [3]),
    /INVALID_INPUT/,
  );
  await assert.rejects(
    commitImport(...f.args, preview.id, [2]),
    /INVALID_INPUT/,
  );
  assert.equal((await f.current()).bookings.length, 0);
});
