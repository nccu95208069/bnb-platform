import {assertFinanceWritesOpen,assertFinanceCommandScope} from '@/lib/finance-history-policy';
import {NextRequest,NextResponse} from 'next/server';
import {principalFor} from '@/lib/workspace-auth/session';
import {sameOrigin,inputBody,privateHeaders} from '@/lib/workspace-auth/http';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {canUseFinance} from '@/lib/finance-store';
import {activeSources} from '@/lib/booking-sources/config';
import {assertNotCardManaged} from '@/lib/card-payment-ownership';
import {ssotFinanceContext} from '@/lib/finance-ssot-context';
import {readPendingOsFinance} from '@/lib/finance-ssot-pending.server';
import {previewSsotOsFinance} from '@/lib/finance-ssot-operations';
import {ssotFinanceEnabled} from '@/lib/booking-sources/iron-gate-ssot-finance.server';

export async function POST(request:NextRequest){
  try{
    sameOrigin(request);
    const input=await inputBody(request,262_144);
    const actor=await principalFor(request);
    if(!actor)throw Error('UNAUTHORIZED');
    const property=input.property_id,year=Number(input.year);
    const source=activeSources().find(s=>s.property.id===property);
    if(!canUseFinance(actor)||typeof property!=='string'||!ssotFinanceEnabled(property)||
      !(actor.allProperties||actor.propertyIds.includes(property))||!source)
      throw Error('FORBIDDEN');
    assertFinanceWritesOpen(property);assertFinanceCommandScope(property,input);
    if(!Number.isInteger(year)||year<2020||year>2100)throw Error('INVALID_INPUT');
    await new RedisWorkspaceStore().limit(`finance-preview:${actor.id}`,90,3600);
    if(await readPendingOsFinance(property,actor))throw Error('FINANCE_PENDING_REQUEST');
    await assertNotCardManaged(property,[
      ...(typeof input.order_id==='string'?[input.order_id]:[]),
      ...(Array.isArray(input.allocations)?input.allocations.map(
        (a:{order_id?:unknown})=>String(a?.order_id??'')):[])]);
    const report=await ssotFinanceContext(source,year,actor);
    const members=(await new RedisWorkspaceStore().read()).value.members;
    const preview=await previewSsotOsFinance(input,report,actor,property,year,members);
    return NextResponse.json(preview,{headers:privateHeaders});
  }catch(error){
    const code=error instanceof Error?error.message:'UNAVAILABLE';
    const details:Record<string,string>={
      FINANCE_GENERAL_ONLY:'目前只開放一般收入與支出，訂單收款及進階設定尚未開放。',
      FINANCE_WRITES_PAUSED:'此旅宿暫停新增及修改收支，原帳與待確認請求均已保留。',
      FINANCE_PENDING_REQUEST:'上一筆財務請求尚未完成或確認。請先查詢原請求。',
      VERSION_CONFLICT:'帳本已更新，請重新整理後預覽。',
      SOURCE_MAPPING_REVIEW_REQUIRED:'來源訂單或金額對應尚待核對，這筆資料未入帳。',
      CARD_PAYMENT_REVIEW_REQUIRED:'這筆訂單由刷卡同步管理，請回 Credit Card 頁核對結果。',
      ORDER_REQUIRED:'住宿收入請選擇對應訂單，才能同步扣抵應收。',
      INVALID_INPUT:'請確認日期、金額與分類。',
      FUTURE_DATE:'這裡記錄已發生收支，日期不能晚於今天。'};
    const status=code==='UNAUTHORIZED'?401:['FORBIDDEN','FINANCE_GENERAL_ONLY'].includes(code)?403:
      ['FINANCE_PENDING_REQUEST','VERSION_CONFLICT','SOURCE_MAPPING_REVIEW_REQUIRED',
        'CARD_PAYMENT_REVIEW_REQUIRED','FINANCE_PREVIEW_EXPIRED'].includes(code)?409:
        ['INVALID_INPUT','ORDER_REQUIRED','FUTURE_DATE'].includes(code)?400:503;
    return NextResponse.json({code,detail:details[code]??
      '財務預覽暫時無法完成，請稍後再試。'},
    {status,headers:privateHeaders});
  }
}
