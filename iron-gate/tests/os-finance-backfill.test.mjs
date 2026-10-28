import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {captureOsFinanceSnapshot,planOsFinanceBackfill,
  reconcileOsFinanceBackfill} from '../src/os-finance-backfill.mjs';

const ID = {
  booking:'11111111-1111-4111-8111-111111111111',
  manual:'22222222-2222-4222-8222-222222222222',
  spread:'33333333-3333-4333-8333-333333333333',
  receipt:'44444444-4444-4444-8444-444444444444',
  status:'55555555-5555-4555-8555-555555555555',
  manualSource:'66666666-6666-4666-8666-666666666666',
  legacySource:'77777777-7777-4777-8777-777777777777',
};
const digest = value => createHash('sha256').update(value).digest('hex');
const stateKey = 'sweetfun-os:finance:v1:sweetfun:2025';
const paymentId = 'PAY-ALIAS-1';
const payKey = `sweetfun-os:payments:v1:sweetfun:${digest(JSON.stringify(paymentId))}`;
const op = (entry_id,i) => ({id:`op-${i}`,hash:'a'.repeat(64),entry_id,
  at:`2026-10-${String(i).padStart(2,'0')}T00:00:00Z`,actor:'actor-1'});
const expense = (id,amount,date,spread) => ({id,property_id:'sweetfun',kind:'expense',
  category:'water',amount_cents:amount,date,description:'',method:'cash',
  source:'manual',actor:'Operator',created_at:'2025-10-01T00:00:00Z',status:'active',
  ...(spread?{expense_spread:spread}:{})});
const receipt = (id,amount,overrides={}) => ({id,amount,payment_type:'deposit',
  payment_method:'cash',received_at:'2026-10-15T16:30:00Z',
  created_at:'2026-10-15T16:31:00Z',actor:'actor-1',actor_name:'Operator',
  settles_room:false,source_version:'legacy-snapshot',
  request_id:id,request_hash:'c'.repeat(64),...overrides});
function fixture() {
  const before = expense(ID.manual,5000,'2025-10-15');
  const amended = {...expense(ID.manual,6000,'2026-01-15'),status:'void',
    history:[{at:'2026-10-02T00:00:00Z',actor:'Operator',actor_id:'actor-1',before}],
    void_at:'2026-10-03T00:00:00Z',void_reason:'correction'};
  const spread = expense(ID.spread,10001,'2025-10-15',[
    {month:'2025-11',amount_cents:5000},{month:'2025-12',amount_cents:5001}]);
  const state = {version:4,entries:[amended,spread],operations:[
    op(ID.manual,1),op(ID.manual,2),op(ID.manual,3),op(ID.spread,4)]};
  const ledger = {version:2,receipts:[
    receipt(ID.receipt,100),receipt(ID.status,0,{status_only:true,
      payment_type:'full',payment_method:'other',settles_room:true,
      sheet_sync:{state:'verified',targets:[],paid:true}})]};
  return {snapshot:{schema_version:1,property_id:'sweetfun',
    captured_at:'2026-10-28T00:00:00Z',scan_complete:true,
    payment_orders:[{property_id:'sweetfun',order_id:'ROOM-1',
      payment_order_id:paymentId,status:'current'}],
    records:[{key:stateKey,value:JSON.stringify(state)},
      {key:payKey,value:JSON.stringify(ledger)}]},
    source_instances:{os_manual:ID.manualSource,os_legacy_payment:ID.legacySource},
    links:[{source_system:'os_legacy_payment',source_instance_id:ID.legacySource,
      property_id:'sweetfun',
      source_order_key:paymentId,booking_id:ID.booking,booking_version:3,
      snapshot_hash:'b'.repeat(64),reviewed:true}],
    catalog:{categories:[{kind:'expense',code:'water',label:'水費',status:'active'},
      {kind:'income',code:'lodging',label:'住宿收入',status:'active'}],accounts:[]}};
}
const DOCUMENT_ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT_ID='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function accepted(command,documentId=DOCUMENT_ID) {
  return {receipt_status:'accepted',request_key:command.request_key,
    document_id:documentId,document_version:1,
    origin_request_hash:command.origin_request_hash};
}
function readbackEvent(command,system,instance,id,extra={}) {
  const fields=['effective_on','cash_on','service_on','category_code','receipt_purpose',
    'payment_method_code','payment_account_ref','advanced_by_ref','advanced_by_kind',
    'advanced_by_label','safe_description','evidence_ref','source_actor_ref',
    'source_recorded_at'];
  return {id:EVENT_ID,document_id:DOCUMENT_ID,source_instance_id:instance,
    source_system:system,source_record_id:id,revision_version:1,
    event_kind:command.event_kind,source_version:command.source_version,
    revision_action:'create',
    evidence_level:command.evidence_level,document_status:'active',current_version:1,
    amount_cents:command.amount_cents,
    cash_effect_cents:command.event_kind==='expense_paid'?-command.amount_cents:
      command.amount_cents,
    booking_allocations:command.booking_allocations.map(a=>({booking_id:a.booking_id,
      amount_cents:a.amount_cents,allocation_kind:a.allocation_kind})),
    expense_attributions:command.expense_attributions,
    ...Object.fromEntries(fields.map(field=>[field,command[field]??null])),...extra};
}

