import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {retentionFixture} from '../../iron-gate/tests/retained-fixture.mjs';
import {createHandler} from '../../iron-gate/src/http.ts';
import {createOsMemberProofVerifier} from '../../iron-gate/src/os-member-proof.mjs';
import {offlandLegacyLifecycleOrderId,overlayOfflandLegacyFinance,overlayOfflandLegacySummary} from '../src/lib/finance-retained-legacy.ts';
import {projectOrders,validateFinanceLinks} from '../src/lib/finance-projection.ts';
import {emptyRegistry,summarizeOrders} from '../src/lib/finance-summary.ts';
import {summarize,revenueSummary} from '../src/lib/finance-model.ts';
import {financeContext} from '../src/lib/finance-context.ts';
import {OFFLAND_SOURCE} from '../src/lib/booking-sources/config.ts';
import {ledgerKey} from '../src/lib/os-payments.ts';
import {financeKey} from '../src/lib/finance-store.ts';
import {initialState,normalizeRows,HEADERS} from '../src/lib/sheet-monitor/reconcile.ts';
import {adaptSheetBookings} from '../src/lib/booking-sources/sweetfun-sheet.ts';

const bookingId='10000000-0000-4000-8000-000000000001';
const id=offlandLegacyLifecycleOrderId('Q:synthetic-parent');
const row={id:'synthetic-row',sheet_row_id:'synthetic-row',order_id:id,property_id:'offland',
 platform:'direct',room_number:'包棟',room_rate:12000,check_in:'2026-10-30',check_out:'2026-10-31',
 external_order_no:'SYNTH-ORDER',reservation_status:'confirmed',payment_status:'paid'};
const receipt={id:'synthetic-deposit',property_id:'offland',kind:'income',category:'lodging',
 amount_cents:300000,date:'2026-09-01',created_at:'2026-09-01T01:00:00Z',description:'Synthetic deposit',
 method:'bank_transfer',source:'calendar',actor:'synthetic-owner',status:'active',order_key:ledgerKey('offland',id)};
const refund={...receipt,id:'synthetic-refund',kind:'refund',amount_cents:50000,date:'2026-10-01'};
const entries=[receipt,refund];
const originalStays=[{checkIn:'2026-10-30',checkOut:'2026-10-31',roomNumbers:['包棟']}];
const retained={bookingId,version:2,status:'retained',sourceOrderRef:'Q:synthetic-parent',stays:[],
 sourceOrderAliases:['Q:synthetic-parent'],
 totalCents:null,netReceivedCents:null,retainedAmountReviewRequired:true,priceHidden:false,
 retention:{schema:1,lifecycleRevision:1,activeRetentionId:'synthetic-retention',history:[{
 id:'synthetic-retention',retainedAt:'2026-10-29T01:00:00Z',reason:'Synthetic postponement',expiresOn:null,
 previousStays:originalStays,previousTotalCents:1200000}]}};
const base=()=>projectOrders([row],entries,[]).orders;
const summary=(orders,bookings,rows=[row])=>overlayOfflandLegacySummary(
 summarizeOrders('offland',rows,entries,emptyRegistry()),orders,entries,bookings);

test('legacy retained projection preserves original cash identity/month and removes all active stay money',()=>{
 const before=structuredClone(entries),beforeOrders=base();
 const [kept]=overlayOfflandLegacyFinance(beforeOrders,entries,[retained]);
 assert.equal(kept.id,id);assert.equal(kept.status,'retained');assert.deepEqual(kept.rooms,[]);
 assert.equal(kept.check_in,'');assert.equal(kept.check_out,'');assert.equal(kept.received,250000);
 assert.equal(kept.receivable,0);assert.equal(kept.receivable_review_required,true);
 assert.equal(kept.source_paid,false);assert.equal(kept.amount_review_required,true);
 assert.equal(kept.retained_credit_cents,null);assert.equal(kept.retained_credit_review_required,true);
 assert.deepEqual(entries,before);assert.equal(beforeOrders[0].check_in,row.check_in);
 assert.equal(summarize(entries,'2026-09').income,300000);assert.equal(summarize(entries,'2026-10').refund,50000);
 assert.equal(revenueSummary([kept],entries,'2026-10').total,0);
 const current=summary([kept],[retained]).orders[0];
 assert.equal(current.id,id);assert.equal(current.source_amount_cents,null);
 assert.equal(current.outstanding_cents,null);assert.equal(current.receivable_total_cents,null);
 assert.equal(current.can_record,false);assert.equal(current.legacy_status,'');
 assert.deepEqual(current.records.map(record=>[record.id,record.at,record.amount_cents]),[
  ['synthetic-deposit','2026-09-01',300000],['synthetic-refund','2026-10-01',-50000]]);
});

