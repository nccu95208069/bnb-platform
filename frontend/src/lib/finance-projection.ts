import {createHash} from 'node:crypto';
import type {CalendarBooking} from '../components/calendar/calendar-types';
import {ledgerKey,checkRows} from './os-payments.ts';
import {recurrenceDue,type FinanceEntry,type FinanceOrder,type PayoutRule,type RecurringExpense} from './finance-model.ts';
export function projectOrders(rows:CalendarBooking[],entries:FinanceEntry[],rules:PayoutRule[]){
 const grouped=new Map<string,CalendarBooking[]>();
 for(const b of rows)if(b.reservation_status!=='cancelled')grouped.set(b.order_id,[...(grouped.get(b.order_id)??[]),b]);
 let excluded=0;const orders:FinanceOrder[]=[];
 for(const [id,bookings] of grouped){
  if(bookings.some(b=>b.source_conflict||!Number.isFinite(b.room_rate)||b.room_rate<0)||new Set(bookings.map(b=>b.platform)).size!==1){excluded++;continue;}
  const total=bookings.reduce((s,b)=>s+Math.round(b.room_rate*100),0),platform=bookings[0].platform;
  const check_in=bookings.map(b=>b.check_in).sort()[0],check_out=bookings.map(b=>b.check_out).sort().at(-1)!;
  const key=ledgerKey(bookings[0].property_id,id);
  const received=entries.filter(e=>e.status==='active'&&e.kind==='income'&&e.method!=='ota').reduce((s,e)=>s+(e.order_key===key&&e.category==='lodging'?e.amount_cents:e.allocations?.filter(a=>a.order_id===id).reduce((n,a)=>n+a.amount_cents,0)??0),0);
  let eligible_date:string|null=null;
  if(platform==='agoda'){const d=new Date(check_out+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+30);eligible_date=d.toISOString().slice(0,10);}
  const rule=rules.find(r=>r.platform===platform);
  if(rule?.mode==='monthly'){const d=new Date(check_out+'T00:00:00Z');d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+rule.offset);d.setUTCDate(Math.min(rule.day,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()));eligible_date=d.toISOString().slice(0,10);}
  orders.push({id,calendar_id:bookings[0].id,platform,rooms:[...new Set(bookings.map(b=>b.room_number))],check_in,check_out,total,received,receivable:Math.max(0,total-received),credit:Math.max(0,received-total),eligible_date,source_version:checkRows(bookings,bookings[0].property_id,id).source_version,source_paid:bookings.every(b=>b.payment_status==='paid')});
 }
 return {orders:orders.sort((a,b)=>a.check_in.localeCompare(b.check_in)),excluded};
}
export const projectionVersion=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateFinanceLinks(input:Record<string,unknown>,orders:FinanceOrder[],entries:FinanceEntry[],recurring:RecurringExpense[],_year:number,asof:string){
 if(input.action!=='create')return;
 const allocations=input.allocations;
 if(allocations!==undefined){
  if(!Array.isArray(allocations)||allocations.length>100||input.kind!=='income'||input.category!=='lodging'||input.method==='ota')throw new Error('INVALID_INPUT');
  let sum=0;const seen=new Set<string>();
  for(const a of allocations){if(!a||typeof a.order_id!=='string'||!Number.isSafeInteger(a.amount_cents)||a.amount_cents<=0||seen.has(a.order_id))throw new Error('INVALID_INPUT');seen.add(a.order_id);const order=orders.find(o=>o.id===a.order_id);if(!order||order.platform!==input.platform||a.amount_cents>order.receivable)throw new Error('VERSION_CONFLICT');sum+=a.amount_cents;}
  if(allocations.length&&sum!==Math.round(Number(input.amount)*100))throw new Error('INVALID_INPUT');
 }
 if(input.kind==='income'&&input.category==='lodging'&&(!Array.isArray(allocations)||!allocations.length))throw new Error('ORDER_REQUIRED');
 if(input.recurrence_id!==undefined){const due=recurrenceDue(recurring,entries,Number(String(input.occurrence).slice(0,4)),asof).find(d=>d.rule_id===input.recurrence_id&&d.date===input.occurrence);if(!due||input.kind!=='expense'||input.category!==due.category||Math.round(Number(input.amount)*100)!==due.amount_cents||String(input.date)<due.date)throw new Error('VERSION_CONFLICT');}
 else if(input.occurrence!==undefined)throw new Error('INVALID_INPUT');
}