test('manual version chain, cross-year key, odd spread and status-only stay distinct',()=>{
  const plan=planOsFinanceBackfill(fixture());
  assert.equal(plan.coverage_complete,true);
  assert.equal(plan.summary.source_net_cash_cents,-1);
  const manual=plan.records.filter(row=>row.source_record_id===ID.manual);
  assert.deepEqual(manual.map(row=>row.command.action),['create','amend','void']);
  assert.deepEqual(manual.map(row=>row.command.source_version),
    ['redis:2025:1','redis:2025:2','redis:2025:3']);
  assert.equal(manual[1].command.cash_on,'2026-01-15');
  assert.equal(manual[1].source_key,stateKey);
  const spread=plan.records.find(row=>row.source_record_id===ID.spread);
  assert.deepEqual(spread.command.expense_attributions.map(row=>row.amount_cents),[5000,5001]);
  assert.deepEqual(spread.command.expense_attributions.map(row=>row.month),
    ['2025-11-01','2025-12-01']);
  assert.equal(spread.command.cash_on,'2025-10-15');
  const payment=plan.records.find(row=>row.source_record_id===ID.receipt);
  assert.equal(payment.command.cash_on,'2026-10-16');
  assert.equal(payment.command.booking_allocations[0].source_order_key,paymentId);
  assert.equal(payment.command.source_record_id,ID.receipt);
  const status=plan.records.find(row=>row.source_record_id===ID.status);
  assert.equal(status.kind,'operational_status');
  assert.equal(status.status,'noncash');
  assert.equal(status.command.settles_room,true);
  assert.equal(status.command.status_code,'room_confirmed');
  assert.equal(status.command.origin_request_hash.length,64);
  assert.equal(status.command.origin_source_version,'redis:ledger:2');
  assert.equal(status.command.version,1);
  assert.equal(status.expected.cash_effect_cents,0);
});

test('unreviewed links, OTA and pending Sheet sync fail closed per record',()=>{
  const input=fixture();
  input.links[0].reviewed=false;
  const ledger=JSON.parse(input.snapshot.records[1].value);
  ledger.receipts.push(receipt('88888888-8888-4888-8888-888888888888',50,
    {payment_method:'ota'}));
  ledger.receipts.push(receipt('99999999-9999-4999-8999-999999999999',30,
    {sheet_sync:{state:'pending',targets:[],paid:false}}));
  ledger.version=4;
  input.snapshot.records[1].value=JSON.stringify(ledger);
  const plan=planOsFinanceBackfill(input);
  for(const row of plan.records.filter(row=>row.source_system==='os_legacy_payment')){
    assert.equal(row.status,'review');
    assert.equal(row.command,undefined);
  }
  assert.equal(plan.coverage_complete,true); // Input coverage, not acceptance.
  assert.equal(plan.summary.review,4);
});