test('rescheduled legacy reports use only new dates/prices and cannot reopen old collection entry points',()=>{
 const current={...retained,status:'confirmed',version:3,totalCents:200000,
  stays:[{checkIn:'2027-02-10',checkOut:'2027-02-12',roomNumbers:['包棟']}]};
 const [order]=overlayOfflandLegacyFinance(base(),entries,[current]);
 assert.equal(order.id,id);assert.equal(order.total,200000);assert.equal(order.check_in,'2027-02-10');
 assert.equal(order.check_out,'2027-02-12');assert.equal(order.received,250000);
 assert.equal(order.source_paid,false);assert.equal(order.receivable_review_required,true);
 assert.equal(order.credit,0);assert.equal(order.receivable,0);
 assert.equal(revenueSummary([order],entries,'2026-10').total,0);
 const projected=summary([order],[current]).orders[0];
 assert.equal(projected.source_amount_cents,200000);assert.equal(projected.outstanding_cents,null);
 assert.equal(projected.customer_payment,'recorded_unverified');assert.equal(projected.can_record,false);
 assert.throws(()=>validateFinanceLinks({action:'create',kind:'income',category:'lodging',method:'cash',
  platform:'direct',amount:10,allocations:[{order_id:id,amount_cents:1000}]},[order],entries,[],2027,'2027-02-01'),
 /IRON_GATE_DIRECT_PAYMENT_REQUIRED|SOURCE_MAPPING_REVIEW_REQUIRED/);
});

test('missing old Sheet row does not orphan verified identity or existing cash records',()=>{
 const [kept]=overlayOfflandLegacyFinance([],entries,[retained]);
 assert.equal(kept.id,id);assert.equal(kept.received,250000);assert.equal(kept.platform,'other');
 const report=summary([kept],[retained],[]);
 assert.equal(report.orders.length,1);assert.equal(report.orders[0].id,id);
 assert.equal(report.orders[0].records.length,2);
});

test('Q and J namespaces are exact, missing/ambiguous identity fails and untouched sources stay unchanged',()=>{
 const j=offlandLegacyLifecycleOrderId('J:synthetic-parent');assert.notEqual(j,id);
 assert.throws(()=>offlandLegacyLifecycleOrderId('Q:synthetic-parent','sweetfun-operations-sheet-v1'),/IDENTITY/);
 assert.throws(()=>overlayOfflandLegacyFinance(base(),entries,[{...retained,sourceOrderRef:null}]),/IDENTITY/);
 assert.throws(()=>overlayOfflandLegacyFinance(base(),entries,[retained,{...retained,bookingId:'another'}]),/IDENTITY/);
 const plain=base();assert.deepEqual(overlayOfflandLegacyFinance(plain,entries,[{...retained,retention:null}]),plain);
 assert.equal(plain[0].source_paid,true);
});

test('known zero is distinct from unknown retained funds; invalid amounts never become spendable credit',()=>{
 for(const amount of [null,undefined,-1,0.5,NaN]){
  const [order]=overlayOfflandLegacyFinance(base(),entries,[{...retained,netReceivedCents:amount,retainedAmountReviewRequired:false}]);
  assert.equal(order.retained_credit_cents,null);
 }
 const [known]=overlayOfflandLegacyFinance(base(),entries,[{...retained,netReceivedCents:0,retainedAmountReviewRequired:false}]);
 assert.equal(known.retained_credit_cents,0);assert.equal(known.retained_credit_review_required,false);
});

