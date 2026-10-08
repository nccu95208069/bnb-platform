import {auditSnapshot,changedFields,type FinanceAuditEvent} from './finance-audit.ts';
import {manualFinanceEntries} from './finance-store.ts';
import {roomPaymentCents} from './os-payment-totals.ts';
import type {FinanceEntry, PaymentAccount} from './finance-model.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { CalendarBooking, PaymentRecord } from '../components/calendar/calendar-types';
import { redisCommand } from './workspace-auth/store.ts';
import type { Principal } from './workspace-auth/types.ts';

export type SheetSync = { state:'pending'|'verified'; targets:{uid:string;fingerprint:string;payment_flag?:string}[]; paid:boolean; verified_at?:string; failure?:{code:string;at:string;requires_review:boolean} };
export type Receipt = PaymentRecord & { status_only?:boolean; payment_account?:FinanceEntry['payment_account']; sheet_sync?:SheetSync; booking_version?:string; audit?:FinanceAuditEvent; actor: string; actor_name: string; note: string; settles_room: boolean; request_id: string; request_hash: string; mission_id: string; source_version: string };
export type Ledger = { version: number; receipts: Receipt[] };
export type ReceiptView=Omit<Receipt,'sheet_sync'>&{sheet_sync?:Omit<SheetSync,'targets'>};
export type LedgerView={version:number;receipts:ReceiptView[]};
export type PaymentRecovery={ledger:LedgerView;can_record:boolean;sheet_write_enabled:boolean;code:string;detail:string};
export type OrderCheck = { property_id: string; order_id: string; source_version: string; booking_version?:string; total: number; rooms: string[]; nights: number; source_paid: boolean; finance_received?:number; ledger: Ledger };
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
    booking_version: digest(matches.map(b => [b.id,b.room_id,b.check_in,b.check_out,b.room_rate]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))),
    total: matches.reduce((s,b)=>s+Math.round(b.room_rate*100),0)/100,
    rooms: [...new Set(matches.map(b=>b.room_number))], nights: matches.length,
    source_paid: matches.every(b=>b.payment_status==='paid'), ledger };
}
export function paymentStatus(check: OrderCheck): CalendarBooking['payment_status'] {
  const recordedRoomCents=roomPaymentCents(check.finance_received??0,check.ledger.receipts);
  if (check.source_paid || (check.total>0 && recordedRoomCents>=Math.round(check.total*100)) || check.ledger.receipts.some(r=>r.settles_room && r.sheet_sync?.state!=='pending' && (r.booking_version ? r.booking_version===check.booking_version : r.source_version===check.source_version))) return 'paid';
  if ((check.finance_received??0)>0||check.ledger.receipts.some(r=>r.amount>0&&r.payment_type!=='other')) return 'deposit';
  return 'unknown';
}
export function shouldMarkSheetPaid(check:OrderCheck,receipt:Receipt){
  return receipt.settles_room || (receipt.payment_type!=='other' && check.total>0 && roomPaymentCents(check.finance_received??0,[...check.ledger.receipts,receipt])>=Math.round(check.total*100));
}
export function ledgerView(ledger:Ledger):LedgerView {
  return {...ledger,receipts:ledger.receipts.map(r=>{
    const {sheet_sync,...rest}=r;
    if(!sheet_sync)return rest;
    const {targets,...visible}=sheet_sync;void targets;
    return {...rest,sheet_sync:visible};
  })};
}
export function prepareReceipt(input: Record<string, unknown>, check: OrderCheck, actor: Principal, now = new Date().toISOString(), accounts:PaymentAccount[]=[]): Receipt {
  if(!canRecord(actor,check.property_id)) throw new Error('FORBIDDEN');
  const {amount,payment_type,payment_method,received_at,note,request_id,settles_room} = input;
  const statusOnly=input.status_only===true;
  if((input.status_only!=null&&typeof input.status_only!=='boolean') || (statusOnly&&(amount!==0||payment_type!=='full'||payment_method!=='other'||settles_room!==true)) || typeof amount!=='number'||!Number.isFinite(amount)||(statusOnly?amount!==0:amount<=0)||amount>10000000||Math.abs(amount*100-Math.round(amount*100))>0.00001 ||
    !['deposit','balance','other','full'].includes(String(payment_type)) || !['cash','bank_transfer','credit_card','ota','other'].includes(String(payment_method)) ||
    typeof received_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(received_at)||!Number.isFinite(Date.parse(received_at))||Date.parse(received_at)>Date.parse(now)+60000 ||
    typeof request_id!=='string'||! /^[a-f0-9-]{36}$/.test(request_id)||typeof note!=='string'||note.length>500||typeof settles_room!=='boolean'||(settles_room&&!['balance','full'].includes(String(payment_type)))) throw new Error('INVALID_INPUT');
  if(['balance','full'].includes(String(payment_type)) && !settles_room) throw new Error('INVALID_INPUT');
  if(new Date(received_at).toISOString()!==(received_at.includes('.')?received_at:received_at.replace('Z','.000Z')))throw new Error('INVALID_INPUT');
  const hashFields:unknown[]=[actor.id,amount,payment_type,payment_method,received_at,note,settles_room];
  if(statusOnly)hashFields.push({status_only:true});
  if(input.payment_account_id!=null)hashFields.push({payment_account_id:input.payment_account_id});
  if(input.payment_account_name!=null||input.payment_account_last_digits!=null)hashFields.push({payment_account_name:input.payment_account_name,payment_account_last_digits:input.payment_account_last_digits});
  const request_hash=digest(hashFields);
  const existing=check.ledger.receipts.find(r=>r.request_id===request_id);
  if(existing) { if(existing.request_hash!==request_hash)throw new Error('IDEMPOTENCY_CONFLICT');return existing; }
  if(check.ledger.receipts.some(r=>r.sheet_sync?.state==='pending'))throw new Error('ORDER_SYNC_PENDING');
  if(input.expected_version!==check.ledger.version||input.source_version!==check.source_version)throw new Error('VERSION_CONFLICT');
  if(!statusOnly && payment_type!=='other' && roomPaymentCents(check.finance_received??0,[...check.ledger.receipts,{amount,payment_type:String(payment_type),payment_method:String(payment_method)}])>Math.round(check.total*100))throw new Error('AMOUNT_EXCEEDS_TOTAL');
  const payment_account=receiptAccount(input,check.property_id,accounts);
  if(check.ledger.receipts.length>=1000)throw new Error('LEDGER_FULL');
  const receipt:Receipt={id:randomUUID(),amount,payment_type:payment_type as Receipt['payment_type'],payment_method:payment_method as Receipt['payment_method'],received_at,created_at:now,
    actor:actor.id,actor_name:actor.displayName,note,settles_room,request_id,request_hash,mission_id:randomUUID(),source_version:check.source_version,booking_version:check.booking_version,...(statusOnly?{status_only:true}:{}),...(payment_account?{payment_account}:{})};
  const after=auditSnapshot(receipt);
  receipt.audit={schema_version:1,id:request_id,request_id,property_id:check.property_id,action:statusOnly?'calendar_payment_confirmed':'calendar_payment_recorded',actor_id:actor.id,actor_name:actor.displayName,actor_email:actor.email??null,actor_role:actor.role,at:now,source:'calendar',result:'succeeded',target_type:'receipt',target_id:receipt.id,before:null,after:{...after,order_id:check.order_id},changed_fields:changedFields(null,{...after,order_id:check.order_id}),version_before:check.ledger.version,version_after:check.ledger.version+1,source_version:check.source_version,completeness:'complete'};
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
  if(!receipt.sheet_sync)await redisCommand(["SET", `${ledgerKey(check.property_id,check.order_id)}:mission:${receipt.mission_id}`, JSON.stringify({id:receipt.mission_id,status:"completed",action:"record_payment",actor:receipt.actor,receipt_id:receipt.id,source_version:receipt.source_version,verified_at:new Date().toISOString(),steps:["check_order","record_payment","verify_receipt"],sheet_write:false})]);
  return verified.ledger;
}
export async function overlayPayments(bookings:CalendarBooking[]):Promise<CalendarBooking[]> {
  const finance=new Map<string,FinanceEntry[]>();await Promise.all([...new Set(bookings.map(b=>b.property_id))].map(async property=>finance.set(property,await manualFinanceEntries(property))));
  const groups=new Map<string,CalendarBooking[]>();
  for(const b of bookings)if(!b.source_conflict&&b.reservation_status!=='cancelled'){const key=ledgerKey(b.property_id,b.order_id);groups.set(key,[...(groups.get(key)??[]),b]);}
  const entries=[...groups.entries()]; if(!entries.length)return bookings;
  const values=await redisCommand(['MGET',...entries.map(([key])=>key)]) as (string|null)[];
  if(!Array.isArray(values)||values.length!==entries.length||values.some(v=>v!==null&&typeof v!=='string'))throw Error('PAYMENT_DATA_INVALID');
  const statuses=new Map<string,CalendarBooking['payment_status']>();
  entries.forEach(([key,rows],index)=>{{const ledger=values[index]?JSON.parse(values[index]!) as Ledger:emptyLedger();if(!Number.isSafeInteger(ledger.version)||!Array.isArray(ledger.receipts))throw Error('PAYMENT_DATA_INVALID');const check=checkRows(rows,rows[0].property_id,rows[0].order_id,ledger);check.finance_received=financeAllocated(finance.get(rows[0].property_id)??[],rows[0].order_id);statuses.set(key,paymentStatus(check));}});
  return bookings.map(b=>{const status=statuses.get(ledgerKey(b.property_id,b.order_id));return status?{...b,payment_status:status}:b;});
}

