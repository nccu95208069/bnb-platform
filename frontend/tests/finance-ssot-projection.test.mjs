import assert from 'node:assert/strict';
import test from 'node:test';
import {entriesFromLedger,readCatalog,reviewUncertainReceivables} from
  '../src/lib/finance-ssot-context.ts';
import {projectOrders,validateFinanceLinks} from '../src/lib/finance-projection.ts';
import {revenueSummary,roomCollectionForOrder,summarize} from '../src/lib/finance-model.ts';
import {summarizeOrders,emptyRegistry} from '../src/lib/finance-summary.ts';

const bookingId='10000000-0000-4000-8000-000000000001';
const receiptId='10000000-0000-4000-8000-000000000002';
const refundId='10000000-0000-4000-8000-000000000003';
const eventId='10000000-0000-4000-8000-000000000004';
const base={id:eventId,document_id:receiptId,revision_version:1,current_version:2,
  document_status:'active',event_kind:'property_receipt',amount_cents:'6000',
  cash_effect_cents:'6000',effective_on:'2026-10-28',cash_on:'2026-10-28',
  category_code:'lodging',receipt_purpose:'room',payment_method_code:'cash',
  payment_account_ref:null,advanced_by_ref:null,advanced_by_kind:null,
  advanced_by_label:null,safe_description:'Synthetic room receipt',
  actor_ref:'synthetic-operator',created_at:'2026-10-28T00:00:00.000Z',
  evidence_level:'operator_attested',evidence_ref:'synthetic-proof',
  reverses_event_id:null,source_system:'os_manual',source_record_id:'os-synthetic',
  source_instance_id:'10000000-0000-4000-8000-000000000005',
  revision_action:'create',source_version:'1',current_reason_note:null,
  booking_allocations:[{booking_id:bookingId,amount_cents:'6000',allocation_kind:'room'}],
  expense_attributions:[]};
const order={id:'SF-SYNTHETIC',calendar_id:'SF-SYNTHETIC',booking_id:bookingId,
  platform:'direct',rooms:['101'],check_in:'2026-10-28',check_out:'2026-10-29',
  total:10000,received:0,receivable:10000,eligible_date:null,
  source_paid:false,credit:0,source_version:'synthetic'};
const catalog={accounts:[],categories:[],recurring:[],payout:[],links:[]};

test('current finance projection selects replacements, preserves void reason and nets refunds',()=>{
  const replaced={...base,id:'10000000-0000-4000-8000-000000000006',
    revision_version:2,amount_cents:'5000',cash_effect_cents:'5000',
    source_version:'2',revision_action:'amend',
    booking_allocations:[{booking_id:bookingId,amount_cents:'5000',allocation_kind:'room'}]};
  const reversal={...base,id:'10000000-0000-4000-8000-000000000007',
    event_kind:'reversal',revision_version:2,amount_cents:'6000',
    cash_effect_cents:'-6000',reverses_event_id:eventId,
    booking_allocations:[{booking_id:bookingId,amount_cents:'-6000',allocation_kind:'room'}]};
  const refund={...base,id:'10000000-0000-4000-8000-000000000008',
    document_id:refundId,revision_version:1,current_version:1,
    event_kind:'property_refund',amount_cents:'2000',cash_effect_cents:'-2000',
    booking_allocations:[{booking_id:bookingId,amount_cents:'2000',allocation_kind:'room'}]};
  const active=entriesFromLedger([base,reversal,replaced,refund],
    'sweetfun',[order],catalog);
  assert.equal(active.length,2);
  assert.equal(active.find(e=>e.id===receiptId).amount_cents,5000);
  assert.equal(active.find(e=>e.id===refundId).kind,'refund');
  const rows=[{property_id:'sweetfun',order_id:order.id,id:'row-1',
    platform:'direct',room_number:'101',room_rate:100,
    check_in:'2026-10-28',check_out:'2026-10-29',
    reservation_status:'confirmed',payment_status:'unpaid'}];
  assert.equal(projectOrders(rows,active,[]).orders[0].received,3000);
  const voided=entriesFromLedger([{...base,current_version:3,
    document_status:'void',current_reason_note:'Synthetic correction'},
    {...replaced,current_version:3,document_status:'void',
      current_reason_note:'Synthetic correction'}],
    'sweetfun',[order],catalog);
  assert.equal(voided[0].status,'void');
  assert.equal(voided[0].void_reason,'Synthetic correction');
});

