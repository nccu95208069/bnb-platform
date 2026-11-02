import assert from 'node:assert/strict';
import test from 'node:test';
import {applyHistoricalSettlements} from '../src/lib/finance-ssot-settlement.ts';
import {revenueSummary} from '../src/lib/finance-model.ts';
import {overlaySsotCalendarPayments} from '../src/lib/finance-ssot-calendar.ts';
import {projectBookings} from '../src/lib/workspace-auth/projection.ts';
import {checkRows} from '../src/lib/os-payments.ts';

const bookingId='10000000-0000-4000-8000-000000000001';
const hash='a'.repeat(64);
const sheetVersion='c'.repeat(64);
const order={id:'SF-synthetic',calendar_id:'calendar',platform:'direct',rooms:['201'],
  check_in:'2026-10-16',check_out:'2026-10-17',total:10000,received:0,
  receivable:10000,eligible_date:null,source_paid:false,credit:0,
  source_version:sheetVersion,
  booking_id:bookingId,ssot_booking_version:2,ssot_source_snapshot_hash:hash};
const settled={property_id:'sweetfun',booking_id:bookingId,
  status:'settled_before_cutover_cash_details_unknown',booking_version:2,
  booking_total_cents:10000,booking_snapshot_hash:'b'.repeat(64),
  source_link_snapshot_hash:hash,sheet_order_source_version:sheetVersion,
  cash_effect_cents:0,collection_hold:true,
  historical_cash_detail_missing:true,review_required:false,
  remaining_due_cents:0,room_received_cents:0,room_refunded_cents:0,
  recorded_change_seq:7,as_of_change_seq:7};

test('owner reviewed legacy settlement ends collection without creating cash revenue',()=>{
  const [result]=applyHistoricalSettlements([order],[settled],'sweetfun');
  assert.equal(result.receivable,0);
  assert.equal(result.received,0);
  assert.equal(result.collection_hold,true);
  assert.equal(result.historical_cash_detail_missing,true);
  assert.equal(result.legacy_settlement.status,
    'settled_before_cutover_cash_details_unknown');
  const month=revenueSummary([result],[],'2026-10');
  assert.equal(month.received,0);
  assert.equal(month.receivable,0);
  assert.equal(month.review_count,1);
  const [calendar]=overlaySsotCalendarPayments([{property_id:'sweetfun',
    iron_gate_source:'external',reservation_status:'confirmed',
    payment_order_id:order.id,payment_status:'paid'}],[result]);
  assert.equal(calendar.payment_status,'unknown');
  assert.equal(calendar.legacy_settlement_status,
    'settled_before_cutover_cash_details_unknown');
  const [hidden]=projectBookings([{...calendar,room_rate:100}],{
    viewPrices:false,allProperties:false,propertyIds:['sweetfun']});
  assert.equal(hidden.legacy_settlement_status,undefined);
  assert.equal(hidden.payment_status,'unknown');
});

test('owner reviewed unpaid booking stays collectible and is not labeled paid',()=>{
  const unpaid={...settled,status:'unpaid_at_cutover',collection_hold:false,
    historical_cash_detail_missing:false,remaining_due_cents:10000};
  const [result]=applyHistoricalSettlements([order],[unpaid],'sweetfun');
  assert.equal(result.receivable,10000);
  assert.equal(result.received,0);
  assert.equal(result.collection_hold,false);
  const [calendar]=overlaySsotCalendarPayments([{property_id:'sweetfun',
    iron_gate_source:'external',reservation_status:'confirmed',
    payment_order_id:order.id,payment_status:'paid',
    payment_review_status:'paid'}],[result]);
  assert.equal(calendar.payment_status,'unpaid');
  assert.equal(calendar.payment_review_status,undefined);
  assert.equal(calendar.legacy_settlement_status,undefined);
  const [ota]=applyHistoricalSettlements([{
    ...order,platform:'agoda',receivable_review_required:true,receivable:0}],[unpaid],'sweetfun');
  assert.equal(ota.receivable,0);
  assert.equal(ota.receivable_review_required,true);
  assert.equal(ota.legacy_settlement.review_required,true);
});

