import { NextRequest, NextResponse } from 'next/server';
import { principalFor } from '@/lib/workspace-auth/session';
import { allowedProperty } from '@/lib/workspace-auth/projection';
import { inputBody, privateHeaders, sameOrigin } from '@/lib/workspace-auth/http';
import { activeSources } from '@/lib/booking-sources/config';
import { readBookingSnapshot } from '@/lib/booking-sources/snapshot';
import { readOperationalSheet } from '@/lib/sheet-monitor/google';
import { normalizeRows, HEADERS } from '@/lib/sheet-monitor/reconcile';
import { adaptSheetBookings } from '@/lib/booking-sources/sweetfun-sheet';
import { financeAllocated, readLedger, checkRows, prepareReceipt, appendReceipt, canRecord, paymentStatus, finishSheetSync, ledgerView, recordSheetSyncFailure, sheetSyncFailure, type Receipt } from '@/lib/os-payments';
import {supportsSheetPayment,prepareSheetSync,syncReceiptToSheet,checkSheetPaymentAccess} from '@/lib/os-payment-sheet';
import {manualFinanceEntries,paymentAccountsForProperty} from '@/lib/finance-store';
import { randomUUID } from 'node:crypto';
import { RedisWorkspaceStore, redisCommand } from '@/lib/workspace-auth/store';

