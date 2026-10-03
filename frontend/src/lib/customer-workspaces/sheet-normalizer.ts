import { createHash } from "node:crypto";
import { dateValue, textValue } from "./service.ts";
import type { Booking, Property, StaySegment } from "./types.ts";

export const NORMALIZATION_VERSION = 1;
export type SourceReference = { row: number; column?: number };
export type SheetSource = {
  spreadsheetId: string;
  sheetId: number;
  title: string;
  rows: string[][];
};
export type Mapping = {
  headerRow: number;
  columns: {
    checkIn: number;
    checkOut: number;
    rooms: number;
    guestName: number;
    externalId: number;
    total: number;
    received: number;
    status?: number;
  };
  roomMap: Record<string, string[]>;
  granularity: "order" | "stay" | "night" | "grid";
  amountBasis: "order" | "line" | "night" | "room-night" | "none";
  receivedMeaning: "source" | "property" | "guest" | "none";
  currency: "TWD";
  from: string;
  grid?: {
    dateColumns: number[];
    cellMeaning: "order-id" | "guest-name";
    // Keys are one-based source row:column, never guest names or visual colors.
    orderIds: Record<string, string>;
  };
};
export type ImportDraft = Pick<
  Booking,
  | "guestName"
  | "checkIn"
  | "checkOut"
  | "roomIds"
  | "stays"
  | "total"
  | "importedFinance"
  | "nightlyPrices"
> & { externalId: string | null };
export type NormalizedOrder = {
  // Kept as the stable preview selection token. Grid cells use a unique token;
  // sourceRows/references, rather than this number, are shown as provenance.
  row: number;
  sourceRows: number[];
  references: SourceReference[];
  roomNightCount: number;
  draft: ImportDraft | null;
  issues: string[];
  fingerprint: string;
};
type Line = {
  selection: number;
  reference: SourceReference;
  externalId: string | null;
  guestName: string | null;
  checkIn: string;
  checkOut: string;
  roomIds: string[];
  total: number | null;
  paid: number | null;
};
type Group = {
  selection: number;
  externalId: string | null;
  lines: Line[];
  references: SourceReference[];
  issues: string[];
};
const MAX_ROOM_NIGHTS = 20000;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function importFingerprint(draft: ImportDraft) {
  // Preserve the pre-normalizer field order for existing single-row imports.
  return digest({
    checkIn: draft.checkIn,
    checkOut: draft.checkOut,
    roomIds: draft.roomIds,
    guestName: draft.guestName,
    externalId: draft.externalId,
    total: draft.total,
    importedFinance: draft.importedFinance,
    ...(draft.stays ? { stays: draft.stays } : {}),
    ...(draft.nightlyPrices ? { nightlyPrices: draft.nightlyPrices } : {}),
  });
}
const cell = (row: string[], index: number | undefined) =>
  index === undefined || index < 0 ? "" : (row[index] ?? "").trim();
const dayAfter = (date: string) =>
  new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
