import { createHash } from 'node:crypto';
import type { Booking, PropertyState } from './types.ts';
import { GateError } from './errors.ts';

export const CARD_SHEET_ID = '1ccdaF5t0uIo0yqoJdSgKoG68UnBeWzCXfV5dQtMeK4A';
export const CARD_CUTOFF = '2026-10-26';
export type CardInput = { sheetId: string; tab: string; row: number; platform: 'booking';
  orderId: string; checkIn: string; checkOut: string; amountCents: number;
  status: 'done' | 'fail'; chargeDate: string | null };
export type CardResult = CardInput & { fingerprint: string; recordedAt: string;
  actorId: string; paymentEventId: string | null };
const fail = (code: string): never => { throw new GateError(code, 409); };
function date(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
const bookingPlatform = (value: unknown) => ['booking', 'booking.com'].includes(String(value).trim().toLowerCase());
export function validateCardInput(input: CardInput) {
  if (!input || input.sheetId !== CARD_SHEET_ID || input.platform !== 'booking' ||
    typeof input.orderId !== 'string' || !/^\d{8,11}$/.test(input.orderId) ||
    typeof input.tab !== 'string' || !/^\d{8}-\d{8}$/.test(input.tab) ||
    !Number.isSafeInteger(input.row) || input.row < 2 || input.row > 10000 ||
    !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 ||
    !date(input.checkIn) || !date(input.checkOut) || input.checkOut <= input.checkIn ||
    !['done', 'fail'].includes(input.status) ||
    (input.status === 'done' ? !date(input.chargeDate) : input.chargeDate !== null))
    throw new GateError('INVALID_CARD_INPUT', 400);
  const start = input.tab.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const end = input.tab.slice(9).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  if (!date(start) || !date(end) || end < start || Date.parse(end) - Date.parse(start) > 6 * 86400000)
    throw new GateError('INVALID_CARD_INPUT', 400);
  if (start < CARD_CUTOFF || input.chargeDate !== null && input.chargeDate < CARD_CUTOFF)
    fail('CARD_HISTORY_REVIEW');
  if (input.chargeDate && Date.parse(`${input.chargeDate}T00:00:00+08:00`) > Date.now())
    fail('FUTURE_RECEIPT');
}
export function cardFingerprint(input: CardInput) {
  // Row/week moves are provenance changes, never a new receipt identity.
  return createHash('sha256').update(JSON.stringify([input.sheetId, input.platform, input.orderId,
    input.checkIn, input.checkOut, input.amountCents, input.status, input.chargeDate]), 'utf8').digest('hex');
}
export function cardPaymentId(propertyId: string, bookingId: string) {
  const h = createHash('sha256').update(`card-received:${propertyId}:${bookingId}`, 'utf8').digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function cardAliases(state: PropertyState, booking: Booking): string[] {
  const keys = [booking.sweetfunSnapshot?.groupKey, ...state.sourceLinks
    .filter(link => link.bookingId === booking.id).map(link => link.externalOrderId)];
  const aliases = [`IG-${booking.id}`, booking.id];
  for (const key of keys) {
    if (typeof key !== 'string' || !/^(?:L:[A-Za-z0-9-]{8,64}|J:[A-Za-z0-9_-]{8,100})$/.test(key)) continue;
    const original = key.startsWith('J:') ? `ungrouped:${key.slice(2)}` : key.slice(2);
    aliases.push(`SF-${createHash('sha256').update(`sweetfun-operations-sheet-v1:order:${original}`, 'utf8').digest('hex').slice(0,20)}`);
  }
  return [...new Set(aliases)].sort();
}
export function hasCardReceipt(booking: Booking) {
  return (booking.cardChargeResults ?? []).some(result => result.status === 'done' && result.paymentEventId);
}
export function resolveCard(state: PropertyState, input: CardInput) {
  validateCardInput(input);
  const matches = state.bookings.filter(booking => {
    if (booking.source !== 'external') return false;
    if (booking.sourceCalendar) return bookingPlatform(booking.sourceCalendar.platform) &&
      booking.sourceCalendar.externalOrderNo === input.orderId;
    const rows = booking.sweetfunSnapshot?.rows;
    return Array.isArray(rows) && rows.length > 0 && rows.every(row =>
      Array.isArray(row?.values) && bookingPlatform(row.values[2]) && String(row.values[13] ?? '').trim() === input.orderId);
  });
  if (matches.length !== 1) fail(matches.length ? 'CARD_ORDER_AMBIGUOUS' : 'CARD_ORDER_NOT_FOUND');
  const booking = matches[0], fingerprint = cardFingerprint(input);
  const success = (booking.cardChargeResults ?? []).find(result => result.status === 'done');
  if (success && success.fingerprint !== fingerprint) fail('CARD_RESULT_CONFLICT');
  const previous = (booking.cardChargeResults ?? []).find(result => result.fingerprint === fingerprint);
  if (previous) {
    if (previous.paymentEventId && !(booking.paymentEvents ?? []).some(event =>
      event.id === previous.paymentEventId && event.kind === 'received' &&
      event.amountCents === input.amountCents && event.method === 'credit_card')) fail('PAYMENT_INTEGRITY_CONFLICT');
    return {booking, previous, fingerprint, action: 'already_synced' as const, aliases: cardAliases(state, booking)};
  }
  if (booking.status !== 'confirmed' || booking.lineOverridePending ||
    state.sourceLinks.some(link => link.bookingId === booking.id &&
      (link.diverged || link.lastAppliedBookingVersion !== booking.version))) fail('CARD_ORDER_REVIEW');
  const stays = booking.stays;
  if (!stays.length || stays.map(stay => stay.checkIn).sort()[0] !== input.checkIn ||
    stays.map(stay => stay.checkOut).sort().at(-1) !== input.checkOut) fail('CARD_STAY_MISMATCH');
  if (booking.totalCents !== input.amountCents) fail('CARD_AMOUNT_MISMATCH');
  if (input.status === 'done') {
    const rows = booking.sweetfunSnapshot?.rows;
    if ((booking.paymentEvents ?? []).length || Array.isArray(rows) && rows.some(row =>
      Array.isArray(row?.values) && (String(row.values[7] ?? '').trim().toLowerCase() === 'done' ||
        String(row.values[16] ?? '').trim().toLowerCase() === 'done' || String(row.values[15] ?? '').trim() !== '')))
      fail('CARD_EXISTING_PAYMENT_REVIEW');
  }
  if ((booking.cardChargeResults ?? []).length >= 100) fail('CARD_RESULT_LIMIT');
  return { booking, previous: undefined, fingerprint,
    action: input.status === 'done' ? 'record_received' as const : 'record_failed' as const,
    aliases: cardAliases(state, booking) };
}
