import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { websiteFixture, editorToken, client, testEnvironment } from './helpers/website-booking-fixture.mjs';
import { accountKey, digest } from '../src/lib/customer-workspaces/auth.ts';
import { createHold, view } from '../src/lib/customer-workspaces/service.ts';
import { holdOperation } from '../src/lib/customer-workspaces/holds.ts';
import { orderMutation } from '../src/lib/customer-workspaces/order-mutations.ts';
import { approveConnection, connectionStatus, ownerConnection, prepareConnection } from '../src/lib/website-booking/connections.ts';
import { authenticatedBinding, guestAction } from '../src/lib/website-booking/booking.ts';
import { serviceClient, validateConfiguration } from '../src/lib/website-booking/config.ts';
import { addDays } from '../src/lib/website-booking/config.ts';
import { enqueueExpiredHolds } from '../src/lib/website-booking/lifecycle.ts';

test('prepare creates no property; only verified intended owner can atomically approve and recover same result',async()=>{
 const f=await websiteFixture({approve:false});
 assert.equal([...f.store.values.keys()].filter(k=>k.startsWith('workspace:')).length,0);
 await assert.rejects(approveConnection(f.store,{...f.account,email:'someone@example.invalid'},f.approval,f.now),/WEBSITE_OWNER_MISMATCH/);
 await assert.rejects(approveConnection(f.store,f.account,{...f.approval,confirmed:false},f.now),/INVALID_INPUT/);
 const account=f.store.values.get(accountKey(f.account.email));f.store.values.set(accountKey(f.account.email),JSON.stringify({...f.account,emailVerifiedAt:undefined}));
 await assert.rejects(approveConnection(f.store,f.account,f.approval,f.now),/WEBSITE_OWNER_MISMATCH/);f.store.values.set(accountKey(f.account.email),account);
 const commit=f.store.commit.bind(f.store);let lost=true;f.store.commit=async changes=>{await commit(changes);if(lost){lost=false;throw Error('response lost');}};
 assert.equal((await approveConnection(f.store,f.account,f.approval,f.now)).state,'connected');
 const recovered=await approveConnection(f.store,f.account,f.approval,f.now);assert.equal(recovered.state,'connected');
 assert.equal([...f.store.values.keys()].filter(k=>k.startsWith('workspace:')).length,1);
 await assert.rejects(approveConnection(f.store,f.account,{...f.approval,slug:'changed'},f.now),/IDEMPOTENCY_CONFLICT/);
});
test('service and binding credentials are separate; invalid site and caller authority are rejected',async()=>{
 const f=await websiteFixture();assert.equal(serviceClient(editorToken).id,client.id);
 assert.throws(()=>serviceClient(f.status.bindingToken),/UNAUTHORIZED/);
 await assert.rejects(authenticatedBinding(f.store,f.binding.id,editorToken),/UNAUTHORIZED/);
 await assert.rejects(prepareConnection(f.store,{...client,site_ids:[]},f.prepare,f.now),/FORBIDDEN/);
 for(const field of ['tenantId','workspaceId','actor','totalCents','roomIds'])await assert.rejects(f.call('availability',{...f.stay,[field]:'forged'}),/INVALID_INPUT/);
 await assert.rejects(guestAction(f.store,f.binding.id,f.status.bindingToken,'bootstrap',{...f.envelope,source:'LINE'}),/INVALID_INPUT/);
});
test('native calendar, server prices, room allocation and persistent outbox form one booking',async()=>{
 const f=await websiteFixture({units:2});const q=await f.quote({quantity:2,adults:4});assert.equal(q.totalCents,800000);
 const {input,result}=await f.reserve(q),w=await f.workspace(),b=w.bookings[0];
 assert.equal(result.status,'hold_active');assert.equal(b.platform,'Official Website');assert.equal(b.total,8000);assert.equal(b.roomIds.length,2);
 assert.equal(Date.parse(b.hold.expiresAt)-Date.parse(b.hold.startedAt),86400000);
 assert.equal(b.nightlyPrices.reduce((n,p)=>n+Math.round(p.amount*100),0),q.totalCents);
 assert.equal((await f.call('requests',{idempotencyKey:input.idempotencyKey})).orderId,b.id);
 assert.equal(result.notifications.guestEmail,'queued');assert.equal(result.notifications.ownerEmail,'queued');
 const a=await f.call('availability',f.stay);assert(a.options.every(o=>o.availableUnits===0));
 const afterCheckout=await f.call('availability',{...f.stay,checkIn:f.stay.checkOut,checkOut:addDays(f.stay.checkOut,1)});
 assert.equal(afterCheckout.options.find(o=>o.roomTypeId==='double').availableUnits,2);
 const json=JSON.stringify(await f.call('requests',{idempotencyKey:input.idempotencyKey}));assert(!json.includes('synthetic-guest'));assert(!json.includes(f.account.email));assert(!json.includes(f.binding.workspaceId));
 assert.equal(view(w,w.members[0]).bookings[0].website,undefined);
});
test('last-room website versus manual OS hold cannot both win; whole-house shares physical rooms',async()=>{
 const f=await websiteFixture(),q=await f.quote(),w=await f.workspace(),p=w.properties[0];
 const input={quoteId:q.quoteId,guest:{name:'Synthetic',email:'guest@example.invalid',phone:'+00000000',note:''},acceptedPolicy:true,idempotencyKey:randomUUID()};
 const outcomes=await Promise.allSettled([f.call('reservations',input),createHold(f.store,f.account.id,w.slug,{requestKey:randomUUID(),version:w.version,propertyId:p.id,roomIds:p.rooms.map(r=>r.id),checkIn:f.stay.checkIn,checkOut:f.stay.checkOut,total:4000,confirmPlatformOnly:true})]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.workspace()).bookings.length,1);
 await assert.rejects(f.quote({roomTypeId:'whole-house'}),/ROOM_CONFLICT/);
});
test('lost reservation response recovers identical order and jobs; altered or reused quote cannot duplicate',async()=>{
 const f=await websiteFixture(),q=await f.quote();const input={quoteId:q.quoteId,guest:{name:'Synthetic',email:'guest@example.invalid',phone:'+00000000',note:''},acceptedPolicy:true,idempotencyKey:randomUUID()};
 const commit=f.store.commit.bind(f.store);let lost=true;f.store.commit=async changes=>{await commit(changes);if(lost){lost=false;throw Error('response lost');}};
 const saved=await f.call('reservations',input);assert.equal(saved.status,'hold_active');const count=f.store.values.size;
 const recovered=await f.call('reservations',input,new Date(f.now.getTime()+6*60000));assert.equal(recovered.status,'hold_active');assert.equal(f.store.values.size,count);
 assert.equal((await f.workspace()).bookings.length,1);
 await assert.rejects(f.call('reservations',{...input,guest:{...input.guest,name:'changed'}}),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(f.call('reservations',{...input,idempotencyKey:randomUUID()}),/QUOTE_EXPIRED/);
});
test('simultaneous identical submission returns same order to both callers rather than false definite rejection',async()=>{
 const f=await websiteFixture(),q=await f.quote();const input={quoteId:q.quoteId,guest:{name:'Synthetic',email:'guest@example.invalid',phone:'+00000000',note:''},acceptedPolicy:true,idempotencyKey:randomUUID()};
 const [a,b]=await Promise.all([f.call('reservations',input),f.call('reservations',input)]);
 assert.equal(a.orderId,b.orderId);assert.equal((await f.workspace()).bookings.length,1);
});
test('expiry enqueues only owner reminders once without releasing or changing canonical booking version',async()=>{
 const f=await websiteFixture(),{input}=await f.reserve();const before=(await f.workspace()).bookings[0];const later=new Date(f.now.getTime()+86400001);
 assert.equal((await enqueueExpiredHolds(f.store,f.binding.id,later)).queued,1);
 assert.equal((await enqueueExpiredHolds(f.store,f.binding.id,later)).queued,0);
 const after=(await f.workspace()).bookings[0];assert.equal(after.version,before.version);assert.equal(after.status,'held');
 assert.equal(after.website.notificationIds.guestEmail,before.website.notificationIds.guestEmail);
 assert.notEqual(after.website.notificationIds.ownerEmail,before.website.notificationIds.ownerEmail);
 assert.equal((await f.call('requests',{idempotencyKey:input.idempotencyKey},later)).status,'hold_expired_waiting_owner');
});
test('quote cannot survive price update or turn observation into an inventory lock',async()=>{
 const f=await websiteFixture(),q=await f.quote();const w=await f.workspace();w.properties[0].pricing.base[w.properties[0].rooms[0].id]=2500;f.store.values.set('workspace:'+w.id,JSON.stringify(w));
 await assert.rejects(f.reserve(q),/CONFIGURATION_CHANGED/);assert.equal((await f.workspace()).bookings.length,0);
 const q2=await f.quote();assert.equal(q2.totalCents,500000);
 await assert.rejects(f.call('reservations',{quoteId:q2.quoteId,guest:{name:'Synthetic',email:'guest@example.invalid',phone:'+00000000',note:''},acceptedPolicy:true,idempotencyKey:randomUUID()},new Date(f.now.getTime()+6*60000)),/QUOTE_EXPIRED/);
});
test('lookup survives sales disable and configuration changes; expiry keeps inventory, owner conversion keeps source',async()=>{
 const f=await websiteFixture(),{input,result}=await f.reserve();
 process.env.WEBSITE_BOOKING_ENABLED='false';process.env.CUSTOMER_HOLDS_ENABLED='false';
 try {assert.equal((await f.call('requests',{idempotencyKey:input.idempotencyKey,configurationHash:'old'})).orderId,result.orderId);assert.equal((await f.call('reservations',input)).orderId,result.orderId);assert.equal((await f.call('bootstrap')).state,'unavailable');} finally {testEnvironment();}
 assert.equal((await f.call('requests',{idempotencyKey:input.idempotencyKey},new Date(f.now.getTime()+86400001))).status,'hold_expired_waiting_owner');
 let w=await f.workspace(),b=w.bookings[0];
 const op={action:'hold-convert',bookingId:b.id,bookingVersion:b.version,requestKey:randomUUID(),version:w.version,confirmPlatformOnly:true,confirmedReceipt:true,amount:1000,method:'cash',receivedAt:new Date(Date.now()-1000).toISOString()};
 await holdOperation(f.store,f.account.id,w.slug,op);assert.equal((await f.call('reservations',input)).status,'confirmed');
 w=await f.workspace();b=w.bookings[0];assert.equal(b.platform,'Official Website');
 await assert.rejects(orderMutation(f.store,f.account.id,w.slug,{action:'order-details',bookingId:b.id,bookingVersion:b.version,requestKey:randomUUID(),version:w.version,platform:'LINE'}),/BOOKING_SOURCE_IMMUTABLE/);
});
test('owner revocation, legacy source and calendar sync prevent new website reservations',async()=>{
 const f=await websiteFixture(),q=await f.quote();const w=await f.workspace();
 w.members[0].active=false;f.store.values.set('workspace:'+w.id,JSON.stringify(w));await assert.rejects(f.reserve(q),/BINDING_UNAVAILABLE/);
 w.members[0].active=true;w.properties[0].setup.mode='sheet';f.store.values.set('workspace:'+w.id,JSON.stringify(w));
 await assert.rejects(f.reserve(q),/LEGACY_INTEGRATION_REQUIRED/);assert.equal((await f.call('bootstrap')).state,'unavailable');
});
test('configuration updates require same owner, invalidate old connection, preserve old request lookup',async()=>{
 const f=await websiteFixture(),{input,result}=await f.reserve();const currentAccount=(await f.store.read(accountKey(f.account.email))).value;
 const config={...f.config,cancellationPolicy:'Updated synthetic policy'},hash=digest(JSON.stringify({reservationConfig:config,roomIds:f.prepare.roomRecords.map(r=>r.id)}));
 const request={...f.prepare,requestId:randomUUID(),reservationConfig:config,configurationHash:hash};const prepared=await prepareConnection(f.store,client,request,f.now);
 const w=await f.workspace(),approval={action:'approve',connectionId:prepared.connectionId,requestKey:randomUUID(),confirmed:true,mode:'existing',slug:w.slug,propertyId:w.properties[0].id,version:w.version,roomMappings:f.binding.physicalMappings};
 await approveConnection(f.store,currentAccount,approval,f.now);
 const old=await connectionStatus(f.store,client,{schemaVersion:1,action:'status',siteId:f.prepare.siteId,connectionId:f.connection.connectionId},f.now);assert.equal(old.state,'superseded');assert.equal(old.bindingToken,undefined);
 const next=await connectionStatus(f.store,client,{schemaVersion:1,action:'status',siteId:f.prepare.siteId,connectionId:prepared.connectionId},f.now);assert.equal(next.bindingId,f.binding.id);assert.equal(next.bindingToken,f.status.bindingToken);
 assert.equal((await f.call('requests',{idempotencyKey:input.idempotencyKey})).orderId,result.orderId);
 await assert.rejects(f.quote(),/CONFIGURATION_CHANGED/);
 const info=await ownerConnection(f.store,currentAccount,prepared.connectionId,f.now);assert(!JSON.stringify(info).includes(next.bindingToken));
});
test('configuration malformed dates, unexpected owner data and mismatched hash are rejected',async()=>{
 const f=await websiteFixture({approve:false});
 for(const update of [{opensOn:'2027-02-30'},{ownerEmail:'private@example.invalid'},{holdHours:48},{availabilityConfirmed:false}]){
  const config={...f.config,...update};const hash=digest(JSON.stringify({reservationConfig:config,roomIds:f.prepare.roomRecords.map(r=>r.id)}));
  assert.throws(()=>validateConfiguration(config,f.prepare.roomRecords,hash,f.now));
 }
 await assert.rejects(prepareConnection(f.store,client,{...f.prepare,siteName:'Changed'},f.now),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(connectionStatus(f.store,client,{schemaVersion:1,action:'status',siteId:f.prepare.siteId,connectionId:f.connection.connectionId},new Date(f.now.getTime()+3600001)),/CONNECTION_EXPIRED/);
});
test('older pending connection cannot overwrite a newer approved binding',async()=>{
 const f=await websiteFixture({approve:false});
 const newer=await prepareConnection(f.store,client,{...f.prepare,requestId:randomUUID()},f.now);
 await approveConnection(f.store,f.account,{...f.approval,connectionId:newer.connectionId},f.now);
 assert.equal((await connectionStatus(f.store,client,{schemaVersion:1,action:'status',siteId:f.prepare.siteId,connectionId:f.connection.connectionId},f.now)).state,'superseded');
 await assert.rejects(approveConnection(f.store,f.account,f.approval,f.now),/CONNECTION_SUPERSEDED/);
 assert.equal([...f.store.values.keys()].filter(k=>k.startsWith('workspace:')).length,1);
});
test('two quotes for a two-room type allocate the remaining room rather than pinning the initially quoted room',async()=>{
 const f=await websiteFixture({units:2}),a=await f.quote(),b=await f.quote();
 await f.reserve(a);await f.reserve(b);const w=await f.workspace();assert.equal(w.bookings.length,2);assert.notEqual(w.bookings[0].roomIds[0],w.bookings[1].roomIds[0]);
});
test('retry whose initial receipt read raced a completed reservation recovers before rejecting used quote',async()=>{
 const f=await websiteFixture(),q=await f.quote();const input={quoteId:q.quoteId,guest:{name:'Synthetic',email:'guest@example.invalid',phone:'+00000000',note:''},acceptedPolicy:true,idempotencyKey:randomUUID()};
 const read=f.store.read.bind(f.store);let intercept=true,original;
 f.store.read=async key=>{const saved=await read(key);if(intercept&&key.startsWith('website:request:')){intercept=false;original=await f.call('reservations',input);}return saved;};
 const result=await f.call('reservations',input);assert(original,'receipt read intercepted');assert.equal(result.orderId,original.orderId);assert.equal((await f.workspace()).bookings.length,1);
});
test('minor note revisions after expiry do not create repeated owner reminders',async()=>{
 const f=await websiteFixture();await f.reserve();const later=new Date(f.now.getTime()+86400001);
 assert.equal((await enqueueExpiredHolds(f.store,f.binding.id,later)).queued,1);
 const w=await f.workspace();w.version++;w.bookings[0].version++;w.bookings[0].notes='Private synthetic note';f.store.values.set('workspace:'+w.id,JSON.stringify(w));
 assert.equal((await enqueueExpiredHolds(f.store,f.binding.id,later)).queued,0);
});
