import { createHash } from "node:crypto";
import { cents, financeSummary, propertyReadiness, staysOf } from "./domain.ts";
import { tagsFor } from "./order-query.ts";
import type { Workspace } from "./types.ts";
import {
  STANDARD_SHEET_MARKER,
  STANDARD_SHEET_RULES,
  STANDARD_SHEET_TABS,
  STANDARD_SHEET_VERSION,
  type StandardColumn,
  type StandardTabKey,
} from "./standard-sheet-schema.ts";
export type SheetCell = string | number | null;
export type StandardWorkbook = {
  schemaVersion: number;
  workspaceId: string;
  workspaceVersion: number;
  generation: string;
  contentHash: string;
  generatedAt: string;
  tables: Record<StandardTabKey, SheetCell[][]>;
};
export const standardHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nextDate = (date: string) =>
  new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
export function standardContentHash(tables: StandardWorkbook["tables"]) {
  return standardHash(
    STANDARD_SHEET_TABS.filter(
      (t) => t.key !== "meta" && tables[t.key]?.length,
    ).map((t) => [
      t.key,
      tables[t.key].map((row) =>
        row.map((cell) => (cell === "" ? null : cell)),
      ),
    ]),
  );
}
export function buildStandardWorkbook(
  workspace: Workspace | null,
  options: { generation?: string; generatedAt?: string } = {},
): StandardWorkbook {
  const tables = Object.fromEntries(
    STANDARD_SHEET_TABS.map((tab) => [
      tab.key,
      [tab.columns.map((c) => c.label)],
    ]),
  ) as StandardWorkbook["tables"];
  tables.rules.push(...STANDARD_SHEET_RULES);
  let nightCount = 0;
  for (const booking of [...(workspace?.bookings ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const property = workspace!.properties.find(
      (p) => p.id === booking.propertyId,
    );
    if (!property) throw new Error("STANDARD_DATA_INVALID");
    const summary = financeSummary(booking);
    const imported = booking.importedFinance;
    const sourcePaid =
      imported?.sourcePaid ??
      imported?.guestPaid ??
      imported?.propertyReceived ??
      null;
    let orderNights = 0;
    const seen = new Set<string>();
    for (const stay of staysOf(booking)) {
      for (
        let date = stay.checkIn;
        date < stay.checkOut;
        date = nextDate(date)
      ) {
        for (const roomId of [...stay.roomIds].sort()) {
          const room = property.rooms.find((r) => r.id === roomId);
          const key = `${roomId}:${date}`;
          if (!room || seen.has(key)) throw new Error("STANDARD_DATA_INVALID");
          seen.add(key);
          if (++nightCount > 50000) throw new Error("STANDARD_SIZE");
          orderNights++;
          const amount =
            booking.nightlyPrices?.find(
              (p) => p.roomId === roomId && p.date === date,
            )?.amount ?? null;
          tables.nights.push([
            `night-${standardHash([booking.id, roomId, date]).slice(0, 32)}`,
            booking.id,
            property.id,
            roomId,
            room.name,
            date,
            nextDate(date),
            booking.status === "confirmed" ? "有效" : "已取消",
            amount,
            "TWD",
          ]);
        }
      }
    }
    tables.orders.push([
      booking.id,
      property.id,
      property.name,
      booking.imported?.externalId ?? booking.calendar?.externalId ?? null,
      booking.guestName,
      booking.status === "confirmed" ? "有效" : "已取消",
      booking.checkIn,
      booking.checkOut,
      orderNights,
      booking.total,
      sourcePaid,
      summary.recordedReceived,
      summary.refunds,
      booking.total === null || sourcePaid === null
        ? null
        : (cents(booking.total) - cents(sourcePaid)) / 100,
      summary.received,
      summary.remaining,
      "TWD",
      booking.version,
      booking.platform ?? null,
      booking.bookedAt ?? null,
      booking.notes,
      tagsFor(property)
        .filter((t) => booking.tagIds?.includes(t.id))
        .map((t) => `${t.short} ${t.name}`)
        .join("、") || null,
      summary.extraReceived,
    ]);
    if (sourcePaid !== null)
      tables.payments.push([
        `source-${booking.id}`,
        booking.id,
        property.id,
        imported?.receivedMeaning === "property"
          ? "來源累計實收"
          : imported?.receivedMeaning === "guest"
            ? "來源旅客已付"
            : "來源累計已付",
        sourcePaid,
        null,
        null,
        null,
        "來源期初摘要；沒有逐筆收款日期，不計入本期交易。",
        "TWD",
        null,
        null,
        null,
      ]);
    if (booking.openingReceived)
      tables.payments.push([
        `opening-${booking.id}`,
        booking.id,
        property.id,
        "已確認期初實收",
        booking.openingReceived.amount,
        null,
        booking.openingReceived.asOf,
        null,
        booking.openingReceived.note,
        "TWD",
        null,
        null,
        null,
      ]);
    const labels = {
      deposit: "訂金",
      balance: "尾款",
      full: "全額",
      other: "其他收款",
      refund: "退款",
    };
    for (const payment of [...booking.payments].sort(
      (a, b) =>
        a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id),
    ))
      tables.payments.push([
        payment.id,
        booking.id,
        property.id,
        labels[payment.kind],
        payment.amount,
        new Date(payment.receivedAt).toISOString(),
        null,
        payment.method,
        payment.note ?? null,
        "TWD",
        payment.allocation === "extra" ? "其他費用（不抵房費）" : "房費",
        payment.receiptAccount?.name ?? null,
        payment.receiptAccount?.last4 ?? null,
      ]);
    if (booking.imported) {
      const batch = workspace!.importBatches?.find(
        (b) => b.id === booking.imported!.batchId,
      );
      for (const reference of booking.imported.references ?? [
        { row: booking.imported.row },
      ])
        tables.sources.push([
          booking.id,
          booking.imported.batchId,
          batch?.source.spreadsheetId ?? null,
          batch?.source.sheetId ?? null,
          reference.row,
          reference.column ?? null,
          booking.imported.externalId,
          booking.imported.fingerprint,
          booking.imported.normalizationVersion ?? 0,
        ]);
    }
  }
  for (const record of [
    ...(workspace?.bookings ?? []),
    ...(workspace?.blocks ?? []),
  ].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!record.calendar) continue;
    for (const ref of record.calendar.references)
      tables.calendarSources.push([
        record.id,
        record.calendar.bindingId,
        record.calendar.batchId,
        ref.calendarId,
        ref.uid,
        ref.eventId ?? null,
        ref.recurrenceId ?? null,
        record.calendar.externalId,
        record.calendar.fingerprint,
      ]);
  }
  for (const block of workspace?.blocks ?? []) {
    const property = workspace!.properties.find(
      (p) => p.id === block.propertyId,
    );
    if (!property) throw new Error("STANDARD_DATA_INVALID");
    for (const stay of block.stays)
      for (let date = stay.checkIn; date < stay.checkOut; date = nextDate(date))
        for (const roomId of stay.roomIds) {
          const room = property.rooms.find((r) => r.id === roomId);
          if (!room || ++nightCount > 50000) throw new Error("STANDARD_SIZE");
          tables.blocks.push([
            block.id,
            property.id,
            property.name,
            room.id,
            room.name,
            date,
            nextDate(date),
            block.reason,
            block.status === "active" ? "封房" : "已釋放",
            block.version,
          ]);
        }
  }
  const contentHash = standardContentHash(tables);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const generation =
    options.generation ??
    standardHash([
      workspace?.id ?? "",
      workspace?.version ?? 0,
      contentHash,
    ]).slice(0, 32);
  const meta: SheetCell[][] = [
    ["format", STANDARD_SHEET_MARKER],
    ["schema_version", STANDARD_SHEET_VERSION],
    ["workspace_id", workspace?.id ?? ""],
    ["workspace_name", workspace?.name ?? "標準帳本範本"],
    ["workspace_version", workspace?.version ?? 0],
    ["generation", generation],
    ["content_hash", contentHash],
    ["generated_at", generatedAt],
    ["timezone", "Asia/Taipei"],
    ["orders", tables.orders.length - 1],
    ["room_nights", tables.nights.length - 1],
    ["payment_records", tables.payments.length - 1],
    ["source_references", tables.sources.length - 1],
    [
      "source_mode",
      "來源唯讀；日曆依來源設定一次搬入或持續同步，此帳本不反向回寫",
    ],
    ["calendar_references", tables.calendarSources.length - 1],
    ["blocked_room_nights", tables.blocks.length - 1],
    [
      "pending_properties",
      (workspace?.properties ?? [])
        .filter((p) => !propertyReadiness(workspace!, p).complete)
        .map((p) => p.name)
        .join("、"),
    ],
  ];
  tables.meta.push(...meta);
  if (
    Object.values(tables).reduce(
      (sum, rows) => sum + rows.reduce((n, row) => n + row.length, 0),
      0,
    ) > 250000
  )
    throw new Error("STANDARD_SIZE");
  return {
    schemaVersion: STANDARD_SHEET_VERSION,
    workspaceId: workspace?.id ?? "",
    workspaceVersion: workspace?.version ?? 0,
    generation,
    contentHash,
    generatedAt,
    tables,
  };
}

