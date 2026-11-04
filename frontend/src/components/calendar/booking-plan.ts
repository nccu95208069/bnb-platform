import type { CalendarBooking } from "./calendar-types";
export function bookingPlanLabel(booking: Pick<CalendarBooking, "property_id" | "booking_plan">): string | null {
  if (booking.property_id !== "offland") return null;
  return booking.booking_plan === "four" ? "四人包棟" :
    booking.booking_plan === "six" ? "六人包棟" : "方案待確認";
}
