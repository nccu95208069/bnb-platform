import test from 'node:test';
import assert from 'node:assert/strict';
import {projectOrders,validateFinanceLinks} from '../src/lib/finance-projection.ts';
import {recurrenceDue,revenueSummary} from '../src/lib/finance-model.ts';
import {ledgerKey,paymentStatus,prepareReceipt,financeAllocated} from '../src/lib/os-payments.ts';
import {applyFinance} from '../src/lib/finance-store.ts';
const actor={id:'admin',displayName:'測試',role:'admin',viewPrices:true,allProperties:false,propertyIds:['sweetfun']};
const row={id:'row-1',order_id:'order-1',property_id:'sweetfun',room_number:'101',platform:'direct',check_in:'2026-09-20',check_out:'2026-09-21',room_rate:3000,payment_status:'unknown',reservation_status:'confirmed'};
const entry={id:'receipt',property_id:'sweetfun',kind:'income',category:'lodging',amount_cents:100000,date:'2026-08-30',description:'訂金',method:'bank_transfer',source:'calendar',status:'active',order_key:ledgerKey('sweetfun','order-1')};
const rule={id:'rec',year:2026,category:'internet',amount_cents:100000,description:'',method:'bank_transfer',start:'2026-01-01',end:null,day:31,actor:'test',created_at:'2026-01-01T00:00:00Z'};
const empty=()=>({version:0,entries:[],operations:[]});
const request={request_id:'00000000-0000-4000-8000-000000000001',expected_version:0};
test('3000 future stay with 1000 deposit shows 1000 received + 2000 receivable; across receipt month',()=>{
 const {orders}=projectOrders([row],[entry],[]);assert.equal(orders[0].received,100000);assert.equal(orders[0].receivable,200000);
 assert.deepEqual(revenueSummary(orders,[entry],'2026-09'),{received:100000,receivable:200000,total:300000});assert.equal(revenueSummary(orders,[entry],'2026-08').total,0);
});
test('retired stays and Sheet done do not invent bank receipts; OTA receipts remain receivable',()=>{
 const {orders}=projectOrders([{...row,platform:'agoda',check_in:'2026-01-01',check_out:'2026-01-02',payment_status:'paid'}],[{...entry,method:'ota',amount_cents:300000}],[]);
 assert.equal(orders[0].receivable,300000);assert.equal(orders[0].received,0);assert.equal(orders[0].eligible_date,'2026-02-01');
});
test('Agoda actual payout allocations count once, regardless of claim eligible date or OTA receipt',()=>{
 const income={...entry,id:'payout',order_key:undefined,source:'manual',amount_cents:300000,allocations:[{order_id:row.order_id,amount_cents:300000}],date:'2027-01-05'};
 const {orders}=projectOrders([{...row,platform:'agoda'}],[income,{...entry,method:'ota',amount_cents:300000}],[]);
 assert.equal(orders[0].received,300000);assert.equal(orders[0].receivable,0);assert.equal(revenueSummary(orders,[income],'2026-09').total,300000);assert.equal(revenueSummary(orders,[income],'2027-01').total,0);
});
test('monthly payout expected date clamps short months; date does not create cash',()=>{
 const {orders}=projectOrders([{...row,platform:'ctrip',check_out:'2026-01-31'}],[],[{platform:'ctrip',mode:'monthly',offset:1,day:31}]);assert.equal(orders[0].eligible_date,'2026-02-28');assert.equal(orders[0].received,0);
});
test('group nightly rows once; invalid/conflicted orders excluded, cancelled excluded',()=>{
 const {orders,excluded}=projectOrders([row,{...row,id:'row-2',check_in:'2026-09-21',check_out:'2026-09-22',room_rate:1000},{...row,order_id:'bad',source_conflict:true},{...row,order_id:'cancel',reservation_status:'cancelled'}],[],[]);assert.equal(orders.length,1);assert.equal(orders[0].total,400000);assert.equal(excluded,1);
});
test('allocation validates scope, sum, outstanding, unique order, methods, and missing order',()=>{
 const {orders}=projectOrders([row],[entry],[]);const input={action:'create',kind:'income',category:'lodging',method:'bank_transfer',platform:'direct',amount:1000,allocations:[{order_id:row.order_id,amount_cents:100000}]};
 assert.doesNotThrow(()=>validateFinanceLinks(input,orders,[],[],2026,'2026-09-08'));
 for(const patch of [{amount:999},{platform:'agoda'},{method:'ota'},{allocations:[{order_id:'other-property',amount_cents:100000}]},{allocations:[{order_id:row.order_id,amount_cents:300000}]},{allocations:[...input.allocations,...input.allocations]},{allocations:[]}])assert.throws(()=>validateFinanceLinks({...input,...patch},orders,[],[],2026,'2026-09-08'));
});
test('recurrence produces due only through today, clamps dates, retains overdue, excludes paid and reverses void',()=>{
 const due=recurrenceDue([rule],[],2026,'2026-03-01');assert.deepEqual(due.map(d=>d.date),['2026-01-31','2026-02-28']);
 const paid={...entry,kind:'expense',recurrence_id:'rec',occurrence:'2026-01-31'};assert.equal(recurrenceDue([rule],[paid],2026,'2026-03-01').length,1);assert.equal(recurrenceDue([rule],[{...paid,status:'void'}],2026,'2026-03-01').length,2);
 assert.equal(recurrenceDue([{...rule,stopped_at:'2026-02-01'}],[],2026,'2026-05-01').length,1);
});
test('previous-year recurrence can be paid this year once',()=>{
 const old={...rule,start:'2025-12-01',year:2025};const input={action:'create',kind:'expense',category:'internet',amount:1000,date:'2026-01-03',recurrence_id:'rec',occurrence:'2025-12-31'};
 assert.doesNotThrow(()=>validateFinanceLinks(input,[],[],[old],2026,'2026-01-03'));assert.throws(()=>validateFinanceLinks(input,[],[{...entry,recurrence_id:'rec',occurrence:'2025-12-31'}],[old],2026,'2026-01-03'),/VERSION_CONFLICT/);
});
test('recurrence storage audits creator, idempotent retry and stop; no cash entry until payment',()=>{
 const input={...request,action:'recurring_create',category:'internet',amount:1000,description:'',method:'bank_transfer',start:'2026-09-01',end:null,day:10};const a=applyFinance(empty(),input,actor,'sweetfun',2026,'2026-09-08T00:00:00Z');assert.equal(a.state.entries.length,0);assert.equal(a.state.recurring.length,1);assert.equal(applyFinance(a.state,input,actor,'sweetfun',2026).state.recurring.length,1);
 const b=applyFinance(a.state,{...request,request_id:'00000000-0000-4000-8000-000000000002',expected_version:1,action:'recurring_stop',rule_id:a.entry_id},actor,'sweetfun',2026,'2026-09-08T00:00:00Z');assert.equal(b.state.recurring[0].stopped_at,'2026-09-08');assert.equal(b.state.operations.length,2);
});
test('finance room allocation participates in calendar status and overpayment checks',()=>{
 const receipts=[{id:'deposit',payment_type:'deposit',payment_method:'bank_transfer',amount:1000}];const check={property_id:'sweetfun',order_id:'order-1',total:3000,source_paid:false,source_version:'v',ledger:{version:0,receipts},finance_received:2000};assert.equal(paymentStatus(check),'paid');assert.equal(paymentStatus({...check,finance_received:500}),'deposit');
 const input={...request,amount:1,payment_type:'deposit',payment_method:'bank_transfer',received_at:'2026-09-08T00:00:00Z',note:'',settles_room:false,source_version:'v'};assert.throws(()=>prepareReceipt(input,check,actor,'2026-09-08T00:01:00Z'),/AMOUNT_EXCEEDS_TOTAL/);assert.equal(financeAllocated([{allocations:[{order_id:'order-1',amount_cents:200000}]}],'order-1'),2000);
});

test('whole booking across two rooms and two nights totals all four rows; deposit reduces suggested collection once',()=>{
 const rows=['101','102'].flatMap(room=>['2026-09-20','2026-09-21'].map((date,i)=>({...row,id:`${room}-${date}`,room_number:room,room_id:room,check_in:date,check_out:i?'2026-09-22':'2026-09-21',room_rate:1000})));
 const full=projectOrders(rows,[],[]).orders[0];assert.equal(full.total,400000);assert.equal(full.receivable,400000);assert.equal(full.check_out,'2026-09-22');assert.deepEqual(full.rooms,['101','102']);
 const partial=projectOrders(rows,[entry],[]).orders[0];assert.equal(partial.received,100000);assert.equal(partial.receivable,300000);
});
