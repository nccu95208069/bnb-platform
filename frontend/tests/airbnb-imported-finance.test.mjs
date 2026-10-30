import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {importedAmountFixture} from '../../iron-gate/tests/airbnb-imported-amount-fixture.mjs';
import {MemoryPropertyRepository} from '../../iron-gate/src/memory-repository.ts';
import {IronGateService} from '../../iron-gate/src/service.ts';
import {createHandler} from '../../iron-gate/src/http.ts';
import {createOsMemberProofVerifier} from '../../iron-gate/src/os-member-proof.mjs';
import {financeContext} from '../src/lib/finance-context.ts';
import {SWEETFUN_SOURCE,OFFLAND_SOURCE} from '../src/lib/booking-sources/config.ts';
import {initialState,HEADERS} from '../src/lib/sheet-monitor/reconcile.ts';
import {adaptSheetBookings} from '../src/lib/booking-sources/sweetfun-sheet.ts';
import {financeKey} from '../src/lib/finance-store.ts';
import {checkedFinanceCorrections} from '../src/lib/booking-sources/iron-gate-finance.server.ts';
import {ironGateCalendarConfig,offlandIronGateCalendarConfig,readSweetfunIronGatePaymentOrder,readSweetfunIronGateCalendarSnapshot,readSourceAmountSnapshot} from '../src/lib/booking-sources/iron-gate-calendar.server.ts';
import {ledgerKey} from '../src/lib/os-payments.ts';

