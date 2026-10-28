import assert from 'node:assert/strict';
import test from 'node:test';
import {entriesFromLedger,reviewUncertainReceivables} from '../src/lib/finance-ssot-context.ts';
import {projectOrders,projectSsotBookingBalances,validateFinanceLinks} from '../src/lib/finance-projection.ts';
import {revenueSummary,summarize,verifiedRetainedCredit} from '../src/lib/finance-model.ts';
import {summarizeSsotOrders} from '../src/lib/finance-ssot-summary.ts';
import {emptyRegistry,summarizeOrders} from '../src/lib/finance-summary.ts';
import {overlaySsotCalendarPayments} from '../src/lib/finance-ssot-calendar.ts';

const bookingId='10000000-0000-4000-8000-000000000021';
const receiptId='10000000-0000-4000-8000-000000000022';
const refundId='10000000-0000-4000-8000-000000000023';
const sourceId='10000000-0000-4000-8000-000000000024';
const order={id:`IG-${bookingId}`,calendar_id:`IG-${bookingId}`,booking_id:bookingId,
  source:'iron_gate',status:'confirmed',ssot_booking_version:1,
  ssot_command_eligible:true,ssot_payment_coverage:'verified_current',
  platform:'direct',rooms:['Synthetic villa'],check_in:'2026-10-30',check_out:'2026-10-31',
  total:10000,received:0,receivable:10000,credit:0,source_paid:false,
  eligible_date:null,source_version:'synthetic'};
const receipt={id:'10000000-0000-4000-8000-000000000025',document_id:receiptId,
  revision_version:1,current_version:1,document_status:'active',
  event_kind:'property_receipt',amount_cents:'3000',cash_effect_cents:'3000',
  effective_on:'2026-09-15',cash_on:'2026-09-15',category_code:'lodging',
  receipt_purpose:'deposit',payment_method_code:'bank_transfer',
  source_system:'os_manual',source_instance_id:sourceId,source_record_id:'synthetic-deposit',
  actor_ref:'synthetic-operator',created_at:'2026-09-15T02:00:00Z',
  booking_allocations:[{booking_id:bookingId,amount_cents:'3000',allocation_kind:'deposit'}],
  expense_attributions:[]};
const refund={...receipt,id:'10000000-0000-4000-8000-000000000026',
  document_id:refundId,event_kind:'property_refund',amount_cents:'500',
  cash_effect_cents:'-500',effective_on:'2026-10-01',cash_on:'2026-10-01',
  source_record_id:'synthetic-refund',related_receipt_event_id:receipt.id,
  related_receipt_document_id:receiptId,
  booking_allocations:[{booking_id:bookingId,amount_cents:'500',allocation_kind:'deposit'}]};
const events=[receipt,refund];
const catalog={accounts:[],categories:[],recurring:[],payout:[],links:[]};
const retained={...order,status:'retained',ssot_booking_version:2,
  check_in:'',check_out:'',rooms:[],retained_credit_cents:null,
  retained_credit_review_required:true};

test('retaining and rescheduling preserve original cash identities and receipt months',()=>{
  const before=entriesFromLedger(events,'offland',[order],catalog);
  const storedEvents=structuredClone(events);
  const during=entriesFromLedger(events,'offland',[retained],catalog);
  const rescheduled={...order,ssot_booking_version:3,total:12000,
    check_in:'2026-11-20',check_out:'2026-11-21'};
  const after=entriesFromLedger(events,'offland',[rescheduled],catalog);
  assert.deepEqual(during,before);
  assert.deepEqual(after,before);
  assert.deepEqual(events,storedEvents);
  assert.deepEqual(before.map(entry=>[entry.id,entry.payment_event_id,entry.date]),[
    [receiptId,receipt.id,'2026-09-15'],[refundId,refund.id,'2026-10-01']]);
  assert.equal(summarize(after,'2026-09').income,3000);
  assert.equal(summarize(after,'2026-10').refund,500);
  assert.equal(summarize(after,'2026-11').income,0);
  const [kept]=projectSsotBookingBalances([retained],during);
  assert.equal(kept.received,2500);
  assert.equal(kept.receivable,0);
  assert.equal(kept.credit,0);
  assert.equal(kept.source_paid,false);
  assert.equal(kept.ssot_command_eligible,false);
  assert.equal(revenueSummary([kept],during,'2026-10').total,0);
  // A stale display date must not reintroduce a retained booking into revenue.
  assert.equal(revenueSummary([{...kept,check_in:order.check_in}],during,'2026-10').total,0);
  const [arranged]=projectSsotBookingBalances([rescheduled],after);
  assert.equal(arranged.receivable,9500);
  assert.equal(revenueSummary([arranged],after,'2026-10').total,0);
  assert.deepEqual(revenueSummary([arranged],after,'2026-11'),{
    received:2500,receivable:9500,total:12000,review_count:0});
});

