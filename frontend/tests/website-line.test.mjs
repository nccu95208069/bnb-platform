import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { websiteFixture } from './helpers/website-booking-fixture.mjs';
import { prepareLinePairing, consumeLinePairing } from '../src/lib/website-booking/line-pairing.ts';
import { ownerAction } from '../src/lib/website-booking/owner-actions.ts';

const sender='U'+'1'.repeat(32), other='U'+'2'.repeat(32);
async function paired(){
 const f=await websiteFixture();
 const worker={id:'synthetic-line-worker',token_sha256:'a'.repeat(64),binding_ids:[f.binding.id],actions:['line_binding','owner_actions']};
 const prepare={action:'line-prepare',connectionId:f.connection.connectionId,requestKey:randomUUID()};
 const pair=await prepareLinePairing(f.store,f.account,prepare,f.now);
 const consume={schemaVersion:1,bindingId:f.binding.id,pairingToken:pair.pairingToken,recipientId:sender};
 return {...f,worker,prepare,pair,consume};
}
test('LINE pairing is owner/browser initiated, short lived, action/binding/sender scoped and replay safe',async()=>{
 const f=await paired();assert.equal((await prepareLinePairing(f.store,f.account,f.prepare,f.now)).pairingToken,f.pair.pairingToken);
 await assert.rejects(prepareLinePairing(f.store,{...f.account,id:randomUUID()},f.prepare,f.now),/FORBIDDEN/);
 await assert.rejects(consumeLinePairing(f.store,{...f.worker,actions:['notifications']},f.consume,f.now),/FORBIDDEN/);
 await assert.rejects(consumeLinePairing(f.store,{...f.worker,binding_ids:[]},f.consume,f.now),/FORBIDDEN/);
 await assert.rejects(consumeLinePairing(f.store,f.worker,{...f.consume,recipientId:'C'+'1'.repeat(32)},f.now),/INVALID_INPUT/);
 await assert.rejects(consumeLinePairing(f.store,f.worker,f.consume,new Date(f.now.getTime()+600001)),/PAIRING_EXPIRED/);
 assert.equal((await consumeLinePairing(f.store,f.worker,f.consume,f.now)).state,'connected');
 assert.equal((await consumeLinePairing(f.store,f.worker,f.consume,f.now)).state,'connected');
 await assert.rejects(consumeLinePairing(f.store,f.worker,{...f.consume,recipientId:other},f.now),/IDEMPOTENCY_CONFLICT/);
 const next=await prepareLinePairing(f.store,f.account,{...f.prepare,requestKey:randomUUID()},f.now);
 await consumeLinePairing(f.store,f.worker,{...f.consume,pairingToken:next.pairingToken},f.now);
 await assert.rejects(consumeLinePairing(f.store,f.worker,f.consume,f.now),/IDEMPOTENCY_CONFLICT/);
});
test('pairing response loss is recovered without accepting a different verified recipient',async()=>{
 const f=await paired(),commit=f.store.commit.bind(f.store);let lose=true;
 f.store.commit=async changes=>{await commit(changes);if(lose){lose=false;throw Error('response lost');}};
 assert.equal((await consumeLinePairing(f.store,f.worker,f.consume,f.now)).state,'connected');
 assert.equal((await f.store.read('website:binding:'+f.binding.id)).value.ownerLine.pairingId,f.pair.pairingId);
});
test('an older unused pairing cannot replace a newer successful pairing',async()=>{
 const f=await paired();const next=await prepareLinePairing(f.store,f.account,{...f.prepare,requestKey:randomUUID()},f.now);
 await consumeLinePairing(f.store,f.worker,{...f.consume,pairingToken:next.pairingToken,recipientId:other},f.now);
 await assert.rejects(consumeLinePairing(f.store,f.worker,f.consume,f.now),/PAIRING_EXPIRED/);
 assert.equal((await f.store.read('website:binding:'+f.binding.id)).value.ownerLine.recipientId,other);
});
test('LINE extends and converts exactly the website order, recovers lost result and rejects stale release',async()=>{
 const f=await paired();await consumeLinePairing(f.store,f.worker,f.consume,f.now);const {result}=await f.reserve();
 const common={schemaVersion:1,bindingId:f.binding.id,recipientId:sender,bookingId:result.orderId};
 let info=await ownerAction(f.store,f.worker,{...common,action:'inspect'},f.now);
 assert.equal(info.source,'Official Website');assert.equal(info.remaining,4000);assert(!JSON.stringify(info).includes('synthetic-guest'));
 const extend={...common,action:'hold-extend',requestKey:randomUUID(),version:info.version,bookingVersion:info.bookingVersion,confirmed:true,confirmPlatformOnly:true,hours:12};
 info=await ownerAction(f.store,f.worker,extend,f.now);assert.equal(info.bookingId,result.orderId);
 const convert={...common,action:'hold-convert',requestKey:randomUUID(),version:info.version,bookingVersion:info.bookingVersion,confirmed:true,confirmPlatformOnly:true,confirmedReceipt:true,amount:1000,method:'cash',receivedAt:new Date(f.now.getTime()-1000).toISOString()};
 const commit=f.store.commit.bind(f.store);let lose=true;f.store.commit=async changes=>{await commit(changes);if(lose){lose=false;throw Error('response lost');}};
 info=await ownerAction(f.store,f.worker,convert,f.now);assert.equal(info.status,'confirmed');assert.equal(info.remaining,3000);assert(info.operation.replayed);
 assert((await ownerAction(f.store,f.worker,convert,f.now)).operation.replayed);assert.equal((await f.workspace()).bookings[0].payments.length,1);
 await assert.rejects(ownerAction(f.store,f.worker,{...extend,action:'hold-release',requestKey:randomUUID(),hours:undefined},f.now),/INVALID_INPUT/);
 const stale={...extend};delete stale.hours;await assert.rejects(ownerAction(f.store,f.worker,{...stale,action:'hold-release',requestKey:randomUUID()},f.now),/VERSION_CONFLICT/);
});
test('LINE owner actions cannot cross bindings, forge sender, bypass confirmation or survive binding revocation',async()=>{
 const f=await paired();await consumeLinePairing(f.store,f.worker,f.consume,f.now);const {result}=await f.reserve();
 const common={schemaVersion:1,bindingId:f.binding.id,recipientId:sender,bookingId:result.orderId,action:'inspect'};
 await assert.rejects(ownerAction(f.store,{...f.worker,actions:['notifications']},common,f.now),/FORBIDDEN/);
 await assert.rejects(ownerAction(f.store,f.worker,{...common,recipientId:other},f.now),/FORBIDDEN/);
 await assert.rejects(ownerAction(f.store,f.worker,{...common,bookingId:randomUUID()},f.now),/NOT_FOUND/);
 await assert.rejects(ownerAction(f.store,f.worker,{...common,workspaceId:'forged'},f.now),/INVALID_INPUT/);
 const info=await ownerAction(f.store,f.worker,common,f.now);
 const release={...common,action:'hold-release',requestKey:randomUUID(),version:info.version,bookingVersion:info.bookingVersion,confirmPlatformOnly:true};
 await assert.rejects(ownerAction(f.store,f.worker,release,f.now),/OWNER_CONFIRMATION_REQUIRED/);
 const commit=f.store.commit.bind(f.store);let revoke=true;
 f.store.commit=async changes=>{if(revoke){revoke=false;const key='website:binding:'+f.binding.id;const b=(await f.store.read(key)).value;f.store.values.set(key,JSON.stringify({...b,ownerLine:{...b.ownerLine,recipientId:other}}));}await commit(changes);};
 await assert.rejects(ownerAction(f.store,f.worker,{...release,confirmed:true},f.now),/VERSION_CONFLICT/);
 assert.equal((await f.workspace()).bookings[0].status,'held');
});
test('global workspace shutdown blocks LINE writes while sales-only shutdown preserves existing-order management',async()=>{
 const f=await paired();await consumeLinePairing(f.store,f.worker,f.consume,f.now);const {result}=await f.reserve();
 const common={schemaVersion:1,bindingId:f.binding.id,recipientId:sender,bookingId:result.orderId,action:'inspect'};
 process.env.WEBSITE_BOOKING_ENABLED='false';
 assert.equal((await ownerAction(f.store,f.worker,common,f.now)).bookingId,result.orderId);
 await assert.rejects(consumeLinePairing(f.store,f.worker,f.consume,f.now),/WEBSITE_BOOKING_UNAVAILABLE/);
 process.env.CUSTOMER_WORKSPACES_ENABLED='false';
 await assert.rejects(ownerAction(f.store,f.worker,common,f.now),/WEBSITE_BOOKING_UNAVAILABLE/);
});
