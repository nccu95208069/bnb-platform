import {createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import type {FinanceEntry} from '../finance-model';
import {calendarIncome, manualFinanceEntries} from '../finance-store.ts';
import {readLedger, ledgerKey} from '../os-payments.ts';
import {redisCommand} from '../workspace-auth/store.ts';
import {cardOwnershipKey} from '../card-payment-ownership.ts';
import {ironGateFinanceConfig, projectDirectFinance} from './iron-gate-finance.server.ts';
import type {ManualConfig} from './iron-gate-manual.server';

type CardInput = {sheetId:string;tab:string;row:number;platform:'booking';orderId:string;
  checkIn:string;checkOut:string;amountCents:number;status:'done'|'fail';chargeDate:string|null};
type Plan = {schema:1;expires:number;input:CardInput;bookingId:string;bookingVersion:number;requestKey:string};
type Config = {finance:ManualConfig;token:string;secret:string};
const object = (v:unknown):v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function cardSyncConfig(env:NodeJS.ProcessEnv=process.env):Config {
  if(env.IRON_GATE_CARD_SYNC_ENABLED!=='true'||!env.CC_SYNC_OS_TOKEN||env.CC_SYNC_OS_TOKEN.length<32)throw Error('CARD_SYNC_UNAVAILABLE');
  const finance=ironGateFinanceConfig(env), grant=JSON.parse(env.IRON_GATE_CARD_SYNC_GRANT??'null');
  if(!object(grant)||grant.propertyId!==finance.grant.propertyId||grant.workspaceId!==finance.grant.workspaceId||
    !UUID.test(String(grant.credentialId))||!UUID.test(String(grant.clientId))||
    typeof grant.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(grant.token))throw Error('CARD_SYNC_UNAVAILABLE');
  if(env.OS_SWEETFUN_FINANCE_SSOT_ENABLED==='true'&&(
    !UUID.test(String(grant.financeSourceInstanceId))||
    grant.financeSourceInstanceId!==env.IRON_GATE_SWEETFUN_CARD_FINANCE_SOURCE_INSTANCE_ID))
    throw Error('CARD_SYNC_UNAVAILABLE');
  return {finance,token:grant.token,secret:env.CC_SYNC_OS_TOKEN};
}
export function cardSyncAuthorized(supplied:string,secret:string) {
  const a=Buffer.from(supplied),b=Buffer.from(`Bearer ${secret}`);
  return a.length===b.length&&timingSafeEqual(a,b);
}
export function signCardPlan(plan:Plan,secret:string) {
  const payload=Buffer.from(JSON.stringify(plan)).toString('base64url');
  return `${payload}.${createHmac('sha256',secret).update(payload).digest('base64url')}`;
}
export function readCardPlan(value:unknown,secret:string):Plan {
  if(typeof value!=='string'||value.length>8192)throw Error('CARD_PREVIEW_REQUIRED');
  const [payload,signature,...extra]=value.split('.');
  const expected=createHmac('sha256',secret).update(payload??'').digest('base64url');
  if(extra.length||!signature||signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw Error('CARD_PREVIEW_REQUIRED');
  const plan=JSON.parse(Buffer.from(payload,'base64url').toString()) as Plan;
  if(plan.schema!==1||!Number.isSafeInteger(plan.expires)||plan.expires<Date.now()||!UUID.test(plan.bookingId)||!UUID.test(plan.requestKey))throw Error('CARD_PREVIEW_EXPIRED');
  return plan;
}
function inputOnly(value:unknown):CardInput {
  const fields=['sheetId','tab','row','platform','orderId','checkIn','checkOut','amountCents','status','chargeDate'];
  if(!object(value)||Object.keys(value).length!==fields.length||fields.some(key=>!(key in value))||
    value.platform!=='booking'||!['done','fail'].includes(String(value.status))||
    typeof value.orderId!=='string'||!/^\d{8,11}$/.test(value.orderId))throw Error('INVALID_CARD_INPUT');
  return Object.fromEntries(fields.map(key=>[key,value[key]])) as CardInput;
}
async function call(config:Config,mode:'preview'|'commit',input:object,requestKey?:string) {
  const response=await fetch(`${config.finance.calendar.baseUrl}/v1/properties/${config.finance.grant.propertyId}/card-sync/${mode}`,{
    method:'POST',headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json',...(requestKey?{'idempotency-key':requestKey}:{})},
    body:JSON.stringify(input),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(25000)});
  const value=await response.json();
  if(!response.ok)throw Error(/^CARD_[A-Z_]+$|^VERSION_CONFLICT$/.test(value?.error?.code)?value.error.code:'CARD_SYNC_UNAVAILABLE');
  if(!object(value)||!UUID.test(String(value.bookingId))||!Number.isSafeInteger(value.bookingVersion)||
    !Array.isArray(value.aliases)||value.aliases.length<2||value.aliases.length>20||
    value.aliases.some(alias=>typeof alias!=='string'||!/^(?:SF-[a-f0-9]{20}|IG-[0-9a-f-]{36}|[0-9a-f-]{36})$/.test(alias))||
    !object(value.financeSnapshot))throw Error('CARD_READBACK_MISMATCH');
  return value;
}
async function legacy(aliases:string[]) {
  const [manual,calendar,ledgers]=await Promise.all([manualFinanceEntries('sweetfun'),calendarIncome('sweetfun',null),
    Promise.all(aliases.map(alias=>readLedger('sweetfun',alias)))]);
  if(ledgers.some(item=>item.ledger.receipts.length))throw Error('CARD_LEGACY_PAYMENT_REVIEW');
  const entries=[...manual,...calendar];
  if(entries.some(entry=>entry.status==='active'&&(aliases.includes(entry.order_id??'')||
    aliases.some(alias=>entry.order_key===ledgerKey('sweetfun',alias))||
    entry.allocations?.some(allocation=>aliases.includes(allocation.order_id)))))throw Error('CARD_LEGACY_PAYMENT_REVIEW');
  return entries;
}
const lockKey='sweetfun-os:payments:v1:sweetfun:lock';
async function reserve(aliases:string[],bookingId:string,token:string) {
  const script="if redis.call('GET',KEYS[1])~=ARGV[1] then return -1 end for i=2,#KEYS do local v=redis.call('GET',KEYS[i]); if v and v~=ARGV[2] then return -2 end end for i=2,#KEYS do redis.call('SET',KEYS[i],ARGV[2]) end return 1";
  if(await redisCommand(['EVAL',script,1+aliases.length,lockKey,...aliases.map(alias=>cardOwnershipKey('sweetfun',alias)),token,bookingId])!==1)throw Error('CARD_OWNERSHIP_CONFLICT');
}
export function verifyCardFinance(result:Record<string,unknown>,config:ManualConfig,input:CardInput,entries:FinanceEntry[]) {
  const projected=projectDirectFinance(result.financeSnapshot as Record<string,unknown>,config,entries);
  if(input.status==='done') {
    const event=projected.entries.find(entry=>entry.payment_event_id===result.paymentEventId);
    const order=projected.orders.find(order=>order.booking_id===result.bookingId);
    if(!event||projected.entries.length!==1||event.amount_cents!==input.amountCents||event.date!==input.chargeDate||
      event.method!=='credit_card'||event.platform!=='booking'||!order||order.total!==input.amountCents||
      order.received!==input.amountCents||order.receivable!==0)throw Error('CARD_READBACK_MISMATCH');
  }else if(result.paymentEventId!==null||projected.entries.length)throw Error('CARD_READBACK_MISMATCH');
  return projected;
}
export async function previewCardSync(value:unknown,config=cardSyncConfig()) {
  const input=inputOnly(value), result=await call(config,'preview',input);
  await legacy(result.aliases as string[]);
  if(result.action==='already_synced')verifyCardFinance(result,config.finance,input,[]);
  const plan:Plan={schema:1,expires:Date.now()+15*60000,input,bookingId:String(result.bookingId),bookingVersion:Number(result.bookingVersion),requestKey:randomUUID()};
  return {bookingId:result.bookingId,bookingVersion:result.bookingVersion,action:result.action,
    netReceivedCents:result.netReceivedCents,paymentEventId:result.paymentEventId,previewToken:signCardPlan(plan,config.secret)};
}
export async function commitCardSync(value:unknown,config=cardSyncConfig()) {
  if(!object(value)||Object.keys(value).sort().join(',')!=='input,previewToken')throw Error('INVALID_CARD_INPUT');
  const input=inputOnly(value.input),plan=readCardPlan(value.previewToken,config.secret);
  if(JSON.stringify(input)!==JSON.stringify(inputOnly(plan.input)))throw Error('CARD_SOURCE_CHANGED');
  const token=randomUUID();
  if(await redisCommand(['SET',lockKey,token,'NX','EX',120])!=='OK')throw Error('VERSION_CONFLICT');
  try {
    const current=await call(config,'preview',input);
    if(current.bookingId!==plan.bookingId||current.action!=='already_synced'&&current.bookingVersion!==plan.bookingVersion)throw Error('CARD_PREVIEW_CHANGED');
    const aliases=current.aliases as string[];
    await legacy(aliases);
    if(input.status==='done')await reserve(aliases,plan.bookingId,token);
    let result;
    try {
      await call(config,'commit',{...input,bookingId:plan.bookingId,expectedBookingVersion:plan.bookingVersion},plan.requestKey);
      result=await call(config,'preview',input);
      const entries=await legacy(aliases);
      const projected=verifyCardFinance(result,config.finance,input,entries);
      if(result.action!=='already_synced')throw Error('CARD_READBACK_MISMATCH');
      return {bookingId:result.bookingId,bookingVersion:result.bookingVersion,paymentEventId:result.paymentEventId,
        netReceivedCents:result.netReceivedCents,financeVerified:true,financeRevision:projected.revision};
    } catch {throw Error('CARD_RESULT_UNKNOWN');}
  } finally {await redisCommand(['EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",1,lockKey,token]).catch(()=>{});}
}
