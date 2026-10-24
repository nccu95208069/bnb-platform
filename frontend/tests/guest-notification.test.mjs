import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {NextRequest} from 'next/server';
import {canNotify,notificationOrderId,setNotification,notificationStates} from '../src/lib/guest-notification.ts';
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

test('active Iron Gate order can be marked after exact source read and reuse legacy marks',async()=>{
 const old={...process.env},fetch=global.fetch,hash=new Map(),audit=[];
 const id='66666666-6666-4666-8666-666666666666',order=`IG-${id}`,sourceRef='L:OBE12345678901234567890';
 const legacy='SF-'+createHash('sha256').update(`sweetfun-operations-sheet-v1:order:${sourceRef.slice(2)}`).digest('hex').slice(0,20);
 const propertyId='22222222-2222-4222-8222-222222222222',workspaceId='11111111-1111-4111-8111-111111111111';
 const roomIds=Object.fromEntries(['101','102','201','202','301','302'].map((room,i)=>[room,`55555555-5555-4555-8555-55555555555${i}`]));
 const member={id:'c'.repeat(32),displayName:'Operator',email:'operator@example.test',role:'housekeeper',status:'active',allProperties:false,propertyIds:['sweetfun'],credential:{schema:1,kind:'password',revision:'d'.repeat(64),salt:'e'.repeat(32),hash:'f'.repeat(128)}};
 const booking={id,propertyId,workspaceId,status:'confirmed',version:1,stays:[{checkIn:'2026-10-25',checkOut:'2026-10-26',roomIds:[roomIds['101']]}]};
 const legacyState={version:1,notified:true,at:'2026-10-23T00:00:00.000Z',actor:member.id,actor_name:member.displayName,request_id:'legacy'};
 hash.set(legacy,JSON.stringify(legacyState));
 Object.assign(process.env,{BOOKING_SHEET_SOURCES:'sweetfun,offland',CALENDAR_OWNER_CODE_HASH:'a'.repeat(64),CALENDAR_OWNER_SESSION_SECRET:'b'.repeat(64),KV_REST_API_URL:'https://test.invalid',KV_REST_API_TOKEN:'test',IRON_GATE_SWEETFUN_CALENDAR_ENABLED:'true',IRON_GATE_SWEETFUN_CALENDAR_GRANT:JSON.stringify({credentialId:'33333333-3333-4333-8333-333333333333',clientId:'44444444-4444-4444-8444-444444444444',workspaceId,propertyId,token:'a'.repeat(43)}),IRON_GATE_SWEETFUN_ROOM_IDS:JSON.stringify(roomIds),IRON_GATE_SWEETFUN_OS_PROOF_SECRET:'private-test-proof-secret-32-bytes-long',IRON_GATE_SWEETFUN_BASE_URL:'https://iron-gate.example/',IRON_GATE_SWEETFUN_AUTHORITY_EPOCH:'1'});
 let sourceReads=0;
 global.fetch=async(url,options)=>{
  if(String(url).startsWith('https://iron-gate.example/')){sourceReads++;assert.match(String(url),new RegExp(`/bookings/${id}$`));return Response.json(booking);}
  const c=JSON.parse(options.body);let result=null;
  if(c[0]==='GET')result=JSON.stringify({version:1,members:[member]});
  if(c[0]==='HGET')result=hash.get(c[2])??null;
  if(c[0]==='HGETALL')result=[...hash].flat();
  if(c[0]==='EVAL'&&c[2]===1)result=1;
  if(c[0]==='EVAL'&&c[2]===2){const id=c[5],expected=c[6],next=c[7];if((hash.get(id)??'')!==expected)result=0;else{hash.set(id,next);audit.push(JSON.parse(c[8]));result=1;}}
  return Response.json({result});
 };
 const cookie=`${MEMBER_COOKIE}=${createMemberSession(member)}`;
 const request=(body)=>new NextRequest('https://local.test/api/v1/guest-notification',{method:'POST',headers:{origin:'https://local.test',host:'local.test',cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const input={property_id:'sweetfun',order_id:order,ig_booking_id:order,notified:true,expected_version:0,request_id:'12345678-1234-4123-8123-123456789012'};
 try{
  assert.equal(notificationOrderId(order),true);
  assert.equal(notificationOrderId('IG-invalid'),false);
  const response=await POST(request(input));assert.equal(response.status,200);
  assert.equal((await response.json()).state.notified,true);
  assert.equal(sourceReads,1);assert.equal(audit.length,1);
  const read=await GET(new NextRequest('https://local.test/api/v1/guest-notification?property=sweetfun',{headers:{cookie}}));
  assert.equal(read.status,200);assert.equal((await read.json()).states[order].version,1);
  assert.equal((await notificationStates('sweetfun'))[legacy].notified,true);
  const mismatched=await POST(request({...input,order_id:legacy,request_id:'12345678-1234-4123-8123-123456789013'}));
  assert.equal(mismatched.status,404);assert.equal(audit.length,1);
  booking.sourceCalendar={sourceOrderRef:sourceRef};
  const continued=await POST(request({...input,order_id:legacy,notified:false,expected_version:1,request_id:'12345678-1234-4123-8123-123456789015'}));
  assert.equal(continued.status,200);assert.equal((await continued.json()).state.version,2);
  assert.equal(audit.length,2);
  booking.status='cancelled';
  const cancelled=await POST(request({...input,request_id:'12345678-1234-4123-8123-123456789014'}));
  assert.equal(cancelled.status,404);assert.equal(audit.length,2);
 }finally{global.fetch=fetch;for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);}
});
