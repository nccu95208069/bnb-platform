import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { websiteFixture } from './helpers/website-booking-fixture.mjs';
import { amendWebsiteBooking } from '../src/lib/customer-workspaces/website-amendment.ts';
import { bookingOperation } from '../src/lib/customer-workspaces/operations.ts';
import { holdOperation } from '../src/lib/customer-workspaces/holds.ts';
import { addDays } from '../src/lib/website-booking/config.ts';
import { runWebsiteEmailDelivery } from '../src/lib/website-booking/delivery.ts';
import { enqueueExpiredHolds } from '../src/lib/website-booking/lifecycle.ts';
import { notificationFingerprint } from '../src/lib/website-booking/notifications.ts';

async function command(f, bookingId, fields) {
 const w=await f.workspace(),b=w.bookings.find(b=>b.id===bookingId);
 return {bookingId,version:w.version,bookingVersion:b.version,requestKey:randomUUID(),...fields};
}
const mutate=(f,input)=>amendWebsiteBooking(f.store,f.account.id,f.binding.slug,input,f.now);
const jobs=f=>[...f.store.values].filter(([k])=>k.startsWith('website:notification:')).map(([,v])=>JSON.parse(v));
async function convert(f,id){return holdOperation(f.store,f.account.id,f.binding.slug,await command(f,id,{action:'hold-convert',confirmedReceipt:true,confirmPlatformOnly:true,amount:1000,method:'cash',receivedAt:new Date(f.now.getTime()-1000).toISOString()}),f.now);}
async function operation(f,id,input){return bookingOperation(f.store,f.account.id,f.binding.slug,await command(f,id,input));}

test('amendment moves native occupancy, keeps order/payment/deadline, and guest replay reads the current safe summary',async()=>{
 const f=await websiteFixture({units:2}),{input:reservation,result}=await f.reserve();
 await convert(f,result.orderId);
 const before=(await f.workspace()).bookings[0],newRoom=f.binding.offers.find(o=>o.id==='double').roomIds.find(id=>!before.roomIds.includes(id));
 const fields={action:'website-amend',confirmed:true,checkIn:addDays(f.stay.checkIn,3),checkOut:addDays(f.stay.checkOut,3),roomIds:[newRoom],total:4600};
 const input=await command(f,result.orderId,fields);
 const changed=await mutate(f,input);assert(changed.operation.verified);assert.equal(changed.bookingId,result.orderId);
 const current=(await f.workspace()).bookings[0];assert.equal(current.status,'confirmed');assert.deepEqual(current.hold,before.hold);assert.deepEqual(current.payments,before.payments);assert.equal(current.nightlyPrices,undefined);
 assert.equal(current.website.reference,before.website.reference);assert.deepEqual(current.website.acceptedTerms,before.website.acceptedTerms);
 const lookup=await f.call('requests',{idempotencyKey:reservation.idempotencyKey});
 assert.deepEqual(lookup.stay,{checkIn:fields.checkIn,checkOut:fields.checkOut,roomTypeName:'Synthetic double',quantity:1,adults:2,children:0,totalCents:460000,currency:'TWD'});
 assert.equal(lookup.status,'confirmed');assert(!JSON.stringify(lookup).includes(newRoom));assert(!JSON.stringify(lookup).includes('@'));
 const replay=await f.call('reservations',reservation);assert.deepEqual(replay,lookup);
 assert.equal((await mutate(f,input)).operation.replayed,true);assert.equal(jobs(f).filter(j=>j.event==='booking_changed').length,3);
 await assert.rejects(mutate(f,{...input,total:4500}),/IDEMPOTENCY_CONFLICT/);
 assert((await f.call('availability',f.stay)).options.find(o=>o.roomTypeId==='double').availableUnits>0);
});

test('a reserved quote cannot overwrite the room taken by an amendment; old nights become available',async()=>{
 const f=await websiteFixture(),{result}=await f.reserve();
 const nextStay={...f.stay,checkIn:addDays(f.stay.checkIn,5),checkOut:addDays(f.stay.checkOut,5)};
 const q=await f.quote(nextStay),before=(await f.workspace()).bookings[0];
 await mutate(f,await command(f,result.orderId,{action:'website-amend',confirmed:true,checkIn:nextStay.checkIn,checkOut:nextStay.checkOut,roomIds:before.roomIds,total:4200}));
 await assert.rejects(f.reserve(q),/ROOM_CONFLICT/);
 assert.equal((await f.workspace()).bookings.length,1);
 assert((await f.call('availability',f.stay)).options.find(o=>o.roomTypeId==='double').availableUnits>0);
 const current=(await f.workspace()).bookings[0];assert.equal(current.hold.expiresAt,before.hold.expiresAt);assert.equal(current.status,'held');
});

