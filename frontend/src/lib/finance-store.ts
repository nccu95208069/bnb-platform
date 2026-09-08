import {createHash,randomUUID} from 'node:crypto';
import {redisCommand} from './workspace-auth/store.ts';
import type {Member,Principal} from './workspace-auth/types.ts';
import {EXPENSE_CATEGORIES,INCOME_CATEGORIES,METHODS,type FinanceEntry,type RecurringExpense,type PayoutRule,taipeiDate} from './finance-model.ts';
import type {Ledger} from './os-payments.ts';
export const canUseFinance=(actor:Principal|null)=>!!actor&&actor.viewPrices&&['owner','god','admin'].includes(actor.role);
type Operation={id:string;hash:string;entry_id:string;at:string;actor:string};
export type FinanceState={version:number;entries:FinanceEntry[];operations:Operation[];recurring?:RecurringExpense[];payout_rules?:PayoutRule[]};
export const financeKey=(property:string,year:number)=>`sweetfun-os:finance:v1:${property}:${year}`;
export async function readFinance(property:string,year:number):Promise<{raw:string|null;state:FinanceState}>{const raw=await redisCommand(['GET',financeKey(property,year)]);if(raw===null)return {raw:null,state:{version:0,entries:[],operations:[]}};if(typeof raw!=='string')throw new Error('UNAVAILABLE');const state=JSON.parse(raw) as FinanceState;if(!Number.isSafeInteger(state.version)||!Array.isArray(state.entries)||!Array.isArray(state.operations))throw new Error('UNAVAILABLE');return {raw,state};}
export function applyFinance(state:FinanceState,input:Record<string,unknown>,actor:Principal,property:string,year:number,now=new Date().toISOString(),members:Member[]=[]) {
 if(!canUseFinance(actor)||(!actor.allProperties&&!actor.propertyIds.includes(property)))throw new Error('FORBIDDEN');
 if(typeof input.request_id!=='string'||!/^[a-f0-9-]{36}$/.test(input.request_id))throw new Error('INVALID_INPUT');
 const hashFields=[actor.id,input.action,input.kind,input.category,input.amount,input.date,input.description,input.method,input.stage,input.entry_id,input.reason,input.allocations,input.platform,input.recurrence_id,input.occurrence,input.start,input.end,input.day,input.rule_id,input.mode,input.offset];
 if(input.advanced_by!=null)hashFields.push(input.advanced_by);
 const hash=createHash('sha256').update(JSON.stringify(hashFields)).digest('hex');
 const previous=state.operations.find(o=>o.id===input.request_id);if(previous){if(previous.hash!==hash)throw new Error('IDEMPOTENCY_CONFLICT');return {state,entry_id:previous.entry_id};}
 if(input.expected_version!==state.version)throw new Error('VERSION_CONFLICT');
 if(state.operations.length>=10000)throw new Error('LIMIT_REACHED');
 let entries=[...state.entries],id:string;let recurring=[...(state.recurring??[])],payout_rules=[...(state.payout_rules??[])];
 if(input.action==='recurring_create'){
 const {category,amount,description='',method,start,end,day}=input;
 const validDate=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
 if(typeof category!=='string'||!Object.hasOwn(EXPENSE_CATEGORIES,category)||typeof amount!=='number'||!Number.isFinite(amount)||amount<=0||amount>10000000||Math.abs(amount*100-Math.round(amount*100))>0.00001||typeof description!=='string'||description.length>500||typeof method!=='string'||method==='ota'||!Object.hasOwn(METHODS,method)||!validDate(start)||String(start).slice(0,4)!==String(year)||(end!=null&&end!==''&&(!validDate(end)||String(end)<String(start)))||!Number.isInteger(day)||Number(day)<1||Number(day)>31)throw new Error('INVALID_INPUT');
 id=randomUUID();recurring.push({id,year,category,amount_cents:Math.round(amount*100),description:description.trim(),method:method as FinanceEntry['method'],start:String(start),end:end?String(end):null,day:Number(day),actor:actor.displayName,created_at:now});
 }else if(input.action==='recurring_stop'){
 const rule=recurring.find(r=>r.id===input.rule_id);if(!rule||rule.stopped_at)throw new Error('INVALID_INPUT');id=rule.id;recurring=recurring.map(r=>r.id===id?{...r,stopped_at:taipeiDate(new Date(now)),stopped_by:actor.displayName}:r);
 }else if(input.action==='payout_rule'){
 if(!['ctrip','owljourney'].includes(String(input.platform))||!['manual','monthly'].includes(String(input.mode))||!Number.isInteger(input.day)||Number(input.day)<1||Number(input.day)>31||!Number.isInteger(input.offset)||Number(input.offset)<1||Number(input.offset)>3)throw new Error('INVALID_INPUT');
 id=randomUUID();payout_rules=[...payout_rules.filter(r=>r.platform!==input.platform),{platform:String(input.platform),mode:input.mode as PayoutRule['mode'],day:Number(input.day),offset:Number(input.offset),updated_at:now}];
 }else if(input.action==='void'){
   if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>300)throw new Error('INVALID_INPUT');
   const old=entries.find(e=>e.id===input.entry_id);if(!old||old.source!=='manual'||old.status!=='active')throw new Error('INVALID_INPUT');id=old.id;
   entries=entries.map(e=>e.id===id?{...e,status:'void',void_reason:input.reason as string,void_at:now,void_actor:actor.displayName}:e);
 }else if(input.action==='create'){
   const {kind,category,amount,date,description='',method,stage}=input;
   if((kind!=='income'&&kind!=='expense')||typeof category!=='string'||!Object.hasOwn(kind==='income'?INCOME_CATEGORIES:EXPENSE_CATEGORIES,category)||typeof amount!=='number'||!Number.isFinite(amount)||amount<=0||amount>10000000||Math.abs(amount*100-Math.round(amount*100))>0.00001||typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date.slice(0,4)!==String(year)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||typeof description!=='string'||(kind==='income'&&!description.trim())||description.length>500||typeof method!=='string'||!Object.hasOwn(METHODS,method)||!['','deposit','balance','full','other'].includes(String(stage??'')))throw new Error('INVALID_INPUT');
   if(date>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now)))throw new Error('FUTURE_DATE');
   if(kind==='expense'&&method==='ota')throw new Error('INVALID_INPUT');
   const advanced_by=resolveAdvance(input.advanced_by,kind,actor,property,members);
   id=randomUUID();entries.push({advanced_by,id,property_id:property,kind,category,amount_cents:Math.round(amount*100),date,description:description.trim(),method:method as FinanceEntry['method'],stage:kind==='income'&&category==='lodging'?String(stage??''):undefined,source:'manual',actor:actor.displayName,created_at:now,status:'active',allocations:input.allocations as FinanceEntry['allocations'],platform:typeof input.platform==='string'?input.platform:undefined,recurrence_id:typeof input.recurrence_id==='string'?input.recurrence_id:undefined,occurrence:typeof input.occurrence==='string'?input.occurrence:undefined});
 }else throw new Error('INVALID_INPUT');
 return {entry_id:id,state:{version:state.version+1,entries,recurring,payout_rules,operations:[...state.operations,{id:input.request_id,hash,entry_id:id,at:now,actor:actor.id}]}};
}
export async function writeFinance(property:string,year:number,raw:string|null,state:FinanceState,requestId:string,lock?:{key:string;token:string}){
 const result=await redisCommand(['EVAL',"if #KEYS>1 and redis.call('GET',KEYS[2])~=ARGV[3] then return 0 end; if (redis.call('GET',KEYS[1]) or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1",lock?2:1,financeKey(property,year),...(lock?[lock.key]:[]),raw??'',JSON.stringify(state),lock?.token??'']);if(result!==1)throw new Error('VERSION_CONFLICT');
 const check=await readFinance(property,year);if(!check.state.operations.some(o=>o.id===requestId))throw new Error('WRITE_UNCONFIRMED');
}
// Existing payment ledgers have no secondary index. Scan only the authorized property,
// with strict key shape, deduplicate receipts and fail rather than return partial totals.
export async function calendarIncome(property:string,year:number|null):Promise<FinanceEntry[]>{
 const keys=new Set<string>();let cursor='0',pages=0;
 do {const result=await redisCommand(['SCAN',cursor,'MATCH',`sweetfun-os:payments:v1:${property}:*`,'COUNT',200]) as [string,string[]];cursor=String(result[0]);for(const key of result[1])if(new RegExp(`^sweetfun-os:payments:v1:${property}:[a-f0-9]{64}$`).test(key))keys.add(key);if(++pages>100)throw new Error('UNAVAILABLE');}while(cursor!=='0');
 const entries:FinanceEntry[]=[];const seen=new Set<string>();const list=[...keys];
 for(let offset=0;offset<list.length;offset+=100){const raw=await redisCommand(['MGET',...list.slice(offset,offset+100)]) as (string|null)[];
  for(const [valueIndex,value] of raw.entries()){if(!value)continue;const ledger=JSON.parse(value) as Ledger;if(!Array.isArray(ledger.receipts))throw new Error('UNAVAILABLE');for(const r of ledger.receipts){if(seen.has(r.id))continue;seen.add(r.id);const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.received_at));if(year!==null&&!date.startsWith(String(year)+'-'))continue;entries.push({id:`payment:${r.id}`,property_id:property,kind:'income',category:r.payment_type==='other'?'other':'lodging',amount_cents:Math.round(r.amount*100),date,description:r.note||'日曆登記收款',method:r.payment_method,stage:r.payment_type,source:'calendar',actor:r.actor_name,created_at:r.created_at,status:'active',order_key:list[offset+valueIndex]});}}
 }
 return entries;
}
// Read-only projection for the calendar: finance allocations share its property lock.
export async function manualFinanceEntries(property:string):Promise<FinanceEntry[]>{
 const years=new Set<number>();let cursor='0',pages=0;
 do{const result=await redisCommand(['SCAN',cursor,'MATCH',`sweetfun-os:finance:v1:${property}:*`,'COUNT',200]) as [string,string[]];cursor=String(result[0]);for(const key of result[1]){const suffix=key.split(':').at(-1)!;if(/^20\d{2}$/.test(suffix))years.add(Number(suffix));}if(++pages>100)throw new Error('UNAVAILABLE');}while(cursor!=='0');
 return (await Promise.all([...years].map(y=>readFinance(property,y)))).flatMap(s=>s.state.entries).filter(e=>e.status==='active'&&e.kind==='income'&&e.method!=='ota');
}

// Names are snapshots; account IDs preserve identity after renaming. No reimbursement is implied.
export function advanceAccounts(members:Member[],property:string){return members.filter(m=>m.status==='active'&&(m.allProperties||m.propertyIds.includes(property))).map(m=>({id:m.id,name:m.displayName}));}
export function resolveAdvance(value:unknown,kind:unknown,actor:Principal,property:string,members:Member[]=[]):FinanceEntry['advanced_by']{
 if(value==null)return undefined;
 if(kind!=='expense'||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_INPUT');
 const v=value as Record<string,unknown>;
 if(v.type==='self')return {type:'self',account_id:actor.id,name:actor.displayName};
 if(v.type==='account'&&typeof v.account_id==='string'){
 const account=advanceAccounts(members,property).find(m=>m.id===v.account_id);
 if(!account)throw new Error('INVALID_INPUT');
 return {type:'account',account_id:account.id,name:account.name};
 }
 if(v.type==='other'&&typeof v.name==='string'&&v.name.trim()&&v.name.trim().length<=100)return {type:'other',name:v.name.trim()};
 throw new Error('INVALID_INPUT');
}
