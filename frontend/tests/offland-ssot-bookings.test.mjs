import assert from 'node:assert/strict';
import test from 'node:test';
import {readSsotBookings,ssotBookingOrder} from
  '../src/lib/booking-sources/iron-gate-ssot-bookings.server.ts';
import {entriesFromLedger} from '../src/lib/finance-ssot-context.ts';
import {projectSsotBookingBalances,validateFinanceLinks} from '../src/lib/finance-projection.ts';
import {previewSsotOsFinance,bookingGuardsForVoid,applySsotFinance,
  osFinanceOriginHash,resumeSsotFinance} from '../src/lib/finance-ssot-operations.ts';
import {verifyFinancePreview} from '../src/lib/finance-ssot-preview.server.ts';
import {revenueSummary} from '../src/lib/finance-model.ts';

const uuid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const grant={credentialId:uuid(1),clientId:uuid(2),workspaceId:uuid(3),propertyId:uuid(4),token:'x'.repeat(43)};
const config={grant:{...grant,credentialId:uuid(5)},calendar:{grant,
  propertyKey:'offland',baseUrl:'https://iron-gate-test.example',
  proofSecret:'synthetic-proof-secret-long-enough',mode:'authority',
  expectedAuthorityEpoch:2,expectedInventoryVersion:null,
  expectedSnapshotHash:null,roomIds:{villa:uuid(6)}}};
const actor={id:'synthetic-owner',role:'owner',allProperties:false,
  propertyIds:['offland'],viewPrices:true};
const booking={id:uuid(7),workspaceId:uuid(3),propertyId:uuid(4),version:3,
  status:'confirmed',source:'os',sourceReviewRequired:false,currency:'TWD',
  totalCents:10000,createdAt:'2026-10-28T01:00:00.000Z',
  stays:[{checkIn:'2026-10-28',checkOut:'2026-10-30',roomIds:[uuid(6)]}],
  paymentSummary:{receivedCents:0,refundedCents:0,netReceivedCents:0},
  paymentReview:{status:'unknown',source:'unknown'}};
const page=(bookings,nextCursor=null)=>({propertyId:uuid(4),inventoryVersion:9,
  authorityEpoch:2,readOnly:false,snapshot:null,bookings,nextCursor});
const sender=responses=>{let count=0;return async(url,options)=>{
  assert.equal(options.cache,'no-store');assert.equal(options.method,'GET');
  assert.equal(new URL(url).searchParams.get('from'),null);
  assert.equal(new URL(url).searchParams.get('status'),null);
  const proof=JSON.parse(Buffer.from(options.headers['x-iron-gate-os-proof'].split('.')[0],'base64url').toString());
  assert.equal(proof.propertyId,uuid(4));
  assert.equal(proof.credentialId,grant.credentialId);
  return Response.json(responses[count++]);
};};

test('full Offland reader keeps current/cancelled UUIDs and verifies every page twice',async()=>{
  const cancelled={...booking,id:uuid(8),status:'cancelled'};
  const result=await readSsotBookings(config,actor,sender([
    page([booking],'next'),page([cancelled]),page([booking],'next'),page([cancelled])]));
  assert.equal(result.orders.length,2);
  assert.equal(result.orders[0].id,`IG-${booking.id}`);
  assert.equal(result.orders[0].ssot_booking_version,3);
  assert.equal(result.orders[0].ssot_command_eligible,true);
  assert.equal(result.orders[1].receivable,0);
  assert.equal(result.orders[1].ssot_command_eligible,false);
  assert.match(result.revision,/^[a-f0-9]{64}$/);
});

test('reader rejects wrong property, workspace, epoch, duplicated IDs and looping cursors',async()=>{
  for(const bad of [page([{...booking,propertyId:uuid(90)}]),
    page([{...booking,workspaceId:uuid(90)}]),
    {...page([booking]),authorityEpoch:1},
    {...page([booking]),propertyId:uuid(90)},
    page([booking,booking]),{...page([booking]),readOnly:true}]){
    await assert.rejects(()=>readSsotBookings(config,actor,sender([bad])),
      /FINANCE_SSOT_BOOKING_READ_MISMATCH/);
  }
  await assert.rejects(()=>readSsotBookings(config,actor,sender([
    page([booking],'same'),page([{...booking,id:uuid(8)}],'same')])),
  /FINANCE_SSOT_BOOKING_READ_MISMATCH/);
  await assert.rejects(()=>readSsotBookings(config,actor,sender([
    page([booking],'next'),{...page([{...booking,id:uuid(8)}]),inventoryVersion:10}])),
  /FINANCE_SSOT_BOOKING_READ_MISMATCH/);
  await assert.rejects(()=>readSsotBookings(config,{...actor,propertyIds:['sweetfun']},
    async()=>{throw Error('cross-property request must never be sent');}),/MANUAL_FORBIDDEN/);
});

