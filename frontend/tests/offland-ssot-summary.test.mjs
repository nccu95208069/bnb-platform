import assert from 'node:assert/strict';
import test from 'node:test';
import {summarizeSsotOrders} from '../src/lib/finance-ssot-summary.ts';
import {emptyRegistry} from '../src/lib/finance-summary.ts';
import {overlaySsotCalendarPayments} from '../src/lib/finance-ssot-calendar.ts';
const uuid='11111111-1111-4111-8111-111111111111',id=`IG-${uuid}`;
const order={id,booking_id:uuid,source:'iron_gate',status:'confirmed',platform:'direct',
 rooms:['包棟'],check_in:'2026-11-01',check_out:'2026-11-02',total:300000,
 received:100000,receivable:200000,ssot_command_eligible:true};
const receipt={id:'r1',property_id:'offland',status:'active',kind:'income',category:'lodging',
 amount_cents:120000,method:'bank_transfer',date:'2026-10-28',actor:'operator',source:'iron_gate',
 allocations:[{order_id:id,allocation_kind:'room',amount_cents:120000}]};
const refund={...receipt,id:'r2',kind:'refund',amount_cents:20000,
 allocations:[{order_id:id,allocation_kind:'room',amount_cents:20000}]};
const booking={id:'night',property_id:'offland',order_id:id,payment_order_id:'legacy-identity',
 iron_gate_booking_id:uuid,iron_gate_source:'external',payment_status:'paid',reservation_status:'confirmed'};
test('Offland summary uses stable IG identity and canonical net room cash including refunds',()=>{
 const result=summarizeSsotOrders('offland',[order],[receipt,refund],emptyRegistry()).orders[0];
 assert.equal(result.id,id);assert.deepEqual(result.aliases,[`ig:${uuid}`]);
 assert.equal(result.recorded_received_cents,100000);assert.equal(result.outstanding_cents,200000);
 assert.equal(result.records.length,2);assert.equal(result.can_record,true);
});
test('unknown imported history preserves real cash but never invents unpaid balances',()=>{
 const reviewed={...order,receivable:0,receivable_review_required:true,ssot_command_eligible:false};
 const row=summarizeSsotOrders('offland',[reviewed],[receipt,refund],emptyRegistry()).orders[0];
 assert.equal(row.recorded_received_cents,100000);assert.equal(row.outstanding_cents,null);
 assert.equal(row.receivable_total_cents,null);assert.equal(row.can_record,false);
 assert.equal(overlaySsotCalendarPayments([booking],[reviewed],'offland')[0].payment_status,'unknown');
});
test('calendar resolves canonical IG UUID rather than stale payment alias and rejects cross-property rows',()=>{
 assert.equal(overlaySsotCalendarPayments([booking],[order],'offland')[0].payment_status,'deposit');
 assert.throws(()=>overlaySsotCalendarPayments([{...booking,property_id:'sweetfun'}],[order],'offland'),/MISMATCH/);
 assert.throws(()=>overlaySsotCalendarPayments([booking],[],'offland'),/MISMATCH/);
});
test('cash/identity/scope mismatches fail closed and cancelled identities remain retained',()=>{
 assert.throws(()=>summarizeSsotOrders('offland',[order],[receipt],emptyRegistry()),/MISMATCH/);
 assert.throws(()=>summarizeSsotOrders('offland',[order],[{...receipt,property_id:'sweetfun'}],emptyRegistry()),/SCOPE/);
 assert.throws(()=>summarizeSsotOrders('offland',[order,order],[receipt,refund],emptyRegistry()),/MISMATCH/);
 const registry={...emptyRegistry(),orders:[{id,aliases:[`ig:${uuid}`],row_ids:[id]}]};
 const result=summarizeSsotOrders('offland',[{...order,status:'cancelled'}],[receipt,refund],registry);
 assert.equal(result.orders.length,0);assert.equal(result.retained.length,1);
});
