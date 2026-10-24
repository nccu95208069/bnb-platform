import { computeBusinessMetrics, type BusinessBooking, type BusinessPulseData } from "./business-metrics.ts";
import { GateError } from "./errors.ts";
import type { Booking, NightPrice, PropertyState } from "./types.ts";

export type BusinessReport = BusinessPulseData & {
  meta: BusinessPulseData["meta"] & {
    inventoryVersion: number;
    authorityEpoch: number;
    readOnly: false;
    saleReady: false;
    unknownPlatformBookings: number;
  };
};

function invalidReport(): never { throw new GateError("REPORT_DATA_INVALID", 409); }

/** Date-only source facts remain date-only. Import time is never a booking date. */
function sourceDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date ? date : null;
}

function importedRows(booking: Booking): Record<string, unknown>[] {
  const rows = booking.sweetfunSnapshot?.rows;
  return booking.source === "external" && !booking.sourceCalendar && Array.isArray(rows)
    && rows.every((row) => row && typeof row === "object" && !Array.isArray(row)) ? rows : [];
}

function bookedOn(booking: Booking): string | null {
  const current = sourceDate(booking.bookedAt);
  if (current) return current;
  // Original imports may have retained slash-format dates. Only unanimous,
  // normalized source-row evidence can fill a missing original booking date.
  const rows = importedRows(booking);
  const dates = rows.map((row) => sourceDate(row.bookedAt));
  return dates.length > 0 && dates.every((date) => date !== null && date === dates[0]) ? dates[0] : null;
}

const PLATFORMS: Record<string, string> = {
  booking: "Booking", "booking.com": "Booking", agoda: "Agoda", airbnb: "Airbnb",
  ctrip: "Ctrip", "trip.com": "Ctrip", trip: "Ctrip", "攜程": "Ctrip", "携程": "Ctrip",
  line: "LINE", owljourney: "奧丁丁", owlnest: "奧丁丁", "奧丁丁": "奧丁丁",
  expedia: "Expedia", "hotels.com": "Hotels.com", klook: "Klook", kkday: "KKday",
  website: "官網", "官網": "官網", "官網訂房": "官網", direct: "直接訂房",
  "直接訂房": "直接訂房", "電話": "電話", "自來客": "自來客", "其他": "其他",
};

function platform(booking: Booking): { name: string; unknown: boolean } {
  let value: unknown = booking.sourceCalendar?.platform;
  if (!booking.sourceCalendar) {
    const values = importedRows(booking).map((row) => Array.isArray(row.values) ? row.values[2] : null);
    if (values.length && values.every((item) => item === values[0])) value = values[0];
    else if (booking.source === "line") value = "LINE";
    else if (booking.source === "website") value = "website";
  }
  // Never forward arbitrary source strings: a malformed channel label could
  // contain a guest name, contact information, or an external order number.
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  const name = Object.hasOwn(PLATFORMS, key) ? PLATFORMS[key] : undefined;
  return { name: name ?? "其他", unknown: !name };
}

/** Only unambiguous public room numbers are recovered; canonical UUIDs stay private. */
function publicRooms(state: PropertyState): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const booking of state.bookings) {
    // A later room amendment can retain the same dates and frozen source rows.
    // Those rows no longer prove which canonical room the public label belongs to.
    if (booking.version !== 1 + (booking.paymentEvents?.length ?? 0)) continue;
    const rows = importedRows(booking);
    if (rows.length !== booking.stays.length) continue;
    for (const [index, stay] of booking.stays.entries()) {
      const row = rows[index];
      if (stay.roomIds.length !== 1 || !state.roomIds.includes(stay.roomIds[0]) ||
        typeof row.room !== "string" || !/^\d{1,4}$/.test(row.room) ||
        sourceDate(row.checkIn) !== stay.checkIn || sourceDate(row.checkOut) !== stay.checkOut) continue;
      const id = stay.roomIds[0], name = row.room;
      const labels = candidates.get(id) ?? new Set<string>();
      labels.add(name); candidates.set(id, labels);
      const ids = reverse.get(name) ?? new Set<string>();
      ids.add(id); reverse.set(name, ids);
    }
  }
  return new Map(state.roomIds.map((id, index) => {
    const labels = candidates.get(id);
    const candidate = labels?.size === 1 ? [...labels][0] : undefined;
    return [id, candidate && reverse.get(candidate)?.size === 1 ? candidate : `房間 ${index + 1}`];
  }));
}

