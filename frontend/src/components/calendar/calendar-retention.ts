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
