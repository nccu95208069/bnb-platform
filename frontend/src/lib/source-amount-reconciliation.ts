// Money-only projection of a verified source correction; it never creates a receipt.
export type SourceAmountBreakdown = {
  schema: 1 | 2; sourceProperty?: "sweetfun" | "offland"; groupId: string; bookingVersion: number; sourceOrderRef: string;
  externalOrderNo: string; roomId: string; checkIn: string; checkOut: string;
  originalTotalCents: number; grossCents: number; hostFeeCents: number; netCents: number;
  groupOriginalCents: number; groupGrossCents: number; groupHostFeeCents: number;
  groupNetCents: number; groupTaxCents: number; groupGuestFeeCents: number | null;
  groupGuestPaidCents: number | null; groupSize: number;
};
export function checkedAmountBreakdown(value: unknown, totalCents: number, version: number): SourceAmountBreakdown {
  const fail = (): never => { throw Error('SOURCE_AMOUNT_RECONCILIATION_CONFLICT'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const m = value as SourceAmountBreakdown;
  const fields = ['originalTotalCents','grossCents','hostFeeCents','netCents','groupOriginalCents',
    'groupGrossCents','groupHostFeeCents','groupNetCents','groupTaxCents','groupGuestFeeCents','groupGuestPaidCents'] as const;
  const v2 = m.schema === 2;
  if ((!v2 && (m.schema !== 1 || m.groupSize !== 5)) ||
    v2 && (!['sweetfun','offland'].includes(String(m.sourceProperty)) || !Number.isSafeInteger(m.groupSize) || m.groupSize < 1 || m.groupSize > 256) || !/^[0-9a-f-]{36}$/.test(m.groupId) ||
    !Number.isSafeInteger(version) || !Number.isSafeInteger(m.bookingVersion) ||
    m.bookingVersion < (v2 ? 2 : 3) || m.bookingVersion > version ||
    !/^J:[A-Za-z0-9_-]{8,100}$/.test(m.sourceOrderRef) || !/^HM[A-Z0-9]{8}$/.test(m.externalOrderNo) ||
    !/^[0-9a-f-]{36}$/.test(m.roomId) || !/^\d{4}-\d{2}-\d{2}$/.test(m.checkIn) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(m.checkOut) || m.checkOut <= m.checkIn || !Number.isFinite(Date.parse(m.checkIn)) || !Number.isFinite(Date.parse(m.checkOut)) ||
    Date.parse(m.checkOut)-Date.parse(m.checkIn)>366*86400000 ||
    fields.some(k => !(v2 && ['groupGuestFeeCents','groupGuestPaidCents'].includes(k) && m[k] === null) && (!Number.isSafeInteger(m[k]) || m[k] === null || m[k]! < 0 || m[k]! > 1e12)) ||
    m.originalTotalCents === 0 || !v2 && m.netCents === 0 || m.netCents !== totalCents ||
    m.grossCents-m.hostFeeCents !== m.netCents || m.groupGrossCents-m.groupHostFeeCents !== m.groupNetCents ||
    (m.groupGuestFeeCents === null) !== (m.groupGuestPaidCents === null) ||
    m.groupGuestFeeCents !== null && m.groupGrossCents+m.groupTaxCents+m.groupGuestFeeCents !== m.groupGuestPaidCents) return fail();
  // Copy an allowlist so arbitrary provider fields cannot reach the UI.
  return {schema:m.schema,...(v2 ? {sourceProperty:m.sourceProperty} : {}),groupId:m.groupId,bookingVersion:m.bookingVersion,sourceOrderRef:m.sourceOrderRef,
    externalOrderNo:m.externalOrderNo,roomId:m.roomId,checkIn:m.checkIn,checkOut:m.checkOut,groupSize:m.groupSize,
    ...Object.fromEntries(fields.map(k => [k,m[k]]))} as SourceAmountBreakdown;
}