test('SSOT payment state clears a stale Iron Gate paid review',()=>{
  const [calendar]=overlaySsotCalendarPayments([{property_id:'sweetfun',
    iron_gate_source:'external',reservation_status:'confirmed',
    payment_order_id:order.id,payment_status:'paid',
    payment_review_status:'paid'}],[order]);
  assert.equal(calendar.payment_status,'unknown');
  assert.equal(calendar.payment_review_status,undefined);
});

test('changed booking or new cash requires review and cannot be collected automatically',()=>{
  const [versionChanged]=applyHistoricalSettlements([{
    ...order,ssot_booking_version:3}],[settled],'sweetfun');
  assert.equal(versionChanged.receivable,0);
  assert.equal(versionChanged.collection_hold,false);
  assert.equal(versionChanged.receivable_review_required,true);
  assert.equal(versionChanged.legacy_settlement.review_required,true);
  const [sourceChanged]=applyHistoricalSettlements([order],[{
    ...settled,source_link_snapshot_hash:'c'.repeat(64)}],'sweetfun');
  assert.equal(sourceChanged.legacy_settlement.review_required,true);
  const [newCash]=applyHistoricalSettlements([{...order,received:5000}],
    [{...settled,collection_hold:false,review_required:true,
      remaining_due_cents:null,room_received_cents:5000}],
    'sweetfun');
  assert.equal(newCash.received,5000);
  assert.equal(newCash.receivable,0);
  assert.equal(newCash.collection_hold,false);
  const [calendar]=overlaySsotCalendarPayments([{property_id:'sweetfun',
    iron_gate_source:'external',reservation_status:'confirmed',
    payment_order_id:order.id,payment_status:'paid'}],[newCash]);
  assert.equal(calendar.payment_status,'unknown');
  assert.equal(calendar.legacy_settlement_status,'review_required');
});

test('changed Sheet payment flag blocks collection even with the same total and booking version',()=>{
  const sheetRow={id:'sheet-row-1',property_id:'sweetfun',order_id:order.id,
    room_id:'201',room_number:'201',check_in:order.check_in,
    check_out:order.check_out,room_rate:100,payment_status:'unknown',
    reservation_status:'confirmed'};
  const before=checkRows([sheetRow],'sweetfun',order.id);
  const after=checkRows([{...sheetRow,payment_status:'paid'}],'sweetfun',order.id);
  assert.equal(before.total,after.total);
  assert.notEqual(before.source_version,after.source_version);
  const unpaid={...settled,status:'unpaid_at_cutover',collection_hold:false,
    historical_cash_detail_missing:false,remaining_due_cents:10000,
    sheet_order_source_version:before.source_version};
  const [result]=applyHistoricalSettlements([{...order,
    source_version:after.source_version,source_paid:true}],[unpaid],'sweetfun');
  assert.equal(result.total,order.total);
  assert.equal(result.ssot_booking_version,unpaid.booking_version);
  assert.equal(result.receivable,0);
  assert.equal(result.receivable_review_required,true);
  assert.equal(result.legacy_settlement.review_required,true);
});

test('missing exact source link and incoherent cash flags fail closed',()=>{
  assert.throws(()=>applyHistoricalSettlements([{...order,
    ssot_source_snapshot_hash:undefined}],[settled],'sweetfun'),/FINANCE_SSOT_READBACK_MISMATCH/);
  assert.throws(()=>applyHistoricalSettlements([order],[{...settled,
    collection_hold:false}],'sweetfun'),/FINANCE_SSOT_READBACK_MISMATCH/);
  assert.throws(()=>applyHistoricalSettlements([order],[{...settled,
    booking_id:'10000000-0000-4000-8000-000000000002'}],'sweetfun'),
  /FINANCE_SSOT_READBACK_MISMATCH/);
  assert.throws(()=>applyHistoricalSettlements([order],[{...settled,
    property_id:'offland'}],'sweetfun'),/FINANCE_SSOT_READBACK_MISMATCH/);
  assert.throws(()=>applyHistoricalSettlements([order],[{...settled,
    sheet_order_source_version:'invalid'}],'sweetfun'),/FINANCE_SSOT_READBACK_MISMATCH/);
});
