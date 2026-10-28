import {createHash} from 'node:crypto';
import type {RetainedBookingDetail} from './booking-sources/retained-booking-contract';
import type {FinanceEntry,FinanceOrder} from './finance-model';
import type {FinanceSummaryRow,OrderIdentity} from './finance-summary';
import {roomCollectionForOrder,verifiedRetainedCredit} from './finance-model.ts';
import {ledgerKey} from './os-payments.ts';

const SOURCE_ID='offland-operations-sheet-v1';
const fail=():never=>{throw Error('OFFLAND_LIFECYCLE_IDENTITY_REQUIRED');};

/** Match the original Sheet adapter's Q parent/J row identity; names never join ledgers. */
export function offlandLegacyLifecycleOrderId(sourceOrderRef:string|null,sourceId=SOURCE_ID){
 if(sourceId!==SOURCE_ID||typeof sourceOrderRef!=='string'||
  !/^(?:Q:[A-Za-z0-9-]{8,128}|J:[A-Za-z0-9_-]{8,100})$/.test(sourceOrderRef))return fail();
 const identity=sourceOrderRef.startsWith('J:')?`ungrouped:${sourceOrderRef.slice(2)}`:sourceOrderRef.slice(2);
 return `SF-${createHash('sha256').update(`${sourceId}:order:${identity}`).digest('hex').slice(0,20)}`;
}

function lifecycleMap(bookings:RetainedBookingDetail[],sourceId:string){
 const map=new Map<string,RetainedBookingDetail>();
 const sourceOwners=new Map<string,string>();
 const bookingIds=new Set<string>();
 for(const booking of bookings){
  if(!booking.retention?.history.length)continue;
  const id=offlandLegacyLifecycleOrderId(booking.sourceOrderRef,sourceId);
  if(map.has(id)||bookingIds.has(booking.bookingId)||booking.priceHidden||
   !Number.isSafeInteger(booking.version)||booking.version<1)return fail();
  const aliases=booking.sourceOrderAliases;
  if(!Array.isArray(aliases)||aliases.length>4097||new Set(aliases).size!==aliases.length||
   !aliases.includes(booking.sourceOrderRef!))return fail();
  for(const alias of aliases){
   const aliasId=offlandLegacyLifecycleOrderId(alias,sourceId);
   if(sourceOwners.has(aliasId))return fail();
   sourceOwners.set(aliasId,id);
  }
  map.set(id,booking);bookingIds.add(booking.bookingId);
 }
 return {managed:map,sourceOwners};
}

function legacyCashRecords(id:string,entries:FinanceEntry[]){
 const seen=new Map<string,FinanceEntry>();
 const key=ledgerKey('offland',id);
 for(const entry of entries){
  if(entry.property_id!=='offland'||entry.status!=='active'||
   !['income','refund'].includes(entry.kind))continue;
  const allocations=entry.allocations??[];
  const allocationTotal=allocations.reduce((sum,allocation)=>sum+allocation.amount_cents,0);
  if(new Set(allocations.map(allocation=>allocation.order_id)).size!==allocations.length||
   allocations.some(allocation=>!Number.isSafeInteger(allocation.amount_cents)||allocation.amount_cents<=0)||
   !Number.isSafeInteger(allocationTotal)||allocationTotal>entry.amount_cents)throw Error('INVALID_FINANCE_AMOUNT');
  const direct=entry.order_key===key&&entry.category==='lodging';
  const allocated=roomCollectionForOrder(entry,id);
  if(!direct&&!allocated)continue;
  if(direct&&entry.allocations?.some(allocation=>allocation.order_id===id))throw Error('DUPLICATE_RECEIPT_CONFLICT');
  const previous=seen.get(entry.id);
  if(previous&&JSON.stringify(previous)!==JSON.stringify(entry))throw Error('DUPLICATE_RECEIPT_CONFLICT');
  seen.set(entry.id,entry);
 }
 return [...seen.values()].map(entry=>{
  const amount=(entry.order_key===key&&entry.category==='lodging'?entry.amount_cents:roomCollectionForOrder(entry,id))*(entry.kind==='refund'?-1:1);
  if(!Number.isSafeInteger(entry.amount_cents)||entry.amount_cents<=0||
   !Number.isSafeInteger(amount)||!amount)throw Error('INVALID_FINANCE_AMOUNT');
  return {id:entry.id,amount_cents:amount,method:entry.method,at:entry.date,actor:entry.actor,source:entry.source};
 }).sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
}