export function sourceDate(value: string) {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value.trim());
  if (!match) throw new Error("日期需包含西元年，例如 2026-10-02");
  try {
    return dateValue(
      `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`,
    );
  } catch {
    throw new Error("日期不存在或超出範圍");
  }
}
function money(value: string) {
  if (!value) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value))
    throw new Error("金額格式不明，請核對欄位對應");
  const amount = Number(value.replaceAll(",", ""));
  if (!Number.isFinite(amount) || amount > 100000000)
    throw new Error("金額超出範圍");
  return Math.round(amount * 100);
}
export function validateMapping(mapping: Mapping) {
  if (
    !mapping ||
    !["order", "stay", "night", "grid"].includes(mapping.granularity) ||
    mapping.currency !== "TWD" ||
    !["order", "line", "night", "room-night", "none"].includes(
      mapping.amountBasis,
    ) ||
    !["source", "property", "guest", "none"].includes(
      mapping.receivedMeaning,
    ) ||
    !Number.isInteger(mapping.headerRow) ||
    mapping.headerRow < 1 ||
    mapping.headerRow > 20 ||
    !mapping.columns ||
    !mapping.roomMap ||
    typeof mapping.roomMap !== "object" ||
    Array.isArray(mapping.roomMap)
  )
    throw new Error("INVALID_INPUT");
  dateValue(mapping.from);
  const required =
    mapping.granularity === "grid"
      ? ["rooms"]
      : mapping.granularity === "night"
        ? ["checkIn", "rooms", "externalId"]
        : mapping.granularity === "stay"
          ? ["checkIn", "checkOut", "rooms", "externalId"]
          : ["checkIn", "checkOut", "rooms"];
  const used: number[] = [];
  for (const key of [
    "checkIn",
    "checkOut",
    "rooms",
    "guestName",
    "externalId",
    "total",
    "received",
    "status",
  ] as const) {
    const index = mapping.columns[key] ?? (key === "status" ? -1 : NaN);
    if (
      !Number.isInteger(index) ||
      index < -1 ||
      index > 51 ||
      (required.includes(key) && index < 0)
    )
      throw new Error("INVALID_INPUT");
    if (index >= 0) used.push(index);
  }
  if (
    new Set(used).size !== used.length ||
    (mapping.amountBasis === "none") !== (mapping.columns.total === -1) ||
    (mapping.receivedMeaning === "none") !== (mapping.columns.received === -1)
  )
    throw new Error("INVALID_INPUT");
  if (mapping.granularity === "grid") {
    const grid = mapping.grid;
    if (
      !grid ||
      !["order-id", "guest-name"].includes(grid.cellMeaning) ||
      !Array.isArray(grid.dateColumns) ||
      !grid.dateColumns.length ||
      grid.dateColumns.length > 51 ||
      new Set(grid.dateColumns).size !== grid.dateColumns.length ||
      grid.dateColumns.some(
        (c) => !Number.isInteger(c) || c < 0 || c > 51 || used.includes(c),
      ) ||
      !grid.orderIds ||
      typeof grid.orderIds !== "object" ||
      Array.isArray(grid.orderIds) ||
      Object.keys(grid.orderIds).length > 20000 ||
      mapping.amountBasis !== "none" ||
      mapping.receivedMeaning !== "none"
    )
      throw new Error("INVALID_INPUT");
  }
}

function roomsFor(label: string, mapping: Mapping, property: Property) {
  const roomIds = mapping.roomMap[label];
  if (
    !Array.isArray(roomIds) ||
    !roomIds.length ||
    roomIds.length > 100 ||
    roomIds.some((id) => !property.rooms.some((room) => room.id === id))
  )
    throw new Error("房間尚未對應");
  if (
    property.kind === "villa" &&
    property.villaRoomIds.some((id) => !roomIds.includes(id))
  )
    throw new Error("包棟旅宿需包含全部實體房間");
  return [...new Set(roomIds)].sort();
}
function uniqueAmount(values: (number | null)[], label: string) {
  const known = [...new Set(values.filter((v): v is number => v !== null))];
  if (known.length > 1)
    throw new Error(`同一訂單的${label}不一致，請核對整組資料`);
  return known[0] ?? null;
}
function compactStays(
  nights: { roomId: string; date: string }[],
): StaySegment[] {
  const byRoom = new Map<string, string[]>();
  for (const night of nights) {
    const dates = byRoom.get(night.roomId) ?? [];
    dates.push(night.date);
    byRoom.set(night.roomId, dates);
  }
  const segments: StaySegment[] = [];
  for (const [roomId, dates] of [...byRoom].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    dates.sort();
    for (const date of dates) {
      const current = segments.at(-1);
      if (current && current.roomIds[0] === roomId && current.checkOut === date)
        current.checkOut = dayAfter(date);
      else {
        segments.push({
          checkIn: date,
          checkOut: dayAfter(date),
          roomIds: [roomId],
        });
      }
    }
  }
  const grouped = new Map<string, StaySegment>();
  for (const segment of segments) {
    const key = `${segment.checkIn}:${segment.checkOut}`;
    const previous = grouped.get(key);
    if (previous) previous.roomIds.push(...segment.roomIds);
    else grouped.set(key, segment);
  }
  return [...grouped.values()].sort(
    (a, b) =>
      a.checkIn.localeCompare(b.checkIn) ||
      a.checkOut.localeCompare(b.checkOut),
  );
}