test('catalog keeps expense categories, account digits, and monthly reminders',()=>{
  const result=readCatalog({accounts:[{code:'account-1',kind:'bank',
    display_name:'Synthetic bank',last_digits:'12345'}],categories:[
      {code:'supplies',kind:'expense',label:'Supplies',status:'active'},
      {code:'other',kind:'income',label:'Other income',status:'active'}],
    recurring:[{id:'10000000-0000-4000-8000-000000000009',
      source_record_id:'os-rule-1',version:1,cadence:'monthly',
      start_on:'2026-10-01',end_on:null,due_day:10,amount_cents:'2500',
      category_code:'supplies',safe_description:'Monthly supplies',
      payment_method_code:'bank_transfer',status:'active'}],
    payout:[{platform:'ctrip',mode:'fixed_day',day:10,
      offset_months:1,version:1,status:'active'}],links:[]},'sweetfun');
  assert.equal(result.accounts[0].last_digits,'12345');
  assert.equal(result.categories.supplies,'Supplies');
  assert.equal(result.categories.other,'其他花費');
  assert.equal(result.recurring[0].amount_cents,2500);
  assert.equal(result.payout[0].offset,1);
});

test('OTA and mixed-payment balances remain in review rather than numeric receivables',()=>{
  const direct={...order,platform:'direct',received:2000,receivable:8000};
  const ota={...order,id:'OTA-SYNTHETIC',booking_id:
    '10000000-0000-4000-8000-000000000010',platform:'agoda'};
  const observed={...base,current_version:1,event_kind:'ota_guest_payment_observed',
    cash_on:null};
  const marked=reviewUncertainReceivables([direct,ota],[observed]);
  assert.equal(marked[0].receivable,0);
  assert.equal(marked[0].receivable_review_required,true);
  assert.equal(marked[1].receivable_review_required,true);
  assert.equal(marked[1].receivable,0);
  const known=reviewUncertainReceivables([direct],[]);
  assert.equal(known[0].receivable,8000);
  assert.equal(known[0].receivable_review_required,undefined);
  const voided=reviewUncertainReceivables([direct],[{
    ...observed,current_version:2,document_status:'void'}]);
  assert.equal(voided[0].receivable,8000);
  const summary=revenueSummary(marked,[],'2026-10');
  assert.equal(summary.review_count,2);
  assert.equal(summary.receivable,0);
  assert.throws(()=>validateFinanceLinks({action:'create',kind:'income',
    category:'lodging',method:'cash',platform:'direct',amount:10,
    allocations:[{order_id:direct.id,amount_cents:1000}]},marked,[],[],
    2026,'2026-10-28'),/SOURCE_MAPPING_REVIEW_REQUIRED/);
});

test('OTA payout is property cash while guest payment observation is not',()=>{
  const payout={...base,current_version:1,event_kind:'ota_payout',
    category_code:null,receipt_purpose:null,payment_method_code:'bank_transfer',
    booking_allocations:[{booking_id:bookingId,amount_cents:'6000',
      allocation_kind:'ota_payout'}]};
  const observed={...payout,id:'10000000-0000-4000-8000-000000000011',
    document_id:'10000000-0000-4000-8000-000000000012',
    event_kind:'ota_guest_payment_observed',cash_on:null,cash_effect_cents:'0'};
  const otaOrder={...order,platform:'agoda'};
  const entries=entriesFromLedger([payout,observed],'sweetfun',[otaOrder],catalog);
  assert.equal(entries.length,1);
  assert.equal(entries[0].ssot_event_kind,'ota_payout');
  assert.equal(entries[0].category,'lodging');
  assert.equal(entries[0].method,'bank_transfer');
  assert.equal(summarize(entries,'2026-10').income,6000);
  assert.equal(summarize(entries,'2026-10').ota,0);
  const rows=[{property_id:'sweetfun',order_id:otaOrder.id,id:'row-ota',
    sheet_row_id:'row-ota',platform:'agoda',room_number:'101',room_rate:100,
    check_in:'2026-10-28',check_out:'2026-10-29',
    reservation_status:'confirmed',payment_status:'paid'}];
  assert.equal(projectOrders(rows,entries,[]).orders[0].received,6000);
  const summary=summarizeOrders('sweetfun',rows,entries,emptyRegistry()).orders[0];
  assert.equal(summary.recorded_received_cents,6000);
  assert.equal(summary.ota_collected_cents,0);
});

