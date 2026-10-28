import type { Booking } from './types.ts';
import { GateError } from './errors.ts';

export type SourceAmountReconciliation = {
  schema: 1 | 2; sourceProperty?: "sweetfun" | "offland"; groupId: string; bookingVersion: number; sourceOrderRef: string;
  externalOrderNo: string; roomId: string; checkIn: string; checkOut: string;
  originalTotalCents: number; grossCents: number; hostFeeCents: number; netCents: number;
  groupOriginalCents: number; groupGrossCents: number; groupHostFeeCents: number;
  groupNetCents: number; groupTaxCents: number; groupGuestFeeCents: number | null;
  groupGuestPaidCents: number | null; groupSize: number;
};
const invalid = (): never => { throw new GateError('SOURCE_AMOUNT_RECONCILIATION_CONFLICT', 409); };
export function reconciledAmount(booking: Booking): SourceAmountReconciliation | null {
  const m = booking.sourceAmountReconciliation;
  if (!m) return null;
  if (booking.retention) {
    // The immutable correction still describes the former contract, not the
    // retained order or its later price. Validate that evidence independently
    // before withholding it from all current-stay projections.
    reconciledAmount(beforeOwnerLifecycle(booking));
    return null;
  }
  if (m.schema === 2) return reconciledImportedAmount(booking, m);
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
      m.groupGuestFeeCents,m.groupGuestPaidCents].some(n => !Number.isSafeInteger(n) || n === null || n < 0 || n > 1e12) ||
    m.originalTotalCents === 0 || m.netCents === 0 ||
    m.grossCents - m.hostFeeCents !== m.netCents ||
    m.groupGrossCents - m.groupHostFeeCents !== m.groupNetCents ||
    m.groupGrossCents + m.groupTaxCents + (m.groupGuestFeeCents ?? NaN) !== m.groupGuestPaidCents) invalid();
  return structuredClone(m);
}

function beforeOwnerLifecycle(booking: Booking): Booking {
  const lifecycle = booking.retention, period = lifecycle?.history?.[0];
  if (!lifecycle || lifecycle.schema !== 1 || !period ||
    !Number.isSafeInteger(period.retainedBookingVersion) || period.retainedBookingVersion < 2 ||
    period.retainedBookingVersion > booking.version || !Array.isArray(period.previousStays) ||
    !period.previousStays.length || lifecycle.sourceOrderRef !== booking.sourceAmountReconciliation?.sourceOrderRef)
    return invalid();
  return { ...booking, retention: undefined, version: period.retainedBookingVersion - 1,
    status: 'confirmed', stays: structuredClone(period.previousStays),
    totalCents: period.previousTotalCents, roomNightPrices: period.previousRoomNightPrices };
}

export function reconciledFinanceAmounts(bookings: Booking[]) {
  const rows = bookings.filter(b => b.sourceAmountReconciliation).map(b => ({
    bookingId: b.id, status: b.status,
    ...reconciledAmount(b.retention ? beforeOwnerLifecycle(b) : b)!,
    ...(b.retention ? { historicalOnly: true as const } : {}),
    // Expose the CURRENT version; the marker version is provenance only.
    version: b.version,
  }));
  const fields = ['groupOriginalCents','groupGrossCents','groupHostFeeCents','groupNetCents',
    'groupTaxCents','groupGuestFeeCents','groupGuestPaidCents','externalOrderNo','checkIn','checkOut'] as const;
  for (const id of new Set(rows.map(r => r.groupId))) {
    const group = rows.filter(r => r.groupId === id), first = group[0];
    const sharedFields = first.schema === 2 ? fields.filter(k => k !== 'checkIn' && k !== 'checkOut') : fields;
    const occupied = new Set<string>();
    for (const row of group) for (let day = Date.parse(row.checkIn); day < Date.parse(row.checkOut); day += 86400000) {
      const key = `${row.roomId}:${day}`; if (occupied.has(key)) invalid(); occupied.add(key);
    }
    if (group.length !== first.groupSize || group.some(r => r.schema !== first.schema || r.sourceProperty !== first.sourceProperty || r.groupSize !== first.groupSize) ||
      new Set(group.map(r => r.sourceOrderRef)).size !== group.length ||
      group.some(r => sharedFields.some(k => r[k] !== first[k])) ||
      group.reduce((s,r) => s+r.originalTotalCents,0) !== first.groupOriginalCents ||
      group.reduce((s,r) => s+r.grossCents,0) !== first.groupGrossCents ||
      group.reduce((s,r) => s+r.hostFeeCents,0) !== first.groupHostFeeCents ||
      group.reduce((s,r) => s+r.netCents,0) !== first.groupNetCents) invalid();
  }
  return rows;
}