test('malformed Redis record and duplicate source IDs are reported, never silently dropped',()=>{
  const input=fixture();
  input.snapshot.records.push({key:'sweetfun-os:finance:v1:sweetfun:2026',value:'{bad'});
  input.snapshot.records.push({...input.snapshot.records[1]});
  const plan=planOsFinanceBackfill(input);
  assert.equal(plan.coverage_complete,false);
  assert.ok(plan.issues.some(row=>row.code==='DUPLICATE_REDIS_KEY'));
  assert.ok(plan.issues.some(row=>row.code==='INVALID_REDIS_JSON'));
});

test('reconciliation needs pinned complete readback and finds a missing event by source ID',()=>{
  const plan=planOsFinanceBackfill(fixture());
  const incomplete=reconcileOsFinanceBackfill(plan,{});
  assert.equal(incomplete.status,'unverified');
  const compared=reconcileOsFinanceBackfill(plan,{complete:true,as_of_change_seq:10,
    unsequenced_event_count:0,events:[]});
  assert.equal(compared.status,'different');
  assert.ok(compared.differences.some(row=>row.source_record_id===ID.receipt &&
    row.code==='RECORD_EVENT_MISMATCH'));
  assert.ok(compared.differences.some(row=>row.code==='NONCASH_READBACK_INCOMPLETE'));
});

test('pinned readback compares cash and zero-cash status by original source ID',()=>{
  const plan=planOsFinanceBackfill(fixture());
  plan.records=plan.records.filter(row=>row.source_system==='os_legacy_payment');
  const money=plan.records.find(row=>row.kind==='money');
  const status=plan.records.find(row=>row.kind==='operational_status');
  const event=readbackEvent(money.command,'os_legacy_payment',ID.legacySource,ID.receipt);
  const provenance={source_instance_id:ID.legacySource,
    record_kind:'operational_status',source_record_id:ID.status,
    source_version:status.command.origin_source_version,target_version:1,
    source_snapshot_hash:status.command.origin_request_hash,
    source_actor_ref:status.command.source_actor_ref,
    source_recorded_at:status.command.source_recorded_at,
    imported_payload:Object.fromEntries(Object.entries(status.command).filter(([key])=>
      !['request_key','origin_request_hash','origin_source_version','source_actor_ref',
        'source_recorded_at'].includes(key))),
    target_current:{source_record_id:ID.status,version:1,
      status_code:'room_confirmed',settles_room:true,booking_id:ID.booking}};
  const readback={complete:true,as_of_change_seq:17,unsequenced_event_count:0,
    events:[event],receipts:{[money.command.request_key]:accepted(money.command)},
    catalog:{complete:true,next_cursor:null,as_of_change_seq:17,
      entries:[provenance]}};
  assert.equal(money.command.source_record_id,ID.receipt);
  assert.equal(reconcileOsFinanceBackfill(plan,readback).status,'matched');
  readback.events[0].category_code='other';
  assert.ok(reconcileOsFinanceBackfill(plan,readback).differences.some(row=>
    row.code==='RECORD_EVENT_MISMATCH'));
  readback.events[0].category_code=money.command.category_code;
  readback.events[0].payment_method_code='bank_transfer';
  assert.ok(reconcileOsFinanceBackfill(plan,readback).differences.some(row=>
    row.code==='RECORD_EVENT_MISMATCH'));
  readback.events[0].payment_method_code=money.command.payment_method_code;
  readback.events[0].cash_effect_cents=9900;
  assert.ok(reconcileOsFinanceBackfill(plan,readback).differences.some(row=>
    row.code==='RECORD_EVENT_MISMATCH'));
  readback.events[0].cash_effect_cents=10000;
  readback.catalog.entries[0].source_snapshot_hash='0'.repeat(64);
  assert.ok(reconcileOsFinanceBackfill(plan,readback).differences.some(row=>
    row.code==='NONCASH_SOURCE_MISMATCH'));
});

