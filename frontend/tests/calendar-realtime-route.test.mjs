import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET } from '../src/app/api/v1/calendar/stream/route.ts';
import { createMemberSession, MEMBER_COOKIE } from '../src/lib/workspace-auth/session.ts';

test('stream rejects anonymous, cross-property, cross-site and reset-required sessions before subscription',async t=>{
  const original={...process.env};
  t.after(()=>{for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);});
  for(const key of Object.keys(process.env))if(key.startsWith('IRON_GATE_')||key.startsWith('UPSTASH_'))delete process.env[key];
  Object.assign(process.env,{CALENDAR_OWNER_CODE_HASH:'a'.repeat(64),CALENDAR_OWNER_SESSION_SECRET:'b'.repeat(64),KV_REST_API_URL:'https://fixture.invalid',KV_REST_API_TOKEN:'synthetic'});
  const member={id:'c'.repeat(32),displayName:'Synthetic',email:'synthetic@example.test',phone:null,role:'viewer_no_price',status:'active',allProperties:false,propertyIds:['offland'],mustResetPassword:false,invitation:null,version:1,credential:{schema:1,kind:'password',revision:'d'.repeat(64),salt:'e'.repeat(32),hash:'f'.repeat(128)}};
  let reads=0;
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    assert.equal(String(url),'https://fixture.invalid');
    assert.deepEqual(JSON.parse(options.body),['GET','sweetfun-os:workspace-auth:v1:members']);
    reads++;return Response.json({result:JSON.stringify({version:1,members:[member]})});
  });
  const cookie=`${MEMBER_COOKIE}=${createMemberSession(member)}`;
  const request=(properties,headers={})=>new NextRequest(`https://calendar.test/api/v1/calendar/stream?properties=${properties}`,{headers});
  assert.equal((await GET(request('offland'))).status,401);assert.equal(reads,0);
  assert.equal((await GET(request('sweetfun',{cookie}))).status,403);assert.equal(reads,1);
  assert.equal((await GET(request('offland,sweetfun',{cookie}))).status,403);
  assert.equal((await GET(request('offland',{cookie,origin:'https://foreign.invalid'}))).status,403);
  assert.equal((await GET(request('offland',{cookie,'sec-fetch-site':'cross-site'}))).status,403);
  const missing=await GET(request('offland',{cookie}));
  assert.equal(missing.status,503);assert.deepEqual(await missing.json(),{code:'CALENDAR_STREAM_UNAVAILABLE'});
  assert.match(missing.headers.get('Cache-Control'),/private, no-store/);
  member.mustResetPassword=true;
  assert.equal((await GET(request('offland',{cookie}))).status,401);
  member.mustResetPassword=false;member.status='suspended';
  assert.equal((await GET(request('offland',{cookie}))).status,401);
  assert.equal((await GET(request('unknown',{cookie}))).status,400);
});
