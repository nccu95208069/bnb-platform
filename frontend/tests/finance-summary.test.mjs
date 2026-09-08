import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeOrders,captureIdentities,emptyRegistry} from '../src/lib/finance-summary.ts';
import {ledgerKey} from '../src/lib/os-payments.ts';
const row={id:'r1',sheet_row_id:'r1',order_id:'o1',property_id:'sweetfun',platform:'direct',room_number:'101',room_rate:3000,check_in:'2026-09-01',check_out:'2026-09-02',payment_status:'paid',reservation_status:'confirmed',external_order_no:'ota1'};
const entry={id:'e1',property_id:'sweetfun',kind:'income',category:'lodging',amount_cents:100000,date:'2026-09-01',method:'bank_transfer',status:'active',actor:'a',source:'calendar',order_key:ledgerKey('sweetfun','o1')};
const project=(rows=[row],entries=[])=>summarizeOrders('sweetfun',rows,entries,emptyRegistry()).orders;
test('legacy paid never creates cash or confirms totals',()=>{const r=project()[0];assert.equal(r.recorded_received_cents,0);assert.equal(r.receipt,'unknown');assert.equal(r.customer_payment,'unknown');assert.equal(r.outstanding_cents,null);});
test('deposit counted once across nights; amount basis stays unknown',()=>{const r=project([row,{...row,id:'r2',sheet_row_id:'r2',check_in:'2026-09-02'}],[entry,entry])[0];assert.equal(r.recorded_received_cents,100000);assert.equal(r.records.length,1);assert.equal(r.customer_payment,'recorded_unverified');assert.equal(r.receivable_total_cents,null);});
test('Agoda claim independent of guest collection and bank receipt',()=>{const r=project([{...row,platform:'agoda'}],[{...entry,method:'ota'}])[0];assert.equal(r.claim,'legacy_claimed');assert.equal(r.recorded_received_cents,0);assert.equal(r.ota_collected_cents,100000);});
test('payout allocation excludes other property, void and service',()=>{const r=project([row],[{...entry,order_key:undefined,allocations:[{order_id:'o1',amount_cents:40000},{order_id:'o2',amount_cents:60000}]},{...entry,id:'void',status:'void'},{...entry,id:'other',property_id:'offland'},{...entry,id:'service',category:'breakfast'}])[0];assert.equal(r.recorded_received_cents,40000);});
test('conflicting repeated receipt fails closed',()=>assert.throws(()=>project([row],[entry,{...entry,amount_cents:1}]),/DUPLICATE_RECEIPT/));
test('cross-property source rejected',()=>assert.throws(()=>project([{...row,property_id:'offland'}]),/SCOPE/));
test('identity survives date edits and disappearance, retaining old aliases',()=>{const first=captureIdentities(emptyRegistry(),project(),0,'admin','v1','2026-09-08');const amended=project([{...row,external_order_no:'ota2',check_in:'2026-10-01'}]);const second=captureIdentities(first,amended,1,'admin','v2','2026-09-09');assert.equal(second.orders[0].id,'o1');assert.deepEqual(second.orders[0].aliases,['ota:direct:ota1','ota:direct:ota2']);assert.equal(summarizeOrders('sweetfun',[],[],second).retained.length,1);assert.throws(()=>captureIdentities(second,[],1,'a','v3','now'),/VERSION_CONFLICT/);});
test('new id cannot silently take old financial links',()=>{const old=captureIdentities(emptyRegistry(),project(),0,'a','v','now');const next=summarizeOrders('sweetfun',[{...row,order_id:'o2'}],[],old);assert.ok(next.orders[0].issues.includes('identity_conflict'));assert.equal(captureIdentities(old,next.orders,1,'a','v2','now').orders.length,1);});
test('duplicate incoming aliases blocked on both orders',()=>{const rows=project([row,{...row,id:'r2',sheet_row_id:'r2',order_id:'o2'}]);assert.ok(rows.every(r=>r.issues.includes('identity_conflict')));assert.equal(captureIdentities(emptyRegistry(),rows,0,'a','v','now').orders.length,0);});
test('mixed nightly flags never guess claim',()=>{const r=project([{...row,platform:'agoda'},{...row,id:'r2',sheet_row_id:'r2',platform:'agoda',payment_status:'unpaid'}])[0];assert.equal(r.claim,'unknown');});

test('registry CAS persists across reads, rejects stale writes and fails closed on outage',async t=>{
 const {readSummaryRegistry,saveSummaryRegistry}=await import('../src/lib/finance-summary-store.ts');
 process.env.KV_REST_API_URL='https://test.invalid';process.env.KV_REST_API_TOKEN='synthetic';const db=new Map();
 t.mock.method(globalThis,'fetch',async(_,options)=>{const c=JSON.parse(options.body);let result=null;if(c[0]==='GET')result=db.get(c[1])??null;else if(c[0]==='EVAL'){result=(db.get(c[3])??'')===c[4]?1:0;if(result)db.set(c[3],c[5]);}return Response.json({result});});
 const before=await readSummaryRegistry('test');const next=captureIdentities(before.state,project(),0,'admin','fingerprint','2026-09-08');await saveSummaryRegistry('test',before.raw,next);assert.equal((await readSummaryRegistry('test')).state.orders[0].id,'o1');await assert.rejects(()=>saveSummaryRegistry('test',before.raw,next),/VERSION_CONFLICT/);
 t.mock.method(globalThis,'fetch',async()=>Response.json({}, {status:503}));await assert.rejects(()=>readSummaryRegistry('test'),/STORE_UNAVAILABLE/);
});
