import { randomUUID } from 'node:crypto';
import type { Principal } from '../workspace-auth/types';
import { taipeiDate } from '../finance-model.ts';
import type { PaymentEvent } from './iron-gate-manual-payment.server';
import type { FinanceEntry } from '../finance-model';
import { financeContext } from '../finance-context';
import { activeSources } from './config';
import { redisCommand, RedisWorkspaceStore } from '../workspace-auth/store';
import { ironGateManualPaymentConfig, recordManualPayment, manualPaymentRequestResult } from './iron-gate-manual-payment.server.ts';

async function report(principal: Principal) {
  const source = activeSources().find(source => source.property.id === 'sweetfun');
  if (!source || process.env.IRON_GATE_SWEETFUN_FINANCE_ENABLED !== 'true')
    throw Error('IRON_GATE_FINANCE_UNAVAILABLE');
  return financeContext(source, new Date().getUTCFullYear(), false, principal);
}

export function verifyFinancePayment(entries: FinanceEntry[], bookingId: string, eventId: string, expected: PaymentEvent) {
  const events = entries.filter(entry => entry.source === 'iron_gate' &&
    entry.iron_gate_booking_id === bookingId && entry.payment_event_id === eventId);
  const event = events[0];
  if(event?.ssot_source_system==='iron_gate_native'){
    if(events.length!==1||event.status!=='active'||
      event.ssot_source_record_id!==eventId||
      event.ssot_evidence_ref!==`ig-payment:${eventId}`||
      event.amount_cents!==expected.amountCents||
      event.kind!==(expected.kind==='received'?'income':'refund')||
      event.date!==taipeiDate(new Date(expected.occurredAt))||
      event.method!==(expected.method??'other')||
      event.refund_of_event_id!==expected.refundOfEventId)
      throw Error('MANUAL_RESULT_UNKNOWN');
    return event.id;
  }
  if (events.length !== 1 || event.status !== 'active' || event.amount_cents !== expected.amountCents ||
    event.kind !== (expected.kind === 'received' ? 'income' : 'refund') ||
    event.date !== taipeiDate(new Date(expected.occurredAt)) || event.method !== (expected.method ?? 'other') ||
    event.refund_of_event_id !== expected.refundOfEventId || event.created_at !== expected.recordedAt ||
    event.description !== `${expected.kind === 'received' ? '直訂收款' : '直訂退款'} · ${expected.evidenceRef}`)
    throw Error('MANUAL_RESULT_UNKNOWN');
  return events[0].id;
}

/** The same property lock as both legacy receipt writers prevents a check/write race. */
export async function recordIntegratedPayment(principal: Principal, bookingId: string,
  input: unknown, requestKey: string) {
  await new RedisWorkspaceStore().limit(`manual-payment:${principal.id}`, 90, 3600);
  const key = 'sweetfun-os:payments:v1:sweetfun:lock', token = randomUUID();
  if (await redisCommand(['SET', key, token, 'NX', 'EX', 120]) !== 'OK') throw Error('VERSION_CONFLICT');
  try {
    await report(principal); // Complete legacy/direct conflict check before the authoritative write.
    const result = await recordManualPayment(principal, ironGateManualPaymentConfig(), bookingId, input, requestKey);
    try {
      const after = await report(principal);
      const financeEntryId = verifyFinancePayment(after.entries, bookingId, requestKey, result.paymentEvent);
      return { ...result, financeVerified: true, financeEntryId, financeRevision: after.iron_gate_revision };
    } catch { throw Error('MANUAL_RESULT_UNKNOWN'); }
  } finally {
    await redisCommand(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, key, token]).catch(() => {});
  }
}

export async function recoverIntegratedPayment(principal: Principal, requestKey: string) {
  const result = await manualPaymentRequestResult(principal, ironGateManualPaymentConfig(), requestKey);
  try {
    const after = await report(principal);
    const financeEntryId = verifyFinancePayment(after.entries, String(result.bookingId), requestKey, result.paymentEvent);
    return { ...result, financeVerified: true, financeEntryId, financeRevision: after.iron_gate_revision };
  } catch { throw Error('MANUAL_RESULT_UNKNOWN'); }
}
