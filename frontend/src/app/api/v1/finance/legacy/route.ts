import {NextRequest,NextResponse} from 'next/server';
import {principalFor} from '@/lib/workspace-auth/session';
import {privateHeaders} from '@/lib/workspace-auth/http';
import {activeSources} from '@/lib/booking-sources/config';
import {canUseFinance,readFinance,calendarIncome} from '@/lib/finance-store';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';

/** Separate read-only archive. No legacy writer or source reconciliation runs here. */
export async function GET(request:NextRequest){try{
 const actor=await principalFor(request);if(!actor)return NextResponse.json({detail:'請先登入。'},{status:401,headers:privateHeaders});
 const property=request.nextUrl.searchParams.get('property')??'offland';
 if(!canUseFinance(actor)||(!actor.allProperties&&!actor.propertyIds.includes(property))||
  !activeSources().some(source=>source.property.id===property))
  return NextResponse.json({detail:'沒有此旅宿的財務權限。'},{status:403,headers:privateHeaders});
 const year=Number(request.nextUrl.searchParams.get('year'));
 if(!Number.isInteger(year)||year<2020||year>2100)
  return NextResponse.json({detail:'年度無效。'},{status:400,headers:privateHeaders});
 await new RedisWorkspaceStore().limit(`finance-legacy:${actor.id}`,120,3600);
 const [{state},calendar]=await Promise.all([readFinance(property,year),calendarIncome(property,year)]);
 const entries=[...state.entries,...calendar].map(entry=>{
  const {audit_event,order_key,...visible}=entry;void audit_event;void order_key;return visible;
 }).sort((a,b)=>b.date.localeCompare(a.date)||b.created_at.localeCompare(a.created_at));
 if(entries.some(entry=>entry.property_id!==property))throw Error('SCOPE_MISMATCH');
 return NextResponse.json({property_id:property,year,read_only:true,
  source:'legacy_os',entries,version:state.version},{headers:privateHeaders});
 }catch{return NextResponse.json({detail:'舊帳暫時無法讀取，請稍後重試。'},{status:503,headers:privateHeaders});}}
