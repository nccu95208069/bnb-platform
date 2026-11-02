import type { CalendarResponse } from './calendar-types';

// Both properties must agree. The primary source alone does not describe an
// Offland update when Sweetfun is also selected.
export function calendarResponseVersion(data: CalendarResponse) {
  const sources = data.sources?.length ? data.sources.map(item =>
    [item.property_id, item.source.kind ?? '', item.source.private_snapshot_version ?? ''])
    .sort((a, b) => a[0].localeCompare(b[0])) :
    [['', data.source?.kind ?? '', data.source?.private_snapshot_version ?? '']];
  return JSON.stringify([sources, data.price_hidden ?? false]);
}

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
  // Adjacent month grids overlap. Prefer the exact requested window so its
  // source warnings and permissions, rather than the prior month's, lead.
  const anchor = windows.find(window => window.period_start === start && window.period_end === end) ??
    windows.find(window => window.period_start <= start && window.period_end >= end) ??
    windows.find(window => window.period_start <= start && window.period_end > start);
  if (!anchor) return null;
  const version = calendarResponseVersion(anchor);
  const peers = windows.filter(window => calendarResponseVersion(window) === version)
    .sort((left, right) => left.period_start.localeCompare(right.period_start));
  let first = anchor.period_start, last = anchor.period_end;
  let changed = true;
  while (changed) {
    changed = false;
    for (const window of peers) {
      if (window.period_start > last || window.period_end < first) continue;
      if (window.period_start < first) { first = window.period_start; changed = true; }
      if (window.period_end > last) { last = window.period_end; changed = true; }
    }
  }
  if (last < end) return null;
  // Input order is completion order (oldest first). A newly verified overlap
  // also removes rows missing from that response, including cancellations.
  const connected = windows.filter(window => calendarResponseVersion(window) === version &&
    window.period_start <= last && window.period_end >= first);
  const bookingMap = new Map<string, CalendarResponse['bookings'][number]>();
  for (const window of connected) {
    for (const [id, booking] of bookingMap) {
      if (booking.check_in < window.period_end && booking.check_out > window.period_start) bookingMap.delete(id);
    }
    for (const booking of window.bookings) bookingMap.set(booking.id, booking);
  }
  const bookings = [...bookingMap.values()];
  const properties = [...new Map(connected.flatMap(window => window.properties).map(property => [property.id, property])).values()];
  const rooms = [...new Map(connected.flatMap(window => window.rooms).map(room => [room.id, room])).values()];
  return { ...anchor, period_start: first, period_end: last, properties, rooms, bookings,
    order_count: new Set(bookings.map(booking => booking.order_id)).size,
    booking_segment_count: bookings.length };
}