test('expense attribution is reconciled by exact month and cents',()=>{
  const plan=planOsFinanceBackfill(fixture());
  plan.records=plan.records.filter(row=>row.source_record_id===ID.spread);
  const command=plan.records[0].command;
  const event=readbackEvent(command,'os_manual',ID.manualSource,ID.spread);
  const readback={complete:true,as_of_change_seq:11,unsequenced_event_count:0,
    events:[event],receipts:{[command.request_key]:accepted(command)}};
  assert.equal(reconcileOsFinanceBackfill(plan,readback).status,'matched');
  event.expense_attributions=[{...command.expense_attributions[0],amount_cents:5001},
    {...command.expense_attributions[1],amount_cents:5000}];
  assert.equal(reconcileOsFinanceBackfill(plan,readback).status,'different');
});

test('recurring rule is zero cash; paid occurrence retains original ID and waits for model support',()=>{
  const ruleId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const paidId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const paid={...expense(paidId,1000,'2025-03-02'),status:'void',
    recurrence_id:ruleId,occurrence:'2025-02-28',void_at:'2025-03-03T00:00:00Z'};
  const rule={id:ruleId,year:2025,category:'water',amount_cents:1000,
    description:'Water',method:'cash',start:'2025-02-01',end:null,day:31,
    created_at:'2025-02-01T00:00:00Z',actor:'Operator'};
  const input=fixture();
  input.snapshot.records=[{key:stateKey,value:JSON.stringify({version:3,
    entries:[paid],recurring:[rule],operations:[op(ruleId,1),op(paidId,2),op(paidId,3)]})}];
  const plan=planOsFinanceBackfill(input);
  const due=plan.records.find(row=>row.kind==='recurring_rule');
  assert.equal(due.command.next_due_on,'2025-02-28');
  assert.equal(due.expected.cash_effect_cents,0);
  assert.match(due.command.source_actor_ref,/^os_actor:[a-f0-9]{64}$/);
  const payment=plan.records.find(row=>row.source_record_id===paidId);
  assert.equal(payment.status,'review');
  assert.deepEqual(payment.recurrence,{recurrence_id:ruleId,occurrence:'2025-02-28'});
  assert.ok(payment.reasons.includes('RECURRENCE_LINK_UNREPRESENTABLE'));
  assert.equal(plan.summary.source_net_cash_cents,0);
});

test('receipt append revision is separate from booking fingerprint and target version',()=>{
  const input=fixture();
  const ledger=JSON.parse(input.snapshot.records[1].value);
  ledger.version=3; // Sheet verification can add a ledger revision without a receipt.
  for (const [index,row] of ledger.receipts.entries()) row.audit={
    id:row.request_id,request_id:row.request_id,actor_id:row.actor,
    at:row.created_at,target_type:'receipt',target_id:row.id,
    action:row.status_only?'calendar_payment_confirmed':'calendar_payment_recorded',
    version_before:index,version_after:index+1};
  input.snapshot.records[1].value=JSON.stringify(ledger);
  let plan=planOsFinanceBackfill(input);
  const status=plan.records.find(row=>row.source_record_id===ID.status);
  assert.equal(status.status,'noncash');
  assert.equal(status.command.origin_source_version,'redis:ledger:2');
  assert.equal(status.command.version,1);
  assert.notEqual(status.command.origin_source_version,ledger.receipts[1].source_version);
  ledger.receipts[1].audit.version_after=3;
  input.snapshot.records[1].value=JSON.stringify(ledger);
  plan=planOsFinanceBackfill(input);
  assert.equal(plan.records.find(row=>row.source_record_id===ID.status).status,'review');
});

