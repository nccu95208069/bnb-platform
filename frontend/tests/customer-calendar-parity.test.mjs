import test from "node:test";
import assert from "node:assert/strict";
import { channelForCalendar, customerCalendarProjection } from "../src/lib/customer-workspaces/calendar-parity.ts";

const property = { id: "p", name: "Synthetic Inn", kind: "rooms", sourceMode: "native",
  rooms: [{ id: "r101", name: "101" }, { id: "r102", name: "102" }], villaRoomIds: [] };
const booking = { id: "b", propertyId: "p", status: "confirmed", guestName: "Synthetic Guest",
  platform: "Booking.com", checkIn: "2026-10-01", checkOut: "2026-10-03", roomIds: ["r101"],
  stays: [
    { checkIn: "2026-10-01", checkOut: "2026-10-03", roomIds: ["r101"] },
    { checkIn: "2026-10-10", checkOut: "2026-10-11", roomIds: ["r102"] },
  ], total: 5000, importedFinance: { propertyReceived: null }, entry: "sheet", payments: [],
  imported: { row: 2, externalId: "source-row:unique-a" } };

test("customer month calendar uses existing channel palette without crossing properties or inventing payment status", () => {
  assert.equal(channelForCalendar("Agoda"), "agoda");
  assert.equal(channelForCalendar("LINE／直訂"), "direct");
  assert.equal(channelForCalendar("Official Website"), "direct");
  const data = { role: "viewer_no_price", bookings: [booking,
    { ...booking, id: "other", propertyId: "other-property", guestName: "Other Tenant" }] };
  const projected = customerCalendarProjection(data, property);
  assert.equal(projected.bookings.length, 2);
  assert.deepEqual(projected.bookings.map((row) => row.room_number), ["101", "102"]);
  assert.ok(projected.bookings.every((row) => row.platform === "booking" && row.payment_status === "unknown"));
  assert.ok(projected.bookings.every((row) => row.price_hidden && row.snapshot_only));
  assert.ok(projected.bookings.every((row) => row.guest_name === "Synthetic Guest"));
  assert.ok(!JSON.stringify(projected).includes("Other Tenant"));
});

test("website holds retain their state, direct channel and occupancy until the owner releases them", () => {
  const hold = { ...booking, entry: "os", platform: "Official Website", status: "held", imported: undefined,
    hold: { state: "active", expiresAt: "2100-01-01T00:00:00Z", scope: "platform_only" } };
  const project = order => customerCalendarProjection({ role: "owner", bookings: [order] }, property).bookings;
  const active = project(hold);
  assert.equal(active.length, 2);
  assert.ok(active.every(row => row.platform === "direct" && row.reservation_status === "held" && row.hold_label === "保留中"));
  assert.ok(active.every(row => !row.source_conflict));
  const expired = project({ ...hold, hold: { ...hold.hold, expiresAt: "2000-01-01T00:00:00Z" } });
  assert.equal(expired.length, 2);
  assert.ok(expired.every(row => row.hold_label === "保留到期・待業主決定"));
  const confirmed = project({ ...hold, status: "confirmed", hold: { ...hold.hold, state: "converted" } });
  assert.ok(confirmed.every(row => row.reservation_status === "confirmed" && !row.hold_label));
  assert.deepEqual(project({ ...hold, status: "cancelled" }), []);
});
