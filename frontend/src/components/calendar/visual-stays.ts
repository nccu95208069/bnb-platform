import type { CalendarBooking } from "./calendar-types";
import { addDays } from "./calendar-utils";
import { comparableGuestName } from "@/lib/guest-remarks";

// These source rows were checked against the OFFLAND Sheet on 2026-10-15.
// This is a calendar presentation link only: each row retains its own order ID,
// payment ledger, finance allocation, and notification state.
const OFFLAND_VISUAL_STAYS = [
  { platform: "owljourney", nights: [
    ["sheet-2eafc35d9fcb6a2e0244", "2026-10-09"],
    ["sheet-31d4c161464248c37014", "2026-10-10"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-b7402ee1d1d15fe944f8", "2026-10-12"],
    ["sheet-6a2a144755ad3ef892cf", "2026-10-13"],
    ["sheet-0bb01cb0bd5fd5534bf1", "2026-10-14"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-9875596077c6235027ea", "2026-10-15"],
    ["sheet-6d71d91558f920c25983", "2026-10-16"],
  ] },
  { platform: "booking", nights: [
    ["sheet-e5a0273523a36cfc917d", "2026-10-19"],
    ["sheet-2037aeb7e2c4aafb37fd", "2026-10-20"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-b7b2645bd55994420fa6", "2026-10-26"],
    ["sheet-143b70fae41711bac4b3", "2026-10-27"],
  ] },
] as const;

function linkedRows(
  bookings: CalendarBooking[],
  expected: (typeof OFFLAND_VISUAL_STAYS)[number],
): CalendarBooking[] | null {
  const byId = new Map(bookings.map((booking) => [booking.id, booking]));
  const rows = expected.nights.map(([id]) => byId.get(id));
  if (rows.some((row) => !row)) return null;
  const linked = rows as CalendarBooking[];
  const first = linked[0];
  if (!linked.every((booking, index) =>
    booking.property_id === "offland" &&
    booking.room_id === "offland-villa" &&
    booking.platform === expected.platform &&
    booking.booked_at === first.booked_at &&
    (booking.guest_name_kind !== "real" || first.guest_name_kind !== "real" ||
      comparableGuestName(booking.guest_name) === comparableGuestName(first.guest_name)) &&
    booking.reservation_status === "confirmed" &&
    booking.source_read_only === true &&
    booking.source_order_linked === false &&
    booking.source_identity_kind === "row" &&
    !booking.source_conflict &&
    booking.check_in === expected.nights[index][1] &&
    booking.check_out === addDays(expected.nights[index][1], 1)
  )) return null;
  return linked;
}

export function visualCalendarStays(bookings: CalendarBooking[]): CalendarBooking[] {
  let result = bookings;
  for (const expected of OFFLAND_VISUAL_STAYS) {
    const linked = linkedRows(result, expected);
    if (!linked) continue;
    const first = linked[0];
    const ids = linked.map((booking) => booking.id);
    const last = linked[linked.length - 1];
    const display: CalendarBooking = {
      ...first,
      check_out: last.check_out,
      room_rate: linked.reduce((sum, booking) => sum + booking.room_rate, 0),
      nightly_amounts: linked.flatMap((booking) => booking.nightly_amounts ?? []),
      payment_status: linked.every((booking) => booking.payment_status === first.payment_status)
        ? first.payment_status : "unknown",
      stay_nights: linked.length,
      visual_source_ids: ids,
    };
    const otherIds = new Set(ids.slice(1));
    result = result.filter((booking) => !otherIds.has(booking.id)).map((booking) =>
      booking.id === first.id ? display : booking,
    );
  }
  return result;
}
