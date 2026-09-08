import {createHash} from 'node:crypto';
import type {CalendarBooking} from '../components/calendar/calendar-types';
import type {FinanceEntry} from './finance-model';
import {ledgerKey} from './os-payments.ts';

export type SettlementStatus = 'unknown' | 'recorded_unverified' | 'partial' | 'complete' | 'unpaid';
export type OrderIdentity = {id:string; aliases:string[]; row_ids:string[]; first_seen:string; last_seen:string};
export type SummaryRegistry = {schema:1; version:number; orders:OrderIdentity[]; audits:{version:number; actor:string; at:string; source_version:string}[]};
export const emptyRegistry = ():SummaryRegistry => ({schema:1,version:0,orders:[],audits:[]});
export type FinanceSummaryRow = {
 id:string; platform:string; rooms:string[]; check_in:string; check_out:string;
 ota_ids:string[]; owl_ids:string[]; row_ids:string[]; aliases:string[];
 source_amount_cents:number|null; customer_payment:SettlementStatus;
 claim:'unknown'|'not_applicable'|'legacy_claimed'|'legacy_unclaimed';
 receipt:SettlementStatus; recorded_received_cents:number; ota_collected_cents:number;
 receivable_total_cents:number|null; outstanding_cents:number|null;
 legacy_status:string; issues:string[]; records:{id:string; amount_cents:number; method:string; at:string; actor:string; source:string}[];
};
const unique=(items:string[])=>[...new Set(items.filter(Boolean))].sort();
export const summaryVersion=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// M1 is a conservative projection. Legacy H never creates a receipt or confirms a total.
export function summarizeOrders(property:string,rows:CalendarBooking[],entries:FinanceEntry[],registry:SummaryRegistry){
 const groups=new Map<string,CalendarBooking[]>();
 for(const row of rows){if(row.property_id!==property)throw new Error('SOURCE_SCOPE_MISMATCH');if(row.reservation_status==='cancelled')continue;groups.set(row.order_id,[...(groups.get(row.order_id)??[]),row]);}
 const result:FinanceSummaryRow[]=[];
 for(const [id,bookings] of groups){
  const platform=bookings[0].platform;
  const ota_ids=unique(bookings.map(b=>b.external_order_no??'')),owl_ids=unique(bookings.map(b=>b.owlnest_order_no??''));
  const row_ids=unique(bookings.map(b=>b.sheet_row_id||b.id));
  const aliases=unique([...ota_ids.map(v=>`ota:${platform}:${v}`),...owl_ids.map(v=>`owl:${v}`)]);
  const issues:string[]=[];
  if(bookings.some(b=>b.source_conflict)||new Set(bookings.map(b=>b.platform)).size!==1||row_ids.length!==bookings.length)issues.push('source_conflict');
  if(!aliases.length)issues.push('external_id_missing');
  if(registry.orders.some(o=>o.id!==id&&(o.aliases.some(a=>aliases.includes(a))||o.row_ids.some(r=>row_ids.includes(r)))))issues.push('identity_conflict');
  const seen=new Map<string,FinanceEntry>();
  for(const e of entries.filter(e=>e.property_id===property&&e.kind==='income'&&e.category==='lodging'&&e.status==='active')){
   if(seen.has(e.id)&&JSON.stringify(seen.get(e.id))!==JSON.stringify(e))throw new Error('DUPLICATE_RECEIPT_CONFLICT');seen.set(e.id,e);
  }
  const records=[...seen.values()].flatMap(e=>{
   const direct=e.order_key===ledgerKey(property,id);
   const allocated=(e.allocations??[]).filter(a=>a.order_id===id);
   if(allocated.length>1||(e.allocations??[]).some(a=>!Number.isSafeInteger(a.amount_cents)||a.amount_cents<=0)||(e.allocations??[]).reduce((s,a)=>s+a.amount_cents,0)>e.amount_cents)throw new Error('INVALID_FINANCE_AMOUNT');
   if(direct&&allocated.length)throw new Error('DUPLICATE_RECEIPT_CONFLICT');
   const amount=direct?e.amount_cents:allocated.reduce((s,a)=>s+a.amount_cents,0);
   if(!amount)return [];
   if(!Number.isSafeInteger(amount)||amount<0)throw new Error('INVALID_FINANCE_AMOUNT');
   return [{id:e.id,amount_cents:amount,method:e.method,at:e.date,actor:e.actor,source:e.source}];
  }).sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
  const received=records.filter(r=>r.method!=='ota').reduce((s,r)=>s+r.amount_cents,0);
  const ota=records.filter(r=>r.method==='ota').reduce((s,r)=>s+r.amount_cents,0);
  const statuses=unique(bookings.map(b=>b.source_payment_flag==='not_yet'?'unpaid':b.payment_status));
  const source_amount=bookings.reduce((s,b)=>s+Math.round(b.room_rate*100),0);
  if(bookings.some(b=>!Number.isFinite(b.room_rate)||b.room_rate<0)||!Number.isSafeInteger(source_amount))issues.push('amount_invalid');
  // Without verified customer/settlement totals, positive evidence is recorded_unverified; even partial cannot be asserted.
  result.push({id,platform,rooms:unique(bookings.map(b=>b.room_number)),check_in:bookings.map(b=>b.check_in).sort()[0],check_out:bookings.map(b=>b.check_out).sort().at(-1)!,ota_ids,owl_ids,row_ids,aliases,
   source_amount_cents:issues.includes('amount_invalid')||issues.includes('source_conflict')?null:source_amount,
   customer_payment:platform==='direct'&&received>0||ota>0?'recorded_unverified':'unknown',
   claim:platform==='direct'?'not_applicable':property==='sweetfun'&&platform==='agoda'&&statuses.length===1?(statuses[0]==='paid'?'legacy_claimed':statuses[0]==='unpaid'?'legacy_unclaimed':'unknown'):'unknown',
   receipt:received>0?'recorded_unverified':'unknown',recorded_received_cents:received,ota_collected_cents:ota,
   receivable_total_cents:null,outstanding_cents:null,legacy_status:statuses.join('/'),issues:[...issues,'amount_basis_unconfirmed'],records});
 }
 // Duplicate aliases within the same incoming batch cannot auto-merge separate ledgers.
 for(const row of result)if(result.some(other=>other.id!==row.id&&(other.aliases.some(a=>row.aliases.includes(a))||other.row_ids.some(r=>row.row_ids.includes(r))))&&!row.issues.includes('identity_conflict'))row.issues.push('identity_conflict');
 const active=new Set(result.map(r=>r.id));
 const retained=registry.orders.filter(o=>!active.has(o.id));
 return {orders:result.sort((a,b)=>a.check_in.localeCompare(b.check_in)||a.id.localeCompare(b.id)),retained};
}
export function captureIdentities(registry:SummaryRegistry,rows:FinanceSummaryRow[],expected:number,actor:string,sourceVersion:string,at:string):SummaryRegistry{
 if(registry.version!==expected)throw new Error('VERSION_CONFLICT');
 const orders=registry.orders.map(o=>({...o,aliases:[...o.aliases],row_ids:[...o.row_ids]}));
 for(const row of rows){
  if(row.issues.includes('identity_conflict')||row.issues.includes('source_conflict'))continue;
  const old=orders.find(o=>o.id===row.id);
  if(old){old.aliases=unique([...old.aliases,...row.aliases]);old.row_ids=unique([...old.row_ids,...row.row_ids]);old.last_seen=at;}
  else orders.push({id:row.id,aliases:row.aliases,row_ids:row.row_ids,first_seen:at,last_seen:at});
 }
 return {schema:1,version:registry.version+1,orders,audits:[...registry.audits,{version:registry.version+1,actor,at,source_version:sourceVersion}]};
}
