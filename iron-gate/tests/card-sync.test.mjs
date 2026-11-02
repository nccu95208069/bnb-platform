import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryPropertyRepository} from '../src/memory-repository.ts';
import {IronGateService} from '../src/service.ts';
import {createHandler} from '../src/http.ts';
const w='11111111-1111-4111-8111-111111111111',p='22222222-2222-4222-8222-222222222222',b='33333333-3333-4333-8333-333333333333',r='44444444-4444-4444-8444-444444444444';
const principal={clientId:'card-client',subjectId:'card-sync',origin:'finance',workspaceId:w,propertyIds:[p],authorityEpoch:1,actions:['card:sync'],fields:['money']};
const input={sheetId:'1ccdaF5t0uIo0yqoJdSgKoG68UnBeWzCXfV5dQtMeK4A',tab:'20261027-20261101',row:2,platform:'booking',orderId:'1234567890',checkIn:'2026-11-01',checkOut:'2026-11-03',amountCents:100000,status:'done',chargeDate:'2026-10-27'};
function setup(change=()=>{}){const repository=new MemoryPropertyRepository();const booking={id:b,propertyId:p,workspaceId:w,version:1,status:'confirmed',channelSyncState:'verified',channelOperationKey:null,source:'external',sourceKey:null,stays:[{checkIn:input.checkIn,checkOut:input.checkOut,roomIds:[r]}],guestName:'Synthetic',contact:null,notes:null,totalCents:100000,currency:'TWD',bookedAt:null,createdAt:'2026-10-01T00:00:00Z',sourceCalendar:{platform:'Booking.com',externalOrderNo:input.orderId}};const state={workspaceId:w,propertyId:p,roomIds:[r],version:1,authorityEpoch:1,channel:{mode:'none',ready:false,websiteSalesEnabled:false,grantId:null,websiteBindingId:null},sourceGrants:[],bookings:[booking],sourceLinks:[],operations:[],fences:[],manualBlocks:[],receipts:[]};change(state,booking);repository.seed(state);return {repository,service:new IronGateService(repository)};}
async function commit(service,value=input){const plan=await service.previewCardSync(principal,p,value);return service.recordCardSync(principal,p,crypto.randomUUID(),{...value,bookingId:plan.bookingId,expectedBookingVersion:plan.bookingVersion});}
test('full Done creates exactly one canonical credit-card receipt across requests, row moves and concurrent retries',async()=>{const {service,repository}=setup();const plan=await service.previewCardSync(principal,p,input);assert.equal(plan.action,'record_received');assert.equal((await repository.read(p)).bookings[0].paymentEvents,undefined);const body={...input,bookingId:b,expectedBookingVersion:1};const results=await Promise.all([service.recordCardSync(principal,p,crypto.randomUUID(),body),service.recordCardSync(principal,p,crypto.randomUUID(),body)]);assert.equal(results[0].paymentEventId,results[1].paymentEventId);await commit(service,{...input,tab:'20261102-20261108',row:9});const after=(await repository.read(p)).bookings[0];assert.equal(after.paymentEvents.length,1);assert.equal(after.paymentEvents[0].method,'credit_card');assert.equal(after.paymentEvents[0].amountCents,100000);assert.equal(after.paymentEvents[0].occurredAt,'2026-10-27T00:00:00+08:00');});
test('Fail has no money; Fail to Done adds once; Done to Fail or changed amount/date requires review',async()=>{const {service,repository}=setup();await commit(service,{...input,status:'fail',chargeDate:null});assert.equal((await repository.read(p)).bookings[0].paymentEvents?.length??0,0);await commit(service);for(const patch of [{status:'fail',chargeDate:null},{amountCents:50000},{chargeDate:'2026-10-26'}])await assert.rejects(()=>commit(service,{...input,...patch}),e=>e.code==='CARD_RESULT_CONFLICT');assert.equal((await repository.read(p)).bookings[0].cardChargeResults.length,2);});
test('exact identity, full total, active order and current scope are mandatory',async()=>{for(const [patch,code] of [[{amountCents:50000},'CARD_AMOUNT_MISMATCH'],[{orderId:'9999999999'},'CARD_ORDER_NOT_FOUND'],[{checkOut:'2026-11-04'},'CARD_STAY_MISMATCH'],[{tab:'20261019-20261025'},'CARD_HISTORY_REVIEW'],[{chargeDate:'2026-10-25'},'CARD_HISTORY_REVIEW']]){const {service}=setup();await assert.rejects(()=>commit(service,{...input,...patch}),e=>e.code===code);}for(const change of [(s,b)=>{s.bookings.push({...b,id:r});},(s,b)=>{b.status='cancelled';},(s,b)=>{b.paymentEvents=[{id:r,kind:'received',amountCents:1,currency:'TWD',evidenceRef:'synthetic',occurredAt:'2026-10-26T00:00:00Z',recordedAt:'2026-10-26T00:00:00Z',actorId:'test'}];},(s,b)=>{b.sweetfunSnapshot={rows:[{values:['','','Booking.com','','','','','done']}]};}]){const {service}=setup(change);await assert.rejects(()=>commit(service));}});
test('stale preview and unauthorized caller cannot write; HTTP rejects card details',async()=>{const {service,repository}=setup();await assert.rejects(()=>service.recordCardSync(principal,p,crypto.randomUUID(),{...input,bookingId:b,expectedBookingVersion:2}),e=>e.code==='VERSION_CONFLICT');await assert.rejects(()=>service.previewCardSync({...principal,origin:'os'},p,input),e=>e.code==='FORBIDDEN');const handle=createHandler(service,async()=>principal);const response=await handle(new Request(`http://local/v1/properties/${p}/card-sync/preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,cardNumber:'synthetic-secret'})}));assert.equal(response.status,400);assert.equal((await repository.read(p)).bookings[0].paymentEvents,undefined);});
test('card-managed Booking payments join finance snapshot and calendar paid status',async()=>{const {service}=setup();await commit(service);const os={...principal,origin:'os',actions:['finance:ledger','booking:read'],fields:['money','payment_status']};const snapshot=await service.directFinanceSnapshot(os,p);assert.equal(snapshot.bookings.length,1);assert.equal(snapshot.bookings[0].source,'external');assert.equal(snapshot.bookings[0].cardManaged,true);const order=await service.getBooking(os,p,b);assert.equal(order.paymentReview.status,'paid');assert.equal(order.cardManaged,true);const blind=await service.getBooking({...os,fields:['payment_status']},p,b);assert.equal(blind.cardManaged,undefined);assert.equal(blind.cardChargeResult,undefined);const finance=await service.getBooking({...os,origin:'finance',fields:['money']},p,b);assert.equal(finance.cardManaged,undefined);});

test('Card-managed external orders reject extra receipts and refunds of another source',async()=>{
 const {service,repository}=setup();const result=await commit(service);
 const os={...principal,origin:'os',actions:['payment:write'],fields:['money']};
 const payment={expectedBookingVersion:2,eventId:crypto.randomUUID(),kind:'received',
  amountCents:1000,currency:'TWD',evidenceRef:'extra-card-receipt',
  occurredAt:'2026-10-28T10:00:00+08:00',method:'credit_card'};
 await assert.rejects(service.recordPaymentEvent(os,p,b,crypto.randomUUID(),payment),
  error=>error.code==='SOURCE_MAPPING_REVIEW_REQUIRED');
 await assert.rejects(service.recordPaymentEvent(os,p,b,crypto.randomUUID(),{
  ...payment,eventId:crypto.randomUUID(),kind:'refunded',
  refundOfEventId:crypto.randomUUID(),evidenceRef:'wrong-card-source'}),
  error=>error.code==='SOURCE_MAPPING_REVIEW_REQUIRED');
 const after=await repository.read(p);
 assert.equal(after.bookings[0].version,2);
 assert.equal(after.bookings[0].paymentEvents.length,1);
 assert.equal(after.bookings[0].paymentEvents[0].id,result.paymentEventId);
});

test('dedicated card credential cannot inherit source or generic payment capabilities',async()=>{
 const {validateGrantShape}=await import('../src/credential-grant.mjs');
 const grant={...principal,credentialId:b,propertyId:p};validateGrantShape(grant);
 for(const patch of [{origin:'os'},{fields:[]},{actions:['card:sync','payment:write']},{actions:['card:sync','source:write']}])assert.throws(()=>validateGrantShape({...grant,...patch}));
});
test('failed result never clears the legacy source-paid display',async()=>{
 const {service}=setup((s,b)=>{b.sweetfunSnapshot={rows:[{values:['','','Booking.com','','','','','done']}]};});
 await commit(service,{...input,status:'fail',chargeDate:null});
 const result=await service.getBooking({...principal,origin:'os',actions:['booking:read'],fields:['payment_status']},p,b);
 assert.equal(result.paymentReview.status,'paid');assert.equal(result.cardChargeResult,undefined);
});

test('card results do not turn a later valid source cancellation into version divergence',async()=>{
 for(const status of ['fail','done']) {
  const {service,repository}=setup(s=>{s.bookings=[];s.sourceGrants=[{grantId:r,sourceSystem:'synthetic',sourceAccount:'synthetic',active:true}];});
  const source={...principal,origin:'source',subjectId:'synthetic-writer',grantId:r,actions:['source:write'],fields:[],sourceSystem:'synthetic',sourceAccount:'synthetic'};
  const notice={propertyId:p,sourceSystem:'synthetic',sourceAccount:'synthetic',externalOrderId:'L:SYNTHETIC-ONLY',sourceVersion:'v1',previousSourceVersion:null,kind:'upsert',expectedInventoryVersion:1,stays:[{checkIn:input.checkIn,checkOut:input.checkOut,roomIds:[r]}],guestName:'Synthetic',bookedAt:null,totalCents:input.amountCents,currency:'TWD',platform:'booking',externalOrderNo:input.orderId};
  assert.equal((await service.applySourceEvent(source,crypto.randomUUID(),notice)).state,'applied');
  await commit(service,{...input,status,chargeDate:status==='done'?input.chargeDate:null});
  const before=await repository.read(p);
  const result=await service.applySourceEvent(source,crypto.randomUUID(),{...notice,kind:'cancel',sourceVersion:'v2',previousSourceVersion:'v1',expectedInventoryVersion:before.version});
  assert.equal(result.state,'applied');
  const after=await repository.read(p);
  assert.equal(after.bookings[0].status,'cancelled');
  assert.equal(after.bookings[0].paymentEvents?.length??0,status==='done'?1:0);
 }
});

test('card result cannot clear a pre-existing source version divergence',async()=>{
 const {service,repository}=setup((s,b)=>{b.version=2;s.sourceLinks=[{bookingId:b.id,lastAppliedBookingVersion:1,diverged:false,externalOrderId:'L:SYNTHETIC-ONLY'}];});
 await assert.rejects(()=>commit(service,{...input,status:'fail',chargeDate:null}),e=>e.code==='CARD_ORDER_REVIEW');
 assert.equal((await repository.read(p)).sourceLinks[0].lastAppliedBookingVersion,1);
});

test('an incomplete source update keeps the order resolvable and Fail replay creates no money',async()=>{
 const {service,repository}=setup(s=>{s.sourceGrants=[{grantId:r,sourceSystem:'synthetic',sourceAccount:'synthetic',active:true}];s.sourceLinks=[{key:JSON.stringify(['synthetic','synthetic','L:SYNTHETIC-ONLY']),sourceSystem:'synthetic',sourceAccount:'synthetic',externalOrderId:'L:SYNTHETIC-ONLY',bookingId:b,sourceVersion:'v1',lastAppliedBookingVersion:1,diverged:false,tombstoneNights:[]}];});
 const source={...principal,origin:'source',subjectId:'synthetic-writer',grantId:r,actions:['source:write'],fields:[],sourceSystem:'synthetic',sourceAccount:'synthetic'};
 assert.equal((await service.applySourceEvent(source,crypto.randomUUID(),{propertyId:p,sourceSystem:'synthetic',sourceAccount:'synthetic',externalOrderId:'L:SYNTHETIC-ONLY',sourceVersion:'v2',previousSourceVersion:'v1',kind:'upsert',expectedInventoryVersion:1,stays:[{checkIn:input.checkIn,checkOut:input.checkOut,roomIds:[r]}],guestName:'Synthetic',bookedAt:null,totalCents:input.amountCents,currency:'TWD',platform:'booking',externalOrderNo:null})).state,'applied');
 const failed={...input,status:'fail',chargeDate:null};
 await commit(service,failed);await commit(service,failed);
 const after=await repository.read(p);
 assert.equal(after.bookings[0].sourceCalendar.externalOrderNo,input.orderId);
 assert.equal(after.bookings[0].cardChargeResults.length,1);
 assert.equal(after.bookings[0].paymentEvents?.length??0,0);
 assert.equal(after.sourceLinks[0].lastAppliedBookingVersion,after.bookings[0].version);
});