test('unknown retained funds never become zero or the original room price',()=>{
  for(const candidate of [retained,{...retained,retained_credit_cents:3000},
    {...retained,retained_credit_cents:undefined,retained_credit_review_required:undefined}]){
    const [projected]=projectSsotBookingBalances([candidate],[]);
    assert.equal(projected.retained_credit_cents,null);
    assert.equal(projected.retained_credit_review_required,true);
    assert.equal(projected.receivable,0);
    assert.equal(projected.source_paid,false);
  }
  assert.equal(verifiedRetainedCredit({retained_credit_cents:0,retained_credit_review_required:false}),0);
  for(const amount of [null,undefined,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
    assert.equal(verifiedRetainedCredit({retained_credit_cents:amount,retained_credit_review_required:false}),null);
  const [verified]=projectSsotBookingBalances([{
    ...retained,retained_credit_cents:2500,retained_credit_review_required:false,
  }],entriesFromLedger(events,'offland',[retained],catalog));
  assert.equal(verified.retained_credit_cents,2500);
  assert.equal(verified.retained_credit_review_required,false);
});

test('rescheduling with uncertain history retains unknown due while showing existing recorded cash',()=>{
  const arranged={...order,total:12000,check_in:'2026-11-20',check_out:'2026-11-21',
    ssot_command_eligible:false,ssot_payment_coverage:'historical_review_required',
    receivable_review_required:true};
  const entries=entriesFromLedger(events,'offland',[arranged],catalog);
  const [projected]=reviewUncertainReceivables(projectSsotBookingBalances([arranged],entries),events);
  assert.equal(projected.received,2500);
  assert.equal(projected.receivable,0);
  assert.equal(projected.receivable_review_required,true);
  assert.equal(projected.source_paid,false);
  const summary=summarizeSsotOrders('offland',[projected],entries,emptyRegistry()).orders[0];
  assert.equal(summary.outstanding_cents,null);
  assert.equal(summary.can_record,false);
  assert.equal(revenueSummary([projected],entries,'2026-11').review_count,1);
});

test('lower rescheduled price leaves excess recorded credit without creating income or refund',()=>{
  const arranged={...order,total:2000,check_in:'2026-11-20',check_out:'2026-11-21'};
  const entries=entriesFromLedger(events,'offland',[arranged],catalog);
  const [projected]=projectSsotBookingBalances([arranged],entries);
  assert.equal(projected.receivable,0);
  assert.equal(projected.credit,500);
  assert.equal(entries.length,2);
  assert.equal(revenueSummary([projected],entries,'2026-11').total,2000);
  assert.equal(summarize(entries,'2026-11').net,0);
});

test('retained summary retains receipt and refund records without current receivable or collection action',()=>{
  const entries=entriesFromLedger(events,'offland',[retained],catalog);
  const orders=projectSsotBookingBalances([retained],entries);
  const summary=summarizeSsotOrders('offland',orders,entries,emptyRegistry()).orders[0];
  assert.equal(summary.status,'retained');
  assert.equal(summary.source_amount_cents,10000);
  assert.equal(summary.recorded_received_cents,2500);
  assert.equal(summary.retained_credit_cents,null);
  assert.equal(summary.receivable_total_cents,null);
  assert.equal(summary.outstanding_cents,null);
  assert.equal(summary.can_record,false);
  assert.deepEqual(summary.records.map(record=>[record.id,record.amount_cents,record.at]),[
    [receiptId,3000,'2026-09-15'],[refundId,-500,'2026-10-01']]);
  assert.ok(summary.issues.includes('retained_credit_review_required'));
  assert.ok(!summary.issues.includes('historical_payment_review_required'));
});

test('retained historical rows cannot create receivables or new lodging receipts',()=>{
  const rows=[{id:'synthetic-row',sheet_row_id:'synthetic-row',order_id:order.id,
    property_id:'offland',platform:'direct',room_number:'Synthetic villa',room_rate:100,
    check_in:'2026-10-30',check_out:'2026-10-31',reservation_status:'retained',payment_status:'paid'}];
  assert.deepEqual(projectOrders(rows,[],[]).orders,[]);
  assert.deepEqual(summarizeOrders('offland',rows,[],emptyRegistry()).orders,[]);
  assert.throws(()=>validateFinanceLinks({action:'create',kind:'income',category:'lodging',
    method:'cash',platform:'direct',amount:10,allocations:[{order_id:order.id,amount_cents:1000}]},
  [{...retained,receivable:10000,ssot_command_eligible:true}],[],[],2026,'2026-10-29',{ssot:true}),
  /SOURCE_MAPPING_REVIEW_REQUIRED/);
  assert.equal(overlaySsotCalendarPayments(rows,[],'offland')[0].payment_status,'unknown');
});
