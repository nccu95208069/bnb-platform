import type { Booking } from "./types.ts";

// Eligibility comes from immutable import evidence, never a label supplied by
// the editing client. Mixed/blank platform rows cannot claim a direct booking.
export function isOsDirectBooking(booking: Booking): boolean {
  if (booking.source === "os" || booking.source === "line") return true;
  if (booking.source !== "external" || booking.sourceCalendar || booking.offlandSnapshot) return false;
  const rows = booking.sweetfunSnapshot?.rows;
  return Array.isArray(rows) && rows.length > 0 && rows.every(row =>
    row && Array.isArray(row.values) && typeof row.values[2] === "string" &&
    row.values[2].trim().toLowerCase() === "line");
}

// This identifies the existing payment ledger; it does not assert that its old
// amount, dates, or paid flag still describe a locally edited order.
export function originalDirectOrderRef(booking: Booking): string | null {
  if (!isOsDirectBooking(booking) || booking.source !== "external") return null;
  const rows = booking.sweetfunSnapshot?.rows;
  const key = booking.sweetfunSnapshot?.groupKey;
  if (!Array.isArray(rows) || !rows.length || typeof key !== "string" ||
    !/^(?:L:[A-Za-z0-9-]{8,64}|J:[A-Za-z0-9_-]{8,100})$/.test(key)) return null;
  return rows.every(row => Array.isArray(row?.values) && key ===
    (key.startsWith("L:") ? `L:${String(row.values[11] ?? "").trim()}` :
      `J:${String(row.values[9] ?? "").trim()}`)) ? key : null;
}