async function fixture(t,property,cancelled=false){
 const f=importedAmountFixture({property,...(cancelled?{cancelled:true,nights:1,rooms:1}:{})});
 const source=property==='sweetfun'?SWEETFUN_SOURCE:OFFLAND_SOURCE,secret='synthetic-amount-snapshot-proof-key';
 const roomIds=property==='sweetfun'?Object.fromEntries(['101','102','201','202','301','302'].map(r=>[r,f.roomIds[r]??randomUUID()])):f.roomIds;
 f.corrected.roomIds=Object.values(roomIds);
 const grant={credentialId:randomUUID(),clientId:randomUUID(),workspaceId:f.state.workspaceId,propertyId:f.state.propertyId,token:'x'.repeat(43)};
 const prefix=`IRON_GATE_${property.toUpperCase()}`;
 const before={...process.env};Object.assign(process.env,{CALENDAR_SOURCE:'sheet_snapshot',SHEET_MONITOR_ENABLED:'true',BOOKING_SHEET_SOURCES:property,
  KV_REST_API_URL:'https://redis.invalid',KV_REST_API_TOKEN:'test',IRON_GATE_SWEETFUN_CALENDAR_ENABLED:property==='sweetfun'?'true':'false',
  IRON_GATE_SWEETFUN_FINANCE_ENABLED:property==='sweetfun'?'true':'false',IRON_GATE_OFFLAND_CALENDAR_ENABLED:property==='offland'?'true':'false',
  IRON_GATE_SWEETFUN_OS_PROOF_SECRET:secret,[`${prefix}_BASE_URL`]:'https://ig.invalid',[`${prefix}_AUTHORITY_EPOCH`]:'1',
  [`${prefix}_ROOM_IDS`]:JSON.stringify(roomIds),[`${prefix}_CALENDAR_GRANT`]:JSON.stringify(grant),
  IRON_GATE_SWEETFUN_FINANCE_GRANT:JSON.stringify(grant)});
 delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.UPSTASH_REDIS_REST_TOKEN;
 t.after(()=>{for(const k of Object.keys(process.env))if(!(k in before))delete process.env[k];Object.assign(process.env,before);});
 const repo=new MemoryPropertyRepository();repo.seed(f.corrected);const service=new IronGateService(repo),verifier=createOsMemberProofVerifier(secret);
 const handler=createHandler(service,async req=>{
  if(req.headers.get('authorization')!==`Bearer ${grant.token}`)return null;
  const proof=await verifier(req,{...grant,origin:'os'});
  return proof?{clientId:grant.clientId,subjectId:proof.subjectId,origin:'os',workspaceId:grant.workspaceId,
   propertyIds:[grant.propertyId],authorityEpoch:1,actions:proof.actions,fields:proof.fields}:null;
 });
 const rows=f.state.bookings.map(b=>b[`${property}Snapshot`].rows[0].values);
 const snapshot=adaptSheetBookings([HEADERS,...rows],source.sourceId,new Date().toISOString(),[],[],source.property);
 const db=new Map([[`${property}:sheet-monitor:v1:${source.sourceId}:state`,'gz1:'+gzipSync(JSON.stringify(initialState(snapshot))).toString('base64')]]);
 const owner={id:'synthetic-owner',role:'owner',allProperties:false,propertyIds:[property],viewPrices:true};
 const config=property==='sweetfun'?ironGateCalendarConfig():offlandIronGateCalendarConfig();
 const status={failed:false,mutations:0};
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  if(String(url).startsWith('https://ig.invalid/'))return status.failed?Response.json({},{status:503}):handler(new Request(url,options));
  assert.equal(String(url),'https://redis.invalid','no unrelated provider or Sheet access');
  const command=JSON.parse(options.body);let result=null;
  if(command[0]==='GET')result=db.get(command[1])??null;
  else if(command[0]==='MGET')result=command.slice(1).map(k=>db.get(k)??null);
  else if(command[0]==='SCAN'){const pattern=new RegExp('^'+command[3].replaceAll('*','.*')+'$');result=['0',[...db.keys()].filter(k=>pattern.test(k))];}
  else{status.mutations++;throw Error('unexpected ledger write');}
  return Response.json({result});
 });
 return {...f,source,repo,service,db,owner,config,status,read:()=>financeContext(source,2026,false,owner)};
}
for(const property of ['sweetfun','offland'])test(`${property}: full finance context joins nightly corrections to original orders and preserves actual receipts`,async t=>{
 const f=await fixture(t,property),first=await f.read();assert.equal(first.orders.length,f.corrected.bookings.length);
 const expected=f.targets[0].amount.groupNetCents;
 assert.equal(first.orders.reduce((s,o)=>s+o.total,0),expected);assert.equal(first.entries.length,0);
 assert.ok(first.orders.every(o=>o.received===0&&!o.source_paid&&o.status==='confirmed'&&o.id.startsWith('SF-')));
 const cal=await readSweetfunIronGateCalendarSnapshot('2026-01-01','2026-01-03',f.owner,f.config);
 assert.equal(cal.bookings.reduce((s,b)=>s+b.room_rate*100,0),expected);
 assert.ok(cal.bookings.every(b=>b.source_amount_reconciliation.schema===2));
 const target=first.orders[0],payment=await readSweetfunIronGatePaymentOrder(target.amount_reconciliation.bookingId,f.owner,f.config);
 assert.equal(payment.paymentOrderId,target.id);assert.equal(payment.totalCents,target.total);
 const entry={id:randomUUID(),property_id:property,kind:'income',category:'lodging',amount_cents:10000,date:'2026-01-01',
  description:'Synthetic previously verified receipt',method:'bank_transfer',source:'manual',actor:'synthetic',created_at:'2026-01-01T00:00:00Z',
  status:'active',order_id:target.id,order_key:ledgerKey(property,target.id),platform:'airbnb'};
 f.db.set(financeKey(property,2026),JSON.stringify({version:1,entries:[entry],operations:[]}));
 const after=await f.read(),updated=after.orders.find(o=>o.id===target.id);
 assert.equal(updated.received,10000);assert.equal(updated.receivable,target.total-10000);assert.equal(after.entries.length,1);
 assert.equal(f.status.mutations,0);assert.ok((await f.repo.read(f.state.propertyId)).bookings.every(b=>b.paymentEvents.length===0));
 const raw=await readSourceAmountSnapshot(f.owner,f.config),manual={calendar:f.config,grant:f.config.grant};
 for(const mutate of [r=>r.sourceAmountReconciliations.pop(),r=>r.sourceAmountReconciliations[0].sourceProperty=property==='offland'?'sweetfun':'offland',
  r=>r.sourceAmountReconciliations[0].groupNetCents++,r=>r.sourceAmountReconciliations[0].roomId=randomUUID()]){
  const bad=structuredClone(raw);mutate(bad);assert.throws(()=>checkedFinanceCorrections(bad.sourceAmountReconciliations,manual));
 }
 await assert.rejects(readSourceAmountSnapshot({...f.owner,propertyIds:[]},f.config));
 await assert.rejects(readSourceAmountSnapshot({...f.owner,viewPrices:false},f.config));
 f.status.failed=true;await assert.rejects(f.read());
});

