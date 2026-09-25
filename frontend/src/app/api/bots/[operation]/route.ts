import {NextRequest,NextResponse} from 'next/server';
import {principalFor} from '@/lib/workspace-auth/session';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {withWorkspace} from '@/lib/bots/persistence';
import {readLiveSource} from '@/lib/bots/source';
import {dispatch} from '@/lib/bots/service.mjs';
import {Fault} from '@/lib/bots/core.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=180;
const headers={'Cache-Control':'private, no-store','Vary':'Cookie','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'};
async function handle(request:NextRequest,{params}:{params:Promise<{operation:string}>}){
 try{
  const principal=await principalFor(request);
  if(!principal)return NextResponse.json({message:'請先登入 Sweetfun OS。'},{status:401,headers});
  if(principal.role!=='owner')return NextResponse.json({message:'Bot 工作台目前僅供業主使用。'},{status:403,headers});
  const {operation}=await params;
  const write=request.method==='POST';
  if(request.headers.get('sec-fetch-site')==='cross-site'||(write&&(request.headers.get('origin')!==`${request.nextUrl.protocol}//${request.headers.get('host')}`||request.headers.get('x-csrf-token')!=='same-origin')))return NextResponse.json({message:'請從本站操作。'},{status:403,headers});
  if(write&&!request.headers.get('content-type')?.startsWith('application/json'))return NextResponse.json({message:'請使用 JSON 格式。'},{status:415,headers});
  let body={};
  if(write){
   if(Number(request.headers.get('content-length'))>100000)throw new Fault('too_large','請求資料過大。',413);
   const text=await request.text();if(Buffer.byteLength(text)>100000)throw new Fault('too_large','請求資料過大。',413);
   try{body=JSON.parse(text)}catch{throw new Fault('invalid_json','資料格式不正確。',400)}
   if(!body||typeof body!=='object'||Array.isArray(body))throw new Fault('invalid_json','資料格式不正確。',400);
   await new RedisWorkspaceStore().limit('bots:'+principal.id+(operation==='chat'?':chat':':write'),operation==='chat'?20:120,60);
  }
  const result=await withWorkspace(s=>dispatch(s,operation,request.method,body,request.nextUrl.searchParams.get('id'),readLiveSource),write);
  return NextResponse.json(result,{headers});
 }catch(e){
  if(e instanceof Fault)return NextResponse.json({error:e.code,message:e.message},{status:e.status,headers});
  const code=e instanceof Error?e.message:'';
  const known:Record<string,[number,string]>={BUSY:[409,'工作區正在處理其他操作，請稍後重試。'],WRITE_CONFLICT:[409,'資料已更新，請重新讀取後重試。'],WRITE_UNCONFIRMED:[503,'儲存結果暫時無法確認，請查看操作紀錄後再試。'],SOURCE_UNAVAILABLE:[503,'正式訂單尚未同步完成或來源已過期，請稍後重試。'],STORE_FULL:[409,'工作區儲存空間已達本版上限，請聯絡管理者。'],RATE_LIMITED:[429,'操作太頻繁，請稍候再試。']};
  const [status,message]=known[code]||[503,'服務暫時無法完成，請稍後重試。'];
  return NextResponse.json({error:known[code]?code:'unavailable',message},{status,headers});
 }
}
export const GET=handle;
export const POST=handle;
