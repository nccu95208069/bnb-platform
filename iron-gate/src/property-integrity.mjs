import { nightsFor } from "./service.ts";

const cellKey = (roomId, night) => `${roomId}:${night}`;

/** Check one consistent property snapshot without returning booking or guest data. */
export function checkPropertyIntegrity(state, occupancyRows) {
  const issues = new Set();
  const counts = { bookings: 0, activeBookings: 0, expectedRoomNights: 0,
    storedRoomNights: 0, pendingOperations: 0, fences: 0 };
  if (!state || typeof state !== "object" || !Array.isArray(state.roomIds) ||
    !Array.isArray(state.bookings) || !Array.isArray(state.operations) ||
    !Array.isArray(state.fences) || !Array.isArray(occupancyRows)) {
    return { ok: false, issues: ["INVALID_PROPERTY_STATE"], counts };
  }
  counts.bookings = state.bookings.length;
  counts.storedRoomNights = occupancyRows.length;
  counts.fences = state.fences.length;
  if (new Set(state.roomIds).size !== state.roomIds.length) issues.add("DUPLICATE_ROOM_ID");
  const bookingIds = new Set();
  const expected = new Map();
  for (const booking of state.bookings) {
    if (!booking || typeof booking.id !== "string" || bookingIds.has(booking.id)) {
      issues.add("DUPLICATE_OR_INVALID_BOOKING_ID");
      continue;
    }
    bookingIds.add(booking.id);
    if (booking.propertyId !== state.propertyId || booking.workspaceId !== state.workspaceId)
      issues.add("BOOKING_SCOPE_MISMATCH");
    if (booking.status !== "held" && booking.status !== "confirmed" &&
      booking.status !== "cancelled") {
      issues.add("INVALID_BOOKING_STATUS");
      continue;
    }
    if (booking.status === "cancelled") continue;
    counts.activeBookings++;
    try {
      for (const cell of nightsFor(booking.stays, state.roomIds)) {
        const key = cellKey(cell.roomId, cell.date);
        if (expected.has(key)) issues.add("ACTIVE_ROOM_NIGHT_COLLISION");
        expected.set(key, booking.id);
      }
    } catch { issues.add("INVALID_ACTIVE_STAY"); }
  }
  counts.expectedRoomNights = expected.size;
  const actual = new Map();
  for (const row of occupancyRows) {
    const roomId = row?.room_id, night = row?.night, bookingId = row?.booking_id;
    if (typeof roomId !== "string" || typeof night !== "string" ||
      typeof bookingId !== "string" || !state.roomIds.includes(roomId)) {
      issues.add("INVALID_OCCUPANCY_ROW");
      continue;
    }
    const key = cellKey(roomId, night);
    if (actual.has(key)) issues.add("DUPLICATE_OCCUPANCY_ROW");
    actual.set(key, bookingId);
  }
  if (expected.size !== actual.size || [...expected].some(([key, id]) => actual.get(key) !== id))
    issues.add("OCCUPANCY_DRIFT");
  const fenceCells = new Set();
  for (const fence of state.fences) {
    if (!fence || !Array.isArray(fence.cells)) {
      issues.add("INVALID_FENCE");
      continue;
    }
    for (const cell of fence.cells) {
      if (!cell || typeof cell.roomId !== "string" || typeof cell.date !== "string") {
        issues.add("INVALID_FENCE");
        continue;
      }
      fenceCells.add(cellKey(cell.roomId, cell.date));
    }
  }
  for (const operation of state.operations) {
    if (operation?.state !== "sync_pending" && operation?.state !== "review_required") continue;
    counts.pendingOperations++;
    if (operation.controlMode === "provider_only") {
      // Provider work must not create a platform occupancy fence. Still count
      // pending work, and never let a malformed mode marker waive integrity.
      if (operation.bookingId !== null || operation.bookingVersion !== 0 ||
        typeof operation.key !== "string" || !operation.key ||
        typeof operation.lineGrantId !== "string" || !operation.lineGrantId ||
        typeof operation.lineActorId !== "string" || !operation.lineActorId ||
        !Array.isArray(operation.cells) || !operation.cells.length ||
        operation.cells.some(cell => !cell || !state.roomIds.includes(cell.roomId) ||
          typeof cell.date !== "string" || !["open", "closed"].includes(cell.desired)) ||
        new Set(operation.cells.map(cell => cellKey(cell.roomId, cell.date))).size !== operation.cells.length)
        issues.add("INVALID_PROVIDER_CONTROL_OPERATION");
      continue;
    }
    if (!Array.isArray(operation.cells) || operation.cells.some((cell) =>
      !cell || typeof cell.roomId !== "string" || typeof cell.date !== "string" ||
      !fenceCells.has(cellKey(cell.roomId, cell.date)))) issues.add("UNFENCED_CHANNEL_OPERATION");
  }
  return { ok: issues.size === 0, issues: [...issues].sort(), counts };
}