test('cancelled imported order remains auditable with zero due and no fabricated receipt/refund',async t=>{
 const f=await fixture(t,'offland',true),report=await f.read();assert.equal(report.orders.length,1);
 assert.equal(report.orders[0].status,'cancelled');assert.equal(report.orders[0].total,0);assert.equal(report.orders[0].receivable,0);assert.equal(report.orders[0].received,0);
 assert.equal(report.entries.length,0);assert.equal(f.status.mutations,0);
 const cal=await readSweetfunIronGateCalendarSnapshot('2026-01-01','2026-01-02',f.owner,f.config);assert.equal(cal.bookings.length,0);
});

test('Offland corrected Airbnb order retains historical cohort evidence while legacy reports follow current lifecycle',async t=>{
 const f=await fixture(t,'offland'),initial=await f.read(),booking=f.corrected.bookings[0];
 const original=initial.orders.find(o=>o.amount_reconciliation.bookingId===booking.id);
 const entry={id:randomUUID(),property_id:'offland',kind:'income',category:'lodging',amount_cents:10000,
  date:'2026-01-01',description:'Synthetic original deposit',method:'cash',source:'manual',actor:'synthetic',
  created_at:'2026-01-01T00:00:00Z',status:'active',order_id:original.id,order_key:ledgerKey('offland',original.id),platform:'airbnb'};
 f.db.set(financeKey('offland',2026),JSON.stringify({version:1,entries:[entry],operations:[]}));
 Object.assign(process.env,{IRON_GATE_OFFLAND_RETAINED_ENABLED:'true',
  IRON_GATE_OFFLAND_RETAINED_GRANT:JSON.stringify(f.config.grant)});
 const principal={clientId:f.config.grant.clientId,subjectId:f.owner.id,origin:'os',workspaceId:f.state.workspaceId,
  propertyIds:[f.state.propertyId],authorityEpoch:1,actions:['booking:read','booking:amend'],
  fields:['guest_name','contact','notes','money','payment_status']};
 const preview=await f.service.previewRetainBooking(principal,f.state.propertyId,booking.id,{reason:'Synthetic postponed stay'});
 await f.service.retainBooking(principal,f.state.propertyId,booking.id,randomUUID(),{
  reason:'Synthetic postponed stay',expectedBookingVersion:preview.bookingVersion,expectedInventoryVersion:preview.inventoryVersion});
 const snapshot=await readSourceAmountSnapshot(f.owner,f.config);
 const historical=snapshot.sourceAmountReconciliations.find(row=>row.bookingId===booking.id);
 assert.equal(historical.historicalOnly,true);assert.equal(historical.status,'retained');
 assert.equal(checkedFinanceCorrections(snapshot.sourceAmountReconciliations,{calendar:f.config,grant:f.config.grant}).length,
  f.corrected.bookings.length);
 const retained=await f.read(),saved=retained.orders.find(o=>o.id===original.id);
 assert.equal(saved.status,'retained');assert.equal(saved.check_in,'');assert.equal(saved.receivable,0);
 assert.equal(saved.received,10000);assert.equal(saved.retained_credit_cents,null);
 assert.equal(retained.entries[0].id,entry.id);assert.equal(retained.entries[0].date,entry.date);
 const proposal={reason:'Synthetic replacement dates',stays:[{checkIn:'2027-03-20',checkOut:'2027-03-21',roomIds:[historical.roomId]}],
  totalCents:400000,roomNightPrices:[{roomId:historical.roomId,date:'2027-03-20',amountCents:400000}]};
 const next=await f.service.previewRescheduleBooking(principal,f.state.propertyId,booking.id,proposal);
 await f.service.rescheduleBooking(principal,f.state.propertyId,booking.id,randomUUID(),{...proposal,
  expectedBookingVersion:next.bookingVersion,expectedInventoryVersion:next.inventoryVersion});
 const after=await f.read(),current=after.orders.find(o=>o.id===original.id);
 assert.equal(current.status,'confirmed');assert.equal(current.check_in,'2027-03-20');assert.equal(current.total,400000);
 assert.equal(current.received,10000);assert.equal(current.source_paid,false);assert.equal(current.receivable_review_required,true);
 assert.equal(after.entries.length,1);assert.equal(after.entries[0].id,entry.id);assert.equal(f.status.mutations,0);
 const detail=await f.service.getBooking(principal,f.state.propertyId,booking.id);
 assert.equal(detail.sourceAmountReconciliation,undefined);
});
