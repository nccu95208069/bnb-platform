import test from 'node:test';
import assert from 'node:assert/strict';
import {FINANCE_SHEET_HEADERS,scanFinanceSheet,planFinanceSheetRow,
  financeSheetRequestKey,previewFinanceSheetBatch,verifyFinanceSheetBatch,
  verifyFinanceSheetIgPreview}
  from '../src/lib/finance-sheet-bulk-core.ts';

const id='10000000-0000-4000-8000-000000000001';
const booking='10000000-0000-4000-8000-000000000002';
const sheet='SyntheticSheet_0123456789';
function row(overrides={}){
  const values={row_id:id,base_version:'',action:'create',event_kind:'expense_paid',
    amount_twd:'101',effective_on:'2026-10-28',cash_on:'2026-10-28',service_on:'2026-09-01',
    booking_id:'',category_code:'supplies',receipt_purpose:'',payment_method_code:'cash',
    allocation_start_month:'2026-10',allocation_months:'2',safe_description:'Supplies',
    property_display:'Sweetfun',sync_status:'',error_code:'',accepted_hash:'',event_id:'',
    ...overrides};
  return FINANCE_SHEET_HEADERS.map(key=>values[key]);
}
const scan=(...rows)=>scanFinanceSheet([[...FINANCE_SHEET_HEADERS],...rows],'Sweetfun');

test('Sheet scanner assigns no identity from row position and rejects duplicate or overwritten IDs',()=>{
  const missing=row({row_id:''});
  const result=scan(missing,row(),row());
  assert.equal(result.unassigned.length,1);
  assert.equal(result.unassigned[0].sheet_row,2);
  assert.equal(result.rows.length,1);
  assert.deepEqual(result.issues.map(issue=>issue.code),['SHEET_DUPLICATE_ROW_ID']);
  assert.equal(scan(row({row_id:'',base_version:'1'})).issues[0].code,
    'SHEET_IDENTITY_OVERWRITTEN');
  const blankTemplate=row({row_id:'',amount_twd:'',effective_on:'',cash_on:'',
    service_on:'',booking_id:'',category_code:'',allocation_start_month:'',
    allocation_months:'',safe_description:''});
  assert.equal(scan(blankTemplate).issues.length,0);
  const orphan=[...blankTemplate];orphan[0]=id;
  assert.equal(scan(orphan).issues[0].code,
    'SHEET_ORPHANED_IDENTITY');
});

test('Sheet scanner rejects formula, personal details, wrong property and invalid dates',()=>{
  assert.equal(scan(row({safe_description:'=IMPORTXML("x")'})).issues[0].code,
    'SHEET_CELL_INVALID');
  assert.equal(scan(row({safe_description:'4111 1111 1111 1111'})).issues[0].code,
    'SHEET_ROW_INVALID');
  assert.equal(scan(row({property_display:'Other'})).issues[0].code,
    'SHEET_ROW_INVALID');
  assert.equal(scan(row({cash_on:'2026-02-30'})).issues[0].code,
    'SHEET_DATE_INVALID');
  assert.throws(()=>scanFinanceSheet([['row_id']], 'Sweetfun'),/SHEET_SCHEMA_MISMATCH/);
});

test('expense plan keeps cash month separate and conserves uneven attribution cents',()=>{
  const parsed=scan(row()).rows[0];
  const candidate=planFinanceSheetRow(parsed,null,sheet,null);
  assert.equal(candidate.source_record_id,`sheet:${sheet}:${id}`);
  assert.equal(candidate.source_version,1);
  assert.equal(candidate.request_key,financeSheetRequestKey(sheet,id,1));
  assert.deepEqual(candidate.command.expense_attributions,[
    {month:'2026-10-01',amount_cents:5050,allocation_policy:'ig_v1_earliest_cent'},
    {month:'2026-11-01',amount_cents:5050,allocation_policy:'ig_v1_earliest_cent'}]);
  const hash=parsed.content_hash;
  const accepted=scan(row({base_version:'1',accepted_hash:hash,
    event_id:'10000000-0000-4000-8000-000000000003'})).rows[0];
  const document={source_record_id:`sheet:${sheet}:${id}`,current_version:1,status:'active',
    accepted_hash:hash,event_id:'10000000-0000-4000-8000-000000000003'};
  assert.equal(planFinanceSheetRow(accepted,document,sheet,null),null);
  const amended=scan(row({base_version:'1',action:'amend',accepted_hash:hash,
    event_id:document.event_id,amount_twd:'102'})).rows[0];
  assert.equal(planFinanceSheetRow(amended,document,sheet,null)?.source_version,2);
  assert.throws(()=>planFinanceSheetRow(amended,{...document,current_version:2},sheet,null),
    /SHEET_VERSION_CONFLICT/);
});

