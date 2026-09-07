import { parseGuestRemarks } from "../guest-remarks.ts";
import { createHash } from "node:crypto";
import type { CalendarBooking } from "../../components/calendar/calendar-types";
import type { SheetSourceDefinition } from "./config";
import { normalizeRows, HEADERS } from "../sheet-monitor/reconcile.ts";
import { adaptSheetBookings } from "./sweetfun-sheet.ts";

// Call only after server-side owner authorization. Names are never persisted in
// the anonymous monitor state, logs, or exported public snapshots.
export function attachPrivateGuestNames(bookings: CalendarBooking[], values: unknown[][], source: SheetSourceDefinition): CalendarBooking[] {
  const headers = (values[0] ?? []).map(v => { const h = String(v).trim(); return source.headerAliases?.[h] ?? h; });
  if (headers.filter(h => h === "預定人姓名").length !== 1) throw new Error("SHEET_SCHEMA_MISMATCH");
  const normalized = normalizeRows(values, source);
  const current = adaptSheetBookings([HEADERS, ...normalized.map(r => r.cells)], source.sourceId, new Date().toISOString(), [], normalized.map(r => r.sourceRow), source.property);
  const currentById = new Map(current.bookings.filter(b => !b.source_conflict).map(b => [b.id, b]));
  const names = new Map(normalized.map(row => {
    const id = `sheet-${createHash("sha256").update(`${source.sourceId}:row:${row.cells[9]}`).digest("hex").slice(0, 20)}`;
    const name = String(values[row.sourceRow - 1]?.[headers.indexOf("預定人姓名")] ?? "").trim();
    const raw = values[row.sourceRow - 1] ?? [];
    const field = (label: string) => { const indices = headers.flatMap((h,i)=>h === label ? [i] : []); return indices.length === 1 ? String(raw[indices[0]] ?? "").trim() : ""; };
    return [id, {name, ota: field("OTA訂單編號"), owl: field("訂單編號")}];
  }));
  return bookings.map(booking => {
    if (booking.property_id !== source.property.id || booking.source_conflict) return booking;
    const row = currentById.get(booking.id);
    // A moved/deleted/reused row or an unconfirmed source change must not attach
    // another stay's identity to the last published calendar record.
    const matches = row && row.order_id === booking.order_id && row.room_id === booking.room_id && row.check_in === booking.check_in && row.check_out === booking.check_out && row.platform === booking.platform && row.room_rate === booking.room_rate;
    const name = matches ? names.get(booking.id)?.name ?? "" : "";
    return { ...booking, external_order_no: matches ? names.get(booking.id)?.ota || null : null, owlnest_order_no: matches ? names.get(booking.id)?.owl || null : null, guest_remarks: parseGuestRemarks(name), guest_name: name || (matches ? "姓名未提供" : "姓名待同步確認"), guest_name_kind: name ? "real" : "missing",
      notes: booking.notes?.replace("公開畫面顯示匿名編號。", "私人檢視顯示來源姓名。") ?? null };
  });
}
