import assert from 'node:assert/strict';
import test from 'node:test';
import {mapSsotActivity} from '../src/lib/finance-ssot-audit.ts';
import {overlaySsotCalendarPayments} from '../src/lib/finance-ssot-calendar.ts';

test('accepted revisions become visible operation history without inventing an actor',()=>{
  const events=mapSsotActivity([{id:'doc:2',at:'2026-10-28T02:00:00Z',
    source:'money',action:'amend',ui_action:'expense_updated',actor_ref:'synthetic-operator',target_id:'doc',
    version:2,source_system:'os_manual',event_kind:'expense_paid',
    amount_cents:'1200',safe_description:'Utilities',reason_note:null,
    before_amount_cents:'1000',before_safe_description:'Supplies',
    request_key:null,response:null}], 'sweetfun');
  assert.equal(events[0].action,'expense_updated');
  assert.deepEqual(events[0].changed_fields,['amount_cents','description','event_kind']);
  assert.equal(events[0].actor_name,null);
  assert.equal(events[0].version_before,1);
});

test('calendar payment overlay uses accepted order totals and fails closed for missing links',()=>{
  const booking={id:'row-1',property_id:'sweetfun',order_id:'IG-legacy',
    payment_order_id:'SF-exact',iron_gate_source:'imported',
    reservation_status:'confirmed',payment_status:'paid'};
  const order={id:'SF-exact',total:10000,received:3000,source_paid:false};
  assert.equal(overlaySsotCalendarPayments([booking],[order])[0].payment_status,'deposit');
  assert.throws(()=>overlaySsotCalendarPayments([booking],[]),
    /FINANCE_SSOT_READBACK_MISMATCH/);
});