test('amendment cannot bypass role, owner confirmation, versions, settlement, cross-property rooms, blocks or legacy ownership',async()=>{
 const f=await websiteFixture(),{result}=await f.reserve(),before=await f.workspace();
 const base=await command(f,result.orderId,{action:'website-amend',confirmed:true,...f.stay,roomIds:before.bookings[0].roomIds,total:4000});
 for(const key of ['roomTypeId','quantity','adults','children'])delete base[key];
 await assert.rejects(mutate(f,{...base,confirmed:false}),/BOOKING_CHANGE_CONFIRMATION_REQUIRED/);
 await assert.rejects(mutate(f,{...base,bookingVersion:999}),/VERSION_CONFLICT/);
 await assert.rejects(mutate(f,{...base,roomIds:[randomUUID()]}),/INVALID_INPUT/);
 await assert.rejects(mutate(f,{...base,total:0}),/INVALID_INPUT/);
 const wsKey='workspace:'+before.id;
 for(const role of ['viewer','housekeeper']){
  f.store.values.set(wsKey,JSON.stringify({...before,members:before.members.map(m=>({...m,role}))}));
  await assert.rejects(mutate(f,base),/FORBIDDEN/);
 }
 f.store.values.set(wsKey,JSON.stringify({...before,blocks:[{id:randomUUID(),propertyId:f.binding.propertyId,status:'active',...f.stay,roomIds:before.bookings[0].roomIds}]}));
 await assert.rejects(mutate(f,base),/ROOM_CONFLICT/);
 f.store.values.set(wsKey,JSON.stringify({...before,bookings:[{...before.bookings[0],entry:'sheet'}]}));
 await assert.rejects(mutate(f,base),/HOLD_INTEGRATION_REQUIRED/);
 f.store.values.set(wsKey,JSON.stringify(before));
 await convert(f,result.orderId);
 const smaller=await command(f,result.orderId,{...base,total:500,requestKey:randomUUID()});
 smaller.version=(await f.workspace()).version;smaller.bookingVersion=(await f.workspace()).bookings[0].version;
 await assert.rejects(mutate(f,smaller),/OVERPAYMENT_CONFIRMATION_REQUIRED/);
 const settled=await mutate(f,{...smaller,allowOverpayment:true});assert(settled.operation.verified);
 assert.equal((await f.workspace()).bookings[0].payments[0].amount,1000);
});

test('a lost amendment response reuses the receipt; a failed outbox transaction leaves occupancy unchanged',async()=>{
 const f=await websiteFixture(),{result}=await f.reserve(),before=await f.workspace();
 const input=await command(f,result.orderId,{action:'website-amend',confirmed:true,checkIn:addDays(f.stay.checkIn,2),checkOut:addDays(f.stay.checkOut,2),roomIds:before.bookings[0].roomIds,total:4500});
 const commit=f.store.commit.bind(f.store);f.store.commit=async()=>{throw Error('STORE_UNAVAILABLE');};
 await assert.rejects(mutate(f,input),/STORE_UNAVAILABLE/);assert.deepEqual(await f.workspace(),before);assert.equal(jobs(f).filter(j=>j.event==='booking_changed').length,0);
 let lost=true;f.store.commit=async changes=>{await commit(changes);if(lost){lost=false;throw Error('response lost');}};
 await assert.rejects(mutate(f,input),/response lost/);assert.equal((await mutate(f,input)).operation.replayed,true);
 assert.equal(jobs(f).filter(j=>j.event==='booking_changed').length,3);assert.equal((await f.workspace()).bookings.length,1);
});

test('two amendments to the same last room have one CAS winner and cannot overlap',async()=>{
 const f=await websiteFixture({units:2}),a=await f.reserve(),b=await f.reserve(),w=await f.workspace();
 const target=w.bookings[0].roomIds;
 const fields={action:'website-amend',confirmed:true,checkIn:addDays(f.stay.checkIn,4),checkOut:addDays(f.stay.checkOut,4),roomIds:target,total:4200};
 const inputs=await Promise.all([command(f,a.result.orderId,fields),command(f,b.result.orderId,fields)]);
 const outcomes=await Promise.allSettled(inputs.map(input=>mutate(f,input)));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.match(outcomes.find(r=>r.status==='rejected').reason.message,/VERSION_CONFLICT|ROOM_CONFLICT/);
 const changed=(await f.workspace()).bookings.filter(b=>b.checkIn===fields.checkIn);assert.equal(changed.length,1);assert.deepEqual(changed[0].roomIds,target);
});

