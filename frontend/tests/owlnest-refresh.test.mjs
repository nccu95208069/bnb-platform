import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {NextRequest} from 'next/server';
import {refreshWindow,refreshedSnapshot,refreshOwlNest,readOwlNest} from '../src/lib/owlnest-refresh.ts';
import {PRICING_KEY} from '../src/lib/pricing-snapshot.ts';
import {POST} from '../src/app/api/v1/availability/refresh/route.ts';
import {createMemberSession,MEMBER_COOKIE} from '../src/lib/workspace-auth/session.ts';
import {createPasswordCredential} from '../src/lib/owner-password.ts';

const start='2026-09-14',end='2026-12-14',observed='2026-09-14T06:00:00.000Z';
const rooms=['101','102','201','202','301','302'];
const prior={schema:1,property_id:'sweetfun',version:'a'.repeat(20),source_commit:'b'.repeat(40),observed_at:'2026-09-07T00:00:00Z',cells:rooms.flatMap(room=>[start,'2027-04-01'].map(date=>({date,room,channels:{booking:1800},rack_price:2600,daytype:'平日',baseline_version:'v1',stock:null,sales_probability:{value:0.6,asof:'2026-09-07',source_version:'c'.repeat(20)}})))};
function payload(){
 const dates=[];for(let d=Date.parse(start);d<Date.parse(end);d+=86400000)dates.push(new Date(d).toISOString().slice(0,10));
 return {status:0,data:rooms.map((_,i)=>({room_id:29260+i,plans:[35000,35007,35005,35006,32116].map((id,j)=>({id,plan_items:dates.map(date=>({date,price:2000+j*100+i}))})),stocks:dates.map(date=>({date,count:1,is_lock:false}))}))};
}
test('window uses Taipei and clamps three calendar months at month end',()=>{
 assert.deepEqual(refreshWindow(new Date(observed)),{start,end});
 assert.deepEqual(refreshWindow(new Date('2026-11-30T16:01:00Z')),{start:'2026-12-01',end:'2027-03-01'});
 assert.deepEqual(refreshWindow(new Date('2026-01-31T01:00:00Z')),{start:'2026-01-31',end:'2026-04-30'});
});
test('all five channels retain distinct actual prices, rack and model metadata; old dates retain age',()=>{
 const result=refreshedSnapshot(payload(),prior,start,end,observed);
 const first=result.cells.find(c=>c.date===start&&c.room==='101');
 assert.equal(first.channels.booking,2200);assert.equal(first.channels.agoda,2300);
 assert.equal(first.rack_price,2600);assert.equal(first.sales_probability.value,0.6);assert.equal(first.observed_at,observed);
 assert.equal(result.cells.find(c=>c.date==='2027-04-01').observed_at,prior.observed_at);
 assert.equal(result.cells.length,91*6+6);
});
test('partial dates, missing channels/rooms, duplicates, and invalid numbers cannot publish',()=>{
 for(const change of [p=>p.data.pop(),p=>p.data[0].plans.pop(),p=>p.data[0].plans[0].plan_items.pop(),p=>p.data[0].plans.push(p.data[0].plans[0]),p=>p.data[0].plans[0].plan_items[0].price=NaN]){
  const p=payload();change(p);assert.throws(()=>refreshedSnapshot(p,prior,start,end,observed));
 }
});
test('verified atomic publish, lock contention and concurrent publisher preservation',async()=>{
 const encoded='gz1:'+gzipSync(JSON.stringify(prior)).toString('base64');
 for(const conflict of [false,true]){
  let saved=encoded,rollback=null,unlocked=false;
  const command=async c=>{
   if(c[0]==='SET')return 'OK';
   if(c[0]==='GET')return saved;
   if(c[0]==='EVAL'&&c[2]===3){if(conflict)return 0;rollback=saved;saved=c.at(-1);return 1;}
   unlocked=true;return 1;
  };
  const run=refreshOwlNest({command,read:async()=>payload(),now:()=>new Date(observed)});
  if(conflict){await assert.rejects(run,/CONFLICT/);assert.equal(saved,encoded);}
  else {assert.equal((await run).verified,true);assert.equal(rollback,encoded);assert.equal(JSON.parse(gunzipSync(Buffer.from(saved.slice(4),'base64'))).observed_at,observed);}
  assert.equal(unlocked,true);
 }
 let read=false;
 await assert.rejects(refreshOwlNest({command:async()=>null,read:async()=>{read=true;},now:()=>new Date(observed)}),/BUSY/);
 assert.equal(read,false);
});
test('incomplete source never publishes; uncertain publication never claims old prices were preserved',async()=>{
 const encoded='gz1:'+gzipSync(JSON.stringify(prior)).toString('base64');
 for(const scenario of ['incomplete','write-network','readback-network']){
  let published=false;
  const command=async c=>{
   if(c[0]==='SET')return 'OK';
   if(c[0]==='GET'){if(published)throw Error('network');return encoded;}
   if(c[0]==='EVAL'&&c[2]===3){published=true;if(scenario==='write-network')throw Error('network');return 1;}
   return 1;
  };
  await assert.rejects(refreshOwlNest({command,read:async()=>scenario==='incomplete'?{status:0,data:[]}:payload(),now:()=>new Date(observed)}),scenario==='incomplete'?/INCOMPLETE/:/UNCONFIRMED/);
  assert.equal(published,scenario!=='incomplete');
 }
});
test('reader only sends GET to fixed hotel, exclusive end translated, expired credentials are explicit',async t=>{
 process.env.OWLNEST_AUTHORIZATION='Bearer synthetic-test-token-12345';
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
  assert.equal(new URL(url).hostname,'www.owlting.com');assert.equal(new URL(url).searchParams.get('during_end_date'),'2026-12-13');
  return Response.json({status:30003});
 });
 await assert.rejects(readOwlNest(start,end),/AUTH_EXPIRED/);
 delete process.env.OWLNEST_AUTHORIZATION;
});
test('route rejects anonymous, cross-origin, reset-required, read-only and wrong-property before OwlNest reads',async t=>{
 process.env.CALENDAR_OWNER_CODE_HASH=createHash('sha256').update('test').digest('hex');process.env.CALENDAR_OWNER_SESSION_SECRET='b'.repeat(64);
 process.env.KV_REST_API_URL='https://test.invalid';process.env.KV_REST_API_TOKEN='test';
 const member={id:'c'.repeat(32),displayName:'Synthetic',role:'viewer',status:'active',propertyIds:['sweetfun'],allProperties:false,credential:await createPasswordCredential('Synthetic password testing!')};
 t.mock.method(globalThis,'fetch',async(url,opt)=>{assert.equal(url,'https://test.invalid');const c=JSON.parse(opt.body);assert.notEqual(c[1],PRICING_KEY);return Response.json({result:JSON.stringify({version:1,members:[member]})});});
 const request=(cookie,origin='https://test.invalid')=>new NextRequest('https://test.invalid/api/v1/availability/refresh',{method:'POST',headers:{origin,host:'test.invalid',...(cookie?{cookie}:{})}});
 assert.equal((await POST(request())).status,401);
 const cookie=()=>`${MEMBER_COOKIE}=${createMemberSession(member)}`;
 assert.equal((await POST(request(cookie(),'https://other.invalid'))).status,403);
 for(const role of ['viewer','viewer_no_price','housekeeper']){member.role=role;assert.equal((await POST(request(cookie()))).status,403);}
 member.role='admin';member.propertyIds=['offland'];assert.equal((await POST(request(cookie()))).status,403);
 member.propertyIds=['sweetfun'];member.mustResetPassword=true;assert.equal((await POST(request(cookie()))).status,401);
});
