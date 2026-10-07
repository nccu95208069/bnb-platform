import type { Booking } from "./types.ts";

export const holdsEnabled = () => process.env.CUSTOMER_HOLDS_ENABLED === "true";
export function requireHoldsEnabled() {
  if (!holdsEnabled()) throw new Error("HOLDS_UNAVAILABLE");
}
export const occupiesInventory = (booking: Pick<Booking, "status">) =>
  booking.status === "confirmed" || booking.status === "held";

export function holdPhase(booking: Pick<Booking, "hold" | "status">, now = new Date()) {
  if (!booking.hold) return null;
  if (booking.hold.state === "converted" || booking.status === "confirmed") return "converted" as const;
  if (booking.status === "cancelled") return "released" as const;
  // The persisted deadline is also the durable owner task. Reading after a
  // restart reconstructs it; expiry never releases inventory or creates money.
  return Date.parse(booking.hold.expiresAt) <= now.getTime()
    ? "awaiting_owner" as const
    : "active" as const;
}
export function bookingStatusLabel(booking: Pick<Booking, "hold" | "status">, now = new Date()) {
  if (booking.status === "cancelled") return booking.hold && booking.hold.state !== "converted" ? "保留已釋出" : "已取消";
  if (booking.status === "held") return holdPhase(booking, now) === "awaiting_owner" ? "保留到期・待業主決定" : "保留中";
  return "正式訂單";
}
