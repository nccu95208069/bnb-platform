import type { CalendarBooking } from "./calendar-types";
import { PLATFORM_LABELS } from "./calendar-utils";

export function realGuestName(booking: CalendarBooking): string {
  return booking.guest_name_kind === "real" ? booking.guest_name.trim() : "";
}

export function bookingIdentityText(booking: CalendarBooking): string {
  return [booking.source_conflict ? "待核對" : PLATFORM_LABELS[booking.platform] ?? "其他", realGuestName(booking), booking.room_number].filter(Boolean).join(" · ");
}

// Use the same ordering in week/day cards; aliases must never stand in for names.
export function BookingIdentity({ booking }: { booking: CalendarBooking }) {
  const guestName = realGuestName(booking);
  return (
    <span className="min-w-0 flex-1 truncate">
      <span className="font-semibold">{booking.source_conflict ? "待核對" : PLATFORM_LABELS[booking.platform] ?? "其他"}</span>
      {guestName && <span className="ml-1.5 font-medium">{guestName}</span>}
      <span className="ml-1.5 opacity-80">{booking.room_number}</span>
    </span>
  );
}
