import {NextRequest,NextResponse} from 'next/server';
import {principalFor} from '@/lib/workspace-auth/session';
import {redisCommand,RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {guestBridge} from '@/lib/bots/guest-bridge';
import {createRelay,RelayError} from '@/lib/host-agents/relay.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'};
async function handle(req:NextRequest,ctx:{params:Promise<{path:string[]}>}){
 try{
  const path=(await ctx.params).path.join('/'),owner=path.startsWith('owner/');
  const relay=createRelay(redisCommand,()=>Date.now(),{guest:guestBridge}),limiter=new RedisWorkspaceStore();
  let principal;
  if(owner){
   principal=await principalFor(req);if(!principal)throw new RelayError('login_required',401);if(principal.role!=='owner')throw new RelayError('forbidden',403);
   if(req.headers.get('sec-fetch-site')==='cross-site'||req.method!=='GET'&&(req.headers.get('origin')!==`${req.nextUrl.protocol}//${req.headers.get('host')}`||req.headers.get('x-csrf-token')!=='same-origin'))throw new RelayError('same_origin_required',403);
  }else{
   if(req.method!=='POST')throw new RelayError('method_not_allowed',405);
   if(req.headers.get('origin'))throw new RelayError('host_only',403);
  }
  let body={};
  if(req.method==='POST'){
   if(!req.headers.get('content-type')?.startsWith('application/json'))throw new RelayError('json_required',415);
   const max=path.endsWith('/result')?3800000:path==='owner/automation-knowledge'?60000:16000;
   if(Number(req.headers.get('content-length'))>max)throw new RelayError('too_large',413);
   const raw=await req.text();if(Buffer.byteLength(raw)>max)throw new RelayError('too_large',413);
   try{body=JSON.parse(raw)}catch{throw new RelayError('invalid_json')}
   if(!body||typeof body!=='object'||Array.isArray(body))throw new RelayError('invalid_json');
  }else if(!owner||path!=='owner/status')throw new RelayError('method_not_allowed',405);
  // Pre-auth pairing attempts are restricted per platform-observed remote IP.
  const identity=owner?principal!.id:req.headers.get('authorization')||req.headers.get('x-vercel-forwarded-for')||'pairing';
  await limiter.limit('host-relay:'+identity,path==='pairing/redeem'||['owner/customer-polish','owner/customer-suggest'].includes(path)?20:120,60);
  const result=owner?await relay.owner(principal!.id,path.slice(6),body):await relay.host(path,req.headers,body);
  return result===null?new NextResponse(null,{status:204,headers}):NextResponse.json(result,{headers});
 }catch(e){
  const error=e instanceof RelayError?e.code:e instanceof Error&&e.message==='RATE_LIMITED'?'rate_limited':'unavailable';
  const status=e instanceof RelayError?e.status:error==='rate_limited'?429:503;
  return NextResponse.json({error,message:error},{status,headers});
 }
}
export const GET=handle;
export const POST=handle;
