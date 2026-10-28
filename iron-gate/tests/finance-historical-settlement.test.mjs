import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createHandler } from '../src/http.ts';
import { bookingSnapshotHash, historicalSettlementProjection,
  parseHistoricalManifest } from '../src/finance-historical-settlement.mjs';

const propertyId=randomUUID();
const sourceInstanceId=randomUUID();
const hex=value=>createHash('sha256').update(value).digest('hex');
const bookings=Array.from({length:4},(_,index)=>({
  id:randomUUID(),propertyId,version:index+1,status:'confirmed',source:'external',
  sourceCalendar:null,totalCents:10000+index*1000,currency:'TWD',
  paymentEvents:[],cardChargeResults:[],
}));
function manifest() {
  return {property_id:propertyId,source_instance_id:sourceInstanceId,
    full_os_snapshot_hash:hex('os'),owner_decision_hash:hex('owner'),
    sheet_snapshot_hash:hex('sheet'),rows:bookings.map((booking,index)=>({
      booking_id:booking.id,booking_version:booking.version,
      booking_snapshot_hash:bookingSnapshotHash(booking),
      booking_total_cents:booking.totalCents,source_order_key:`order-${index}`,
      source_link_snapshot_hash:hex(`link-${index}`),
      os_receipt_id:`receipt-${index}`,os_receipt_version:'1',
      os_receipt_snapshot_hash:hex(`receipt-${index}`),
      sheet_row_snapshot_hash:hex(`sheet-row-${index}`),
      sheet_order_source_version:hex(`sheet-order-version-${index}`),
      money_aliases_hash:hex(`aliases-${index}`),
      os_receipt_amount_cents:0,os_settles_room:true,
      decision:index===3?'unpaid_at_cutover':
        'settled_before_cutover_cash_details_unknown',
    }))};
}
function pinned(value) {
  const bytes=Buffer.from(JSON.stringify(value));
  return parseHistoricalManifest(bytes,createHash('sha256').update(bytes).digest('hex'));
}

test('private manifest is exactly four zero-cash receipt decisions with a pinned digest',()=>{
  const original=manifest();
  const parsed=pinned(original);
  assert.equal(parsed.rows.length,4);
  assert.equal(parsed.rows[3].decision,'unpaid_at_cutover');
  const bytes=Buffer.from(JSON.stringify(original));
  assert.throws(()=>parseHistoricalManifest(bytes,hex('wrong')),
    /HISTORICAL_MANIFEST_HASH_MISMATCH/);
  const nonzero=manifest();
  nonzero.rows[0].os_receipt_amount_cents=100;
  assert.throws(()=>pinned(nonzero),/HISTORICAL_MANIFEST_INVALID/);
  const duplicate=manifest();
  duplicate.rows[3].booking_id=duplicate.rows[0].booking_id;
  assert.throws(()=>pinned(duplicate),/HISTORICAL_MANIFEST_INVALID/);
  const flipped=manifest();
  flipped.rows[3].decision=flipped.rows[0].decision;
  assert.throws(()=>pinned(flipped),/HISTORICAL_MANIFEST_INVALID/);
  const unknownField=manifest();
  unknownField.rows[0].cash_on='2026-10-28';
  assert.throws(()=>pinned(unknownField),/HISTORICAL_MANIFEST_INVALID/);
  const missingSheetVersion=manifest();
  delete missingSheetVersion.rows[0].sheet_order_source_version;
  assert.throws(()=>pinned(missingSheetVersion),/HISTORICAL_MANIFEST_INVALID/);
  const malformedSheetVersion=manifest();
  malformedSheetVersion.rows[0].sheet_order_source_version='booking:3';
  assert.throws(()=>pinned(malformedSheetVersion),/HISTORICAL_MANIFEST_INVALID/);
});

test('settled projection holds collection without inventing received cash',()=>{
  const booking=bookings[0];
  const disposition={id:randomUUID(),decision:'settled_before_cutover_cash_details_unknown',
    booking_version:booking.version,booking_total_cents:booking.totalCents,
    booking_snapshot_hash:bookingSnapshotHash(booking)};
  const result=historicalSettlementProjection(disposition,booking,null,0,false);
  assert.equal(result.remaining_due_cents,0);
  assert.equal(result.collection_hold,true);
  assert.equal(result.historical_cash_detail_missing,true);
  assert.equal(result.legacy_settlement.cash_effect_cents,0);
  assert.equal(result.legacy_settlement.status,disposition.decision);
  assert.equal(result.review_required,false);
  assert.equal(historicalSettlementProjection(disposition,booking,null,1,false)
    .review_required,true);
  const changed={...booking,version:booking.version+1};
  assert.equal(historicalSettlementProjection(disposition,changed,null,0,false)
    .remaining_due_cents,null);
  assert.equal(historicalSettlementProjection(disposition,changed,null,0,false)
    .collection_hold,true);
});

test('unpaid projection preserves exact operational due and flags changed booking',()=>{
  const booking=bookings[3];
  const disposition={id:randomUUID(),decision:'unpaid_at_cutover',
    booking_version:booking.version,booking_total_cents:booking.totalCents,
    booking_snapshot_hash:bookingSnapshotHash(booking)};
  const result=historicalSettlementProjection(disposition,booking,booking.totalCents,0,false);
  assert.equal(result.remaining_due_cents,booking.totalCents);
  assert.equal(result.collection_hold,false);
  assert.equal(result.historical_cash_detail_missing,false);
  assert.equal(result.review_required,false);
  const uncertain=historicalSettlementProjection(disposition,booking,null,0,false);
  assert.equal(uncertain.remaining_due_cents,null);
  assert.equal(uncertain.review_required,true);
  assert.equal(historicalSettlementProjection(disposition,
    {...booking,totalCents:booking.totalCents+1},booking.totalCents,0,false)
    .review_required,true);
});

test('historical routes forward pinned read and private command/receipt',async()=>{
  const principal={origin:'finance',propertyIds:[propertyId],actions:['finance:read','finance:import']};
  const calls=[];
  const finance={
    historicalSettlementPreview:async(...args)=>{calls.push(['preview',args]);return {ok:true};},
    historicalSettlementCommit:async(...args)=>{calls.push(['commit',args]);return {ok:true};},
    historicalSettlementReceipt:async(...args)=>{calls.push(['receipt',args]);return {ok:true};},
    historicalSettlements:async(...args)=>{calls.push(['list',args]);return {legacy_settlements:[]};},
  };
  const handle=createHandler({},async()=>principal,undefined,finance);
  const base=`http://local/v1/properties/${propertyId}/finance/historical-settlements`;
  const input={request_key:'historical-1',booking_id:bookings[0].id,
    source_order_key:'order-0',decision:'settled_before_cutover_cash_details_unknown',
    manifest_sha256:hex('manifest')};
  for (const [path,method] of [['/preview','preview'],['','commit']]) {
    const response=await handle(new Request(base+path,{method:'POST',
      headers:{'content-type':'application/json','idempotency-key':'historical-1'},
      body:JSON.stringify(input)}));
    assert.equal(response.status,method==='preview'?200:201);
    assert.deepEqual(calls.at(-1),[method,[principal,propertyId,input,'historical-1']]);
  }
  const receipt=await handle(new Request(`${base}/receipts/historical-1`));
  assert.equal(receipt.status,200);
  assert.deepEqual(calls.at(-1),['receipt',[principal,propertyId,'historical-1']]);
  const listed=await handle(new Request(`${base}?as_of_change_seq=42`));
  assert.equal(listed.status,200);
  assert.deepEqual(calls.at(-1),['list',[principal,propertyId,42]]);
});