export function normalizeSheet(
  source: SheetSource,
  mapping: Mapping,
  property: Property,
): NormalizedOrder[] {
  validateMapping(mapping);
  if (
    !Array.isArray(source.rows) ||
    source.rows.length > 501 ||
    source.rows.length < mapping.headerRow ||
    source.rows.some(
      (r) =>
        !Array.isArray(r) ||
        r.length > 52 ||
        r.some((v) => typeof v !== "string" || v.length > 2000),
    )
  )
    throw new Error("IMPORT_SIZE");
  const groups = new Map<string, Group>();
  let roomNights = 0;
  function add(row: string[], rowNumber: number, column?: number) {
    const c = mapping.columns;
    const reference: SourceReference = {
      row: rowNumber,
      ...(column === undefined ? {} : { column: column + 1 }),
    };
    const selection =
      column === undefined ? rowNumber : rowNumber * 100 + column + 1;
    const grid = mapping.grid;
    const content = column === undefined ? "" : cell(row, column);
    const rawId =
      column === undefined
        ? cell(row, c.externalId)
        : (grid!.orderIds[`${rowNumber}:${column + 1}`] ??
          (grid!.cellMeaning === "order-id" ? content : ""));
    const groupKey = rawId ? `id:${rawId}` : `row:${selection}`;
    const group = groups.get(groupKey) ?? {
      selection,
      externalId: null,
      lines: [],
      references: [],
      issues: [],
    };
    groups.set(groupKey, group);
    group.references.push(reference);
    try {
      const externalId = textValue(rawId, 200);
      group.externalId = externalId;
      if (mapping.granularity !== "order" && !externalId)
        throw new Error(
          column === undefined
            ? "多列訂單需要來源訂單編號，不能只按客人姓名合併"
            : "此房況格尚未指定訂單編號，不能只按客人姓名合併",
        );
      const status = cell(row, c.status).toLowerCase();
      if (["取消", "已取消", "cancelled", "canceled", "void"].includes(status))
        throw new Error("來源標示取消，不匯入有效房況");
      if (
        status &&
        ![
          "成立",
          "已確認",
          "確認",
          "有效",
          "已入住",
          "已退房",
          "confirmed",
          "active",
          "checked-in",
          "checked-out",
        ].includes(status)
      )
        throw new Error("來源訂單狀態不明，請核對後再匯入");
      const checkIn = sourceDate(
        column === undefined
          ? cell(row, c.checkIn)
          : cell(source.rows[mapping.headerRow - 1], column),
      );
      const checkOut =
        mapping.granularity === "night" || column !== undefined
          ? dayAfter(checkIn)
          : sourceDate(cell(row, c.checkOut));
      dateValue(checkOut);
      const nights = (Date.parse(checkOut) - Date.parse(checkIn)) / 86400000;
      if (nights < 1 || nights > 366)
        throw new Error("退房日期需晚於入住，最長 366 晚");
      const roomIds = roomsFor(cell(row, c.rooms), mapping, property);
      roomNights += nights * roomIds.length;
      if (roomNights > MAX_ROOM_NIGHTS) throw new Error("IMPORT_SIZE");
      group.lines.push({
        selection,
        reference,
        externalId,
        checkIn,
        checkOut,
        roomIds,
        guestName: textValue(
          column !== undefined && grid!.cellMeaning === "guest-name"
            ? content
            : cell(row, c.guestName),
          100,
        ),
        total: money(cell(row, c.total)),
        paid: money(cell(row, c.received)),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "IMPORT_SIZE")
        throw error;
      group.issues.push(
        error instanceof Error && error.message !== "INVALID_INPUT"
          ? error.message
          : "欄位內容超出限制",
      );
    }
  }
  source.rows.slice(mapping.headerRow).forEach((row, i) => {
    if (row.every((v) => !v.trim())) return;
    if (mapping.granularity !== "grid") add(row, mapping.headerRow + i + 1);
    else
      for (const column of [...mapping.grid!.dateColumns].sort(
        (a, b) => a - b,
      )) {
        if (cell(row, column)) add(row, mapping.headerRow + i + 1, column);
      }
  });
  return [...groups.values()].map((group) => {
    const result: NormalizedOrder = {
      row: group.selection,
      sourceRows: [...new Set(group.references.map((r) => r.row))].sort(
        (a, b) => a - b,
      ),
      references: group.references,
      roomNightCount: 0,
      draft: null,
      issues: [...new Set(group.issues)],
      fingerprint: "",
    };
    if (group.issues.length || !group.lines.length) return result;
    try {
      const names = [
        ...new Set(
          group.lines.flatMap((line) =>
            line.guestName ? [line.guestName] : [],
          ),
        ),
      ];
      if (names.length > 1)
        throw new Error("同一訂單編號有不同客人姓名，請核對整組資料");
      const nightlyPrices: NonNullable<Booking["nightlyPrices"]> = [];
      const nights = new Map<string, { roomId: string; date: string }>();
      for (const line of group.lines) {
        for (
          let date = line.checkIn;
          date < line.checkOut;
          date = dayAfter(date)
        ) {
          for (const roomId of line.roomIds) {
            const key = `${roomId}:${date}`;
            if (nights.has(key))
              throw new Error(
                "同一訂單重複占用相同房間與住宿日，請核對重複來源列",
              );
            nights.set(key, { roomId, date });
            const knownNightly =
              mapping.amountBasis === "room-night" ||
              (mapping.amountBasis === "night" && line.roomIds.length === 1) ||
              (mapping.amountBasis === "line" &&
                line.roomIds.length === 1 &&
                dayAfter(line.checkIn) === line.checkOut);
            if (knownNightly && line.total !== null)
              nightlyPrices.push({ roomId, date, amount: line.total / 100 });
          }
        }
      }
      const stays = compactStays([...nights.values()]);
      if (stays.length > 50)
        throw new Error("同一訂單最多 50 段住宿，請核對來源分組");
      const total =
        mapping.amountBasis === "order"
          ? uniqueAmount(
              group.lines.map((l) => l.total),
              "訂單總額",
            )
          : group.lines.some((l) => l.total === null)
            ? null
            : group.lines.reduce(
                (sum, l) =>
                  sum +
                  l.total! *
                    (["night", "room-night"].includes(mapping.amountBasis)
                      ? (Date.parse(l.checkOut) - Date.parse(l.checkIn)) /
                        86400000
                      : 1) *
                    (mapping.amountBasis === "room-night"
                      ? l.roomIds.length
                      : 1),
                0,
              );
      const paid = uniqueAmount(
        group.lines.map((l) => l.paid),
        "累計已付金額",
      );
      if (total !== null && total > 100000000 * 100)
        throw new Error("金額超出範圍");
      const checkIn = stays[0].checkIn;
      const checkOut = stays.reduce(
        (d, s) => (d > s.checkOut ? d : s.checkOut),
        stays[0].checkOut,
      );
      const draft: ImportDraft = {
        guestName: names[0] ?? null,
        externalId: group.externalId,
        checkIn,
        checkOut,
        roomIds: [...new Set(stays.flatMap((s) => s.roomIds))].sort(),
        ...(stays.length > 1 || group.lines.length > 1 ? { stays } : {}),
        ...(nightlyPrices.length
          ? {
              nightlyPrices: nightlyPrices.sort(
                (a, b) =>
                  a.date.localeCompare(b.date) ||
                  a.roomId.localeCompare(b.roomId),
              ),
            }
          : {}),
        total: total === null ? null : total / 100,
        importedFinance: {
          currency: "TWD",
          amountBasis: mapping.amountBasis,
          sourceAmount:
            mapping.amountBasis === "order"
              ? total === null
                ? null
                : total / 100
              : group.lines.length === 1 && group.lines[0].total !== null
                ? group.lines[0].total / 100
                : null,
          receivedMeaning: mapping.receivedMeaning,
          propertyReceived:
            mapping.receivedMeaning === "property" && paid !== null
              ? paid / 100
              : null,
          guestPaid:
            mapping.receivedMeaning === "guest" && paid !== null
              ? paid / 100
              : null,
          ...(mapping.receivedMeaning === "source"
            ? { sourcePaid: paid === null ? null : paid / 100 }
            : {}),
        },
      };
      result.draft = draft;
      result.roomNightCount = nights.size;
      result.fingerprint = importFingerprint(draft);
    } catch (error) {
      result.issues.push(
        error instanceof Error ? error.message : "無法轉換此訂單",
      );
    }
    return result;
  });
}
