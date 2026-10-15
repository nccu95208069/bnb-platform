import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { memoryStore, testEnvironment, websiteFixture } from './helpers/website-booking-fixture.mjs';
import { requestDeviceEmailLogin as requestLogin, inspectDeviceEmailLogin as inspect, consumeDeviceEmailLogin as consume, pollDeviceEmailLogin as poll } from '../src/lib/customer-workspaces/email-device-login.ts';
import { newLoginProof, LOGIN_PROOF_COOKIE } from '../src/lib/customer-workspaces/passwordless.ts';
import { accountKey, authenticate, sessionFor } from '../src/lib/customer-workspaces/auth.ts';
import { newPasswordlessCredential } from '../src/lib/customer-workspaces/identity.ts';
import { studioAuthOperation } from '../src/lib/website-booking/studio-auth.ts';
import * as Login from '../src/app/api/customer-login/route.ts';
import { store as routeStore } from '../src/lib/customer-workspaces/http.ts';
function fixture(){
 testEnvironment();process.env.CUSTOMER_DEPLOYMENT_ORIGIN='https://os.example.invalid';
 const store=memoryStore(),mail=[];
 const input={email:'new+owner@example.invalid',proof:newLoginProof(),requestKey:randomUUID(),studio:{clientId:'studio-device',origin:'https://studio.example.invalid'}};
 const send=async(...args)=>{mail.push(args);return 'provider:'+mail.length};
 return {store,mail,input,send};
}
const tokenOf=mail=>new URL(mail[0][2].match(/https:\/\/\S+/)[0]).hash.slice(1);
const signup=async(f)=>{const challenge=await requestLogin(f.store,f.input,f.send);return {...challenge,token:tokenOf(f.mail)}};
const clientOf=f=>({id:f.input.studio.clientId,allow_new_sites:true,editor_origin:f.input.studio.origin});

test('different browser confirms phone and original browser only with the displayed pairing code',async()=>{
 const f=fixture(),c=await signup(f),phone=newLoginProof();
 assert.match(c.pairingCode,/^\d{6}$/);assert.match(c.token,/^v2\./);assert(!f.mail[0][2].includes(c.pairingCode));
 assert.equal((await f.store.read(accountKey(f.input.email))).value,null);
 assert.equal((await inspect(f.store,c.token,phone,f.input.studio.clientId)).sameDevice,false);
 assert.equal((await inspect(f.store,c.token,f.input.proof,f.input.studio.clientId)).sameDevice,true);
 assert.deepEqual(await poll(f.store,c.requestKey,f.input.proof,f.input.studio.clientId),{status:'pending'});
 await assert.rejects(consume(f.store,c.token,phone,'both',undefined,f.input.studio.clientId),/LOGIN_PAIRING_REQUIRED/);
 const wrong=c.pairingCode==='000000'?'999999':'000000';
 await assert.rejects(consume(f.store,c.token,phone,'both',wrong,f.input.studio.clientId),/LOGIN_PAIRING_INVALID/);
 assert.equal((await f.store.read(accountKey(f.input.email))).value,null);
 const verified=await consume(f.store,c.token,phone,'both',c.pairingCode,f.input.studio.clientId);
 assert.equal(verified.account.email,f.input.email);assert(verified.account.emailVerifiedAt);assert.equal(verified.originalDevice,false);
 const desktop=await poll(f.store,c.requestKey,f.input.proof,f.input.studio.clientId);
 assert.equal(desktop.status,'approved');assert.equal(desktop.account.id,verified.account.id);assert.equal(desktop.originalDevice,true);
 assert.equal((await authenticate(f.store,sessionFor(desktop.account))).id,verified.account.id);
 assert.equal((await consume(f.store,c.token,phone,'both',c.pairingCode,f.input.studio.clientId)).account.id,verified.account.id);
 assert.equal((await consume(f.store,c.token,f.input.proof,'current',undefined,f.input.studio.clientId)).account.id,verified.account.id);
 await assert.rejects(consume(f.store,c.token,newLoginProof(),'both',c.pairingCode,f.input.studio.clientId),/LINK_INVALID/);
 await assert.rejects(inspect(f.store,c.token,newLoginProof(),f.input.studio.clientId),/LINK_INVALID/);
});

test('phone-only sign in never authorizes the initiating browser, including a replay requesting more devices',async()=>{
 const f=fixture(),c=await signup(f),phone=newLoginProof();
 const verified=await consume(f.store,c.token,phone,'current',undefined,f.input.studio.clientId);
 assert.equal(verified.account.email,f.input.email);
 assert.deepEqual(await poll(f.store,c.requestKey,f.input.proof,f.input.studio.clientId),{status:'other_device'});
 await assert.rejects(consume(f.store,c.token,f.input.proof,'current',undefined,f.input.studio.clientId),/LINK_INVALID/);
 await assert.rejects(consume(f.store,c.token,phone,'both',c.pairingCode,f.input.studio.clientId),/LINK_INVALID/);
});

