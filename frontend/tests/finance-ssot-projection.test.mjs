import assert from 'node:assert/strict';
import test from 'node:test';
import {entriesFromLedger,readCatalog} from '../src/lib/finance-ssot-context.ts';
import {projectOrders} from '../src/lib/finance-projection.ts';

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