test('legacy cash allocations reject duplicate, invalid and overallocated amounts before projecting retained money',()=>{
 const allocation={order_id:id,amount_cents:100000};
 for(const allocations of [[allocation,allocation],
  [{...allocation,amount_cents:0}],[{...allocation,amount_cents:-1}],
  [{...allocation,amount_cents:0.5}],[{...allocation,amount_cents:NaN}],
  [{...allocation,amount_cents:300001}],
  [allocation,{order_id:'another-order',amount_cents:200001}],
  [allocation,{order_id:'another-order',amount_cents:1},{order_id:'another-order',amount_cents:1}]]){
  const bad={...receipt,order_key:undefined,allocations};
  assert.throws(()=>overlayOfflandLegacyFinance(base(),[bad],[retained]),/INVALID_FINANCE_AMOUNT/);
  assert.throws(()=>overlayOfflandLegacySummary({orders:[],retained:[]},
   overlayOfflandLegacyFinance(base(),entries,[retained]),[bad],[retained]),/INVALID_FINANCE_AMOUNT/);
 }
 for(const amount_cents of [0,-1,0.5,NaN])
  assert.throws(()=>overlayOfflandLegacyFinance(base(),[{...receipt,amount_cents}],[retained]),/INVALID_FINANCE_AMOUNT/);
 const doubleLinked={...receipt,allocations:[allocation]};
 assert.throws(()=>overlayOfflandLegacyFinance(base(),[doubleLinked],[retained]),/DUPLICATE_RECEIPT_CONFLICT/);
 const allocated={...receipt,order_key:undefined,allocations:[allocation,{order_id:'another-order',amount_cents:200000}]};
 const [valid]=overlayOfflandLegacyFinance(base(),[allocated,allocated],[retained]);
 assert.equal(valid.received,100000);
 assert.throws(()=>overlayOfflandLegacyFinance(base(),[allocated,{...allocated,amount_cents:400000}],[retained]),/DUPLICATE_RECEIPT_CONFLICT/);
});

test('proven Q/J aliases hide split stale stays while preserving the Q ledger and unrelated same-guest rows',()=>{
 const aliases=['Q:synthetic-parent','J:synthetic-child-a','J:synthetic-child-b'];
 const childIds=aliases.slice(1).map(ref=>offlandLegacyLifecycleOrderId(ref));
 const unrelatedId=offlandLegacyLifecycleOrderId('J:synthetic-unrelated');
 const rows=[...childIds,unrelatedId].map((order_id,index)=>({...row,id:`row-${index}`,
  sheet_row_id:`row-${index}`,order_id,guest_name:'Same synthetic guest'}));
 const childReceipt={...receipt,id:'synthetic-child-receipt',order_key:ledgerKey('offland',childIds[0]),amount_cents:10000};
 const cash=[...entries,childReceipt];
 const booking={...retained,sourceOrderAliases:aliases};
 for(const current of [booking,{...booking,status:'confirmed',version:3,totalCents:400000,
  stays:[{checkIn:'2027-04-04',checkOut:'2027-04-05',roomNumbers:['包棟']}]}]){
  const orders=overlayOfflandLegacyFinance(projectOrders(rows,cash,[]).orders,cash,[current]);
  assert.deepEqual(orders.map(order=>order.id).sort(),[id,unrelatedId].sort());
  assert.equal(orders.find(order=>order.id===id).received,250000);
  const result=overlayOfflandLegacySummary(summarizeOrders('offland',rows,cash,emptyRegistry()),orders,cash,[current]);
  assert.deepEqual(result.orders.map(order=>order.id).sort(),[id,unrelatedId].sort());
  assert.deepEqual(result.orders.find(order=>order.id===id).records.map(record=>record.id),['synthetic-deposit','synthetic-refund']);
  assert.equal(cash.at(-1).order_key,childReceipt.order_key);
 }
 for(const sourceOrderAliases of [undefined,[],['J:synthetic-child-a'],[...aliases,aliases[0]],['Q:synthetic-parent','name:guest']])
  assert.throws(()=>overlayOfflandLegacyFinance(base(),entries,[{...retained,sourceOrderAliases}]),/IDENTITY/);
 assert.throws(()=>overlayOfflandLegacyFinance(base(),entries,[booking,{...retained,bookingId:'second',
  sourceOrderRef:'J:synthetic-child-a',sourceOrderAliases:['J:synthetic-child-a']}]),/IDENTITY/);
});

