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
