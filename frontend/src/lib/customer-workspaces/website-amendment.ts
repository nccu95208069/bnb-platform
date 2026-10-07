import { bookingsOverlap, cents, financeSummary, staysOf } from "./domain.ts";
import { occupiesInventory, requireHoldsEnabled } from "./hold-state.ts";
import { mutationContext, saveMutation } from "./mutations.ts";
import { money, normalizeStays, view } from "./service.ts";
import type { CustomerStore } from "./store.ts";
import type { Booking } from "./types.ts";
import { fields } from "../website-booking/config.ts";
import { bindingKey, nativeProperty } from "../website-booking/connections.ts";
import { holdNotificationChanges } from "../website-booking/lifecycle.ts";
import type { WebsiteBinding } from "../website-booking/types.ts";

// Owner-approved amendments use the same workspace CAS as reservations. They
// retain the original order/payment ledger and never renew the hold deadline.
export async function amendWebsiteBooking(
  store: CustomerStore, accountId: string, slug: string,
  input: Record<string, unknown>, now = new Date(),
) {
  requireHoldsEnabled();
  fields(input, ["action", "bookingId", "requestKey", "version", "bookingVersion", "confirmed",
    "checkIn", "checkOut", "roomIds", "total", "allowOverpayment"]);
  if (input.action !== "website-amend") throw Error("INVALID_INPUT");
  const { requestKey: _key, version: _version, ...normalized } = input;
  void _key; void _version;
  const context = await mutationContext(store, accountId, slug, input, "booking.website-amend", normalized, ["owner", "admin"]);
  const booking = context.workspace.bookings.find(b => b.id === input.bookingId);
  const property = context.workspace.properties.find(p => p.id === booking?.propertyId &&
    (context.member.allProperties || context.member.propertyIds.includes(p.id)));
  if (!booking || !property) throw Error("NOT_FOUND");
  if (!booking.website || booking.platform !== "Official Website" || booking.entry !== "os" || booking.hold?.scope !== "platform_only")
    throw Error("HOLD_INTEGRATION_REQUIRED");
  if (context.previous) return { workspace: view(context.workspace, context.member), bookingId: booking.id,
    operation: { key: context.key, verified: true, replayed: true } };
  nativeProperty(context.workspace, property);
  if (!["held", "confirmed"].includes(booking.status)) throw Error("ORDER_CANCELLED");
  if (booking.version !== input.bookingVersion) throw Error("VERSION_CONFLICT");
  if (input.confirmed !== true) throw Error("BOOKING_CHANGE_CONFIRMATION_REQUIRED");
  if (staysOf(booking).length !== 1) throw Error("BOOKING_AMENDMENT_UNSUPPORTED");
  const [stay] = normalizeStays(property, input);
  const bindingSnapshot = await store.read<WebsiteBinding>(bindingKey(booking.website.bindingId)), binding = bindingSnapshot.value;
  if (!binding || binding.workspaceId !== context.workspace.id || binding.propertyId !== property.id) throw Error("HOLD_INTEGRATION_REQUIRED");
  let capacity = 0;
  for (const roomId of stay.roomIds) {
    const mapping = binding.physicalMappings.filter(m => m.roomIds.includes(roomId));
    const roomType = binding.config.rooms.find(r => r.enabled && r.roomTypeId === mapping[0]?.roomTypeId);
    const places = Number(roomType?.capacity);
    if (mapping.length !== 1 || !Number.isSafeInteger(places) || places < 1 || places > 60) throw Error("BOOKING_ROOM_MAPPING_REQUIRED");
    capacity += places;
  }
  if (booking.website.adults + booking.website.children > capacity) throw Error("BOOKING_CAPACITY_CONFLICT");
  if ((property.setup?.coverageFrom && stay.checkIn < property.setup.coverageFrom) ||
      (property.setup?.coverageTo && stay.checkOut > property.setup.coverageTo)) throw Error("SOURCE_COVERAGE");
  const total = money(input.total);
  if (typeof input.total !== "number" || total === null || total <= 0 ||
      (booking.expectedDeposit != null && cents(booking.expectedDeposit) > cents(total))) throw Error("INVALID_INPUT");
  let next: Booking = { ...booking, ...stay, total, version: booking.version + 1 };
  // A single amended stay replaces the old single stay and original quote's
  // nightly amounts. Do not present stale source rates as the new agreement.
  delete next.stays;
  delete next.nightlyPrices;
  const finance = financeSummary(next);
  if (finance.received === null) throw Error("OPENING_BALANCE_REQUIRED");
  if (finance.credit !== null && finance.credit > 0 && input.allowOverpayment !== true)
    throw Error("OVERPAYMENT_CONFIRMATION_REQUIRED");
  if (context.workspace.bookings.some(b => b.id !== booking.id && b.propertyId === property.id && occupiesInventory(b) && bookingsOverlap(b, next)) ||
      context.workspace.blocks?.some(b => b.propertyId === property.id && b.status === "active" && bookingsOverlap(b, next))) throw Error("ROOM_CONFLICT");
  const notifications = await holdNotificationChanges(store, context.workspace, next, "booking_changed", now);
  // Capacity was checked against this exact approved mapping. A concurrent
  // owner reconfiguration cannot change it before the shared atomic commit.
  if (notifications.changes.find(c => c.key === bindingKey(binding.id))?.before !== bindingSnapshot.raw) throw Error("VERSION_CONFLICT");
  next = notifications.booking;
  const saved = await saveMutation(store, context, { ...context.workspace,
    bookings: context.workspace.bookings.map(b => b.id === next.id ? next : b) }, next.id, notifications.changes);
  const actual = saved.workspace.bookings.find(b => b.id === next.id);
  if (!actual || actual.version < next.version || (actual.version === next.version && JSON.stringify(actual) !== JSON.stringify(next)))
    throw Error("WRITE_UNCONFIRMED");
  return { workspace: view(saved.workspace, saved.member), bookingId: next.id,
    operation: { key: context.key, verified: true, replayed: false } };
}