async function legacyLifecycleFixture(t){
 const f=await retentionFixture(),saved={...process.env};
 t.after(()=>{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
 const grant={credentialId:randomUUID(),clientId:randomUUID(),workspaceId:f.workspaceId,
  propertyId:f.propertyId,token:'x'.repeat(43)},secret='synthetic-retained-finance-proof-secret';
 Object.assign(process.env,{CALENDAR_SOURCE:'sheet_snapshot',SHEET_MONITOR_ENABLED:'true',BOOKING_SHEET_SOURCES:'offland',
  KV_REST_API_URL:'https://redis.invalid',KV_REST_API_TOKEN:'synthetic',
  OS_OFFLAND_FINANCE_SSOT_ENABLED:'false',IRON_GATE_OFFLAND_RETAINED_ENABLED:'true',
  IRON_GATE_OFFLAND_CALENDAR_ENABLED:'true',IRON_GATE_OFFLAND_BASE_URL:'https://ig.invalid',
  IRON_GATE_OFFLAND_AUTHORITY_EPOCH:'1',IRON_GATE_OFFLAND_OS_PROOF_SECRET:secret,
  IRON_GATE_OFFLAND_ROOM_IDS:JSON.stringify({包棟:f.roomId}),
  IRON_GATE_OFFLAND_CALENDAR_GRANT:JSON.stringify(grant),IRON_GATE_OFFLAND_RETAINED_GRANT:JSON.stringify(grant)});
 delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.UPSTASH_REDIS_REST_TOKEN;
 const verifier=createOsMemberProofVerifier(secret),handler=createHandler(f.service,async request=>{
  assert.equal(request.headers.get('authorization'),`Bearer ${grant.token}`);
  const proof=await verifier(request,{...grant,origin:'os'});
  return proof?{clientId:grant.clientId,subjectId:proof.subjectId,origin:'os',workspaceId:f.workspaceId,
   propertyIds:[f.propertyId],authorityEpoch:1,actions:proof.actions,fields:proof.fields}:null;
 });
 const db=new Map(),status={failed:false,writes:0};
 let snapshot;
 const setSheet=raw=>{
  const normalized=normalizeRows([f.snapshot.headers,...raw],OFFLAND_SOURCE);
  snapshot=adaptSheetBookings([HEADERS,...normalized.map(r=>r.cells)],OFFLAND_SOURCE.sourceId,
   '2026-10-29T00:00:00Z',[],normalized.map(r=>r.sourceRow),OFFLAND_SOURCE.property);
  db.set(`offland:sheet-monitor:v1:${OFFLAND_SOURCE.sourceId}:state`,
   'gz1:'+gzipSync(JSON.stringify(initialState(snapshot))).toString('base64'));
 };
 setSheet(f.snapshot.rows.map(r=>r.values));
 db.set(financeKey('offland',2026),JSON.stringify({version:1,entries,operations:[]}));
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  if(String(url).startsWith('https://ig.invalid/'))return status.failed?Response.json({},{status:503}):handler(new Request(url,options));
  assert.equal(String(url),'https://redis.invalid','read-only finance never accesses external room or Sheet providers');
  const command=JSON.parse(options.body);let result=null;
  if(command[0]==='GET')result=db.get(command[1])??null;
  else if(command[0]==='MGET')result=command.slice(1).map(k=>db.get(k)??null);
  else if(command[0]==='SCAN'){const pattern=new RegExp('^'+command[3].replaceAll('*','.*')+'$');result=['0',[...db.keys()].filter(k=>pattern.test(k))];}
  else{status.writes++;throw Error('unexpected finance mutation');}
  return Response.json({result});
 });
 const actor={id:'synthetic-owner',role:'owner',allProperties:false,propertyIds:['offland'],viewPrices:true};
 return {...f,db,status,actor,setSheet,rows:()=>snapshot.bookings,read:()=>financeContext(OFFLAND_SOURCE,2027,false,actor)};
}

