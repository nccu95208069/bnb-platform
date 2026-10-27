// Money-only projection of a verified source correction; it never creates a receipt.
export type SourceAmountBreakdown = {
  schema: 1; groupId: string; bookingVersion: number; sourceOrderRef: string;
  externalOrderNo: string; roomId: string; checkIn: string; checkOut: string;
  originalTotalCents: number; grossCents: number; hostFeeCents: number; netCents: number;
  groupOriginalCents: number; groupGrossCents: number; groupHostFeeCents: number;
  groupNetCents: number; groupTaxCents: number; groupGuestFeeCents: number;
  groupGuestPaidCents: number; groupSize: 5;
};
export function checkedAmountBreakdown(value: unknown, totalCents: number, version: number): SourceAmountBreakdown {
  const fail = (): never => { throw Error('SOURCE_AMOUNT_RECONCILIATION_CONFLICT'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const m = value as SourceAmountBreakdown;
  const fields = ['originalTotalCents','grossCents','hostFeeCents','netCents','groupOriginalCents',
    'groupGrossCents','groupHostFeeCents','groupNetCents','groupTaxCents','groupGuestFeeCents','groupGuestPaidCents'] as const;
  if (m.schema !== 1 || m.groupSize !== 5 || !/^[0-9a-f-]{36}$/.test(m.groupId) ||
    !Number.isSafeInteger(version) || !Number.isSafeInteger(m.bookingVersion) ||
    m.bookingVersion < 3 || m.bookingVersion > version ||
    !/^J:[A-Za-z0-9_-]{8,100}$/.test(m.sourceOrderRef) || !/^HM[A-Z0-9]{8}$/.test(m.externalOrderNo) ||
    !/^[0-9a-f-]{36}$/.test(m.roomId) || !/^\d{4}-\d{2}-\d{2}$/.test(m.checkIn) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(m.checkOut) || m.checkOut <= m.checkIn ||
    fields.some(k => !Number.isSafeInteger(m[k]) || m[k] < 0 || m[k] > 1e12) ||
    m.originalTotalCents === 0 || m.netCents === 0 || m.netCents !== totalCents ||
    m.grossCents-m.hostFeeCents !== m.netCents || m.groupGrossCents-m.groupHostFeeCents !== m.groupNetCents ||
    m.groupGrossCents+m.groupTaxCents+m.groupGuestFeeCents !== m.groupGuestPaidCents) return fail();
  // Copy an allowlist so arbitrary provider fields cannot reach the UI.
  return {schema:1,groupId:m.groupId,bookingVersion:m.bookingVersion,sourceOrderRef:m.sourceOrderRef,
    externalOrderNo:m.externalOrderNo,roomId:m.roomId,checkIn:m.checkIn,checkOut:m.checkOut,groupSize:5,
    ...Object.fromEntries(fields.map(k => [k,m[k]]))} as SourceAmountBreakdown;
}