// Version 2 supports exact, immutable single-row imports across rooms and nights.
// It remains an evidence overlay: paymentEvents and original source rows are untouched.
function reconciledImportedAmount(booking: Booking, m: SourceAmountReconciliation): SourceAmountReconciliation {
  const snapshot = m.sourceProperty === 'sweetfun' ? booking.sweetfunSnapshot :
    m.sourceProperty === 'offland' ? booking.offlandSnapshot : undefined;
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows as {values?: unknown[]; platform?: string; checkIn?: string; checkOut?: string; roomFeeCents?: number}[] : undefined;
  const stay = booking.stays[0];
  const values = rows?.[0]?.values;
  const code = String(values?.[m.sourceProperty === 'sweetfun' ? 13 : 16] ?? '').trim();
  const fields = ['originalTotalCents','grossCents','hostFeeCents','netCents','groupOriginalCents',
    'groupGrossCents','groupHostFeeCents','groupNetCents','groupTaxCents'] as const;
  const keys = ['schema','sourceProperty','groupId','bookingVersion','sourceOrderRef','externalOrderNo',
    'roomId','checkIn','checkOut',...fields,'groupGuestFeeCents','groupGuestPaidCents','groupSize'];
  if (Object.keys(m).sort().join(',') !== keys.sort().join(',') ||
    !/^[0-9a-f-]{36}$/.test(m.groupId) || !Number.isSafeInteger(m.groupSize) || m.groupSize < 1 || m.groupSize > 256 ||
    !Number.isSafeInteger(m.bookingVersion) || m.bookingVersion < 2 || m.bookingVersion > booking.version ||
    booking.source !== 'external' || booking.currency !== 'TWD' || booking.osDirectOverride || booking.lineOverridePending ||
    booking.sourceCalendar?.platform !== 'airbnb' || booking.sourceCalendar.externalOrderNo !== m.externalOrderNo ||
    !/^HM[A-Z0-9]{8}$/.test(m.externalOrderNo) || !/^J:[A-Za-z0-9_-]{8,100}$/.test(m.sourceOrderRef) ||
    snapshot?.groupKey !== m.sourceOrderRef || !rows || rows.length !== 1 || booking.stays.length !== 1 ||
    stay.roomIds.length !== 1 || stay.roomIds[0] !== m.roomId ||
    !/^\d{4}-\d{2}-\d{2}$/.test(m.checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(m.checkOut) ||
    !Number.isFinite(Date.parse(m.checkIn)) || !Number.isFinite(Date.parse(m.checkOut)) ||
    m.checkOut <= m.checkIn || Date.parse(m.checkOut)-Date.parse(m.checkIn) > 366*86400000 ||
    stay.checkIn !== m.checkIn || stay.checkOut !== m.checkOut ||
    rows[0].platform !== 'Airbnb' || values?.[2] !== 'Airbnb' || code && code !== m.externalOrderNo ||
    `J:${values?.[9]}` !== m.sourceOrderRef || rows[0].checkIn !== m.checkIn || rows[0].checkOut !== m.checkOut ||
    rows[0].roomFeeCents !== m.originalTotalCents || booking.totalCents !== m.netCents ||
    fields.some(k => !Number.isSafeInteger(m[k]) || m[k] < 0 || m[k] > 1e12) || m.originalTotalCents === 0 ||
    !['confirmed','cancelled'].includes(booking.status) || booking.status === 'cancelled' && m.netCents !== 0 ||
    m.grossCents-m.hostFeeCents !== m.netCents || m.groupGrossCents-m.groupHostFeeCents !== m.groupNetCents ||
    (m.groupGuestFeeCents === null) !== (m.groupGuestPaidCents === null) ||
    [m.groupGuestFeeCents,m.groupGuestPaidCents].some(n => n !== null && (!Number.isSafeInteger(n) || n < 0 || n > 1e12)) ||
    m.groupGuestFeeCents !== null && m.groupGrossCents+m.groupTaxCents+m.groupGuestFeeCents !== m.groupGuestPaidCents) invalid();
  return structuredClone(m);
}