test('same inventory version cannot hide a booking-only update between scans',async()=>{
  await assert.rejects(()=>readSsotBookings(config,actor,sender([
    page([booking]),page([{...booking,version:4}])])),
  /FINANCE_SSOT_BOOKING_READ_MISMATCH/);
  await assert.rejects(()=>readSsotBookings(config,actor,sender([
    page([booking]),page([])])),/FINANCE_SSOT_BOOKING_READ_MISMATCH/);
});

test('historical/unknown payment coverage cannot become an unpaid zero balance',()=>{
  for(const row of [{...booking,source:'external',sourceCalendar:{platform:'LINE',sourceOrderRef:'Q:SYNTHETIC'}},
    {...booking,sourceReviewRequired:true},
    {...booking,paymentSummary:{receivedCents:2000,refundedCents:2000,netReceivedCents:0}},
    {...booking,totalCents:null}]){
    const order=ssotBookingOrder(row,config);
    assert.equal(order.ssot_payment_coverage,'historical_review_required');
    assert.equal(order.receivable_review_required,true);
    assert.equal(order.ssot_command_eligible,false);
    assert.equal(order.receivable,0);
  }
  assert.equal(ssotBookingOrder({...booking,totalCents:null},config).amount_review_required,true);
  assert.throws(()=>ssotBookingOrder({...booking,stays:[...booking.stays,...booking.stays]},config),
    /FINANCE_SSOT_BOOKING_READ_MISMATCH/);
});

const catalog={accounts:[],categories:[],recurring:[],payout:[],links:[]};
const event=(n,source,amount)=>({id:uuid(n),document_id:uuid(n+1),
  revision_version:1,current_version:1,document_status:'active',
  event_kind:'property_receipt',amount_cents:amount,cash_effect_cents:amount,
  effective_on:'2026-10-28',cash_on:'2026-10-28',category_code:'lodging',
  receipt_purpose:'room',payment_method_code:'cash',source_system:source,
  source_instance_id:uuid(n+2),source_record_id:`synthetic-${n}`,
  actor_ref:'synthetic-owner',created_at:'2026-10-28T01:00:00Z',
  booking_allocations:[{booking_id:booking.id,amount_cents:amount,allocation_kind:'room'}],
  expense_attributions:[]});

test('LINE and OS receipts share one current balance, and cancelled receipt identity survives',()=>{
  const order=ssotBookingOrder(booking,config);
  const events=[event(20,'line_finance',2000),event(30,'os_manual',3000)];
  const entries=entriesFromLedger(events,'offland',[order],catalog);
  const [balance]=projectSsotBookingBalances([order],entries);
  assert.equal(balance.received,5000);assert.equal(balance.receivable,5000);
  assert.equal(entries.length,2);
  assert.ok(entries.every(entry=>entry.order_id===order.id));
  const cancelled=ssotBookingOrder({...booking,status:'cancelled'},config);
  const history=entriesFromLedger(events,'offland',[cancelled],catalog);
  const cancelledOrders=projectSsotBookingBalances([cancelled],history);
  assert.equal(cancelledOrders[0].received,5000);
  assert.equal(cancelledOrders[0].receivable,0);
  assert.equal(revenueSummary(cancelledOrders,history,'2026-10').receivable,0);
  assert.deepEqual(bookingGuardsForVoid(history[1],cancelledOrders),[
    {booking_id:booking.id,expected_booking_version:3}]);
});