export const financeAllocated=(entries:FinanceEntry[],order:string)=>entries.reduce((s,e)=>s+(e.allocations?.filter(a=>a.order_id===order).reduce((n,a)=>n+a.amount_cents,0)??0),0)/100;

export function receiptAccount(input:Record<string,unknown>,property:string,accounts:PaymentAccount[]):FinanceEntry['payment_account'] {
  const {payment_account_id:id,payment_account_name:name,payment_account_last_digits:digits}=input;
  if(id==null&&name==null&&digits==null){
    if(['bank_transfer','credit_card'].includes(String(input.payment_method)))throw new Error('PAYMENT_ACCOUNT_REQUIRED');
    return undefined;
  }
  if(input.status_only===true||!['bank_transfer','credit_card'].includes(String(input.payment_method)))throw new Error('INVALID_INPUT');
  if(id!=null){
    if(name!=null||digits!=null)throw new Error('INVALID_INPUT');
    const a=accounts.find(a=>a.id===id&&a.property_id===property&&a.method===input.payment_method);
    if(!a)throw new Error('INVALID_INPUT');
    return {id:a.id,name:a.name,method:a.method,last_digits:a.last_digits};
  }
  if(typeof name!=='string'||!name.trim()||name.trim().length>50||/[\x00-\x1f]/.test(name)||typeof digits!=='string'||!(input.payment_method==='credit_card'?/^\d{4}$/:/^\d{5}$/).test(digits))throw new Error('INVALID_INPUT');
  return {id:`receipt-account:${digest([property,input.payment_method,name.trim(),digits]).slice(0,20)}`,name:name.trim(),method:input.payment_method as PaymentAccount['method'],last_digits:digits};
}

