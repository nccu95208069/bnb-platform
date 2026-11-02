import test from 'node:test';
import assert from 'node:assert/strict';
import { cardFingerprint, cardPaymentId } from '../src/card-sync.ts';
import { planNativeCardHistory } from '../src/finance-native-history.mjs';

const propertyId='40000000-0000-4000-8000-000000000001';
const nativeBookingId='40000000-0000-4000-8000-000000000002';
const cardBookingId='40000000-0000-4000-8000-000000000003';
const nativeReceiptId='40000000-0000-4000-8000-000000000004';
const nativeRefundId='40000000-0000-4000-8000-000000000005';
const cardRefundId='40000000-0000-4000-8000-000000000006';
const chargeDate='2026-10-27';
const actorId='synthetic-operator';
function payment(id,kind,amount,refundOfEventId=null) {
  return {id,kind,amountCents:amount,currency:'TWD',method:'credit_card',
    evidenceRef:`synthetic:${id}`,occurredAt:'2026-10-27T10:00:00+08:00',
    recordedAt:'2026-10-27T04:00:00Z',actorId,
    ...(refundOfEventId?{refundOfEventId}:{})};
}
function cardResult(status,paymentEventId=null) {
  const source={sheetId:'SyntheticCardSheet',tab:'20261027-20261102',row:2,
    platform:'booking',orderId:'12345678',checkIn:'2026-11-12',checkOut:'2026-11-13',
    amountCents:10000,status,chargeDate:status==='done'?chargeDate:null};
  return {...source,fingerprint:cardFingerprint(source),
    recordedAt:'2026-10-27T04:00:00Z',actorId,paymentEventId};
}
function state() {
  const cardEventId=cardPaymentId(propertyId,cardBookingId);
  return {propertyId,bookings:[
    {id:nativeBookingId,propertyId,version:3,source:'os',totalCents:10000,
      paymentEvents:[payment(nativeReceiptId,'received',7000),
        payment(nativeRefundId,'refunded',2000,nativeReceiptId)]},
    {id:cardBookingId,propertyId,version:4,source:'external',totalCents:10000,
      cardChargeResults:[cardResult('fail'),cardResult('done',cardEventId)],
      paymentEvents:[payment(cardEventId,'received',10000),
        payment(cardRefundId,'refunded',3000,cardEventId)]},
  ]};
}

test('W7 derives original native and Card identities without adding money for Fail',()=>{
  const source=state();
  const card=planNativeCardHistory(source,'sweetfun_card');
  const native=planNativeCardHistory(source,'iron_gate_native');
  assert.deepEqual(card.issues,[]);
  assert.deepEqual(native.issues,[]);
  assert.equal(card.records.length,2);
  assert.equal(card.records[0].action,'card_fail');
  assert.equal(card.records[0].event,null);
  assert.equal(card.records[1].source_record_id,cardBookingId);
  assert.equal(card.records[1].event.id,cardPaymentId(propertyId,cardBookingId));
  assert.equal(card.records[1].event.amount_cents,10000);
  assert.equal(card.records[0].source_recorded_at,'2026-10-27T04:00:00Z');
  assert.equal(card.records[1].event.source_recorded_at,'2026-10-27T04:00:00Z');
  assert.equal(native.records.length,3);
  assert.deepEqual(new Set(native.records.map(row=>row.event.id)),
    new Set([nativeReceiptId,nativeRefundId,cardRefundId]));
  assert.equal(native.records.find(row=>row.event.id===cardRefundId).event.related_receipt_event_id,
    card.records[1].event.id);
  assert.ok(native.records.every(row=>row.source_recorded_at==='2026-10-27T04:00:00Z' &&
    row.event.source_recorded_at===row.source_recorded_at));
  assert.ok(card.records.every(row=>row.source_actor_ref.startsWith('ig_actor:')));
  assert.equal(JSON.stringify(card).includes(actorId),false);
  assert.equal(source.bookings[0].version,3);
});

test('W7 source planning rejects changed Card identity and duplicate payment IDs',()=>{
  const changed=state();
  changed.bookings[1].cardChargeResults[1].paymentEventId=nativeReceiptId;
  const card=planNativeCardHistory(changed,'sweetfun_card');
  assert.ok(card.issues.some(row=>row.code==='CARD_EVENT_IDENTITY_MISMATCH'));
  const duplicate=state();
  duplicate.bookings[1].paymentEvents.push({...duplicate.bookings[0].paymentEvents[0]});
  const native=planNativeCardHistory(duplicate,'iron_gate_native');
  assert.ok(native.issues.some(row=>row.code==='PAYMENT_EVENT_ID_OVERLAP'));
  const mismatchedTime=state();
  mismatchedTime.bookings[1].paymentEvents[0].recordedAt='2026-10-27T05:00:00Z';
  assert.ok(planNativeCardHistory(mismatchedTime,'sweetfun_card').issues.some(row=>
    row.code==='CARD_EVENT_IDENTITY_MISMATCH'));
});

test('W7 source planning refuses orphan and over-limit refunds',()=>{
  const orphan=state();
  orphan.bookings[0].paymentEvents[1].refundOfEventId=cardPaymentId(propertyId,cardBookingId);
  assert.ok(planNativeCardHistory(orphan,'iron_gate_native').issues.some(row=>
    row.code==='REFUND_SOURCE_UNRESOLVED'));
  const tooMuch=state();
  tooMuch.bookings[0].paymentEvents[1].amountCents=8000;
  assert.ok(planNativeCardHistory(tooMuch,'iron_gate_native').issues.some(row=>
    row.code==='REFUND_EXCEEDS_RECEIPT'));
});

test('W7 requires original source audit time for Card and native history',()=>{
  const noCardTime=state();
  delete noCardTime.bookings[1].cardChargeResults[0].recordedAt;
  assert.ok(planNativeCardHistory(noCardTime,'sweetfun_card').issues.some(row=>
    row.code==='SOURCE_TIMESTAMP_MISSING'));
  const noPaymentTime=state();
  delete noPaymentTime.bookings[1].paymentEvents[0].recordedAt;
  assert.ok(planNativeCardHistory(noPaymentTime,'sweetfun_card').issues.some(row=>
    row.code==='SOURCE_TIMESTAMP_MISSING'));
  const noNativeTime=state();
  noNativeTime.bookings[0].paymentEvents[0].recordedAt='2026-10-27';
  assert.ok(planNativeCardHistory(noNativeTime,'iron_gate_native').issues.some(row=>
    row.code==='SOURCE_TIMESTAMP_INVALID'));
});
