import {createHash,randomUUID} from 'node:crypto';
import {redisCommand} from './workspace-auth/store.ts';
import type {Principal} from './workspace-auth/types.ts';
import {EXPENSE_CATEGORIES,INCOME_CATEGORIES,METHODS,type FinanceEntry} from './finance-model.ts';
import type {Ledger} from './os-payments.ts';
export const canUseFinance=(actor:Principal|null)=>!!actor&&actor.viewPrices&&['owner','god','admin'].includes(actor.role);
type Operation={id:string;hash:string;entry_id:string;at:string;actor:string};
export type FinanceState={version:number;entries:FinanceEntry[];operations:Operation[]};
export const financeKey=(property:string,year:number)=>`sweetfun-os:finance:v1:${property}:${year}`;
export async function readFinance(property:string,year:number):Promise<{raw:string|null;state:FinanceState}>{const raw=await redisCommand(['GET',financeKey(property,year)]);if(raw===null)return {raw:null,state:{version:0,entries:[],operations:[]}};if(typeof raw!=='string')throw new Error('UNAVAILABLE');const state=JSON.parse(raw) as FinanceState;if(!Number.isSafeInteger(state.version)||!Array.isArray(state.entries)||!Array.isArray(state.operations))throw new Error('UNAVAILABLE');return {raw,state};}
export function applyFinance(state:FinanceState,input:Record<string,unknown>,actor:Principal,property:string,year:number,now=new Date().toISOString()) {
 if(!canUseFinance(actor)||(!actor.allProperties&&!actor.propertyIds.includes(property)))throw new Error('FORBIDDEN');
 if(typeof input.request_id!=='string'||!/^[a-f0-9-]{36}$/.test(input.request_id))throw new Error('INVALID_INPUT');
 const hash=createHash('sha256').update(JSON.stringify([actor.id,input.action,input.kind,input.category,input.amount,input.date,input.description,input.method,input.stage,input.entry_id,input.reason])).digest('hex');
 const previous=state.operations.find(o=>o.id===input.request_id);if(previous){if(previous.hash!==hash)throw new Error('IDEMPOTENCY_CONFLICT');return {state,entry_id:previous.entry_id};}
 if(input.expected_version!==state.version)throw new Error('VERSION_CONFLICT');
 if(state.operations.length>=10000)throw new Error('LIMIT_REACHED');
 let entries=[...state.entries],id:string;
 if(input.action==='void'){
   if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>300)throw new Error('INVALID_INPUT');
   const old=entries.find(e=>e.id===input.entry_id);if(!old||old.source!=='manual'||old.status!=='active')throw new Error('INVALID_INPUT');id=old.id;
   entries=entries.map(e=>e.id===id?{...e,status:'void',void_reason:input.reason as string,void_at:now,void_actor:actor.displayName}:e);
 }else if(input.action==='create'){
   const {kind,category,amount,date,description,method,stage}=input;
   if((kind!=='income'&&kind!=='expense')||typeof category!=='string'||!Object.hasOwn(kind==='income'?INCOME_CATEGORIES:EXPENSE_CATEGORIES,category)||typeof amount!=='number'||!Number.isFinite(amount)||amount<=0||amount>10000000||Math.abs(amount*100-Math.round(amount*100))>0.00001||typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date.slice(0,4)!==String(year)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||typeof description!=='string'||!description.trim()||description.length>500||typeof method!=='string'||!Object.hasOwn(METHODS,method)||!['','deposit','balance','full','other'].includes(String(stage??'')))throw new Error('INVALID_INPUT');
   if(date>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now)))throw new Error('FUTURE_DATE');
   if(kind==='expense'&&method==='ota')throw new Error('INVALID_INPUT');
   id=randomUUID();entries.push({id,property_id:property,kind,category,amount_cents:Math.round(amount*100),date,description:description.trim(),method:method as FinanceEntry['method'],stage:kind==='income'&&category==='lodging'?String(stage??''):undefined,source:'manual',actor:actor.displayName,created_at:now,status:'active'});
 }else throw new Error('INVALID_INPUT');
 return {entry_id:id,state:{version:state.version+1,entries,operations:[...state.operations,{id:input.request_id,hash,entry_id:id,at:now,actor:actor.id}]}};
}
export async function writeFinance(property:string,year:number,raw:string|null,state:FinanceState,requestId:string){
 const result=await redisCommand(['EVAL',"if (redis.call('GET',KEYS[1]) or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1",1,financeKey(property,year),raw??'',JSON.stringify(state)]);if(result!==1)throw new Error('VERSION_CONFLICT');
 const check=await readFinance(property,year);if(!check.state.operations.some(o=>o.id===requestId))throw new Error('WRITE_UNCONFIRMED');
}
// Existing payment ledgers have no secondary index. Scan only the authorized property,
// with strict key shape, deduplicate receipts and fail rather than return partial totals.
export async function calendarIncome(property:string,year:number):Promise<FinanceEntry[]>{
 const keys=new Set<string>();let cursor='0',pages=0;
 do {const result=await redisCommand(['SCAN',cursor,'MATCH',`sweetfun-os:payments:v1:${property}:*`,'COUNT',200]) as [string,string[]];cursor=String(result[0]);for(const key of result[1])if(new RegExp(`^sweetfun-os:payments:v1:${property}:[a-f0-9]{64}$`).test(key))keys.add(key);if(++pages>100)throw new Error('UNAVAILABLE');}while(cursor!=='0');
 const entries:FinanceEntry[]=[];const seen=new Set<string>();const list=[...keys];
 for(let offset=0;offset<list.length;offset+=100){const raw=await redisCommand(['MGET',...list.slice(offset,offset+100)]) as (string|null)[];
  for(const value of raw){if(!value)continue;const ledger=JSON.parse(value) as Ledger;if(!Array.isArray(ledger.receipts))throw new Error('UNAVAILABLE');for(const r of ledger.receipts){if(seen.has(r.id))continue;seen.add(r.id);const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.received_at));if(!date.startsWith(String(year)+'-'))continue;entries.push({id:`payment:${r.id}`,property_id:property,kind:'income',category:r.payment_type==='other'?'other':'lodging',amount_cents:Math.round(r.amount*100),date,description:r.note||'日曆登記收款',method:r.payment_method,stage:r.payment_type,source:'calendar',actor:r.actor_name,created_at:r.created_at,status:'active'});}}
 }
 return entries;
}
