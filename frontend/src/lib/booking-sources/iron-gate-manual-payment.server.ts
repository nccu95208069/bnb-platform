import type { Principal } from '../workspace-auth/types';
import { callIronGate, ironGateManualConfig, type Grant,
  type ManualConfig } from './iron-gate-manual.server.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READ_ACTIONS = ['booking:read'];
const WRITE_ACTIONS = ['payment:write'];
export type PaymentEvent = { id: string; kind: 'received' | 'refunded'; amountCents: number;
  currency: 'TWD'; evidenceRef: string; occurredAt: string; recordedAt: string;
  actorId: string; method?: 'cash' | 'bank_transfer' | 'credit_card' | 'other';
  refundOfEventId?: string };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function bookingPath(config: ManualConfig, bookingId: string): string {
  if (!UUID.test(bookingId)) throw Error('MANUAL_INVALID_INPUT');
  return `/v1/properties/${config.grant.propertyId}/bookings/${bookingId}`;
}
export function checkPaymentBooking(raw: Record<string, unknown>, config: ManualConfig, bookingId: string, allowCard = false) {
  if (raw.id !== bookingId || raw.propertyId !== config.grant.propertyId ||
    raw.workspaceId !== config.grant.workspaceId ||
    (raw.source !== 'os' && !(allowCard && raw.source === 'external' && raw.cardManaged === true)) ||
    !Number.isSafeInteger(raw.version) || Number(raw.version) < 1 ||
    !['held', 'confirmed', 'cancelled'].includes(String(raw.status)) ||
    raw.currency !== 'TWD' ||
    raw.totalCents !== null && (!Number.isSafeInteger(raw.totalCents) || Number(raw.totalCents) < 0) ||
    !object(raw.paymentSummary) ||
    !Number.isSafeInteger(raw.paymentSummary.receivedCents) ||
    !Number.isSafeInteger(raw.paymentSummary.refundedCents) ||
    !Number.isSafeInteger(raw.paymentSummary.netReceivedCents) ||
    !Array.isArray(raw.paymentEvents) || raw.paymentEvents.length > 500)
    throw Error('MANUAL_READBACK_MISMATCH');
  const events: PaymentEvent[] = raw.paymentEvents.map(value => {
    if (!object(value) || !UUID.test(String(value.id)) ||
      !['received', 'refunded'].includes(String(value.kind)) ||
      !Number.isSafeInteger(value.amountCents) || Number(value.amountCents) <= 0 ||
      value.currency !== 'TWD' || typeof value.evidenceRef !== 'string' ||
      typeof value.occurredAt !== 'string' || !Number.isFinite(Date.parse(value.occurredAt)) ||
      typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt)) ||
      typeof value.actorId !== 'string' ||
      value.method !== undefined && !['cash', 'bank_transfer', 'credit_card', 'other'].includes(String(value.method)) ||
      value.refundOfEventId !== undefined && (!UUID.test(String(value.refundOfEventId)) || value.kind !== 'refunded')) throw Error('MANUAL_READBACK_MISMATCH');
    return value as PaymentEvent;
  });
  if (new Set(events.map(event => event.id)).size !== events.length ||
    events.filter(event => event.kind === 'received').reduce((sum, event) => sum + event.amountCents, 0) !==
      raw.paymentSummary.receivedCents ||
    events.filter(event => event.kind === 'refunded').reduce((sum, event) => sum + event.amountCents, 0) !==
      raw.paymentSummary.refundedCents ||
    Number(raw.paymentSummary.receivedCents) - Number(raw.paymentSummary.refundedCents) !==
      raw.paymentSummary.netReceivedCents) throw Error('MANUAL_READBACK_MISMATCH');
  if (Number(raw.paymentSummary.netReceivedCents) < 0 ||
    !Number.isSafeInteger(Number(raw.paymentSummary.receivedCents) + Number(raw.paymentSummary.refundedCents)))
    throw Error('MANUAL_READBACK_MISMATCH');
  for (const event of events.filter(event => event.refundOfEventId)) {
    const original = events.find(item => item.id === event.refundOfEventId && item.kind === 'received');
    if (!original || Date.parse(event.occurredAt) < Date.parse(original.occurredAt) ||
      events.filter(item => item.refundOfEventId === original.id).reduce((sum, item) => sum + item.amountCents, 0) > original.amountCents)
      throw Error('MANUAL_READBACK_MISMATCH');
  }
  const cardManaged=raw.source === 'external' && raw.cardManaged === true;
  const cardReceipts=cardManaged?events.filter(event=>event.kind==='received'&&
    event.method==='credit_card'&&event.evidenceRef.startsWith('booking-card:')):[];
  if(cardManaged&&(cardReceipts.length!==1||
    events.some(event=>event.kind==='received'&&event.id!==cardReceipts[0].id)||
    events.some(event=>event.kind==='refunded'&&
      event.refundOfEventId!==cardReceipts[0].id)))
    throw Error('MANUAL_READBACK_MISMATCH');
  return { bookingId, version: Number(raw.version), status: String(raw.status),
    cardManaged,cardReceiptId:cardManaged?cardReceipts[0].id:null,
    totalCents: raw.totalCents as number | null,
    receivedCents: Number(raw.paymentSummary.receivedCents),
    refundedCents: Number(raw.paymentSummary.refundedCents),
    netReceivedCents: Number(raw.paymentSummary.netReceivedCents), events };
}