async function authorized(request:NextRequest,property:unknown,order:unknown) {
  const actor=await principalFor(request); if(!actor)throw new Error('UNAUTHORIZED');
  if(typeof property!=='string'||typeof order!=='string'||!/^SF-[a-f0-9]{20}$/.test(order))throw new Error('INVALID_INPUT');
  if(!actor.viewPrices||!allowedProperty(actor,property))throw new Error('FORBIDDEN');
  const source=activeSources().find(s=>s.property.id===property);if(!source)throw new Error('NOT_FOUND');
  return {actor,source,property,order};
}
async function context(source:ReturnType<typeof activeSources>[number],property:string,order:string,previous:Awaited<ReturnType<typeof readLedger>>) {
  const snapshot=await readBookingSnapshot(source);
  if(!snapshot)throw new Error("NOT_FOUND");
  const {raw,ledger}=previous;
  const check=checkRows(snapshot.bookings,property,order,ledger);
  // Compare authoritative source before every check/write, including historical rows.
  const values=await readOperationalSheet(source);
  const normalized=normalizeRows(values,source);
  const live=adaptSheetBookings([HEADERS,...normalized.map(r=>r.cells)],source.sourceId,new Date().toISOString(),[],normalized.map(r=>r.sourceRow),source.property);
  const current=checkRows(live.bookings,property,order,ledger);
  if(current.booking_version!==check.booking_version)throw new Error('SOURCE_CHANGED');
  current.finance_received=financeAllocated(await manualFinanceEntries(property),order);
  return {check:current,raw};
}
const failures:Record<string,[number,string]>={ORDER_SYNC_PENDING:[409,'請先完成前一筆收款的主表同步，再登記新款項。'],PAYMENT_ACCOUNT_REQUIRED:[400,'請選擇或填入收款帳戶。'],SHEET_SYNC_REVIEW_REQUIRED:[503,'OS 已保存，但主表資料已變動。請先核對主表，再繼續同步同一筆款項。'],SHEET_SYNC_PERMISSION:[503,'OS 已保存，但主表寫入權限不足。請管理員恢復權限後繼續同步同一筆款項。'],SHEET_SYNC_PENDING:[503,'OS 已保存，主表尚未確認同步。請按「繼續同步主表」，不會重複收款。'],SHEET_PAYMENT_UNSUPPORTED:[400,'此旅宿尚未開放主表付款同步。'],SHEET_PAYMENT_PERMISSION:[503,'主表寫入權限不足，請聯絡管理員。'],SHEET_PAYMENT_FORMULA:[409,'付款欄有公式，請先由管理員核對主表。'],SHEET_NOTE_FULL:[409,'主表付款註記已滿，請由管理員核對。'],AMOUNT_EXCEEDS_TOTAL:[400,'本次加上 OS 已登記的房費超過訂單房費，請核對；額外收費請選其他款項。'],UNAUTHORIZED:[401,'請先登入。'],FORBIDDEN:[403,'此帳號沒有這間旅宿的付款權限。'],INVALID_INPUT:[400,'請確認金額、付款方式與日期時間。'],NOT_FOUND:[404,'來源訂單已變動或不存在，請重新整理日曆。'],SOURCE_CONFLICT:[409,'訂單資料有衝突，請先核對來源。'],SOURCE_CHANGED:[409,'訂單剛被更正，請等日曆同步後重新確認。'],VERSION_CONFLICT:[409,'付款或訂單資料已更新，請重新載入確認後再送出。'],IDEMPOTENCY_CONFLICT:[409,'同一次請求的內容不同，請重新載入。'],WRITE_UNCONFIRMED:[503,'可能已儲存，請使用原內容重試確認，勿另建一筆。'],RATE_LIMITED:[429,'操作過於頻繁，請稍後重試。']};
function failure(e:unknown){const code=e instanceof Error?e.message:'';const [status,detail]=failures[code]??[503,'付款服務暫時無法確認，請保留原內容重試。'];return NextResponse.json({code:failures[code]?code:'UNAVAILABLE',detail},{status,headers:privateHeaders});}
export async function GET(request:NextRequest){try{
 const {actor,source,property,order}=await authorized(request,request.nextUrl.searchParams.get('property'),request.nextUrl.searchParams.get('order'));
 const previous=await readLedger(property,order);
 const can_record=canRecord(actor,property),sheet_write_enabled=supportsSheetPayment(source);
 try{
  const {check}=await context(source,property,order,previous);
  const payment_accounts=can_record?await paymentAccountsForProperty(property):[];
  return NextResponse.json({...check,ledger:ledgerView(check.ledger),payment_accounts,can_record,sheet_write_enabled,payment_status:paymentStatus(check)},{headers:privateHeaders});
 }catch(error){
  // Saved receipts remain recoverable even when the order/source cannot be read.
  // Do not return fabricated order totals or enable another payment in this state.
  if(!previous.ledger.receipts.some(r=>r.sheet_sync?.state==='pending'))throw error;
  const code=sheetSyncFailure(error instanceof Error?error.message:'').code;
  return NextResponse.json({recovery:{ledger:ledgerView(previous.ledger),can_record,sheet_write_enabled,code,detail:'訂單來源暫時無法核對。已保存的收款仍保留，請核對主表後繼續同步。'}},{headers:privateHeaders});
 }
}catch(e){return failure(e);}}
async function complete(source:ReturnType<typeof activeSources>[number],property:string,order:string,receipt:Receipt,lock:{key:string;token:string}){
 try{
  await syncReceiptToSheet(source,order,receipt,lock);
  const ledger=await finishSheetSync(property,order,receipt,lock);
  return NextResponse.json({receipt_id:receipt.id,mission_id:receipt.mission_id,verified:true,sheet_verified:true,version:ledger.version},{headers:privateHeaders});
 }catch(error){
  const code=error instanceof Error?error.message:'';
  await recordSheetSyncFailure(property,order,receipt,lock,code).catch(()=>{});
  const reason=sheetSyncFailure(code);
  throw new Error(reason.requires_review?'SHEET_SYNC_REVIEW_REQUIRED':code==='SHEET_PAYMENT_PERMISSION'?'SHEET_SYNC_PERMISSION':'SHEET_SYNC_PENDING');
 }
}
export async function POST(request:NextRequest){
 let lock:{key:string;token:string}|null=null;
 try{
  sameOrigin(request);const input=await inputBody(request);
  const actor=await principalFor(request);if(!actor)throw new Error('UNAUTHORIZED');
  if(typeof input.property_id!=='string')throw new Error('INVALID_INPUT');
  if(!canRecord(actor,input.property_id))throw new Error('FORBIDDEN');
  await new RedisWorkspaceStore().limit(`payment:${actor.id}`,60,3600);
  const source=activeSources().find(s=>s.property.id===input.property_id);
  if(!source)throw new Error('NOT_FOUND');
  if(input.action==='check_sheet_access'){
    await checkSheetPaymentAccess(source);
    return NextResponse.json({verified:true,sheet_write_enabled:true},{headers:privateHeaders});
  }
  if(typeof input.order_id!=='string'||!/^SF-[a-f0-9]{20}$/.test(input.order_id))throw new Error('INVALID_INPUT');
  const key=`sweetfun-os:payments:v1:${input.property_id}:lock`,token=randomUUID();
  if(await redisCommand(['SET',key,token,'NX','EX',120])!=='OK')throw new Error('VERSION_CONFLICT');
  lock={key,token};
  // Resolve a previously committed retry even if the Sheet changed after payment.
  const previous=await readLedger(input.property_id,input.order_id);
  const existing=previous.ledger.receipts.find(r=>r.request_id===input.request_id);
  if(existing){
    if(input.action!=='retry_sync'){
      const retryCheck={property_id:input.property_id,order_id:input.order_id,source_version:existing.source_version,total:0,rooms:[],nights:0,source_paid:false,ledger:previous.ledger};
      prepareReceipt(input,retryCheck,actor);
    }
    if(existing.sheet_sync)return await complete(source,input.property_id,input.order_id,existing,lock);
    return NextResponse.json({receipt_id:existing.id,mission_id:existing.mission_id,verified:true,version:previous.ledger.version},{headers:privateHeaders});
  }
  if(input.action==='retry_sync')throw new Error('NOT_FOUND');
  if(previous.ledger.receipts.some(r=>r.sheet_sync?.state==='pending'))throw new Error('ORDER_SYNC_PENDING');

  let resolved;
  try {resolved=await context(source,input.property_id,input.order_id,previous);} catch(error) {
    const code=error instanceof Error?error.message:'';
    if(['SOURCE_CONFLICT','SOURCE_CHANGED','NOT_FOUND'].includes(code)) {
      const missionId=randomUUID(),childId=randomUUID();
      await redisCommand(['SET',`sweetfun-os:payments:v1:${input.property_id}:investigation:${missionId}`,JSON.stringify({id:missionId,status:'blocked',action:'record_payment',order_id:input.order_id,actor:actor.id,at:new Date().toISOString(),child:{id:childId,status:'open',action:'investigate_source',reason:code},resume_requires_check:true})]);
    }
    throw error;
  }
  const {check,raw}=resolved;
  const accounts=await paymentAccountsForProperty(check.property_id);
  const receipt=prepareReceipt(input,check,actor,new Date().toISOString(),accounts);
  if(supportsSheetPayment(source)){
    receipt.sheet_sync=await prepareSheetSync(source,input.order_id,check,receipt);
  }
  const ledger=await appendReceipt(check,raw,receipt,lock);
  if(receipt.sheet_sync)return await complete(source,input.property_id,input.order_id,receipt,lock);
  return NextResponse.json({receipt_id:receipt.id,mission_id:receipt.mission_id,verified:true,version:ledger.version},{headers:privateHeaders});
 }catch(e){return failure(e);}finally{if(lock)await redisCommand(['EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",1,lock.key,lock.token]).catch(()=>{});}
}
