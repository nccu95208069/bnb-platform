import assert from 'node:assert/strict';
import test from 'node:test';
import {reviewOnlyOfflandCalendarPayments,overlaySsotCalendarPayments} from
  '../src/lib/finance-ssot-calendar.ts';
import {ssotBookingOrder} from '../src/lib/booking-sources/iron-gate-ssot-bookings.server.ts';

const uuid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const config={grant:{workspaceId:uuid(1),propertyId:uuid(2)},
  calendar:{roomIds:{villa:uuid(3)}}};
const raw={id:uuid(4),workspaceId:uuid(1),propertyId:uuid(2),version:3,
  status:'confirmed',source:'external',sourceReviewRequired:false,currency:'TWD',
  totalCents:10000,createdAt:'2026-10-28T01:00:00.000Z',
  stays:[{checkIn:'2026-11-10',checkOut:'2026-11-12',roomIds:[uuid(3)]}],
  sourceCalendar:{platform:'Booking'},
  paymentSummary:{receivedCents:0,refundedCents:0,netReceivedCents:0},
  paymentReview:{status:'paid',source:'sheet_flag'}};
const booking={id:'synthetic-room-stay',property_id:'offland',
  order_id:`IG-${raw.id}`,iron_gate_booking_id:raw.id,
  iron_gate_booking_version:3,source_booking_version:3,
  iron_gate_source:'external',reservation_status:'confirmed',price_hidden:false,
  payment_status:'paid',payment_review_status:'paid',source_payment_flag:'done',
  source_payment_label:'Old paid claim',payment_unconfirmed:false,
  legacy_settlement_status:'settled_before_cutover_cash_details_unknown'};

test('snapshot-only external review equals the complete SSOT projection regardless of historical cash',()=>{
  for(const received of [0,3000,10000,15000]){
    const order={...ssotBookingOrder(raw,config),received};
    assert.equal(order.receivable_review_required,true);
    const expected=overlaySsotCalendarPayments([booking],[order],'offland');
    assert.deepEqual(reviewOnlyOfflandCalendarPayments([booking]),expected);
    assert.equal(expected[0].payment_status,'unknown');
    assert.equal(expected[0].payment_review_status,undefined);
    assert.equal(expected[0].legacy_settlement_status,undefined);
    assert.equal(expected[0].source_payment_flag,'unknown');
    assert.notEqual(expected[0].source_payment_label,'Old paid claim');
    assert.equal(expected[0].payment_unconfirmed,true);
  }
  assert.equal(booking.payment_status,'paid','input is not mutated');
});

test('native, mixed, redacted and incomplete snapshots require the existing live ledger path',()=>{
  for(const different of [
    ...['os','line','website',undefined].map(iron_gate_source=>({iron_gate_source})),
    {property_id:'sweetfun'},{price_hidden:true},{reservation_status:'cancelled'},
    {reservation_status:'retained'},{iron_gate_booking_id:undefined},
    {iron_gate_booking_version:0},{source_booking_version:2},
  ]){
    const changed={...booking,...different};
    assert.equal(reviewOnlyOfflandCalendarPayments([changed]),null);
    assert.equal(reviewOnlyOfflandCalendarPayments([booking,changed]),null);
  }
});

test('protected nights and repeated stay segments remain present without accepting mixed versions',()=>{
  const blocked={id:'synthetic-block',property_id:'offland',source_conflict:true,
    price_hidden:true,payment_status:'unknown'};
  const otherStay={...booking,id:'synthetic-second-stay'};
  const result=reviewOnlyOfflandCalendarPayments([booking,blocked,otherStay]);
  assert.equal(result.length,3);assert.equal(result[1],blocked);
  assert.equal(result[2].payment_status,'unknown');
  assert.equal(reviewOnlyOfflandCalendarPayments([booking,
    {...otherStay,iron_gate_booking_version:4,source_booking_version:4}]),null);
  assert.deepEqual(reviewOnlyOfflandCalendarPayments([]),[]);
});
