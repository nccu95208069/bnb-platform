import {auditSnapshot,changedFields,type FinanceAuditEvent} from './finance-audit.ts';
import {manualFinanceEntries} from './finance-store.ts';
import type {FinanceEntry} from './finance-model.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { CalendarBooking, PaymentRecord } from '../components/calendar/calendar-types';
import { redisCommand } from './workspace-auth/store.ts';
import type { Principal } from './workspace-auth/types.ts';

export type Receipt = PaymentRecord & { audit?:FinanceAuditEvent; actor: string; actor_name: string; note: string; settles_room: boolean; request_id: string; request_hash: string; mission_id: string; source_version: string };
export type Ledger = { version: number; receipts: Receipt[] };
export type OrderCheck = { property_id: string; order_id: string; source_version: string; total: number; rooms: string[]; nights: number; source_paid: boolean; finance_received?:number; ledger: Ledger };
export const emptyLedger = (): Ledger => ({ version: 0, receipts: [] });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function canRecord(actor: Principal, property: string) {
  return actor.viewPrices && ['owner','god','admin','housekeeper'].includes(actor.role) && (actor.allProperties || actor.propertyIds.includes(property));
}
export function checkRows(rows: CalendarBooking[], property: string, order: string, ledger = emptyLedger()): OrderCheck {
  const matches = rows.filter(b => b.property_id === property && b.order_id === order);
  if (!matches.length) throw new Error('NOT_FOUND');
  if (matches.some(b => b.source_conflict || b.reservation_status === 'cancelled')) throw new Error('SOURCE_CONFLICT');
  return { property_id: property, order_id: order,
    source_version: digest(matches.map(b => [b.id,b.room_id,b.check_in,b.check_out,b.room_rate,b.payment_status]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))),
    total: matches.reduce((s,b)=>s+Math.round(b.room_rate*100),0)/100,
    rooms: [...new Set(matches.map(b=>b.room_number))], nights: matches.length,
    source_paid: matches.every(b=>b.payment_status==='paid'), ledger };
}
export function paymentStatus(check: OrderCheck): CalendarBooking['payment_status'] {
  const recordedRoomCents=Math.max(Math.round((check.finance_received??0)*100)+check.ledger.receipts.filter(r=>r.payment_method!=='ota'&&r.payment_type!=='other').reduce((s,r)=>s+Math.round(r.amount*100),0),check.ledger.receipts.filter(r=>r.payment_type!=='other').reduce((sum,r)=>sum+Math.round(r.amount*100),0));
  if (check.source_paid || (check.total>0 && recordedRoomCents>=Math.round(check.total*100)) || check.ledger.receipts.some(r=>r.settles_room && r.source_version===check.source_version)) return 'paid';
  if ((check.finance_received??0)>0||check.ledger.receipts.some(r=>r.payment_type!=='other')) return 'deposit';
  return 'unknown';
}
export function prepareReceipt(input: Record<string, unknown>, check: OrderCheck, actor: Principal, now = new Date().toISOString()): Receipt {
  if(!canRecord(actor,check.property_id)) throw new Error('FORBIDDEN');
  const {amount,payment_type,payment_method,received_at,note,request_id,settles_room} = input;
  if(typeof amount!=='number'||!Number.isFinite(amount)||amount<=0||amount>10000000||Math.abs(amount*100-Math.round(amount*100))>0.00001 ||
    !['deposit','balance','other','full'].includes(String(payment_type)) || !['cash','bank_transfer','credit_card','ota','other'].includes(String(payment_method)) ||
    typeof received_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(received_at)||!Number.isFinite(Date.parse(received_at))||Date.parse(received_at)>Date.parse(now)+60000 ||
    typeof request_id!=='string'||! /^[a-f0-9-]{36}$/.test(request_id)||typeof note!=='string'||note.length>500||typeof settles_room!=='boolean'||(settles_room&&!['balance','full'].includes(String(payment_type)))) throw new Error('INVALID_INPUT');
  if(['balance','full'].includes(String(payment_type)) && !settles_room) throw new Error('INVALID_INPUT');
  const request_hash=digest([actor.id,amount,payment_type,payment_method,received_at,note,settles_room]);
  const existing=check.ledger.receipts.find(r=>r.request_id===request_id);
  if(existing) { if(existing.request_hash!==request_hash)throw new Error('IDEMPOTENCY_CONFLICT');return existing; }
  if(input.expected_version!==check.ledger.version||input.source_version!==check.source_version)throw new Error('VERSION_CONFLICT');
  if(payment_type!=='other' && Math.max(check.ledger.receipts.filter(r=>r.payment_type!=='other').reduce((sum,r)=>sum+Math.round(r.amount*100),0),Math.round((check.finance_received??0)*100)+check.ledger.receipts.filter(r=>r.payment_type!=='other'&&r.payment_method!=='ota').reduce((sum,r)=>sum+Math.round(r.amount*100),0))+Math.round(amount*100)>Math.round(check.total*100))throw new Error('AMOUNT_EXCEEDS_TOTAL');
  if(check.ledger.receipts.length>=1000)throw new Error('LEDGER_FULL');
  const receipt:Receipt={id:randomUUID(),amount,payment_type:payment_type as Receipt['payment_type'],payment_method:payment_method as Receipt['payment_method'],received_at,created_at:now,
    actor:actor.id,actor_name:actor.displayName,note,settles_room,request_id,request_hash,mission_id:randomUUID(),source_version:check.source_version};
  const after=auditSnapshot(receipt);
  receipt.audit={schema_version:1,id:request_id,request_id,property_id:check.property_id,action:'calendar_payment_recorded',actor_id:actor.id,actor_name:actor.displayName,actor_email:actor.email??null,actor_role:actor.role,at:now,source:'calendar',result:'succeeded',target_type:'receipt',target_id:receipt.id,before:null,after:{...after,order_id:check.order_id},changed_fields:changedFields(null,{...after,order_id:check.order_id}),version_before:check.ledger.version,version_after:check.ledger.version+1,source_version:check.source_version,completeness:'complete'};
  return receipt;
}
export const ledgerKey=(property:string,order:string)=>`sweetfun-os:payments:v1:${property}:${digest(order)}`;
export async function readLedger(property:string,order:string):Promise<{raw:string|null;ledger:Ledger}> {
  const raw=await redisCommand(['GET',ledgerKey(property,order)]);
  if(raw===null)return {raw:null,ledger:emptyLedger()};
  if(typeof raw!=='string')throw new Error('STORE_UNAVAILABLE');
  const ledger=JSON.parse(raw) as Ledger;
  if(!Number.isSafeInteger(ledger.version)||!Array.isArray(ledger.receipts))throw new Error('STORE_UNAVAILABLE');
  return {raw,ledger};
}
export const APPEND_PAYMENT = "if #KEYS>2 and redis.call('GET',KEYS[3])~=ARGV[4] then return 0 end; local old=redis.call('GET',KEYS[1]); if (old or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); redis.call('SET',KEYS[2],ARGV[3]); return 1";
export async function appendReceipt(check:OrderCheck,raw:string|null,receipt:Receipt, lock?:{key:string;token:string}) {
  if(!check.ledger.receipts.some(r=>r.id===receipt.id)) {
    const ledger={version:check.ledger.version+1,receipts:[...check.ledger.receipts,receipt]};
    const keys=[ledgerKey(check.property_id,check.order_id),`${ledgerKey(check.property_id,check.order_id)}:mission:${receipt.mission_id}`,...(lock?[lock.key]:[])];
    const result=await redisCommand(['EVAL',APPEND_PAYMENT,keys.length,...keys,raw??'',JSON.stringify(ledger),JSON.stringify({id:receipt.mission_id,status:'verification_pending',receipt_id:receipt.id,actor:receipt.actor,source_version:receipt.source_version,created_at:receipt.created_at}),lock?.token??'']);
    if(result!==1)throw new Error('VERSION_CONFLICT');
  }
  const verified=await readLedger(check.property_id,check.order_id);
  if(!verified.ledger.receipts.some(r=>r.id===receipt.id&&r.request_hash===receipt.request_hash&&JSON.stringify(r.audit)===JSON.stringify(receipt.audit)))throw new Error('WRITE_UNCONFIRMED');
  await redisCommand(["SET", `${ledgerKey(check.property_id,check.order_id)}:mission:${receipt.mission_id}`, JSON.stringify({id:receipt.mission_id,status:"completed",action:"record_payment",actor:receipt.actor,receipt_id:receipt.id,source_version:receipt.source_version,verified_at:new Date().toISOString(),steps:["check_order","record_payment","verify_receipt"],sheet_write:false})]);
  return verified.ledger;
}
export async function overlayPayments(bookings:CalendarBooking[]):Promise<CalendarBooking[]> {
  const finance=new Map<string,FinanceEntry[]>();await Promise.all([...new Set(bookings.map(b=>b.property_id))].map(async property=>finance.set(property,await manualFinanceEntries(property))));
  const groups=new Map<string,CalendarBooking[]>();
  for(const b of bookings)if(!b.source_conflict&&b.reservation_status!=='cancelled'){const key=ledgerKey(b.property_id,b.order_id);groups.set(key,[...(groups.get(key)??[]),b]);}
  const entries=[...groups.entries()]; if(!entries.length)return bookings;
  const values=await redisCommand(['MGET',...entries.map(([key])=>key)]) as (string|null)[];
  const statuses=new Map<string,CalendarBooking['payment_status']>();
  entries.forEach(([key,rows],index)=>{{const ledger=values[index]?JSON.parse(values[index]!) as Ledger:emptyLedger();const check=checkRows(rows,rows[0].property_id,rows[0].order_id,ledger);check.finance_received=financeAllocated(finance.get(rows[0].property_id)??[],rows[0].order_id);statuses.set(key,paymentStatus(check));}});
  return bookings.map(b=>{const status=statuses.get(ledgerKey(b.property_id,b.order_id));return status?{...b,payment_status:status}:b;});
}

export const financeAllocated=(entries:FinanceEntry[],order:string)=>entries.reduce((s,e)=>s+(e.allocations?.filter(a=>a.order_id===order).reduce((n,a)=>n+a.amount_cents,0)??0),0)/100;