test('same browser remains one-click and protected against swapped scope, proof, token and redirects',async()=>{
 const f=fixture(),c=await signup(f);
 for(const scope of [undefined,'other-studio'])await assert.rejects(inspect(f.store,c.token,f.input.proof,scope),/LINK_INVALID/);
 await assert.rejects(poll(f.store,c.requestKey,newLoginProof(),f.input.studio.clientId),/LINK_INVALID/);
 await assert.rejects(inspect(f.store,c.token,undefined,f.input.studio.clientId),/LOGIN_BROWSER_REQUIRED/);
 const tampered=c.token.slice(0,-1)+(c.token.endsWith('A')?'B':'A');
 await assert.rejects(inspect(f.store,tampered,f.input.proof,f.input.studio.clientId),/LINK_INVALID/);
 await assert.rejects(requestLogin(f.store,{...f.input,returnPath:'https://evil.invalid'},f.send),/INVALID_INPUT/);
 await assert.rejects(requestLogin(f.store,{...f.input,studio:{...f.input.studio,origin:'https://other.invalid'}},f.send),/IDEMPOTENCY_CONFLICT/);
 const signed=await consume(f.store,c.token,f.input.proof,'current',undefined,f.input.studio.clientId);
 assert.equal(signed.originalDevice,true);assert.equal((await poll(f.store,c.requestKey,f.input.proof,f.input.studio.clientId)).account.id,signed.account.id);
});

test('delivery retry is idempotent, preserves plus addressing and accepts non-Gmail email domains',async()=>{
 for(const email of ['member+test@gmail.com','owner@outlook.com','owner@yahoo.com','owner@icloud.com','front.desk@independent-inn.example']){
  const f=fixture();f.input.email=email;const c=await signup(f),again=await requestLogin(f.store,f.input,f.send);
  assert.deepEqual(again,{status:'accepted',requestKey:c.requestKey,pairingCode:c.pairingCode,expiresAt:c.expiresAt});assert.equal(f.mail.length,1);assert.equal(f.mail[0][0],email);
 }
 const f=fixture();await assert.rejects(requestLogin(f.store,{...f.input,email:'member@gmail.com+test'},f.send),/INVALID_INPUT/);assert.equal(f.mail.length,0);
 await signup(f);await assert.rejects(requestLogin(f.store,{...f.input,email:'another@example.invalid'},f.send),/IDEMPOTENCY_CONFLICT/);
});

test('expiry and account credential rotation invalidate inspect, consume and polling',async()=>{
 const f=fixture(),c=await signup(f),phone=newLoginProof();
 const signed=await consume(f.store,c.token,phone,'both',c.pairingCode,f.input.studio.clientId);
 const saved=await f.store.read(accountKey(f.input.email));
 await f.store.commit([{key:accountKey(f.input.email),before:saved.raw,after:{...signed.account,credential:newPasswordlessCredential()}}]);
 await assert.rejects(inspect(f.store,c.token,phone,f.input.studio.clientId),/LINK_INVALID/);
 await assert.rejects(consume(f.store,c.token,phone,'current',undefined,f.input.studio.clientId),/LINK_INVALID/);
 await assert.rejects(poll(f.store,c.requestKey,f.input.proof,f.input.studio.clientId),/LINK_INVALID/);
 const other=fixture(),d=await signup(other),key='customer-device-login:'+d.requestKey,old=await other.store.read(key);
 await other.store.commit([{key,before:old.raw,after:{...old.value,expiresAt:Date.now()-1}}]);
 await assert.rejects(inspect(other.store,d.token,newLoginProof(),other.input.studio.clientId),/LINK_INVALID/);
 await assert.rejects(poll(other.store,d.requestKey,other.input.proof,other.input.studio.clientId),/LINK_INVALID/);
});

test('wrong confirmation codes exhaust a per-request attempt limit without affecting other login requests',async()=>{
 const f=fixture(),counts=new Map();f.store.limit=async(key,max)=>{const n=(counts.get(key)||0)+1;counts.set(key,n);if(n>max)throw Error('RATE_LIMITED')};
 const c=await signup(f),phone=newLoginProof(),wrong=c.pairingCode==='000000'?'111111':'000000';
 for(let n=0;n<5;n++)await assert.rejects(consume(f.store,c.token,phone,'both',wrong,f.input.studio.clientId),/LOGIN_PAIRING_INVALID/);
 await assert.rejects(consume(f.store,c.token,phone,'both',c.pairingCode,f.input.studio.clientId),/RATE_LIMITED/);
 assert.equal((await f.store.read(accountKey(f.input.email))).value,null);
});