export async function finishSheetSync(property:string,order:string,receipt:Receipt,lock:{key:string;token:string}) {
  const current=await readLedger(property,order);
  const saved=current.ledger.receipts.find(r=>r.id===receipt.id);
  if(!saved?.sheet_sync)throw new Error('WRITE_UNCONFIRMED');
  if(saved.sheet_sync.state==='verified')return current.ledger;
  const at=new Date().toISOString();
  const ledger:Ledger={version:current.ledger.version+1,receipts:current.ledger.receipts.map(r=>r.id===receipt.id?{...r,sheet_sync:{...r.sheet_sync!,state:'verified',verified_at:at,failure:undefined}}:r)};
  const mission={id:receipt.mission_id,status:'completed',action:receipt.status_only?'confirm_paid':'record_payment',actor:receipt.actor,receipt_id:receipt.id,verified_at:at,steps:['check_order','record_payment','verify_receipt','update_main_sheet','verify_main_sheet'],sheet_write:true};
  const result=await redisCommand(['EVAL',APPEND_PAYMENT,3,ledgerKey(property,order),`${ledgerKey(property,order)}:mission:${receipt.mission_id}`,lock.key,current.raw??'',JSON.stringify(ledger),JSON.stringify(mission),lock.token]);
  if(result!==1)throw new Error('WRITE_UNCONFIRMED');
  const verified=await readLedger(property,order);
  if(verified.ledger.receipts.find(r=>r.id===receipt.id)?.sheet_sync?.state!=='verified')throw new Error('WRITE_UNCONFIRMED');
  return verified.ledger;
}

const REVIEW_FAILURES=new Set(['SOURCE_CHANGED','SOURCE_CONFLICT','NOT_FOUND','SHEET_PAYMENT_FORMULA','SHEET_NOTE_FULL','SHEET_IDENTITY_MISMATCH']);
export function sheetSyncFailure(code:string){
  const known=REVIEW_FAILURES.has(code)||['SHEET_PAYMENT_PERMISSION','WRITE_UNCONFIRMED','VERSION_CONFLICT'].includes(code);
  return {code:known?code:'SHEET_PAYMENT_UNAVAILABLE',at:new Date().toISOString(),requires_review:REVIEW_FAILURES.has(code)};
}
export async function recordSheetSyncFailure(property:string,order:string,receipt:Receipt,lock:{key:string;token:string},code:string){
  const current=await readLedger(property,order);
  const saved=current.ledger.receipts.find(r=>r.id===receipt.id);
  if(!saved?.sheet_sync||saved.sheet_sync.state==='verified')return;
  const failure=sheetSyncFailure(code);
  const ledger:Ledger={version:current.ledger.version+1,receipts:current.ledger.receipts.map(r=>r.id===receipt.id?{...r,sheet_sync:{...r.sheet_sync!,failure}}:r)};
  const mission={id:receipt.mission_id,status:failure.requires_review?'blocked':'verification_pending',action:'sync_payment',receipt_id:receipt.id,actor:receipt.actor,failure,resume_requires_check:true,
    ...(failure.requires_review?{child:{id:`${receipt.mission_id}:source`,status:'open',action:'investigate_source',reason:failure.code}}:{})};
  await redisCommand(['EVAL',APPEND_PAYMENT,3,ledgerKey(property,order),`${ledgerKey(property,order)}:mission:${receipt.mission_id}`,lock.key,current.raw??'',JSON.stringify(ledger),JSON.stringify(mission),lock.token]);
}
