import type { CalendarResponse } from './calendar-types';

export function hasCalendarCoverage(data: CalendarResponse | null, start: string, end: string) {
  return !!data && data.period_start <= start && data.period_end >= end;
}

// Validate before replacing last-good data: a malformed 200 must never look like an empty calendar.
export function validCalendarResponse(value: unknown, start: string, end: string): value is CalendarResponse {
  if (!value || typeof value !== 'object') return false;
  const data = value as CalendarResponse;
  return hasCalendarCoverage(data, start, end) && Array.isArray(data.bookings) && Array.isArray(data.rooms) && Array.isArray(data.properties) &&
    data.properties.every(p => p && typeof p.id === 'string' && typeof p.name === 'string') &&
    data.rooms.every(r => r && typeof r.id === 'string' && typeof r.property_id === 'string') &&
    data.bookings.every(b => b && typeof b.id === 'string' && typeof b.property_id === 'string' && typeof b.room_id === 'string' && typeof b.check_in === 'string' && typeof b.check_out === 'string' && b.check_in < b.check_out);
}

export function retainedCalendar(data: CalendarResponse | null, failed: boolean): CalendarResponse | null {
  if (!data || !failed) return data;
  return { ...data, bookings: data.bookings.map(b => ({ ...b, snapshot_only: true })) };
}

// Month grids overlap at their edges. Combine only a contiguous set from the
// same inventory version, anchored on the month the user is viewing.
export function combinedCalendarWindows(windows: CalendarResponse[], start: string, end: string): CalendarResponse | null {
  const anchor = windows.find(window => hasCalendarCoverage(window, start, end));
  if (!anchor) return null;
  const version = anchor.source?.private_snapshot_version;
  const peers = windows.filter(window => window.source?.private_snapshot_version === version)
    .sort((left, right) => left.period_start.localeCompare(right.period_start));
  let first = start, last = end;
  let changed = true;
  while (changed) {
    changed = false;
    for (const window of peers) {
      if (window.period_start > last || window.period_end < first) continue;
      if (window.period_start < first) { first = window.period_start; changed = true; }
      if (window.period_end > last) { last = window.period_end; changed = true; }
    }
  }
  const connected = peers.filter(window => window.period_start <= last && window.period_end >= first);
  const bookings = [...new Map(connected.flatMap(window => window.bookings).map(booking => [booking.id, booking])).values()];
  const properties = [...new Map(connected.flatMap(window => window.properties).map(property => [property.id, property])).values()];
  const rooms = [...new Map(connected.flatMap(window => window.rooms).map(room => [room.id, room])).values()];
  return { ...anchor, period_start: first, period_end: last, properties, rooms, bookings,
    order_count: new Set(bookings.map(booking => booking.order_id)).size,
    booking_segment_count: bookings.length };
}