const EPOCH = Date.UTC(1899, 11, 30);
// Dates are typed serial numbers in Google Sheets; JSON transport keeps ISO dates.
export function toGoogleCell(value: SheetCell, column?: StandardColumn) {
  if (value === null || value === "") return {};
  if (column?.type === "date" || column?.type === "datetime") {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
      throw new Error("STANDARD_DATA_INVALID");
    const offset = column.type === "datetime" ? 8 * 3600000 : 0;
    return {
      userEnteredValue: {
        numberValue: (Date.parse(value) + offset - EPOCH) / 86400000,
      },
    };
  }
  return {
    userEnteredValue:
      typeof value === "number"
        ? { numberValue: value }
        : { stringValue: value },
  };
}
export function fromGoogleCell(
  value: unknown,
  column?: StandardColumn,
): SheetCell {
  if (value === undefined || value === null || value === "") return null;
  if (
    (column?.type === "date" || column?.type === "datetime") &&
    typeof value === "number"
  ) {
    const offset = column.type === "datetime" ? 8 * 3600000 : 0;
    const iso = new Date(
      Math.round(value * 86400000) + EPOCH - offset,
    ).toISOString();
    return column.type === "date" ? iso.slice(0, 10) : iso;
  }
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error("STANDARD_DATA_INVALID");
  return value;
}
export function normalizedTable(
  rows: unknown[][],
  key: StandardTabKey,
  columnCount?: number,
): SheetCell[][] {
  const columns = STANDARD_SHEET_TABS.find(
    (tab) => tab.key === key,
  )!.columns.slice(0, columnCount);
  const values = rows.map((row, i) =>
    columns.map((column, c) =>
      fromGoogleCell(row[c], i === 0 ? undefined : column),
    ),
  );
  while (values.length > 1 && values.at(-1)!.every((cell) => cell === null))
    values.pop();
  return values;
}