test('booking receipt needs a current exact version and void binds the same booking',()=>{
  const source=row({event_kind:'property_receipt',category_code:'',receipt_purpose:'room',
    booking_id:booking,allocation_start_month:'',allocation_months:''});
  const parsed=scan(source).rows[0];
  assert.throws(()=>planFinanceSheetRow(parsed,null,sheet,null),
    /SHEET_BOOKING_REVIEW_REQUIRED/);
  const first=planFinanceSheetRow(parsed,null,sheet,3);
  assert.deepEqual(first.command.booking_allocations,[{booking_id:booking,
    expected_booking_version:3,amount_cents:10100,allocation_kind:'room'}]);
  assert.throws(()=>verifyFinanceSheetIgPreview(first,{...first.command,
    booking_allocations:[{...first.command.booking_allocations[0],
      expected_booking_version:4}],preview_token:'new-token'}),
    /SHEET_PREVIEW_STALE/);
  assert.equal(verifyFinanceSheetIgPreview(first,{...first.command,
    preview_token:'approved-token'}).preview_token,'approved-token');
  const voidRow=scan(row({event_kind:'property_receipt',category_code:'',
    receipt_purpose:'room',booking_id:booking,allocation_start_month:'',allocation_months:'',
    base_version:'1',action:'void',accepted_hash:parsed.content_hash,
    event_id:'10000000-0000-4000-8000-000000000003'})).rows[0];
  const document={source_record_id:`sheet:${sheet}:${id}`,current_version:1,status:'active',
    accepted_hash:parsed.content_hash,event_id:'10000000-0000-4000-8000-000000000003'};
  assert.deepEqual(planFinanceSheetRow(voidRow,document,sheet,3)?.command.booking_guards,
    [{booking_id:booking,expected_booking_version:3}]);
});

test('batch token binds exact row contents and ledger state for selected safe rows',()=>{
  const options={spreadsheetId:sheet,sourceInstanceId:'10000000-0000-4000-8000-000000000004',
    values:[[...FINANCE_SHEET_HEADERS],row()],propertyDisplay:'Sweetfun',
    ledgerEvents:[],bookingVersions:{},secret:'synthetic-hmac-secret-at-least-32-bytes',now:1000};
  const preview=previewFinanceSheetBatch(options);
  assert.equal(preview.safe_rows.length,1);
  assert.deepEqual(verifyFinanceSheetBatch(preview,preview.preview_token,options.secret,[id],2000),
    preview.safe_rows);
  const later=previewFinanceSheetBatch({...options,now:5000});
  assert.deepEqual(verifyFinanceSheetBatch(later,preview.preview_token,options.secret,[id],5000),
    later.safe_rows);
  const changed=previewFinanceSheetBatch({...options,values:[[...FINANCE_SHEET_HEADERS],
    row({amount_twd:'102'})]});
  assert.throws(()=>verifyFinanceSheetBatch(changed,preview.preview_token,
    options.secret,[id],2000),/SHEET_PREVIEW_STALE/);
  assert.throws(()=>verifyFinanceSheetBatch(preview,preview.preview_token,
    options.secret,[id],1_000_000),/SHEET_PREVIEW_STALE/);
  assert.throws(()=>verifyFinanceSheetBatch(preview,preview.preview_token,
    options.secret,[id,id],2000),/SHEET_PREVIEW_INVALID/);
});

test('missing accepted row is reported without recreating its payment',()=>{
  const sourceInstanceId='10000000-0000-4000-8000-000000000004';
  const accepted=scan(row()).rows[0];
  const ledger=[{id:'10000000-0000-4000-8000-000000000003',
    source_instance_id:sourceInstanceId,source_system:'sheet_bulk',
    source_record_id:`sheet:${sheet}:${id}`,current_version:1,revision_version:1,
    document_status:'active',event_kind:'expense_paid',
    evidence_ref:`sheet:${accepted.content_hash}`}];
  const preview=previewFinanceSheetBatch({spreadsheetId:sheet,sourceInstanceId,
    values:[[...FINANCE_SHEET_HEADERS]],propertyDisplay:'Sweetfun',ledgerEvents:ledger,
    bookingVersions:{},secret:'synthetic-hmac-secret-at-least-32-bytes'});
  assert.equal(preview.safe_rows.length,0);
  assert.equal(preview.issues[0].code,'SHEET_MISSING_ACCEPTED_ROW');
});

test('voided Sheet document keeps its original event as evidence but cannot reimport',()=>{
  const sourceInstanceId='10000000-0000-4000-8000-000000000004';
  const initial=scan(row()).rows[0];
  const oldEvent='10000000-0000-4000-8000-000000000003';
  const ledger=[{id:oldEvent,source_instance_id:sourceInstanceId,
    source_system:'sheet_bulk',source_record_id:`sheet:${sheet}:${id}`,
    current_version:2,revision_version:1,document_status:'void',
    event_kind:'expense_paid',evidence_ref:`sheet:${initial.content_hash}`}];
  const projected=row({base_version:'2',action:'void',accepted_hash:initial.content_hash,
    event_id:oldEvent});
  const preview=previewFinanceSheetBatch({spreadsheetId:sheet,sourceInstanceId,
    values:[[...FINANCE_SHEET_HEADERS],projected],propertyDisplay:'Sweetfun',
    ledgerEvents:ledger,bookingVersions:{},
    secret:'synthetic-hmac-secret-at-least-32-bytes'});
  assert.equal(preview.safe_rows.length,0);
  assert.equal(preview.issues.length,0);
});

test('booking version change invalidates the batch approval even when Sheet cells are unchanged',()=>{
  const source=row({event_kind:'property_receipt',category_code:'',receipt_purpose:'room',
    booking_id:booking,allocation_start_month:'',allocation_months:''});
  const common={spreadsheetId:sheet,sourceInstanceId:'10000000-0000-4000-8000-000000000004',
    values:[[...FINANCE_SHEET_HEADERS],source],propertyDisplay:'Sweetfun',
    ledgerEvents:[],secret:'synthetic-hmac-secret-at-least-32-bytes',now:1000};
  const original=previewFinanceSheetBatch({...common,bookingVersions:{[booking]:3}});
  const changed=previewFinanceSheetBatch({...common,bookingVersions:{[booking]:4}});
  assert.throws(()=>verifyFinanceSheetBatch(changed,original.preview_token,
    common.secret,[id],2000),/SHEET_PREVIEW_STALE/);
});