function stayAmounts(booking: Booking, rooms: Map<string, string>): number[] | null {
  if (booking.totalCents === null || booking.stays.some((stay) => stay.roomIds.length !== 1)) return null;
  if (booking.stays.length === 1) return [booking.totalCents];
  const rows = importedRows(booking);
  if (booking.version !== 1 + (booking.paymentEvents?.length ?? 0) || rows.length !== booking.stays.length)
    return null;
  const amounts: number[] = [];
  for (const [index, stay] of booking.stays.entries()) {
    const row = rows[index];
    if (row.room !== rooms.get(stay.roomIds[0]) || sourceDate(row.checkIn) !== stay.checkIn ||
      sourceDate(row.checkOut) !== stay.checkOut || typeof row.roomFeeCents !== "number" ||
      !Number.isSafeInteger(row.roomFeeCents) || row.roomFeeCents < 0) return null;
    amounts.push(row.roomFeeCents);
  }
  const sum = amounts.reduce((value, amount) => value + amount, 0);
  return Number.isSafeInteger(sum) && sum === booking.totalCents ? amounts : null;
}

/** Called only after the service's dedicated aggregate-scope and authority checks. */
export function createBusinessReport(state: PropertyState,
  paid: (booking: Booking) => boolean, now = new Date(),
  exactNightPrices: ReadonlyMap<string, readonly NightPrice[]> = new Map()): BusinessReport {
  const rooms = publicRooms(state);
  let unknownPlatformBookings = 0;
  const input: BusinessBooking[] = state.bookings.map((booking) => {
    if (booking.workspaceId !== state.workspaceId || booking.propertyId !== state.propertyId ||
      booking.currency !== "TWD") invalidReport();
    const channel = platform(booking);
    if (booking.status === "confirmed" && channel.unknown) unknownPlatformBookings++;
    const amounts = stayAmounts(booking, rooms);
    const prices = exactNightPrices.get(booking.id);
    const stays = prices ? prices.map((price) => {
      const room = rooms.get(price.roomId);
      if (!room) invalidReport();
      return { room, checkIn: price.date,
        checkOut: new Date(Date.parse(`${price.date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10),
        amountCents: price.amountCents };
    }) : booking.stays.flatMap((stay, index) => stay.roomIds.map((id) => {
      const room = rooms.get(id);
      if (!room) invalidReport();
      return { room, checkIn: stay.checkIn, checkOut: stay.checkOut,
        ...(amounts ? { amountCents: amounts[index] } : {}) };
    }));
    return { id: booking.id, status: booking.status, bookedAt: bookedOn(booking),
      platform: channel.name, totalCents: booking.totalCents, paid: paid(booking),
      // Guest names, contact, notes, source aliases and external references never
      // enter the calculator; all guest labels are its fixed neutral placeholder.
      stays };
  });
  let report: BusinessPulseData;
  try {
    report = computeBusinessMetrics(input, { now, source: "iron-gate",
      sourceUpdatedAt: null, rooms: [...rooms.values()], propertyName: "民宿" });
  } catch { invalidReport(); }
  if (unknownPlatformBookings) report.meta.warnings.push(
    `${unknownPlatformBookings} 筆訂單的來源平台無法確認，歸入其他。`);
  return { ...report, meta: { ...report.meta, inventoryVersion: state.version,
    authorityEpoch: state.authorityEpoch, readOnly: false, saleReady: false, unknownPlatformBookings } };
}