test('booked extras remain cash income but do not settle room receivables',()=>{
  const room={...base,current_version:1};
  const extra={...base,id:'10000000-0000-4000-8000-000000000013',
    document_id:'10000000-0000-4000-8000-000000000014',current_version:1,
    amount_cents:'700',cash_effect_cents:'700',category_code:'lodging',
    receipt_purpose:'extra',
    booking_allocations:[{booking_id:bookingId,amount_cents:'700',
      allocation_kind:'extra'}]};
  const entries=entriesFromLedger([room,extra],'sweetfun',[order],catalog);
  const rows=[{property_id:'sweetfun',order_id:order.id,id:'row-extra',
    platform:'direct',room_number:'101',room_rate:100,
    check_in:'2026-10-28',check_out:'2026-10-29',
    reservation_status:'confirmed',payment_status:'unpaid'}];
  assert.equal(summarize(entries,'2026-10').income,6700);
  assert.equal(roomCollectionForOrder(entries[1],order.id),0);
  const projected=projectOrders(rows,entries,[]).orders[0];
  assert.equal(projected.received,6000);
  assert.equal(projected.receivable,4000);
  const revenue=revenueSummary([projected],entries,'2026-10');
  assert.equal(revenue.received,6700);
  assert.equal(revenue.receivable,4000);
  assert.equal(revenue.total,10700);
});

test('split room receipt contributes its booking allocation to each direct order',()=>{
  const secondBookingId='10000000-0000-4000-8000-000000000015';
  const second={...order,id:'SF-SECOND',booking_id:secondBookingId};
  const split={...base,current_version:1,amount_cents:'5000',
    booking_allocations:[
      {booking_id:bookingId,amount_cents:'2000',allocation_kind:'room'},
      {booking_id:secondBookingId,amount_cents:'3000',allocation_kind:'room'}]};
  const [entry]=entriesFromLedger([split],'sweetfun',[order,second],catalog);
  assert.equal(entry.order_id,undefined);
  assert.equal(roomCollectionForOrder(entry,order.id),2000);
  assert.equal(roomCollectionForOrder(entry,second.id),3000);
});

test('canceled imported booking keeps verified historical receipt without receivable',()=>{
  const canceled=[{property_id:'sweetfun',order_id:order.id,id:'row-canceled',
    platform:'direct',room_number:'101',room_rate:100,
    check_in:'2026-10-28',check_out:'2026-10-29',
    reservation_status:'cancelled',payment_status:'unpaid'}];
  const current=projectOrders(canceled,[],[]).orders;
  assert.equal(current.length,0);
  const link={source_instance_id:base.source_instance_id,
    source_order_key:order.id,booking_id:bookingId,
    verified_booking_version:1,source_snapshot_hash:'a'.repeat(64)};
  const receipt={...base,current_version:1};
  const entries=entriesFromLedger([receipt],'sweetfun',current,
    {...catalog,links:[link]});
  assert.equal(entries.length,1);
  assert.equal(entries[0].allocations[0].order_id,order.id);
  assert.equal(summarize(entries,'2026-10').income,6000);
  assert.equal(revenueSummary(current,entries,'2026-10').receivable,0);
  assert.throws(()=>entriesFromLedger([receipt],'sweetfun',current,
    {...catalog,links:[link,{...link,source_order_key:'OTHER'}]}),
  /FINANCE_SSOT_READBACK_MISMATCH/);
  const versioned=[{...link,source_order_key:`${bookingId}:v1`},
    {...link,source_order_key:`${bookingId}:v2`,verified_booking_version:2}];
  const nativeHistory=entriesFromLedger([receipt],'sweetfun',current,
    {...catalog,links:versioned});
  assert.equal(nativeHistory[0].allocations[0].order_id,bookingId);
  assert.throws(()=>entriesFromLedger([receipt],'sweetfun',current,
    {...catalog,links:[...versioned,{...link,source_order_key:'OTHER'}]}),
  /FINANCE_SSOT_READBACK_MISMATCH/);
});