test('concurrent consumption binds the link to one consumer and never creates duplicate accounts',async()=>{
 const f=fixture(),c=await signup(f),proofs=[newLoginProof(),newLoginProof()];
 const outcomes=await Promise.allSettled(proofs.map(proof=>consume(f.store,c.token,proof,'current',undefined,f.input.studio.clientId)));
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal([...f.store.values.keys()].filter(k=>k.startsWith('account:')).length,1);
 const winner=outcomes.findIndex(x=>x.status==='fulfilled'),loser=1-winner;
 await assert.rejects(consume(f.store,c.token,proofs[loser],'current',undefined,f.input.studio.clientId),/LINK_INVALID/);
 assert.equal((await consume(f.store,c.token,proofs[winner],'current',undefined,f.input.studio.clientId)).account.id,outcomes[winner].value.account.id);
});

test('generic sign in remains non-enumerating and unconfirmed delivery never creates an account',async()=>{
 const f=fixture();delete f.input.studio;
 const c=await requestLogin(f.store,f.input,f.send);assert.equal(c.status,'accepted');assert.equal(f.mail.length,0);
 assert.deepEqual(await poll(f.store,c.requestKey,f.input.proof),{status:'pending'});
 const other=fixture();let calls=0;const send=async()=>{calls++;throw Error('lost provider response')};
 assert.equal((await requestLogin(other.store,other.input,send)).status,'needs_attention');
 await requestLogin(other.store,other.input,send);assert.equal(calls,1);assert.equal((await other.store.read(accountKey(other.input.email))).value,null);
});

test('Studio device protocol is opt-in, server scoped, and returns one account to each approved device',async()=>{
 const f=fixture(),client=clientOf(f),input={action:'request',protocol:'device-v2',origin:client.editor_origin,email:f.input.email,requestKey:f.input.requestKey,proof:f.input.proof};
 const challenge=await studioAuthOperation(f.store,client,input,f.send),token=tokenOf(f.mail),phone=newLoginProof();
 assert.equal((await studioAuthOperation(f.store,client,{action:'inspect',origin:client.editor_origin,token,proof:phone},f.send)).email,f.input.email);
 const signed=await studioAuthOperation(f.store,client,{action:'consume',origin:client.editor_origin,token,proof:phone,mode:'both',pairingCode:challenge.pairingCode},f.send);
 const desktop=await studioAuthOperation(f.store,client,{action:'poll',origin:client.editor_origin,requestKey:challenge.requestKey,proof:f.input.proof},f.send);
 assert.equal(desktop.status,'approved');assert.equal(desktop.id,signed.id);assert.equal(desktop.expiresIn,604800);
 await assert.rejects(studioAuthOperation(f.store,{...client,id:'other'},{action:'poll',origin:client.editor_origin,requestKey:challenge.requestKey,proof:f.input.proof},f.send),/LINK_INVALID/);
});

function req(body,proof){return new NextRequest('https://os.example.invalid/api/customer-login',{method:'POST',headers:{origin:'https://os.example.invalid','content-type':'application/json',...(proof?{cookie:LOGIN_PROOF_COOKIE+'='+proof}:{})},body:JSON.stringify(body)})}
test('real OS route supports cross-browser owner approval links with secure cookies and no exposed session',async t=>{
 const f=await websiteFixture({approve:false});process.env.CUSTOMER_DEPLOYMENT_ORIGIN='https://os.example.invalid';
 for(const name of ['read','commit','limit'])t.mock.method(routeStore,name,f.store[name].bind(f.store));
 const mail=[],proof=newLoginProof(),phone=newLoginProof(),requestKey=randomUUID();
 const challenge=await requestLogin(f.store,{email:f.account.email,requestKey,proof,websiteConnectionId:f.connection.connectionId},async(...args)=>{mail.push(args);return 'provider:1'}),token=tokenOf(mail);
 const pending=await Login.POST(req({action:'poll',requestKey},proof));assert.deepEqual(await pending.json(),{status:'pending'});
 const details=await Login.POST(req({action:'inspect',token},phone));assert.equal(details.status,200);assert.equal((await details.json()).sameDevice,false);
 const signed=await Login.POST(req({action:'consume',token,mode:'both',pairingCode:challenge.pairingCode},phone));assert.equal(signed.status,200,await signed.clone().text());
 assert.match(signed.headers.get('set-cookie'),/HttpOnly/);assert.match(signed.headers.get('set-cookie'),/Secure/);
 assert.deepEqual(await signed.json(),{url:'/website-booking?connection='+f.connection.connectionId});
 const desktop=await Login.POST(req({action:'poll',requestKey},proof));assert.equal(desktop.status,200);assert.deepEqual(await desktop.json(),{url:'/website-booking?connection='+f.connection.connectionId});
 assert.equal((await Login.POST(req({action:'poll',requestKey},newLoginProof()))).status,400);
});