test('category inventory includes previous revisions but built-ins require target setup',()=>{
  const input=fixture();
  const before=expense(ID.manual,5000,'2025-10-15');
  const after={...expense(ID.manual,5000,'2025-10-15'),category:'gas',
    history:[{at:'2025-10-16T00:00:00Z',before}]};
  input.snapshot.records=[{key:stateKey,value:JSON.stringify({version:2,
    entries:[after],operations:[op(ID.manual,1),op(ID.manual,2)]})}];
  input.catalog.categories=[];
  const plan=planOsFinanceBackfill(input);
  assert.deepEqual(plan.records.filter(row=>row.kind==='category').map(row=>
    row.source_record_id).sort(),['expense:gas','expense:water']);
  assert.ok(plan.records.filter(row=>row.kind==='category').every(row=>
    row.status==='review' && row.reasons.includes('BUILTIN_CATEGORY_CONFIGURATION_REQUIRED')));
});

test('source connector link and original receipt timestamp are required',()=>{
  const input=fixture();
  input.links[0].source_instance_id=ID.manualSource;
  let plan=planOsFinanceBackfill(input);
  assert.equal(plan.records.find(row=>row.source_record_id===ID.status).status,'review');
  input.links[0].source_instance_id=ID.legacySource;
  const ledger=JSON.parse(input.snapshot.records[1].value);
  ledger.receipts[1].created_at='2026-10-15T16:31:00';
  input.snapshot.records[1].value=JSON.stringify(ledger);
  plan=planOsFinanceBackfill(input);
  assert.equal(plan.records.find(row=>row.source_record_id===ID.status).status,'review');
});

test('double SCAN and MGET capture rejects a changing Redis source',async()=>{
  const input=fixture();
  let reads=0;
  const scan=async(_cursor,pattern)=>['0',input.snapshot.records.filter(row=>
    row.key.startsWith(pattern.slice(0,-1))).map(row=>row.key)];
  const mget=async keys=>{reads++;return keys.map(key=>input.snapshot.records.find(row=>
    row.key===key)?.value);};
  const captured=await captureOsFinanceSnapshot({property_id:'sweetfun',scan,mget,
    payment_orders:input.snapshot.payment_orders});
  assert.equal(captured.scan_complete,true);
  assert.equal(captured.records.length,2);
  assert.equal(reads,2);
  await assert.rejects(captureOsFinanceSnapshot({property_id:'sweetfun',scan,
    mget:async keys=>{reads++;return keys.map(key=>reads>3?'changed':
      input.snapshot.records.find(row=>row.key===key)?.value);}}),
  /SOURCE_CHANGED_DURING_CAPTURE/);
});

test('a settled cash receipt preserves one cash event and a separate zero-cash status',()=>{
  const input=fixture();
  const ledger=JSON.parse(input.snapshot.records[1].value);
  ledger.receipts[0].settles_room=true;
  ledger.receipts[0].sheet_sync={state:'verified',targets:[],paid:true};
  input.snapshot.records[1].value=JSON.stringify(ledger);
  const plan=planOsFinanceBackfill(input);
  const rows=plan.records.filter(row=>row.source_record_id===ID.receipt);
  assert.deepEqual(rows.map(row=>row.kind),['money','operational_status']);
  assert.deepEqual(rows.map(row=>row.status),['ready','noncash']);
  assert.equal(rows.filter(row=>row.command?.amount_cents===10000).length,1);
  assert.equal(rows[1].expected.cash_effect_cents,0);
});

