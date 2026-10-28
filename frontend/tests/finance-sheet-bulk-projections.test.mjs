import test from 'node:test';
import assert from 'node:assert/strict';
import {FINANCE_SHEET_HEADERS,scanFinanceSheet}
  from '../src/lib/finance-sheet-bulk-core.ts';
import {financeSheetProjections,financeSheetProjectionDigest}
  from '../src/lib/finance-sheet-bulk-projections.ts';

const source='10000000-0000-4000-8000-000000000001';
const booking='10000000-0000-4000-8000-000000000002';
const document='10000000-0000-4000-8000-000000000003';
const event=(id,kind,allocation,extra={})=>({id,document_id:document,
  revision_version:1,current_version:1,document_status:'active',
  event_kind:kind,amount_cents:Math.abs(allocation),cash_effect_cents:allocation,
  effective_on:'2026-10-28',cash_on:'2026-10-28',source_system:'sheet_bulk',
  source_instance_id:source,source_record_id:`sheet:SyntheticSheet_0123456789:${booking}`,
  evidence_level:'operator_attested',created_at:'2026-10-28T00:00:00Z',
  booking_allocations:[{booking_id:booking,amount_cents:allocation,
    allocation_kind:'room'}],expense_attributions:[],...extra});

test('read-only finance tabs keep refunds, reversals and costs separate',()=>{
  const scan=scanFinanceSheet([[...FINANCE_SHEET_HEADERS]],'Sweetfun');
  const events=[
    event('10000000-0000-4000-8000-000000000011','property_receipt',10000),
    event('10000000-0000-4000-8000-000000000012','property_refund',2000,
      {cash_effect_cents:-2000}),
    event('10000000-0000-4000-8000-000000000013','reversal',-3000,
      {reversed_kind:'property_receipt'}),
    event('10000000-0000-4000-8000-000000000014','ota_guest_payment_observed',5000,
      {cash_effect_cents:0}),
    event('10000000-0000-4000-8000-000000000015','expense_paid',1200,
      {cash_effect_cents:-1200,category_code:'supplies',
        expense_attributions:[{month:'2026-11-01',amount_cents:1200,
          allocation_policy:'ig_v1_earliest_cent'}]})];
  const tabs=financeSheetProjections(events,scan,'Sweetfun',source);
  assert.deepEqual(tabs[1].rows[1].slice(2,8),
    ['7000','2000','5000','5000','0','1200']);
  assert.equal(tabs[2].rows.length,6);
  assert.equal(tabs[3].rows[1][6],'1200');
  assert.equal(tabs[4].rows.length,6);
  assert.equal(financeSheetProjectionDigest(tabs),financeSheetProjectionDigest(tabs));
});

test('accepted row with an action-only void edit remains visible for review',()=>{
  const scan={rows:[{sheet_row:2,row_id:booking,action:'void',
    sync_status:'accepted'}],issues:[],unassigned:[]};
  const pending=financeSheetProjections([],scan,'Sweetfun',source)[0].rows;
  assert.equal(pending[1][4],'SHEET_PENDING_ACTION');
});
