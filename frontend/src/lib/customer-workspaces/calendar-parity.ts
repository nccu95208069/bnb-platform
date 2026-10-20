import type { CalendarBooking, CalendarProperty, CalendarRoom } from "@/components/calendar/calendar-types";
import { financeSummary, staysOf } from "./domain.ts";
import { bookingStatusLabel } from "./hold-state.ts";
import type { Booking, Property, WorkspaceView } from "./types.ts";

export function channelForCalendar(value: string | null | undefined): CalendarBooking["platform"] {
  const text = (value ?? "").trim().toLowerCase();
  if (/booking|bkg/.test(text)) return "booking";
  if (/agoda|ago/.test(text)) return "agoda";
  if (/airbnb|air bnb/.test(text)) return "airbnb";
  if (/trip|ctrip/.test(text)) return "ctrip";
  if (/owl/.test(text)) return "owljourney";
  if (/line|直訂|直接|官網|direct|official website/.test(text)) return "direct";
  return "other";
}

export function customerCalendarProjection(
  data: WorkspaceView,
  property: Property,
): { properties: CalendarProperty[]; rooms: CalendarRoom[]; bookings: CalendarBooking[] } {
  const properties: CalendarProperty[] = [{
    id: property.id, name: property.name, short_name: property.name,
    location: "", room_count: property.rooms.length, color: "emerald",
  }];
  const rooms: CalendarRoom[] = property.rooms.map((room) => ({
    id: room.id, property_id: property.id, room_number: room.name, label: room.name,
  }));
  const roomNames = new Map(property.rooms.map((room) => [room.id, room.name]));
  const bookings = data.bookings
    .filter((booking) => booking.propertyId === property.id && booking.status !== "cancelled")
    .flatMap((booking) => projectBooking(booking, property, roomNames, data.role));
  return { properties, rooms, bookings };
}

function projectBooking(
  booking: WorkspaceView["bookings"][number],
  property: Property,
  roomNames: Map<string, string>,
  role: WorkspaceView["role"],
): CalendarBooking[] {
  const finance = financeSummary(booking as Booking);
  const paymentStatus: CalendarBooking["payment_status"] =
    finance.status === "paid" ? "paid" :
    finance.status === "unpaid" ? "unpaid" :
    finance.status === "partial" ? "deposit" : "unknown";
  return staysOf(booking).flatMap((stay, index) => stay.roomIds.flatMap((roomId) => {
    const roomName = roomNames.get(roomId);
    if (!roomName) return [];
    return [{
      id: `${booking.id}:${index}:${roomId}`,
      sheet_row_id: booking.imported ? String(booking.imported.row) : booking.id,
      order_id: booking.id,
      external_order_no: booking.imported?.externalId ?? null,
      property_id: property.id,
      property_name: property.name,
      room_id: roomId,
      room_number: roomName,
      guest_name: booking.guestName ?? "",
      guest_name_kind: booking.guestName ? "real" as const : "missing" as const,
      platform: channelForCalendar(booking.platform),
      check_in: stay.checkIn,
      check_out: stay.checkOut,
      booked_at: booking.bookedAt ?? null,
      room_rate: 0,
      payment_status: paymentStatus,
      reservation_status: booking.status,
      ...(booking.status === "held" ? { hold_label: bookingStatusLabel(booking) } : {}),
      notes: null,
      payments: [],
      audit_log: [],
      extra_guest_count: 0,
      extra_bed_count: 0,
      pet_count: 0,
      baby_supplies: [],
      service_note: null,
      snapshot_only: true,
      price_hidden: role === "viewer_no_price",
      source_identity_kind: booking.imported?.externalId?.startsWith("source-row:") ? "row" as const : "parent_order" as const,
    } satisfies CalendarBooking];
  }));
}
