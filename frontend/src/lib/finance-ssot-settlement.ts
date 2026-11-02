import type {HistoricalSettlementReadback} from './booking-sources/iron-gate-ssot-finance.server.ts';
import type {FinanceOrder,LegacySettlementDisplay} from './finance-model.ts';

const HEX=/^[0-9a-f]{64}$/;
const fail=():never=>{throw Error('FINANCE_SSOT_READBACK_MISMATCH');};

/** A historical disposition changes collection duty, never recorded cash. */
export function applyHistoricalSettlements(orders:FinanceOrder[],
  rows:HistoricalSettlementReadback[],propertyId:string):FinanceOrder[]{
  if(!rows.length)return orders;
  const byBooking=new Map<string,FinanceOrder>();
  for(const order of orders){
    if(!order.booking_id)continue;
    if(byBooking.has(order.booking_id))fail();
    byBooking.set(order.booking_id,order);
  }
  const updates=new Map<string,FinanceOrder>();
  for(const row of rows){
    if(row.property_id!==propertyId)fail();
    const order=byBooking.get(row.booking_id)??fail();
    if(updates.has(order.id))fail();
    if(!HEX.test(order.ssot_source_snapshot_hash??'')||
      !HEX.test(row.sheet_order_source_version??'')||
      !Number.isSafeInteger(order.ssot_booking_version)||
      !['settled_before_cutover_cash_details_unknown','unpaid_at_cutover'].includes(row.status)||
      row.cash_effect_cents!==0)fail();
    const settled=row.status==='settled_before_cutover_cash_details_unknown';
    if(row.collection_hold!==(settled&&!row.review_required)||
      row.historical_cash_detail_missing!==settled||
      !row.review_required && (row.remaining_due_cents===null||
        settled&&row.remaining_due_cents!==0))fail();
    const localMismatch=order.ssot_source_snapshot_hash!==row.source_link_snapshot_hash||
      order.source_version!==row.sheet_order_source_version||
      order.ssot_booking_version!==row.booking_version||
      order.total!==row.booking_total_cents||
      order.received!==row.room_received_cents-row.room_refunded_cents;
    // An unpaid owner decision does not establish who should collect an OTA
    // booking. Preserve the separate payer-responsibility review.
    const review=row.review_required||localMismatch||
      !settled&&order.receivable_review_required===true;
    const collectionHold=settled&&!review;
    const legacy:LegacySettlementDisplay={status:row.status,
      collection_hold:collectionHold,historical_cash_detail_missing:settled,
      review_required:review};
    updates.set(order.id,{...order,legacy_settlement:legacy,
      collection_hold:collectionHold,historical_cash_detail_missing:settled,
      // An inconsistent source never becomes an actionable receivable.
      receivable:review?0:row.remaining_due_cents!,
      receivable_review_required:review,
      // Recorded cash remains the ledger projection, even when due is zero.
      received:order.received});
  }
  return orders.map(order=>updates.get(order.id)??order);
}
