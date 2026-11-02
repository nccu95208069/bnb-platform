import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { studioAuthOperation } from '../src/lib/website-booking/studio-auth.ts';
import { newLoginProof, consumeEmailLogin } from '../src/lib/customer-workspaces/passwordless.ts';
import { accountKey } from '../src/lib/customer-workspaces/auth.ts';
import { newPasswordlessCredential } from '../src/lib/customer-workspaces/identity.ts';
import { websiteFixture } from './helpers/website-booking-fixture.mjs';

test('ordinary email creates a new Studio owner only after same-browser verification and preserves idempotency', async()=>{
 const f=await websiteFixture({approve:false}),email='brand-new-owner@example.invalid';
 const client={...f.client,id:'studio-email',allow_new_sites:true,editor_origin:'https://studio.example.invalid'};
 const proof=newLoginProof(),requestKey=randomUUID();let message,calls=0;
 const send=async(to,subject,text)=>{assert.equal(to,email);assert.match(subject,/Stayform/);message=text;calls++;return 'provider:new-owner'};
 const request={action:'request',origin:client.editor_origin,email,requestKey,proof};
 assert.equal((await studioAuthOperation(f.store,client,request,send)).status,'accepted');
 await studioAuthOperation(f.store,client,request,send);assert.equal(calls,1);
 assert.equal((await f.store.read(accountKey(email))).value,null);
 const link=new URL(message.match(/https:\/\/[^\s]+/)[0]);assert.equal(link.origin,client.editor_origin);assert.equal(link.pathname,'/auth/verify');
 const token=link.hash.slice(1),consume={action:'consume',origin:client.editor_origin,token,proof};
 await assert.rejects(studioAuthOperation(f.store,client,{...consume,proof:newLoginProof()},send),/LINK_INVALID/);
 await assert.rejects(consumeEmailLogin(f.store,token,proof),/LINK_INVALID/);
 await assert.rejects(studioAuthOperation(f.store,{...client,id:'different-client'},consume,send),/LINK_INVALID/);
 const result=await studioAuthOperation(f.store,client,consume,send);
 assert.equal(result.email,email);assert.equal(result.expiresIn,7*86400);assert(result.session);
 assert.equal((await studioAuthOperation(f.store,client,consume,send)).id,result.id);
 const account=(await f.store.read(accountKey(email))).value;
 assert.equal(account.id,result.id);assert(account.emailVerifiedAt);assert.deepEqual(account.workspaces,[]);
 const session=await studioAuthOperation(f.store,client,{action:'session',origin:client.editor_origin,session:result.session},send);
 assert.deepEqual(session,{id:result.id,email});assert.equal(calls,1);
 const saved=await f.store.read(accountKey(email));
 await f.store.commit([{key:accountKey(email),before:saved.raw,after:{...account,credential:newPasswordlessCredential()}}]);
 await assert.rejects(studioAuthOperation(f.store,client,{action:'session',origin:client.editor_origin,session:result.session},send),/UNAUTHORIZED/);
 await assert.rejects(studioAuthOperation(f.store,client,consume,send),/LINK_INVALID/);
});

test('Studio signup refuses legacy clients, different origins, caller redirects and reused requests with changed data',async()=>{
 const f=await websiteFixture({approve:false});const client={...f.client,allow_new_sites:true};
 const input={action:'request',origin:client.editor_origin,email:'other@example.invalid',requestKey:randomUUID(),proof:newLoginProof()};
 let calls=0;const send=async()=>{calls++;return 'provider:once'};
 for(const args of [ [{...client,allow_new_sites:false},input], [client,{...input,origin:'https://evil.example.invalid'}], [client,{...input,returnPath:'https://evil.example.invalid'}], [client,{...input,proof:'invalid'}] ]){
  await assert.rejects(studioAuthOperation(f.store,args[0],args[1],send),/FORBIDDEN|INVALID_INPUT|LOGIN_BROWSER_REQUIRED/);
 }
 assert.equal(calls,0);
 await studioAuthOperation(f.store,client,input,send);
 await assert.rejects(studioAuthOperation(f.store,client,{...input,email:'another@example.invalid'},send),/IDEMPOTENCY_CONFLICT/);
 assert.equal(calls,1);
});

test('failed Studio email delivery never reports a successful send or creates an account',async()=>{
 const f=await websiteFixture({approve:false}),email='delivery-failure@example.invalid',client={...f.client,allow_new_sites:true};
 const input={action:'request',origin:client.editor_origin,email,requestKey:randomUUID(),proof:newLoginProof()};let calls=0;
 const send=async()=>{calls++;throw Error('provider unavailable')};
 await assert.rejects(studioAuthOperation(f.store,client,input,send),/LOGIN_DELIVERY_UNCONFIRMED/);
 await assert.rejects(studioAuthOperation(f.store,client,input,send),/LOGIN_DELIVERY_UNCONFIRMED/);
 assert.equal(calls,1);assert.equal((await f.store.read(accountKey(email))).value,null);
});
