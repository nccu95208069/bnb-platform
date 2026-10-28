import {NextRequest,NextResponse} from 'next/server';
import {principalFor} from '@/lib/workspace-auth/session';
import {sameOrigin,inputBody,privateHeaders} from '@/lib/workspace-auth/http';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {canUseFinance} from '@/lib/finance-store';
import {activeSources} from '@/lib/booking-sources/config';
import {acknowledgePendingOsFinance,readPendingOsFinance} from
  '@/lib/finance-ssot-pending.server';
import {submitSsotOsFinance} from '@/lib/finance-ssot-submit.server';

async function scope(request:NextRequest,property:unknown){
  const actor=await principalFor(request);
  if(!actor)throw Error('UNAUTHORIZED');
  if(!canUseFinance(actor))throw Error('FORBIDDEN');
  if(typeof property!=='string'||property!=='sweetfun'||
    process.env.OS_SWEETFUN_FINANCE_SSOT_ENABLED!=='true'||
    !(actor.allProperties||actor.propertyIds.includes(property))||
    !activeSources().some(source=>source.property.id===property))throw Error('FORBIDDEN');
  return {actor,property};
}

function failure(error:unknown){
  const code=error instanceof Error?error.message:'UNAVAILABLE';
  const status=code==='UNAUTHORIZED'?401:code==='FORBIDDEN'?403:
    ['FINANCE_PENDING_REQUEST','VERSION_CONFLICT','IDEMPOTENCY_CONFLICT',
      'FINANCE_PREVIEW_REQUIRED','FINANCE_PREVIEW_EXPIRED'].includes(code)?409:
    code==='INVALID_INPUT'?400:503;
  return NextResponse.json({code,detail:code==='FINANCE_PENDING_REQUEST'?
    '上一筆財務請求尚未完成或確認。請先查詢原請求。':
    code==='FINANCE_PENDING_UNAVAILABLE'?'待確認請求暫時無法讀取，請稍後再試。':
    code==='WRITE_UNCONFIRMED'?
      '原請求結果仍無法確認，已保留原請求。請勿新增一筆，請聯絡管理員核對。':
    code},{status,headers:privateHeaders});
}

export async function GET(request:NextRequest){
  try{
    const {actor,property}=await scope(request,
      request.nextUrl.searchParams.get('property'));
    const pending=await readPendingOsFinance(property,actor);
    return NextResponse.json({pending:pending?{
      request_id:pending.request_id,status:pending.status,
      action:String(pending.input.action??''),created_at:pending.created_at}:null},
    {headers:privateHeaders});
  }catch(error){return failure(error);}
}

export async function POST(request:NextRequest){
  try{
    sameOrigin(request);
    const body=await inputBody(request);
    const {actor,property}=await scope(request,body.property_id);
    await new RedisWorkspaceStore().limit(`finance-pending:${actor.id}`,90,3600);
    const pending=await readPendingOsFinance(property,actor);
    if(!pending)throw Error('FINANCE_PENDING_UNAVAILABLE');
    if(pending.status==='rejected')return NextResponse.json({
      code:pending.error_code??'INVALID_INPUT',rejected:true},{status:409,
      headers:privateHeaders});
    if(pending.status==='accepted'){
      if(!pending.result)throw Error('FINANCE_PENDING_UNAVAILABLE');
      return NextResponse.json(pending.result,{headers:privateHeaders});
    }
    const year=Number(pending.input.year);
    if(!Number.isInteger(year)||year<2020||year>2100)
      throw Error('FINANCE_PENDING_UNAVAILABLE');
    return NextResponse.json(await submitSsotOsFinance(pending.input,actor,
      property,year),{headers:privateHeaders});
  }catch(error){return failure(error);}
}

export async function DELETE(request:NextRequest){
  try{
    sameOrigin(request);
    const {actor,property}=await scope(request,
      request.nextUrl.searchParams.get('property'));
    const requestId=request.nextUrl.searchParams.get('request_id')??'';
    const acknowledged=await acknowledgePendingOsFinance(property,actor,requestId);
    return NextResponse.json({acknowledged},{headers:privateHeaders});
  }catch(error){return failure(error);}
}
