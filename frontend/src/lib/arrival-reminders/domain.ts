import { createHash } from 'node:crypto';
import type { CalendarBooking } from '../../components/calendar/calendar-types';
import type { Booking, Property } from '../customer-workspaces/types';

export type Arrival = { id: string; guest: string; checkIn: string; checkOut: string; rooms: string[]; notes: string; href: string; fingerprint: string };
export type UnconfirmedArrival = { id: string; date: string; rooms: string[]; reason: 'order_link' | 'source'; guest?: string; notes?: string; href: string };
export type ArrivalList = { unconfirmed?: UnconfirmedArrival[]; sourceIncomplete?: boolean; scope: string; propertyName: string; checkedAt: string; day: string; arrivals: Arrival[] };
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function taipeiDay(now = new Date()) { return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10); }
export function tomorrow(day: string) { return new Date(Date.parse(day + 'T00:00:00Z') + 86400_000).toISOString().slice(0, 10); }
function arrival(value: Omit<Arrival, 'fingerprint'>): Arrival {
  return { ...value, fingerprint: hash([value.id, value.guest, value.checkIn, value.checkOut, value.rooms, value.notes]) };
}
export function nativeArrivals(bookings: Booking[], property: Property, slug: string, day: string): Arrival[] {
  return bookings.filter(b => b.propertyId === property.id && b.status === 'confirmed' &&
    (b.checkIn === day || b.checkIn === tomorrow(day)) && b.notes?.trim()).map(b => arrival({
      id: b.id, guest: b.guestName || '未填姓名', checkIn: b.checkIn, checkOut: b.checkOut,
      rooms: b.roomIds.map(id => property.rooms.find(r => r.id === id)?.name || '待核對房間').sort(),
      notes: b.notes!.trim(), href: `/w/${slug}/orders/${encodeURIComponent(b.id)}`,
    })).sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.id.localeCompare(b.id));
}
export function inspectLegacyArrivals(rows: CalendarBooking[], propertyId: string, day: string) {
  const unconfirmed: UnconfirmedArrival[] = [];
  const groups = new Map<string, CalendarBooking[]>();
  for (const b of rows.filter(b => b.property_id === propertyId)) groups.set(b.order_id, [...(groups.get(b.order_id) ?? []), b]);
  const result: Arrival[] = [];
  for (const [id, segments] of groups) {
    const checkIn = segments.map(b => b.check_in).sort()[0];
    if (checkIn !== day && checkIn !== tomorrow(day)) continue;
    // A nightly row is not a new arrival. Group all nights before selecting the day.
    // Unknown notes and source conflicts are not an empty list or a confirmed reminder.
    if (segments.some(b => b.source_conflict || b.source_order_linked === false || b.source_notes_unconfirmed || b.snapshot_only)) {
      const trustedNotes = segments.every(b => !b.source_conflict && !b.source_notes_unconfirmed && !b.snapshot_only);
      unconfirmed.push({ id, date: checkIn, rooms: [...new Set(segments.map(b => b.room_number))].sort(),
        reason: trustedNotes ? 'order_link' : 'source',
        ...(trustedNotes ? { guest: segments[0].guest_name, notes: [...new Set(segments.flatMap(b => (b.source_notes ?? []).map(n => n.text.trim())).filter(Boolean))].join('\n\n') } : {}),
        href: `/calendar?date=${checkIn}&properties=${encodeURIComponent(propertyId)}&mode=sold&stay=${encodeURIComponent(`${checkIn}_${segments[0].room_number}`)}` });
      continue;
    }
    if (segments.some(b => b.reservation_status !== 'confirmed')) continue;
    const notes = [...new Set(segments.flatMap(b => (b.source_notes ?? []).map(n => n.text.trim())).filter(Boolean))].join('\n\n');
    if (!notes) continue;
    result.push(arrival({ id, guest: segments[0].guest_name, checkIn,
      checkOut: segments.map(b => b.check_out).sort().at(-1)!, rooms: [...new Set(segments.map(b => b.room_number))].sort(), notes,
      href: `/calendar?date=${checkIn}&properties=${encodeURIComponent(propertyId)}&order=${encodeURIComponent(id)}` }));
  }
  return { arrivals: result.sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.id.localeCompare(b.id)),
    unconfirmed: unconfirmed.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) };
}
export function legacyArrivals(rows: CalendarBooking[], propertyId: string, day: string): Arrival[] {
  const result = inspectLegacyArrivals(rows, propertyId, day);
  if (result.unconfirmed.length) throw Error('ARRIVAL_SOURCE_UNCONFIRMED');
  return result.arrivals;
}
export function reminderText(list: ArrivalList, item: Arrival) {
  const title = `${list.propertyName}｜${item.checkIn === list.day ? '今日' : '明日'}入住備註`;
  // LINE's limit is UTF-16 code units. Full original notes stay available in OS.
  const notes = item.notes.length > 3200 ? item.notes.slice(0, 3200) + '\n（其餘備註請開啟訂單查看）' : item.notes;
  return `${title}\n${item.guest.slice(0, 160)}｜${item.rooms.join('、').slice(0, 200)}\n入住 ${item.checkIn}；退房 ${item.checkOut}\n\n${notes}\n\nhttps://sweetfun-os.vercel.app${item.href}\n送達不代表已處理，請在 OS 入住備註頁確認。`;
}
