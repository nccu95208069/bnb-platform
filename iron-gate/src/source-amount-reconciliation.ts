import type { Booking } from './types.ts';
import { GateError } from './errors.ts';

export type SourceAmountReconciliation = {
  schema: 1; groupId: string; bookingVersion: number; sourceOrderRef: string;
  externalOrderNo: string; roomId: string; checkIn: string; checkOut: string;
  originalTotalCents: number; grossCents: number; hostFeeCents: number; netCents: number;
  groupOriginalCents: number; groupGrossCents: number; groupHostFeeCents: number;
  groupNetCents: number; groupTaxCents: number; groupGuestFeeCents: number;
  groupGuestPaidCents: number; groupSize: 5;
};
const invalid = (): never => { throw new GateError('SOURCE_AMOUNT_RECONCILIATION_CONFLICT', 409); };
export function reconciledAmount(booking: Booking): SourceAmountReconciliation | null {
  const m = booking.sourceAmountReconciliation;
  if (!m) return null;
  const rows = booking.sweetfunSnapshot?.rows, stay = booking.stays[0];
  if (Object.keys(m).sort().join(',') !== ['schema','groupId','bookingVersion','sourceOrderRef',
    'externalOrderNo','roomId','checkIn','checkOut','originalTotalCents','grossCents','hostFeeCents','netCents',
    'groupOriginalCents','groupGrossCents','groupHostFeeCents','groupNetCents','groupTaxCents',
    'groupGuestFeeCents','groupGuestPaidCents','groupSize'].sort().join(',') || m.schema !== 1 || m.groupSize !== 5 || !/^[0-9a-f-]{36}$/.test(m.groupId) ||
    !Number.isSafeInteger(m.bookingVersion) || m.bookingVersion < 3 || m.bookingVersion > booking.version ||
    booking.source !== 'external' || booking.currency !== 'TWD' || booking.osDirectOverride ||
    booking.lineOverridePending || booking.sourceCalendar?.platform !== 'airbnb' ||
    !/^HM[A-Z0-9]{8}$/.test(m.externalOrderNo) ||
    booking.sourceCalendar.externalOrderNo !== m.externalOrderNo ||
    !/^J:[A-Za-z0-9_-]{8,100}$/.test(m.sourceOrderRef) ||
    m.sourceOrderRef !== booking.sweetfunSnapshot?.groupKey ||
    !Array.isArray(rows) || rows.length !== 1 || booking.stays.length !== 1 ||
    stay.roomIds.length !== 1 || stay.roomIds[0] !== m.roomId ||
    stay.checkIn !== m.checkIn || stay.checkOut !== m.checkOut ||
    rows[0]?.values?.[2] !== 'Airbnb' || rows[0]?.values?.[13] !== '' ||
    `J:${rows[0]?.values?.[9]}` !== m.sourceOrderRef || rows[0]?.checkIn !== m.checkIn ||
    rows[0]?.checkOut !== m.checkOut || rows[0]?.roomFeeCents !== m.originalTotalCents ||
    booking.totalCents !== m.netCents ||
    [m.originalTotalCents,m.grossCents,m.hostFeeCents,m.netCents,m.groupOriginalCents,
      m.groupGrossCents,m.groupHostFeeCents,m.groupNetCents,m.groupTaxCents,
      m.groupGuestFeeCents,m.groupGuestPaidCents].some(n => !Number.isSafeInteger(n) || n < 0 || n > 1e12) ||
    m.originalTotalCents === 0 || m.netCents === 0 ||
    m.grossCents - m.hostFeeCents !== m.netCents ||
    m.groupGrossCents - m.groupHostFeeCents !== m.groupNetCents ||
    m.groupGrossCents + m.groupTaxCents + m.groupGuestFeeCents !== m.groupGuestPaidCents) invalid();
  return structuredClone(m);
}

export function reconciledFinanceAmounts(bookings: Booking[]) {
  const rows = bookings.filter(b => b.sourceAmountReconciliation).map(b => ({
    bookingId: b.id, status: b.status, ...reconciledAmount(b)!,
    // Expose the CURRENT version; the marker version is provenance only.
    version: b.version,
  }));
  const fields = ['groupOriginalCents','groupGrossCents','groupHostFeeCents','groupNetCents',
    'groupTaxCents','groupGuestFeeCents','groupGuestPaidCents','externalOrderNo','checkIn','checkOut'] as const;
  for (const id of new Set(rows.map(r => r.groupId))) {
    const group = rows.filter(r => r.groupId === id), first = group[0];
    if (group.length !== first.groupSize || new Set(group.map(r => r.roomId)).size !== group.length ||
      new Set(group.map(r => r.sourceOrderRef)).size !== group.length ||
      group.some(r => fields.some(k => r[k] !== first[k])) ||
      group.reduce((s,r) => s+r.originalTotalCents,0) !== first.groupOriginalCents ||
      group.reduce((s,r) => s+r.grossCents,0) !== first.groupGrossCents ||
      group.reduce((s,r) => s+r.hostFeeCents,0) !== first.groupHostFeeCents ||
      group.reduce((s,r) => s+r.netCents,0) !== first.groupNetCents) invalid();
  }
  return rows;
}