/** Lifecycle ownership changes the stay projection, never the old cash IDs or dates. */
export function overlayOfflandLegacyFinance(orders:FinanceOrder[],entries:FinanceEntry[],
 bookings:RetainedBookingDetail[],sourceId=SOURCE_ID):FinanceOrder[]{
 const {managed,sourceOwners}=lifecycleMap(bookings,sourceId);
 const prior=new Map(orders.map(order=>[order.id,order]));
 if(prior.size!==orders.length)throw Error('OFFLAND_LIFECYCLE_IDENTITY_REQUIRED');
 // Proven source aliases hide stale child projections; cash stays on the original root ID.
 const result=orders.filter(order=>!sourceOwners.has(order.id));
 for(const [id,booking] of managed){
  const old=prior.get(id);
  if(old?.booking_id&&old.booking_id!==booking.bookingId)return fail();
  const active=booking.status==='confirmed';
  if(active&&!booking.stays.length||booking.status==='retained'&&booking.stays.length)throw Error('OFFLAND_LIFECYCLE_STATE_INVALID');
  const amountKnown=active&&Number.isSafeInteger(booking.totalCents)&&Number(booking.totalCents)>=0;
  const records=legacyCashRecords(id,entries);
  const received=records.filter(record=>record.method!=='ota').reduce((sum,record)=>sum+record.amount_cents,0);
  if(!Number.isSafeInteger(received))throw Error('INVALID_FINANCE_AMOUNT');
  const credit=verifiedRetainedCredit({retained_credit_cents:booking.netReceivedCents,
   retained_credit_review_required:booking.retainedAmountReviewRequired});
  result.push({...old,id,calendar_id:active?`ig-${booking.bookingId}-0-${booking.stays[0].roomNumbers[0]}`:old?.calendar_id??`IG-${booking.bookingId}`,
   booking_id:booking.bookingId,source:'iron_gate',status:booking.status,
   ssot_booking_version:booking.version,ssot_command_eligible:false,
   ssot_payment_coverage:'historical_review_required',
   platform:old?.platform??'other',
   rooms:active?[...new Set(booking.stays.flatMap(stay=>stay.roomNumbers))].sort():[],
   check_in:active?booking.stays.map(stay=>stay.checkIn).sort()[0]:'',
   check_out:active?booking.stays.map(stay=>stay.checkOut).sort().at(-1)!:'',
   total:amountKnown?booking.totalCents!:0,amount_review_required:!amountKnown,
   received,receivable:0,receivable_review_required:true,credit:0,source_paid:false,eligible_date:null,
   amount_reconciliation:undefined,
   ...(booking.status==='retained'?{retained_credit_cents:credit,retained_credit_review_required:credit===null}:
    {retained_credit_cents:undefined,retained_credit_review_required:undefined}),
   source_version:createHash('sha256').update(JSON.stringify([id,booking.bookingId,booking.version,
    booking.status,booking.stays,booking.totalCents,booking.retention,booking.sourceOrderAliases])).digest('hex')});
 }
 return result.sort((a,b)=>a.check_in.localeCompare(b.check_in)||a.id.localeCompare(b.id));
}

/** The summary retains the same identity/receipts while dropping stale Sheet stay and paid flags. */
export function overlayOfflandLegacySummary(summary:{orders:FinanceSummaryRow[];retained:OrderIdentity[]},
 orders:FinanceOrder[],entries:FinanceEntry[],bookings:RetainedBookingDetail[],sourceId=SOURCE_ID){
 const {managed,sourceOwners}=lifecycleMap(bookings,sourceId);
 const result=summary.orders.filter(row=>!sourceOwners.has(row.id));
 for(const [id,booking] of managed){
  const order=orders.find(candidate=>candidate.id===id);
  if(!order||order.booking_id!==booking.bookingId||order.status!==booking.status)return fail();
  if(order.status==='cancelled')continue;
  const old=summary.orders.find(row=>row.id===id);
  const records=legacyCashRecords(id,entries);
  const received=records.filter(record=>record.method!=='ota').reduce((sum,record)=>sum+record.amount_cents,0);
  const ota=records.filter(record=>record.method==='ota').reduce((sum,record)=>sum+record.amount_cents,0);
  if(!Number.isSafeInteger(received)||!Number.isSafeInteger(ota))throw Error('INVALID_FINANCE_AMOUNT');
  const retained=order.status==='retained';
  const credit=retained?verifiedRetainedCredit(order):null;
  result.push({id,status:order.status,platform:order.platform,rooms:order.rooms,
   check_in:order.check_in,check_out:order.check_out,
   ota_ids:old?.ota_ids??[],owl_ids:old?.owl_ids??[],row_ids:old?.row_ids??[],
   aliases:[...new Set([...(old?.aliases??[]),`ig:${booking.bookingId}`])].sort(),
   source_amount_cents:order.amount_review_required?null:order.total,
   customer_payment:received>0||ota>0?'recorded_unverified':'unknown',
   claim:order.platform==='direct'?'not_applicable':'unknown',
   receipt:received>0?'recorded_unverified':'unknown',recorded_received_cents:received,ota_collected_cents:ota,
   receivable_total_cents:null,outstanding_cents:null,legacy_status:'',
   issues:[...new Set([...(old?.issues.filter(issue=>issue==='identity_conflict')??[]),
    retained?'retained_stay_unassigned':'historical_payment_review_required',
    ...(retained&&credit===null?['retained_credit_review_required']:[]),
    ...(order.amount_review_required&&!retained?['amount_basis_unconfirmed']:[])])],
   records,can_record:false,
   ...(retained?{retained_credit_cents:credit,retained_credit_review_required:credit===null}:{})});
 }
 const active=new Set(result.map(row=>row.id));
 return {orders:result.sort((a,b)=>a.check_in.localeCompare(b.check_in)||a.id.localeCompare(b.id)),
  retained:summary.retained.filter(identity=>!active.has(identity.id))};
}