/** Separate opt-in payment grant keeps money writes out of the booking grant. */
export function ironGateManualPaymentConfig(env: NodeJS.ProcessEnv = process.env): ManualConfig {
  const manual = ironGateManualConfig(env);
  try {
    if (env.IRON_GATE_SWEETFUN_MANUAL_PAYMENTS_ENABLED !== 'true') throw Error();
    const grant = JSON.parse(env.IRON_GATE_SWEETFUN_MANUAL_PAYMENT_GRANT ?? 'null') as unknown;
    if (!object(grant) || Object.keys(grant).sort().join(',') !==
      'clientId,credentialId,propertyId,token,workspaceId' ||
      !UUID.test(String(grant.credentialId)) || !UUID.test(String(grant.clientId)) ||
      grant.workspaceId !== manual.calendar.grant.workspaceId ||
      grant.propertyId !== manual.calendar.grant.propertyId ||
      typeof grant.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant.token)) throw Error();
    return { ...manual, grant: grant as Grant };
  } catch { throw Error('MANUAL_CONFIG_UNAVAILABLE'); }
}

export async function readManualPayment(principal: Principal, config: ManualConfig,
  bookingId: string, send: typeof fetch = fetch) {
  const raw = await callIronGate(config, principal, 'GET', bookingPath(config, bookingId),
    null, null, send, READ_ACTIONS, ['money']);
  return checkPaymentBooking(raw, config, bookingId, true);
}

export async function recordManualPayment(principal: Principal, config: ManualConfig,
  bookingId: string, input: unknown, requestKey: string, send: typeof fetch = fetch) {
  if (!UUID.test(requestKey) || !object(input) ||
    Object.keys(input).some(key => !['expectedBookingVersion', 'kind', 'amountCents',
      'evidenceRef', 'occurredAt', 'method', 'refundOfEventId'].includes(key)) ||
    !Number.isSafeInteger(input.expectedBookingVersion) || Number(input.expectedBookingVersion) < 1 ||
    !['received', 'refunded'].includes(String(input.kind)) ||
    !Number.isSafeInteger(input.amountCents) || Number(input.amountCents) <= 0 ||
    typeof input.evidenceRef !== 'string' || !input.evidenceRef.trim() ||
    input.evidenceRef.length > 256 || /[\u0000-\u001f\u007f]/.test(input.evidenceRef) ||
    typeof input.occurredAt !== 'string' || !Number.isFinite(Date.parse(input.occurredAt)))
    throw Error('MANUAL_INVALID_INPUT');
  if (!['cash', 'bank_transfer', 'credit_card', 'other'].includes(String(input.method)) ||
    input.kind === 'refunded' && !UUID.test(String(input.refundOfEventId)) ||
    input.kind === 'received' && input.refundOfEventId !== undefined) throw Error('MANUAL_INVALID_INPUT');
  const before = await readManualPayment(principal, config, bookingId, send);
  if (before.cardManaged && process.env.OS_SWEETFUN_FINANCE_SSOT_ENABLED !== 'true')
    throw Error('IRON_GATE_FINANCE_UNAVAILABLE');
  if (before.cardManaged && input.kind !== 'refunded')
    throw Error('SOURCE_MAPPING_REVIEW_REQUIRED');
  if (before.cardManaged && input.refundOfEventId !== before.cardReceiptId)
    throw Error('INVALID_REFUND_REFERENCE');
  const payload = { expectedBookingVersion: input.expectedBookingVersion,
    eventId: requestKey, kind: input.kind, amountCents: input.amountCents,
    currency: 'TWD', evidenceRef: input.evidenceRef.trim(), occurredAt: input.occurredAt,
    method: input.method, ...(input.refundOfEventId ? { refundOfEventId: input.refundOfEventId } : {}) };
  const result = await callIronGate(config, principal, 'POST',
    `${bookingPath(config, bookingId)}/payment-events`, payload, requestKey, send,
    WRITE_ACTIONS, ['money']);
  if (result.bookingId !== bookingId || result.paymentEventId !== requestKey ||
    !Number.isSafeInteger(result.bookingVersion))
    throw Error('MANUAL_READBACK_MISMATCH');
  let after;
  try { after = await readManualPayment(principal, config, bookingId, send); }
  catch { throw Error('MANUAL_RESULT_UNKNOWN'); }
  const event = after.events.find(item => item.id === requestKey);
  if (!event || event.kind !== payload.kind || event.amountCents !== payload.amountCents ||
    event.evidenceRef !== payload.evidenceRef || event.occurredAt !== payload.occurredAt ||
    event.method !== input.method || event.refundOfEventId !== input.refundOfEventId ||
    after.version < Number(result.bookingVersion)) throw Error('MANUAL_READBACK_MISMATCH');
  return { bookingId, paymentEventId: requestKey, bookingVersion: after.version,
    netReceivedCents: after.netReceivedCents, requestKey, paymentEvent: event };
}

export async function manualPaymentRequestResult(principal: Principal, config: ManualConfig,
  requestKey: string, send: typeof fetch = fetch) {
  if (!UUID.test(requestKey)) throw Error('MANUAL_INVALID_INPUT');
  const result = await callIronGate(config, principal, 'GET',
    `/v1/properties/${config.grant.propertyId}/requests/${requestKey}`,
    null, null, send, WRITE_ACTIONS, ['money']);
  if (!UUID.test(String(result.bookingId)) || result.paymentEventId !== requestKey)
    throw Error('MANUAL_READBACK_MISMATCH');
  const booking = await readManualPayment(principal, config, String(result.bookingId), send);
  const event = booking.events.find(event => event.id === requestKey);
  if (!event)
    throw Error('MANUAL_READBACK_MISMATCH');
  return { bookingId: result.bookingId, paymentEventId: requestKey,
    bookingVersion: booking.version, netReceivedCents: booking.netReceivedCents, requestKey, paymentEvent: event };
}