test('signed backend finance context hides re-exported J children through retain and reschedule without moving old cash',async t=>{
 const f=await legacyLifecycleFixture(t),initial=await f.read();
 assert.equal(initial.orders.length,2);assert.equal(initial.orders.find(order=>order.id===id).received,250000);
 const originalEntries=structuredClone(initial.entries);
 await f.service.retainBooking(f.owner,f.propertyId,f.bookingId,randomUUID(),await f.retainInput());
 f.setSheet(f.snapshot.rows.map(r=>r.values.map((value,index)=>index===16?'':value)));
 assert.equal(new Set(f.rows().map(row=>row.order_id)).size,3);
 const retainedReport=await f.read(),saved=retainedReport.orders.find(order=>order.id===id);
 assert.equal(retainedReport.orders.length,2);assert.equal(saved.status,'retained');assert.equal(saved.received,250000);
 assert.equal(saved.check_in,'');assert.equal(saved.source_paid,false);assert.equal(saved.retained_credit_cents,null);
 assert.equal(revenueSummary(retainedReport.orders,retainedReport.entries,'2027-01').total,0);
 assert.ok(retainedReport.offland_lifecycle[0].sourceOrderAliases.includes('J:synthetic-child-a'));
 const report=overlayOfflandLegacySummary(summarizeOrders('offland',f.rows(),retainedReport.entries,emptyRegistry()),
  retainedReport.orders,retainedReport.entries,retainedReport.offland_lifecycle);
 assert.equal(report.orders.length,2);assert.equal(report.orders.find(order=>order.id===id).can_record,false);
 await f.service.rescheduleBooking(f.owner,f.propertyId,f.bookingId,randomUUID(),await f.rescheduleInput());
 const after=await f.read(),current=after.orders.find(order=>order.id===id);
 assert.equal(after.orders.length,2);assert.equal(current.status,'confirmed');assert.equal(current.check_in,'2027-04-04');
 assert.equal(current.total,1400000);assert.equal(current.received,250000);assert.equal(current.receivable_review_required,true);
 assert.equal(revenueSummary(after.orders,after.entries,'2027-01').total,0);
 assert.deepEqual(revenueSummary(after.orders,after.entries,'2027-04'),
  {received:250000,receivable:0,total:250000,review_count:1});
 assert.deepEqual(after.entries,originalEntries);assert.notEqual(after.projection_version,retainedReport.projection_version);
 assert.equal(f.status.writes,0);f.status.failed=true;await assert.rejects(f.read());
});

test('independent retained flag fails closed without its grant, while SSOT keeps its own routing',async t=>{
 const saved={...process.env};t.after(()=>{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
 Object.assign(process.env,{IRON_GATE_OFFLAND_RETAINED_ENABLED:'true',OS_OFFLAND_FINANCE_SSOT_ENABLED:'false',CALENDAR_SOURCE:'sheet_snapshot'});
 delete process.env.IRON_GATE_OFFLAND_RETAINED_GRANT;delete process.env.IRON_GATE_OFFLAND_SSOT_FINANCE_GRANT;
 const actor={id:'synthetic-owner',role:'owner',allProperties:false,propertyIds:['offland'],viewPrices:true};
 await assert.rejects(financeContext(OFFLAND_SOURCE,2026,false,actor),/MANUAL_CONFIG_UNAVAILABLE/);
 process.env.OS_OFFLAND_FINANCE_SSOT_ENABLED='true';
 await assert.rejects(financeContext(OFFLAND_SOURCE,2026,false,actor),/FINANCE_SSOT_UNAVAILABLE/);
});