test('terms and formal cancellation atomically queue current emails; payments never create duplicate order notifications',async()=>{
 const f=await websiteFixture(),{input:reservation,result}=await f.reserve();await convert(f,result.orderId);
 await operation(f,result.orderId,{action:'terms',total:4500,expectedDeposit:1200});
 let b=(await f.workspace()).bookings[0];assert.equal(b.nightlyPrices,undefined);assert.equal(jobs(f).filter(j=>j.event==='booking_changed').length,3);
 const sent=[];const send=async(to,subject,text)=>{sent.push({to,subject,text});return 'synthetic-provider:'+sent.length;};
 const delivery=await runWebsiteEmailDelivery(f.store,[f.binding.id],{send,now:()=>f.now});assert.equal(delivery.sent,2);assert(sent.every(m=>m.subject.includes('訂單資料已更新')));assert(sent.every(m=>m.text.includes('4500')));
 await assert.rejects(operation(f,result.orderId,{action:'cancel',confirmed:true}),/CANCELLATION_REQUIRES_SETTLEMENT/);
 await operation(f,result.orderId,{action:'payment',kind:'refund',amount:1000,method:'現金',receivedAt:new Date(f.now.getTime()-1000).toISOString()});
 assert.equal(jobs(f).filter(j=>j.event==='booking_changed').length,3);
 await assert.rejects(operation(f,result.orderId,{action:'cancel'}),/BOOKING_CANCELLATION_CONFIRMATION_REQUIRED/);
 const cancel=await command(f,result.orderId,{action:'cancel',confirmed:true});
 await bookingOperation(f.store,f.account.id,f.binding.slug,cancel);await bookingOperation(f.store,f.account.id,f.binding.slug,cancel);
 b=(await f.workspace()).bookings[0];assert.equal(b.status,'cancelled');assert.equal(b.hold.state,'converted');assert.equal(b.payments.length,2);
 assert.equal(jobs(f).filter(j=>j.event==='booking_cancelled').length,3);
 assert.equal((await runWebsiteEmailDelivery(f.store,[f.binding.id],{send,now:()=>f.now})).sent,2);
 assert(sent.slice(2).every(m=>m.subject.includes('取消')));
 assert.equal((await f.call('requests',{idempotencyKey:reservation.idempotencyKey})).status,'released');
 assert.equal((await runWebsiteEmailDelivery(f.store,[f.binding.id],{send,now:()=>f.now})).sent,0);assert.equal(sent.length,4);
});

test('accepted payment and cancellation text is immutable; old orders never acquire the latest policy as an invented snapshot',async()=>{
 const f=await websiteFixture(),{input,result}=await f.reserve();
 const terms={transferInstructions:f.config.transferInstructions,cancellationPolicy:f.config.cancellationPolicy};
 assert.deepEqual(result.acceptedTerms,terms);
 const key='website:binding:'+f.binding.id,binding=(await f.store.read(key)).value;
 f.store.values.set(key,JSON.stringify({...binding,config:{...binding.config,transferInstructions:'NEW bank instructions',cancellationPolicy:'NEW policy'}}));
 assert.deepEqual((await f.call('requests',{idempotencyKey:input.idempotencyKey})).acceptedTerms,terms);
 const w=await f.workspace();delete w.bookings[0].website.acceptedTerms;f.store.values.set('workspace:'+w.id,JSON.stringify(w));
 assert.equal((await f.call('requests',{idempotencyKey:input.idempotencyKey})).acceptedTerms,null);
});

test('amendment cannot shrink below guest capacity or race an approved room-mapping change',async()=>{
 const f=await websiteFixture({units:2}),q=await f.quote({quantity:2,adults:4}),{result}=await f.reserve(q),w=await f.workspace(),b=w.bookings[0];
 const input=await command(f,result.orderId,{action:'website-amend',confirmed:true,checkIn:b.checkIn,checkOut:b.checkOut,roomIds:[b.roomIds[0]],total:4000});
 await assert.rejects(mutate(f,input),/BOOKING_CAPACITY_CONFLICT/);assert.deepEqual(await f.workspace(),w);
 const key='website:binding:'+f.binding.id,read=f.store.read.bind(f.store);let reads=0;
 f.store.read=async k=>{if(k===key&&++reads===2){const changed=(await read(key)).value;changed.config.rooms[0].capacity=1;f.store.values.set(key,JSON.stringify(changed));}return read(k);};
 await assert.rejects(mutate(f,{...input,roomIds:b.roomIds}),/VERSION_CONFLICT/);assert.deepEqual(await f.workspace(),w);
});

test('old expiry notification receipt survives fingerprint upgrade without a duplicate reminder',async()=>{
 const f=await websiteFixture(),{result}=await f.reserve(),w=await f.workspace(),b=w.bookings[0];
 b.website.expiryNotifiedFingerprint=notificationFingerprint(b,1);f.store.values.set('workspace:'+w.id,JSON.stringify(w));
 const expired=new Date(f.now.getTime()+25*3600000);
 assert.equal((await enqueueExpiredHolds(f.store,f.binding.id,expired)).queued,0);
 assert.equal(jobs(f).filter(j=>j.event==='hold_expired').length,0);
 assert.equal((await f.workspace()).bookings.find(b=>b.id===result.orderId).status,'held');
});
