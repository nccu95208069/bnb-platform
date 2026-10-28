import type {FinanceEntry,FinanceOrder} from './finance-model';
import type {FinanceSummaryRow,SummaryRegistry} from './finance-summary';
import {roomCollectionForOrder} from './finance-model.ts';

/** Current IG identities and accepted ledger amounts never fall back to Sheet aliases. */
export function summarizeSsotOrders(property:string,orders:FinanceOrder[],entries:FinanceEntry[],registry:SummaryRegistry){
 if(entries.some(entry=>entry.property_id!==property))throw Error('SOURCE_SCOPE_MISMATCH');
 const seen=new Set<string>();
 const rows:FinanceSummaryRow[]=orders.filter(order=>order.status!=='cancelled').map(order=>{
  if(order.source!=='iron_gate'||!order.booking_id||order.id!==`IG-${order.booking_id}`||seen.has(order.id))
   throw Error('FINANCE_SSOT_READBACK_MISMATCH');
  seen.add(order.id);
  const records=entries.filter(entry=>entry.status==='active'&&['income','refund'].includes(entry.kind))
   .flatMap(entry=>{const amount=roomCollectionForOrder(entry,order.id)*(entry.kind==='refund'?-1:1);
    return amount?[{id:entry.id,amount_cents:amount,method:entry.method,at:entry.date,actor:entry.actor,source:entry.source}]:[];})
   .sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
  const received=records.reduce((sum,row)=>sum+row.amount_cents,0);
  if(received!==order.received||!Number.isSafeInteger(received)||received<0)
   throw Error('FINANCE_SSOT_READBACK_MISMATCH');
  const review=Boolean(order.receivable_review_required||order.amount_review_required||order.status!=='confirmed');
  return {id:order.id,platform:order.platform,rooms:order.rooms,check_in:order.check_in,check_out:order.check_out,
   ota_ids:[],owl_ids:[],row_ids:[order.id],aliases:[`ig:${order.booking_id}`],
   source_amount_cents:order.amount_review_required?null:order.total,
   customer_payment:received>0?'recorded_unverified':'unknown',
   claim:order.platform==='direct'?'not_applicable':'unknown',
   receipt:received>0?'recorded_unverified':'unknown',recorded_received_cents:received,ota_collected_cents:0,
   receivable_total_cents:review?null:order.total,outstanding_cents:review?null:order.receivable,
   legacy_status:'',issues:review?['historical_payment_review_required']:[],records,
   can_record:!review&&order.ssot_command_eligible===true&&order.receivable>0};
 });
 return {orders:rows.sort((a,b)=>a.check_in.localeCompare(b.check_in)||a.id.localeCompare(b.id)),
  retained:registry.orders.filter(order=>!seen.has(order.id))};
}
