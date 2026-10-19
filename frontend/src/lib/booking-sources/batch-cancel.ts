import { createHash } from "node:crypto";

import type { CalendarBooking } from "../../components/calendar/calendar-types";
import type { SheetSourceDefinition } from "./config";
import { adaptSheetBookings } from "./sweetfun-sheet.ts";
import { HEADERS, normalizeRows } from "../sheet-monitor/reconcile.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rowId = (source: SheetSourceDefinition, uid: string) =>
  `sheet-${createHash("sha256").update(`${source.sourceId}:row:${uid}`).digest("hex").slice(0, 20)}`;

export type BatchCancelRow = {
  id: string;
  date: string;
  room: string;
  guest: string;
  orderNumber: string | null;
  sourceLinked: boolean;
  sourcePaid: boolean;
};

export type BatchCancelPreview = {
  digest: string;
  propertyId: string;
  rows: BatchCancelRow[];
  omitted: BatchCancelRow[];
  roomNightCount: number;
  distinctOrderCount: number;
  formalOrderCount: number;
  unlinkedRoomNightCount: number;
  paidRoomNightCount: number;
  canConfirm: boolean;
};

export type BatchCancelPlan = {
  preview: BatchCancelPreview;
  selectedRows: number[];
  selectedOrderIds: string[];
};

function summaryRow(booking: CalendarBooking, sourceRow: number, values: unknown[][], nameColumn: number, sourceOrder: string): BatchCancelRow {
  return {
    id: booking.id,
    date: booking.check_in,
    room: booking.room_number,
    guest: String(values[sourceRow - 1]?.[nameColumn] ?? "").trim() || "姓名未填",
    orderNumber: booking.source_order_linked ? sourceOrder || null : null,
    sourceLinked: booking.source_order_linked === true,
    sourcePaid: booking.source_payment_flag === "done",
  };
}

const ordered = (a: BatchCancelRow, b: BatchCancelRow) =>
  a.date.localeCompare(b.date) || a.room.localeCompare(b.room) || a.id.localeCompare(b.id);

// The selection contains immutable source-row identities, never mutable Sheet row numbers.
// A parent order is all-or-nothing. Missing source order numbers stay independent rows.
export function planBatchCancel(values: unknown[][], source: SheetSourceDefinition, ids: string[]): BatchCancelPlan {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 ||
      ids.some(id => typeof id !== "string" || !/^sheet-[a-f0-9]{20}$/.test(id)) ||
      new Set(ids).size !== ids.length) throw Error("INVALID_INPUT");
  const normalized = normalizeRows(values, source);
  const snapshot = adaptSheetBookings(
    [HEADERS, ...normalized.map(row => row.cells)], source.sourceId,
    new Date().toISOString(), [], normalized.map(row => row.sourceRow), source.property,
  );
  const bookings = snapshot.bookings.filter(booking => !booking.source_conflict);
  const headers = (values[0] ?? []).map(value => source.headerAliases?.[String(value).trim()] ?? String(value).trim());
  const nameColumn = headers.indexOf("預定人姓名");
  if (nameColumn < 0 || headers.lastIndexOf("預定人姓名") !== nameColumn) throw Error("SHEET_SCHEMA_MISMATCH");
  const byId = new Map(bookings.map(booking => [booking.id, booking]));
  const selected = ids.map(id => byId.get(id));
  if (selected.some(booking => !booking || booking.reservation_status !== "confirmed"))
    throw Error("SOURCE_CHANGED");
  const safeSelected = selected as CalendarBooking[];
  const selectedSet = new Set(ids);
  const selectedOrders = new Set(safeSelected.map(booking => booking.order_id));
  const sourceRows = new Map(normalized.map(row => [rowId(source, row.cells[9]), row]));
  const acceptedIds = new Set(bookings.map(booking => booking.id));
  // The adapter omits quarantined rows. A damaged row sharing a formal parent
  // must still block deletion of the otherwise valid nights in that order.
  const selectedFormalNumbers = new Set(safeSelected.filter(booking => booking.source_order_linked)
    .map(booking => sourceRows.get(booking.id)?.cells[11]));
  for (const row of normalized) {
    if (row.cells[11] && selectedFormalNumbers.has(row.cells[11]) &&
        !selectedSet.has(rowId(source, row.cells[9])) && !acceptedIds.has(rowId(source, row.cells[9]))) {
      throw Error("SOURCE_CONFLICT");
    }
  }
  const omitted = bookings.filter(booking => selectedOrders.has(booking.order_id) && !selectedSet.has(booking.id));
  const selectedRows = ids.map(id => sourceRows.get(id)?.sourceRow);
  if (selectedRows.some(row => !Number.isInteger(row) || Number(row) < 2)) throw Error("SOURCE_CHANGED");
  const describe = (booking: CalendarBooking) => {
    const row = sourceRows.get(booking.id);
    if (!row) throw Error("SOURCE_CHANGED");
    return summaryRow(booking, row.sourceRow, values, nameColumn, row.cells[11]);
  };
  const rows = safeSelected.map(describe).sort(ordered);
  const omittedRows = omitted.map(describe).sort(ordered);
  const formalOrders = new Set(safeSelected.filter(booking => booking.source_order_linked).map(booking => booking.order_id));
  const preview: BatchCancelPreview = {
    digest: hash([source.sourceId, values, ids.slice().sort()]),
    propertyId: source.property.id,
    rows,
    omitted: omittedRows,
    roomNightCount: rows.length,
    distinctOrderCount: selectedOrders.size,
    formalOrderCount: formalOrders.size,
    unlinkedRoomNightCount: safeSelected.filter(booking => !booking.source_order_linked).length,
    paidRoomNightCount: rows.filter(row => row.sourcePaid).length,
    canConfirm: omittedRows.length === 0,
  };
  return { preview, selectedRows: selectedRows as number[], selectedOrderIds: [...selectedOrders] };
}

export function expectedAfterDelete(values: unknown[][], selectedRows: number[]): unknown[][] {
  const remove = new Set(selectedRows);
  return values.filter((_, index) => !remove.has(index + 1));
}

export function verifiedAfterDelete(before: unknown[][], after: unknown[][], selectedRows: number[]): boolean {
  return hash(expectedAfterDelete(before, selectedRows)) === hash(after);
}

export function deleteDimensionRequests(source: SheetSourceDefinition, selectedRows: number[]) {
  const descending = [...new Set(selectedRows)].sort((a, b) => b - a);
  return descending.map(row => ({
    deleteDimension: { range: { sheetId: source.sheetId, dimension: "ROWS" as const, startIndex: row - 1, endIndex: row } },
  }));
}