test('only explicit SSOT flow can allocate a verified current IG booking without invented alias',async()=>{
  const order=ssotBookingOrder(booking,config);
  const input={request_id:uuid(50),property_id:'offland',year:2026,
    projection_version:'synthetic',expected_version:0,action:'create',
    kind:'income',category:'lodging',amount:25,date:'2026-10-28',
    method:'cash',stage:'balance',description:'Synthetic receipt',platform:'direct',
    allocations:[{order_id:order.id,amount_cents:2500}]};
  assert.throws(()=>validateFinanceLinks(input,[order],[],[],2026,'2026-10-28'),
    /IRON_GATE_DIRECT_PAYMENT_REQUIRED/);
  const report={projection_version:'synthetic',asof:'2026-10-28',
    state:{version:0,entries:[],operations:[]},entries:[],recurring:[],
    orders:[order],payment_accounts:[],payout_rules:[],ssot_catalog:catalog};
  const result=await previewSsotOsFinance(input,report,actor,'offland',2026,[],
    async(_config,_actor,command)=>{
      assert.deepEqual(command.booking_allocations,[{booking_id:booking.id,
        expected_booking_version:3,amount_cents:2500,allocation_kind:'room'}]);
      return {command:{...command,preview_token:'synthetic-ig-preview'},bookings:[{bookingId:booking.id}]};
    },config);
  assert.equal(result.booking_count,1);
  await assert.rejects(()=>previewSsotOsFinance(input,{...report,
    orders:[{...order,ssot_command_eligible:false}]},actor,'offland',2026,[],
  async()=>{throw Error('must not call preview');},config),/IRON_GATE_DIRECT_PAYMENT_REQUIRED/);
});

test('Offland general expense and income need no booking, and category creation reuses Offland grant',async t=>{
  const input={request_id:uuid(60),property_id:'offland',year:2026,
    projection_version:'synthetic',expected_version:0,action:'create',
    kind:'expense',category:'supplies',amount:25,date:'2026-10-28',
    method:'cash',description:'Synthetic supplies'};
  const report={projection_version:'synthetic',asof:'2026-10-28',
    state:{version:0,entries:[],operations:[]},entries:[],recurring:[],
    orders:[],payment_accounts:[],payout_rules:[],ssot_catalog:catalog};
  const preview=await previewSsotOsFinance(input,report,actor,'offland',2026,[],
    async()=>{throw Error('unlinked expense needs no booking preview');},config);
  const income=await previewSsotOsFinance({...input,request_id:uuid(61),kind:'income',
    category:'other'},report,actor,'offland',2026,[],
  async()=>{throw Error('unlinked income needs no booking preview');},config);
  assert.equal(income.booking_count,0);
  const hash=osFinanceOriginHash(input,actor.id,'offland');
  const proof=verifyFinancePreview({...input,ssot_preview_proof:preview.preview_proof},
    actor,'offland',hash,config.calendar.proofSecret);
  const receipts=new Map(),paths=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const path=new URL(url).pathname;paths.push(path);
    assert.ok(path.startsWith(`/v1/properties/${grant.propertyId}/finance/`));
    const signed=JSON.parse(Buffer.from(options.headers['x-iron-gate-os-proof'].split('.')[0],'base64url'));
    assert.equal(signed.credentialId,config.grant.credentialId);
    if(options.method==='POST'){
      const command=JSON.parse(options.body);
      const receipt={receipt_status:'accepted',request_key:command.request_key,
        ...(path.endsWith('/categories')?{category_code:'supplies'}:
          {document_id:uuid(62),origin_request_hash:hash})};
      receipts.set(command.request_key,receipt);return Response.json(receipt,{status:201});
    }
    if(path.includes('/receipts/'))return Response.json(receipts.get(path.split('/').at(-1)));
    if(path.endsWith('/categories'))return Response.json({categories:[
      {kind:'expense',code:'supplies',label:'備品採購',status:'active'}]});
    const key={'accounts':'accounts','recurring-rules':'recurring_rules',
      'payout-rules':'payout_rules','source-links':'source_links'}[path.split('/').at(-1)];
    assert.ok(key);return Response.json({[key]:[]});
  });
  const result=await applySsotFinance(input,report,actor,'offland',2026,[],hash,proof,config);
  assert.equal(result.entry_id,uuid(62));
  assert.ok(paths.some(path=>path.endsWith('/categories')));
  const recovered=await resumeSsotFinance(input,actor,'offland',
    async(resolved,_actor,key)=>{
      assert.equal(resolved.grant.propertyId,grant.propertyId);return receipts.get(key);
    },config);
  assert.equal(recovered.result.entry_id,uuid(62));
  await assert.rejects(()=>resumeSsotFinance(input,actor,'sweetfun',
    async()=>receipts.get(input.request_id),config),/IDEMPOTENCY_CONFLICT/);
});
