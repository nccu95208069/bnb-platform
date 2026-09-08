import { NextRequest, NextResponse } from 'next/server';
import { principalFor } from '@/lib/workspace-auth/session';
import { allowedProperty } from '@/lib/workspace-auth/projection';
import { inputBody, privateHeaders, sameOrigin } from '@/lib/workspace-auth/http';
import { activeSources } from '@/lib/booking-sources/config';
import { readBookingSnapshot } from '@/lib/booking-sources/snapshot';
import { readOperationalSheet } from '@/lib/sheet-monitor/google';
import { normalizeRows, HEADERS } from '@/lib/sheet-monitor/reconcile';
import { adaptSheetBookings } from '@/lib/booking-sources/sweetfun-sheet';
import { financeAllocated, readLedger, checkRows, prepareReceipt, appendReceipt, canRecord, paymentStatus } from '@/lib/os-payments';
import {manualFinanceEntries} from '@/lib/finance-store';
import { randomUUID } from 'node:crypto';
import { RedisWorkspaceStore, redisCommand } from '@/lib/workspace-auth/store';

async function context(request:NextRequest,property:unknown,order:unknown,write=false) {
  const actor=await principalFor(request); if(!actor)throw new Error('UNAUTHORIZED');
  if(typeof property!=='string'||typeof order!=='string'||!/^SF-[a-f0-9]{20}$/.test(order))throw new Error('INVALID_INPUT');
  if(!actor.viewPrices||!allowedProperty(actor,property)||(write&&!canRecord(actor,property)))throw new Error('FORBIDDEN');
  const source=activeSources().find(s=>s.property.id===property);if(!source)throw new Error('NOT_FOUND');
  const snapshot=await readBookingSnapshot(source);
  if(!snapshot)throw new Error("NOT_FOUND");
  const {raw,ledger}=await readLedger(property,order);
  const check=checkRows(snapshot.bookings,property,order,ledger);
  // Compare authoritative source before every check/write, including historical rows.
  const values=await readOperationalSheet(source);
  const normalized=normalizeRows(values,source);
  const live=adaptSheetBookings([HEADERS,...normalized.map(r=>r.cells)],source.sourceId,new Date().toISOString(),[],normalized.map(r=>r.sourceRow),source.property);
  const current=checkRows(live.bookings,property,order,ledger);
  if(current.source_version!==check.source_version)throw new Error('SOURCE_CHANGED');
  check.finance_received=financeAllocated(await manualFinanceEntries(property),order);
  return {actor,check,raw};
}
const failures:Record<string,[number,string]>={AMOUNT_EXCEEDS_TOTAL:[400,'本次加上 OS 已登記的房費超過訂單房費，請核對；額外收費請選其他款項。'],UNAUTHORIZED:[401,'請先登入。'],FORBIDDEN:[403,'此帳號沒有這間旅宿的付款權限。'],INVALID_INPUT:[400,'請確認金額、付款方式與日期時間。'],NOT_FOUND:[404,'來源訂單已變動或不存在，請重新整理日曆。'],SOURCE_CONFLICT:[409,'訂單資料有衝突，請先核對來源。'],SOURCE_CHANGED:[409,'訂單剛被更正，請等日曆同步後重新確認。'],VERSION_CONFLICT:[409,'付款或訂單資料已更新，請重新載入確認後再送出。'],IDEMPOTENCY_CONFLICT:[409,'同一次請求的內容不同，請重新載入。'],WRITE_UNCONFIRMED:[503,'可能已儲存，請使用原內容重試確認，勿另建一筆。'],RATE_LIMITED:[429,'操作過於頻繁，請稍後重試。']};
function failure(e:unknown){const code=e instanceof Error?e.message:'';const [status,detail]=failures[code]??[503,'付款服務暫時無法確認，請保留原內容重試。'];return NextResponse.json({code:failures[code]?code:'UNAVAILABLE',detail},{status,headers:privateHeaders});}
export async function GET(request:NextRequest){try{const {check,actor}=await context(request,request.nextUrl.searchParams.get('property'),request.nextUrl.searchParams.get('order'));return NextResponse.json({...check,can_record:canRecord(actor,check.property_id),payment_status:paymentStatus(check)},{headers:privateHeaders});}catch(e){return failure(e);}}
export async function POST(request:NextRequest){
 let lock:{key:string;token:string}|null=null;
 try{
  sameOrigin(request);const input=await inputBody(request);
  const actor=await principalFor(request);if(!actor)throw new Error('UNAUTHORIZED');
  if(typeof input.property_id!=='string'||typeof input.order_id!=='string'||!/^SF-[a-f0-9]{20}$/.test(input.order_id))throw new Error('INVALID_INPUT');
  if(!canRecord(actor,input.property_id))throw new Error('FORBIDDEN');
  await new RedisWorkspaceStore().limit(`payment:${actor.id}`,60,3600);
  const key=`sweetfun-os:payments:v1:${input.property_id}:lock`,token=randomUUID();
  if(await redisCommand(['SET',key,token,'NX','EX',60])!=='OK')throw new Error('VERSION_CONFLICT');
  lock={key,token};
  // Resolve a previously committed retry even if the Sheet changed after payment.
  const previous=await readLedger(input.property_id,input.order_id);
  const existing=previous.ledger.receipts.find(r=>r.request_id===input.request_id);
  if(existing){
    const retryCheck={property_id:input.property_id,order_id:input.order_id,source_version:existing.source_version,total:0,rooms:[],nights:0,source_paid:false,ledger:previous.ledger};
    const receipt=prepareReceipt(input,retryCheck,actor);
    const ledger=await appendReceipt(retryCheck,previous.raw,receipt,lock);
    return NextResponse.json({receipt_id:receipt.id,mission_id:receipt.mission_id,verified:true,version:ledger.version},{headers:privateHeaders});
  }
  let resolved;
  try {resolved=await context(request,input.property_id,input.order_id,true);} catch(error) {
    const code=error instanceof Error?error.message:'';
    if(['SOURCE_CONFLICT','SOURCE_CHANGED','NOT_FOUND'].includes(code)) {
      const missionId=randomUUID(),childId=randomUUID();
      await redisCommand(['SET',`sweetfun-os:payments:v1:${input.property_id}:investigation:${missionId}`,JSON.stringify({id:missionId,status:'blocked',action:'record_payment',order_id:input.order_id,actor:actor.id,at:new Date().toISOString(),child:{id:childId,status:'open',action:'investigate_source',reason:code},resume_requires_check:true})]);
    }
    throw error;
  }
  const {check,raw}=resolved;
  const receipt=prepareReceipt(input,check,actor);
  const ledger=await appendReceipt(check,raw,receipt,lock);
  return NextResponse.json({receipt_id:receipt.id,mission_id:receipt.mission_id,verified:true,version:ledger.version},{headers:privateHeaders});
 }catch(e){return failure(e);}finally{if(lock)await redisCommand(['EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",1,lock.key,lock.token]).catch(()=>{});}
}
