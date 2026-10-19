import { createHash } from "node:crypto";

import type { CalendarBooking } from "../../components/calendar/calendar-types";
import type { SheetSourceDefinition } from "./config";
import { adaptSheetBookings } from "./sweetfun-sheet.ts";
import { HEADERS, normalizeRows } from "../sheet-monitor/reconcile.ts";

const rowId = (source: SheetSourceDefinition, uid: string) =>
  `sheet-${createHash("sha256").update(`${source.sourceId}:row:${uid}`).digest("hex").slice(0, 20)}`;

export type BatchReviewRow = {
  id: string;
  date: string;
  room: string;
  guest: string;
  orderNumber: string | null;
  sourceLinked: boolean;
  sourcePaid: boolean;
};

export type BatchReviewPreview = {
  propertyId: string;
  rows: BatchReviewRow[];
  omitted: BatchReviewRow[];
  roomNightCount: number;
  distinctOrderCount: number;
  formalOrderCount: number;
  unlinkedRoomNightCount: number;
  paidRoomNightCount: number;
  selectionComplete: boolean;
};

export type BatchReviewPlan = {
  preview: BatchReviewPreview;
  selectedOrderIds: string[];
};

function summaryRow(booking: CalendarBooking, sourceRow: number, values: unknown[][], nameColumn: number, sourceOrder: string): BatchReviewRow {
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

const ordered = (a: BatchReviewRow, b: BatchReviewRow) =>
  a.date.localeCompare(b.date) || a.room.localeCompare(b.room) || a.id.localeCompare(b.id);

// The selection contains source-row identities, never mutable Sheet row numbers.
// Review a parent order as a whole. Missing source numbers stay independent rows.
export function planBatchReview(values: unknown[][], source: SheetSourceDefinition, ids: string[]): BatchReviewPlan {
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
  // must still block an incomplete or misleading review of that order.
  const selectedFormalNumbers = new Set(safeSelected.filter(booking => booking.source_order_linked)
    .map(booking => sourceRows.get(booking.id)?.cells[11]));
  for (const row of normalized) {
    if (row.cells[11] && selectedFormalNumbers.has(row.cells[11]) &&
        !selectedSet.has(rowId(source, row.cells[9])) && !acceptedIds.has(rowId(source, row.cells[9]))) {
      throw Error("SOURCE_CONFLICT");
    }
  }
  const omitted = bookings.filter(booking => selectedOrders.has(booking.order_id) && !selectedSet.has(booking.id));
  if (ids.some(id => !sourceRows.has(id))) throw Error("SOURCE_CHANGED");
  const describe = (booking: CalendarBooking) => {
    const row = sourceRows.get(booking.id);
    if (!row) throw Error("SOURCE_CHANGED");
    return summaryRow(booking, row.sourceRow, values, nameColumn, row.cells[11]);
  };
  const rows = safeSelected.map(describe).sort(ordered);
  const omittedRows = omitted.map(describe).sort(ordered);
  const formalOrders = new Set(safeSelected.filter(booking => booking.source_order_linked).map(booking => booking.order_id));
  const preview: BatchReviewPreview = {
    propertyId: source.property.id,
    rows,
    omitted: omittedRows,
    roomNightCount: rows.length,
    distinctOrderCount: selectedOrders.size,
    formalOrderCount: formalOrders.size,
    unlinkedRoomNightCount: safeSelected.filter(booking => !booking.source_order_linked).length,
    paidRoomNightCount: rows.filter(row => row.sourcePaid).length,
    selectionComplete: omittedRows.length === 0,
  };
  return { preview, selectedOrderIds: [...selectedOrders] };
}