test('same receipt ID twice and suspected Card overlap block all affected candidates',()=>{
  const input=fixture();
  const ledger=JSON.parse(input.snapshot.records[1].value);
  ledger.receipts.push({...ledger.receipts[0]});
  ledger.version=3;
  input.snapshot.records[1].value=JSON.stringify(ledger);
  let plan=planOsFinanceBackfill(input);
  assert.equal(plan.records.filter(row=>row.source_record_id===ID.receipt &&
    row.status==='ready').length,0);
  assert.ok(plan.issues.some(row=>row.code==='DUPLICATE_RECEIPT_ID'));

  const clean=fixture();
  clean.reference_complete=true;
  clean.reference_events=[{property_id:'sweetfun',source_system:'sweetfun_card',
    document_status:'active',event_kind:'property_receipt',cash_on:'2026-10-17',
    booking_allocations:[{booking_id:ID.booking,amount_cents:10000}]}];
  plan=planOsFinanceBackfill(clean);
  const old=plan.records.find(row=>row.source_record_id===ID.receipt);
  assert.equal(old.status,'review');
  assert.ok(old.reasons.includes('SUSPECTED_CROSS_SOURCE_DUPLICATE'));
});

test('catalog candidates retain exact source actor evidence and never create cash',()=>{
  const input=fixture();
  const accountId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const account={id:accountId,property_id:'sweetfun',method:'bank_transfer',
    last_digits:'12345',name:'Operating bank',created_at:'2025-10-01T00:00:00Z',
    actor_id:'actor-1'};
  const payout={platform:'ctrip',mode:'monthly',day:31,offset:2,
    updated_at:'2025-10-02T00:00:00Z'};
  const payoutOp={...op('payout-op',2),event:{id:'op-2',
    at:'2026-10-02T00:00:00Z',version_before:1,version_after:2,
    action:'payout_rule_updated',target_type:'payout_rule',target_id:'ctrip'}};
  input.snapshot.records=[{key:stateKey,value:JSON.stringify({version:2,
    entries:[],payment_accounts:[account],payout_rules:[payout],
    operations:[op(accountId,1),payoutOp]})}];
  const plan=planOsFinanceBackfill(input);
  const rows=plan.records.filter(row=>row.status==='noncash');
  assert.deepEqual(rows.map(row=>row.kind),['payment_account','payout_rule']);
  for(const row of rows){
    assert.match(row.command.source_actor_ref,/^os_actor:[a-f0-9]{64}$/);
    assert.match(row.command.origin_request_hash,/^[a-f0-9]{64}$/);
    assert.equal(row.expected.cash_effect_cents,0);
  }
  assert.equal(plan.summary.source_net_cash_cents,0);
});

test('missing built-in category is explicit setup review while money awaits catalog readback',()=>{
  const input=fixture();
  input.catalog.categories=[];
  const plan=planOsFinanceBackfill(input);
  const category=plan.records.find(row=>row.kind==='category' &&
    row.source_record_id==='expense:water');
  assert.equal(category.status,'review');
  assert.ok(category.reasons.includes('BUILTIN_CATEGORY_CONFIGURATION_REQUIRED'));
  assert.equal(category.command,undefined);
  assert.ok(plan.records.find(row=>row.source_record_id===ID.spread).reasons.includes(
    'CATEGORY_NOT_PROVISIONED'));
});

test('custom category keeps exact first-use operation provenance',()=>{
  const input=fixture();
  const custom='custom_0123456789abcdef0123';
  const entry={...expense(ID.spread,1000,'2025-10-15'),
    category:custom,category_name:'Equipment'};
  input.snapshot.records=[{key:stateKey,value:JSON.stringify({version:1,
    entries:[entry],operations:[op(ID.spread,1)]})}];
  input.catalog.categories=[];
  const plan=planOsFinanceBackfill(input);
  const category=plan.records.find(row=>row.source_record_id===`expense:${custom}`);
  assert.equal(category.status,'noncash');
  assert.equal(category.command.origin_source_version,'redis:2025:1');
  assert.equal(category.command.source_recorded_at,'2026-10-01T00:00:00Z');
});
