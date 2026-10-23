import type { CalendarBooking } from "./calendar-types";
import { addDays } from "./calendar-utils";
import { comparableGuestName } from "@/lib/guest-remarks";

// These source rows were checked against the OFFLAND Sheet on 2026-10-15 by
// guest, booking date (the source has no time of day), and nightly rate.
// This is a calendar presentation link only: each row retains its own order ID,
// payment ledger, finance allocation, and notification state.
export const OFFLAND_VISUAL_STAYS = [
  { platform: "agoda", nights: [
    ["sheet-4529bd08179ba11e198e", "2025-12-31"],
    ["sheet-1e019bf649f021fe3b78", "2026-01-01"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-4b7e1dc9b9d8e4b20c8b", "2026-02-21"],
    ["sheet-c8f3fbf42e5f57228cd7", "2026-02-22"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-eae415f9da6eebc4023e", "2026-03-18"],
    ["sheet-609f154ca266571736a6", "2026-03-19"],
  ] },
  { platform: "booking", nights: [
    ["sheet-f31f887c8f25957b3671", "2026-03-23"],
    ["sheet-6e1323667ab5b0127bfc", "2026-03-24"],
  ] },
  { platform: "direct", nights: [
    ["sheet-860927b32693c1e58198", "2026-03-26"],
    ["sheet-d6685a59f151081edb31", "2026-03-27"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-df909f3bfda024d2fdd1", "2026-04-07"],
    ["sheet-e41c29ef91bb4bf5b385", "2026-04-08"],
  ] },
  { platform: "booking", nights: [
    ["sheet-b47d939836284a6dfc4e", "2026-04-15"],
    ["sheet-61d2167e32288beee372", "2026-04-16"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-77abdb6682b6efe84626", "2026-05-11"],
    ["sheet-a6b3d8fe6fef60a4ae65", "2026-05-12"],
  ] },
  { platform: "direct", nights: [
    ["sheet-c70a0a6d719e8057284d", "2026-05-17"],
    ["sheet-4d76126c4ca0ec4e8a77", "2026-05-18"],
  ] },
  { platform: "other", nights: [
    ["sheet-4700bf3816fb6e34629f", "2026-06-19"],
    ["sheet-fbe030903d60a205bfd5", "2026-06-20"],
  ] },
  { platform: "booking", nights: [
    ["sheet-dff69a448b1510b369b4", "2026-06-22"],
    ["sheet-3211527b99e5893f1374", "2026-06-23"],
  ] },
  { platform: "direct", nights: [
    ["sheet-3a6f9fde334de1104f35", "2026-07-02"],
    ["sheet-7cfa5112fbcfe629f40c", "2026-07-03"],
  ] },
  { platform: "direct", nights: [
    ["sheet-a003188c33ea1c7ec3c3", "2026-07-19"],
    ["sheet-c0205e43e729a41f7610", "2026-07-20"],
  ] },
  { platform: "booking", nights: [
    ["sheet-53d65dcd73209c1e486a", "2026-07-29"],
    ["sheet-959f500e2581ed6c19af", "2026-07-30"],
  ] },
  { platform: "direct", nights: [
    ["sheet-a40868e1152f6b4f6963", "2026-08-03"],
    ["sheet-e2eff4d2e8891a038154", "2026-08-04"],
  ] },
  { platform: "other", nights: [
    ["sheet-0f86b9330795d220edaf", "2026-08-05"],
    ["sheet-228f77df9cc586c70a32", "2026-08-06"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-83700c7ef024782d9557", "2026-08-10"],
    ["sheet-d910abf56aea95b46c91", "2026-08-11"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-9cb0a694b3ff0aa79810", "2026-08-19"],
    ["sheet-22cee7eb1c42f4009b48", "2026-08-20"],
  ] },
  { platform: "direct", nights: [
    ["sheet-27edac3a7ef85837326f", "2026-08-23"],
    ["sheet-3aa96fbcfac678aca012", "2026-08-24"],
  ] },
  { platform: "direct", nights: [
    ["sheet-fcd0b13dc597dab94ac4", "2026-09-03"],
    ["sheet-0db7e56e12ab93dff907", "2026-09-04"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-1011b4c5eae778612d5e", "2026-09-18"],
    ["sheet-ef70a54533f867aa8408", "2026-09-19"],
  ] },
  { platform: "other", nights: [
    ["sheet-6de2542bebba40eb99ac", "2026-09-22"],
    ["sheet-72965a9ed98d89f79232", "2026-09-23"],
  ] },
  { platform: "other", confirmedException: true, nights: [
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
  { platform: "booking", nights: [
    ["sheet-128d29a0b339abf039b7", "2026-11-02"],
    ["sheet-7554354918cf716ff7d5", "2026-11-03"],
  ] },
  { platform: "direct", nights: [
    ["sheet-1fe0cffbc4cff4f0326f", "2026-11-22"],
    ["sheet-1de0ed9ad324e0d39aaf", "2026-11-23"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-34629e0e8df8abdde857", "2026-11-24"],
    ["sheet-cb8bed00d9dba52fd94a", "2026-11-25"],
  ] },
  { platform: "direct", nights: [
    ["sheet-1b7d1fb95dcc53df76dd", "2026-11-26"],
    ["sheet-8a7fa744fb6c8d58332d", "2026-11-27"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-5c1819f760c1b632862f", "2026-11-30"],
    ["sheet-407a6d677e28cca8d33f", "2026-12-01"],
    ["sheet-0c298ca7cd408ac56f0f", "2026-12-02"],
  ] },
  { platform: "booking", nights: [
    ["sheet-852193014914986620f6", "2027-01-18"],
    ["sheet-d11527194e889689d3dc", "2027-01-19"],
  ] },
  { platform: "other", nights: [
    ["sheet-da593ff0380ad3f69aab", "2027-01-25"],
    ["sheet-32a4563a362e85777f35", "2027-01-26"],
  ] },
  { platform: "airbnb", nights: [
    ["sheet-252101eaac74fa048e3a", "2027-01-28"],
    ["sheet-a0b464ad184d17174850", "2027-01-29"],
  ] },
  { platform: "booking", nights: [
    ["sheet-8eb15ebe3a45c46958e9", "2027-02-06"],
    ["sheet-be6788e67eca43b1e04f", "2027-02-07"],
  ] },
  { platform: "booking", nights: [
    ["sheet-de55fbb3871de530f502", "2027-03-14"],
    ["sheet-4b673762a2f02cc875ef", "2027-03-15"],
  ] },
  { platform: "booking", nights: [
    ["sheet-063ffed7d0bcc9c1505e", "2027-03-18"],
    ["sheet-033ca8edbfd3cdd0f1a5", "2027-03-19"],
    ["sheet-f3b2eefa6735b51cf54c", "2027-03-20"],
  ] },
  { platform: "direct", nights: [
    ["sheet-dd5d748c1431b4aa53cd", "2027-05-22"],
    ["sheet-d1ffc0fee8a571e10fb2", "2027-05-23"],
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
  const rates = linked.map((booking) => booking.room_rate);
  if (!first.booked_at || !rates.every(Number.isFinite) ||
    (!("confirmedException" in expected) && Math.max(...rates) - Math.min(...rates) > 1)) return null;
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
      payment_review_status: linked.every((booking) =>
        booking.payment_review_status === first.payment_review_status)
        ? first.payment_review_status : undefined,
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
