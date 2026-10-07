import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { websiteFixture } from './helpers/website-booking-fixture.mjs';
import { requestEmailLogin, consumeEmailLogin, newLoginProof, LOGIN_PROOF_COOKIE } from '../src/lib/customer-workspaces/passwordless.ts';
import { WEBSITE_LOGIN_COOKIE } from '../src/lib/website-booking/login.ts';
import * as Owner from '../src/app/api/website-booking/owner/route.ts';
import * as Login from '../src/app/api/customer-login/route.ts';
import { store as websiteStore } from '../src/lib/website-booking/http.ts';
import { store as customerStore } from '../src/lib/customer-workspaces/http.ts';
const origin='https://os.example.invalid';
function request(path,body,cookie){return new NextRequest(origin+path,{method:'POST',headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});}
function patch(t,store){for(const target of [websiteStore,customerStore])for(const key of ['read','commit','limit'])t.mock.method(target,key,store[key].bind(store));}
test('website login challenge is tied to intended connection and browser, with safe fixed return URL',async t=>{
 const f=await websiteFixture({approve:false});patch(t,f.store);const proof=newLoginProof(),requestKey=randomUUID();let sent,sendCount=0;
 const input={email:f.account.email,requestKey,proof,websiteConnectionId:f.connection.connectionId};
 const send=async(_to,_subject,text)=>{sent=text;sendCount++;return 'synthetic-mail-id';};
 assert.equal((await requestEmailLogin(f.store,input,send)).status,'accepted');await requestEmailLogin(f.store,input,send);assert.equal(sendCount,1);
 const token=sent.match(/\/signin#([^\s]+)/)[1];
 await assert.rejects(consumeEmailLogin(f.store,token,proof),/LINK_INVALID/);
 await assert.rejects(consumeEmailLogin(f.store,token,proof,undefined,undefined,randomUUID()),/LINK_INVALID/);
 await assert.rejects(requestEmailLogin(f.store,{...input,websiteConnectionId:randomUUID()},send),/IDEMPOTENCY_CONFLICT/);
 const response=await Login.POST(request('/api/customer-login',{action:'consume',token},`${LOGIN_PROOF_COOKIE}=${proof}; ${WEBSITE_LOGIN_COOKIE}=${f.connection.connectionId}`));
 assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).url,'/website-booking?connection='+f.connection.connectionId);
 assert.equal([...f.store.values.keys()].filter(k=>k.startsWith('workspace:')).length,0);
});
test('owner login route reports preview as unsent and requires browser binding and intended email',async t=>{
 const f=await websiteFixture({approve:false});patch(t,f.store);process.env.CUSTOMER_INTAKE_PREVIEW='true';t.after(()=>delete process.env.CUSTOMER_INTAKE_PREVIEW);
 const prepared=await Owner.POST(request('/api/website-booking/owner',{action:'login-prepare',connectionId:f.connection.connectionId}));assert.equal(prepared.status,200);
 const proof=prepared.cookies.get(LOGIN_PROOF_COOKIE).value,cookie=`${LOGIN_PROOF_COOKIE}=${proof}; ${WEBSITE_LOGIN_COOKIE}=${f.connection.connectionId}`;
 const input={action:'login-request',connectionId:f.connection.connectionId,email:f.account.email,requestKey:randomUUID()};
 assert.equal((await Owner.POST(request('/api/website-booking/owner',input))).status,400);
 assert.equal((await Owner.POST(request('/api/website-booking/owner',{...input,email:'other@example.invalid'},cookie))).status,403);
 const preview=await Owner.POST(request('/api/website-booking/owner',input,cookie));assert.equal(preview.status,200);const result=await preview.json();assert.equal(result.delivery,'preview');assert.match(result.detail,/尚未寄出/);
});
