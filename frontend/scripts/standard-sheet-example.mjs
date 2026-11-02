// Synthetic examples run through the same preview/commit/export path as the UI.
// No network access, source Sheet writes, customer records or production store.
import fs from "node:fs/promises";
import path from "node:path";
import {
  previewImport,
  commitImport,
} from "../src/lib/customer-workspaces/sheet-import.ts";
import { buildStandardWorkbook } from "../src/lib/customer-workspaces/standard-sheet.ts";
import { STANDARD_SHEET_TABS } from "../src/lib/customer-workspaces/standard-sheet-schema.ts";

const output = process.argv[2];
if (!output)
  throw Error(
    "Usage: node --experimental-strip-types scripts/standard-sheet-example.mjs OUTPUT_DIRECTORY",
  );
const property = {
  id: "demo-property",
  name: "示範旅宿（合成資料）",
  kind: "mixed",
  sourceMode: "native",
  rooms: [
    { id: "room101", name: "101" },
    { id: "room102", name: "102" },
  ],
  villaRoomIds: ["room101", "room102"],
};
const workspace = {
  id: "demo-workspace",
  slug: "standard-example",
  name: "標準帳本示範｜全部為合成資料",
  version: 1,
  members: [
    {
      accountId: "example-owner",
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
  [`slug:${workspace.slug}`, JSON.stringify(workspace.id)],
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
const header = [
  "入住",
  "退房",
  "房間",
  "客人",
  "訂單編號",
  "訂單總額",
  "累計已付",
];
const mapping = {
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
  roomMap: { 101: ["room101"], 102: ["room102"], 包棟: ["room101", "room102"] },
  granularity: "stay",
  amountBasis: "order",
  receivedMeaning: "source",
  currency: "TWD",
  from: "2026-10-01",
};
const cases = [
  {
    title: "多房多晚與不連續日期範例",
    rows: [
      header,
      [
        "2026-10-10",
        "2026-10-12",
        "101",
        "合成旅客A",
        "DEMO-A",
        "12000",
        "3000",
      ],
      [
        "2026-10-10",
        "2026-10-12",
        "102",
        "合成旅客A",
        "DEMO-A",
        "12000",
        "3000",
      ],
      ["2026-10-20", "2026-10-21", "101", "合成旅客C", "DEMO-C", "6000", "0"],
      ["2026-10-23", "2026-10-24", "102", "合成旅客C", "DEMO-C", "6000", "0"],
    ],
    mapping,
  },
  {
    title: "一房一晚範例",
    rows: [
      header,
      ["2026-10-15", "", "101", "合成旅客B", "DEMO-B", "4000", "1000"],
      ["2026-10-16", "", "101", "合成旅客B", "DEMO-B", "4000", "1000"],
    ],
    mapping: {
      ...mapping,
      granularity: "night",
      columns: { ...mapping.columns, checkOut: -1 },
    },
  },
  {
    title: "房況格範例",
    rows: [
      ["房間", "2026-10-26", "2026-10-27"],
      ["101", "合成旅客D", "合成旅客D"],
      ["102", "合成旅客D", ""],
    ],
    mapping: {
      ...mapping,
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
        dateColumns: [1, 2],
        cellMeaning: "guest-name",
        orderIds: { "2:2": "DEMO-D", "2:3": "DEMO-D", "3:2": "DEMO-D" },
      },
    },
  },
];
for (const [i, example] of cases.entries()) {
  const source = {
    spreadsheetId: "synthetic-source-example-0001",
    sheetId: i + 1,
    title: example.title,
    rows: example.rows,
  };
  const preview = await previewImport(
    store,
    "example-owner",
    workspace.slug,
    property.id,
    source,
    example.mapping,
  );
  if (preview.rows.some((row) => row.issues.length))
    throw Error(JSON.stringify(preview.rows));
  await commitImport(
    store,
    "example-owner",
    workspace.slug,
    property.id,
    preview.id,
    preview.rows.map((row) => row.row),
  );
}
const saved = (await store.read(`workspace:${workspace.id}`)).value;
const example = buildStandardWorkbook(saved),
  template = buildStandardWorkbook(null);
await fs.mkdir(output, { recursive: true });
for (const [name, value] of Object.entries({
  "standard-template": template,
  "standard-example": example,
  "standard-example-workspace": saved,
  "standard-schema": STANDARD_SHEET_TABS,
  "standard-example-inputs": cases,
}))
  await fs.writeFile(
    path.join(output, `${name}.json`),
    JSON.stringify(value, null, 2) + "\n",
  );
console.log(
  JSON.stringify({
    orders: example.tables.orders.length - 1,
    roomNights: example.tables.nights.length - 1,
    sourceSummaries: example.tables.payments.length - 1,
    output,
  }),
);
