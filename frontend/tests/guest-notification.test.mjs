import test from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {canNotify,setNotification,notificationStates} from '../src/lib/guest-notification.ts';
import {GET,POST} from '../src/app/api/v1/guest-notification/route.ts';
import {createMemberSession,MEMBER_COOKIE} from '../src/lib/workspace-auth/session.ts';
test('notification is versioned, reversible, idempotent and audits every committed change',async()=>{
 const old={...process.env},fetch=global.fetch,hash=new Map(),audit=[];
 Object.assign(process.env,{KV_REST_API_URL:'https://test.invalid',KV_REST_API_TOKEN:'test'});
 global.fetch=async(url,options)=>{const c=JSON.parse(options.body);let result=null;
 if(c[0]==='HGET')result=hash.get(c[2])??null;
 if(c[0]==='HGETALL')result=[...hash].flat();
 if(c[0]==='EVAL'){const [, , , , ,id,expected,next,event]=c;if((hash.get(id)??'')!==expected)result=0;else{hash.set(id,next);audit.push(JSON.parse(event));result=1;}}
 return Response.json({result});};
 const actor={id:'actor',displayName:'Operator',email:'actor@example.test',role:'housekeeper'},order='SF-'+'a'.repeat(20);
 try{
 assert.deepEqual(await notificationStates('offland'),{});
 const first=await setNotification('offland',order,true,0,'request1',actor);assert.equal(first.notified,true);assert.equal(first.version,1);assert.equal(audit.length,1);
 assert.deepEqual(await setNotification('offland',order,true,0,'request1',actor),first);assert.equal(audit.length,1);
 await assert.rejects(setNotification('offland',order,false,0,'request2',actor),/VERSION_CONFLICT/);
 const second=await setNotification('offland',order,false,1,'request2',actor);assert.equal(second.version,2);assert.equal(second.notified,false);assert.equal(audit.length,2);assert.equal(audit[1].actor.id,'actor');assert.equal(audit[1].before.notified,true);assert.ok(audit[1].at);
 assert.equal((await notificationStates('offland'))[order].notified,false);
 }finally{global.fetch=fetch;for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);}
});
test('roles and cross-property authorization deny before notification store reads',async()=>{
 for(const role of ['owner','god','admin','housekeeper'])assert.equal(canNotify({role}),true);
 for(const role of ['viewer','viewer_no_price'])assert.equal(canNotify({role}),false);
 const old={...process.env},fetch=global.fetch;let reads=0;
 Object.assign(process.env,{BOOKING_SHEET_SOURCES:'sweetfun,offland',CALENDAR_OWNER_CODE_HASH:'a'.repeat(64),CALENDAR_OWNER_SESSION_SECRET:'b'.repeat(64),KV_REST_API_URL:'https://test.invalid',KV_REST_API_TOKEN:'test'});
 const member={id:'c'.repeat(32),displayName:'Viewer',email:'viewer@example.test',role:'viewer_no_price',status:'active',allProperties:false,propertyIds:['offland'],credential:{schema:1,kind:'password',revision:'d'.repeat(64),salt:'e'.repeat(32),hash:'f'.repeat(128)}};
 global.fetch=async(url,options)=>{const c=JSON.parse(options.body);if(c[0]==='HGETALL'){reads++;return Response.json({result:[]});}return Response.json({result:JSON.stringify({version:1,members:[member]})});};
 const request=(method,property,cookie=true)=>new NextRequest('https://local.test/api/v1/guest-notification?property='+property,{method,headers:{origin:'https://local.test',host:'local.test',...(cookie?{cookie:`${MEMBER_COOKIE}=${createMemberSession(member)}`}:{})},...(method==='POST'?{body:JSON.stringify({property_id:property})}:{})});
 try{
 assert.equal((await GET(request('GET','offland',false))).status,401);
 assert.equal((await GET(request('GET','sweetfun'))).status,403);assert.equal(reads,0);
 assert.equal((await POST(request('POST','offland'))).status,403);assert.equal(reads,0);
 const r=await GET(request('GET','offland'));assert.equal(r.status,200);assert.equal((await r.json()).can_write,false);assert.equal(reads,1);
 }finally{global.fetch=fetch;for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);}
});
