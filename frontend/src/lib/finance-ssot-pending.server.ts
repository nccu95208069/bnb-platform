import {createHash} from 'node:crypto';
import type {Principal} from './workspace-auth/types.ts';
import {redisCommand} from './workspace-auth/store.ts';
import {osFinanceOriginHash} from './finance-ssot-operations.ts';

type PendingStatus='pending'|'accepted'|'rejected';
export type PendingOsFinance={schema:1;property_id:string;actor_id:string;
  request_id:string;origin_hash:string;created_at:string;status:PendingStatus;
  input:Record<string,unknown>;result?:Record<string,unknown>;error_code?:string};
type Stored={raw:string;value:PendingOsFinance};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const compareAndSet="if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2]); return 1 end return 0";
const compareAndDelete="if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0";

function key(property:string,actorId:string){
  return `sweetfun-os:finance-ssot:pending:v1:${property}:${createHash('sha256').update(actorId).digest('hex')}`;
}

async function stored(property:string,actorId:string):Promise<Stored|null>{
  const raw=await redisCommand(['GET',key(property,actorId)]);
  if(raw===null)return null;
  if(typeof raw!=='string')throw Error('FINANCE_PENDING_UNAVAILABLE');
  try{
    const value=JSON.parse(raw) as PendingOsFinance;
    if(value.schema!==1||value.property_id!==property||value.actor_id!==actorId||
      !UUID.test(value.request_id)||!['pending','accepted','rejected'].includes(value.status)||
      typeof value.origin_hash!=='string'||typeof value.created_at!=='string'||
      !value.input||typeof value.input!=='object'||Array.isArray(value.input))throw Error();
    return {raw,value};
  }catch{throw Error('FINANCE_PENDING_UNAVAILABLE');}
}

export async function readPendingOsFinance(property:string,actor:Principal){
  return (await stored(property,actor.id))?.value??null;
}

export async function reservePendingOsFinance(input:Record<string,unknown>,
  property:string,actor:Principal):Promise<{pending:PendingOsFinance;created:boolean}>{
  if(typeof input.request_id!=='string'||!UUID.test(input.request_id)||
    input.property_id!==property)throw Error('INVALID_INPUT');
  const originHash=osFinanceOriginHash(input,actor.id,property);
  const existing=await stored(property,actor.id);
  if(existing){
    if(existing.value.request_id!==input.request_id)
      throw Error('FINANCE_PENDING_REQUEST');
    if(existing.value.origin_hash!==originHash)
      throw Error('IDEMPOTENCY_CONFLICT');
    return {pending:existing.value,created:false};
  }
  const value:PendingOsFinance={schema:1,property_id:property,actor_id:actor.id,
    request_id:input.request_id,origin_hash:originHash,
    created_at:new Date().toISOString(),status:'pending',input};
  const result=await redisCommand(['SET',key(property,actor.id),JSON.stringify(value),'NX']);
  if(result==='OK')return {pending:value,created:true};
  const raced=await stored(property,actor.id);
  if(raced?.value.request_id===input.request_id&&raced.value.origin_hash===originHash)
    return {pending:raced.value,created:false};
  throw Error('FINANCE_PENDING_REQUEST');
}

async function transition(property:string,actor:Principal,requestId:string,
  status:'accepted'|'rejected',extra:Pick<PendingOsFinance,'result'|'error_code'>){
  const prior=await stored(property,actor.id);
  if(!prior||prior.value.request_id!==requestId)
    throw Error('FINANCE_PENDING_UNAVAILABLE');
  if(prior.value.status===status)return prior.value;
  if(prior.value.status!=='pending')throw Error('FINANCE_PENDING_UNAVAILABLE');
  const next:PendingOsFinance={...prior.value,status,...extra};
  const changed=await redisCommand(['EVAL',compareAndSet,1,key(property,actor.id),
    prior.raw,JSON.stringify(next)]);
  if(changed===1)return next;
  const raced=await stored(property,actor.id);
  if(raced?.value.request_id===requestId&&raced.value.status===status)return raced.value;
  throw Error('FINANCE_PENDING_UNAVAILABLE');
}

export async function acceptPendingOsFinance(property:string,actor:Principal,
  requestId:string,result:Record<string,unknown>){
  return transition(property,actor,requestId,'accepted',{result});
}

export async function rejectPendingOsFinance(property:string,actor:Principal,
  requestId:string,errorCode:string){
  return transition(property,actor,requestId,'rejected',{error_code:errorCode});
}

export async function acknowledgePendingOsFinance(property:string,actor:Principal,
  requestId:string){
  if(!UUID.test(requestId))throw Error('INVALID_INPUT');
  const prior=await stored(property,actor.id);
  if(!prior)return false;
  if(prior.value.request_id!==requestId)throw Error('FINANCE_PENDING_REQUEST');
  if(prior.value.status==='pending')throw Error('FINANCE_PENDING_REQUEST');
  const removed=await redisCommand(['EVAL',compareAndDelete,1,key(property,actor.id),prior.raw]);
  if(removed!==1)throw Error('FINANCE_PENDING_UNAVAILABLE');
  return true;
}
