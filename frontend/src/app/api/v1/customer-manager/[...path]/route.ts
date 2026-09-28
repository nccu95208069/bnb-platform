import {NextRequest,NextResponse} from 'next/server';
import {principalFor} from '@/lib/workspace-auth/session';
import {redisCommand,RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {createManager} from '@/lib/host-agents/manager.mjs';
import {createRelay} from '@/lib/host-agents/relay.mjs';
import {guestBridge} from '@/lib/bots/guest-bridge';
import {createDaili,dailiProperty} from '@/lib/host-agents/daili.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
const headers={'Cache-Control':'private, no-store','Vary':'Cookie','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'};
async function handle(req:NextRequest,ctx:{params:Promise<{path:string[]}>}){
 try{
  const path=(await ctx.params).path,manager=createManager(redisCommand),limiter=new RedisWorkspaceStore(),daili=createDaili(redisCommand,manager);
  if(path[0]==='webhook'&&path.length===2){
   if(req.method!=='POST')return NextResponse.json({error:'method_not_allowed'},{status:405,headers});
   const raw=await req.text();if(Buffer.byteLength(raw)>128000)return NextResponse.json({error:'too_large'},{status:413,headers});
   const relay=createRelay(redisCommand,()=>Date.now(),{guest:guestBridge,manager});
   const result=await manager.webhook(path[1],raw,req.headers.get('x-line-signature'),
    (owner:string,property:string,body:Record<string,unknown>)=>dailiProperty(owner,property)?daili.decide(owner,property,body):relay.owner(owner,'automation-decide',{...body,property_id:property}),
    (owner:string,property:string)=>dailiProperty(owner,property)?daili.activity(owner,property):relay.owner(owner,'automation-events',{property_id:property}));
   return NextResponse.json(result,{headers});
  }
  const principal=await principalFor(req);
  if(!principal)return NextResponse.json({error:'login_required'},{status:401,headers});
  if(principal.role!=='owner')return NextResponse.json({error:'forbidden'},{status:403,headers});
  if(path.length!==1||!['status','configure','pair-code','unbind','property-add','daili-status','daili-decide','daili-toggle'].includes(path[0]))return NextResponse.json({error:'not_found'},{status:404,headers});
  if(req.headers.get('sec-fetch-site')==='cross-site'||req.method!=='GET'&&(req.headers.get('origin')!==`${req.nextUrl.protocol}//${req.headers.get('host')}`||req.headers.get('x-csrf-token')!=='same-origin'))return NextResponse.json({error:'same_origin_required'},{status:403,headers});
  await limiter.limit('customer-manager:'+principal.id,30,60);
  let body:Record<string,unknown>={};
  if(req.method==='POST'){
   const raw=await req.text();if(Buffer.byteLength(raw)>8000)return NextResponse.json({error:'too_large'},{status:413,headers});
   try{body=JSON.parse(raw)}catch{return NextResponse.json({error:'invalid_json'},{status:400,headers});}
   if(!body||typeof body!=='object'||Array.isArray(body))return NextResponse.json({error:'invalid_json'},{status:400,headers});
  }else if(!['status','daili-status'].includes(path[0]))return NextResponse.json({error:'method_not_allowed'},{status:405,headers});
  const property=String(body.property_id||req.nextUrl.searchParams.get('property_id')||'');
  if(path[0]==='daili-status')return NextResponse.json(await daili.activity(principal.id,property),{headers});
  if(path[0]==='daili-decide')return NextResponse.json(await daili.decide(principal.id,property,body),{headers});
  if(path[0]==='daili-toggle')return NextResponse.json(await daili.toggle(principal.id,property,body.enabled),{headers});
  if(path[0]==='status'){
   const result=await manager.owner(principal.id,'status');
   return NextResponse.json({...result,properties:result.properties.map((p:{id:string})=>({...p,source:dailiProperty(principal.id,p.id)?'daili':'host'}))},{headers});
  }
  return NextResponse.json(await manager.owner(principal.id,path[0],body),{headers});
 }catch(e){
  const err=e as Error&{code?:string;status?:number};
  return NextResponse.json({error:err.code||'unavailable'},{status:err.status||503,headers});
 }
}
export const GET=handle;
export const POST=handle;
