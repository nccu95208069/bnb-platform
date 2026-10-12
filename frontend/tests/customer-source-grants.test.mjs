import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { digest } from '../src/lib/customer-workspaces/auth.ts';
import { memoryStore, websiteFixture } from './helpers/website-booking-fixture.mjs';
import { authorizedGrant, exchangeSourceCode, issueSourceCode, ownerSourceAction, ownerSourceGrants,
  proposeSourceAccount, reportSourceRevoked, sourceClient, sourceGrantStatus } from '../src/lib/customer-sources/grants.ts';
import { mutateSourceBooking, sourceBookingLink, sourceBookingStatus } from '../src/lib/customer-sources/bookings.ts';
import { acquireInventoryGuard, finalizeInventoryGuard, inventoryNight, inventoryStatus,
  recordInventoryVerified } from '../src/lib/customer-sources/inventory.ts';
import { sourceOwnerCommand, sourceOwnerRead } from '../src/lib/customer-sources/owner-actions.ts';
import { availability, bookingOperation } from '../src/lib/customer-workspaces/operations.ts';

const serviceToken = 'synthetic-source-service-token-for-local-tests';
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const now = new Date('2026-10-12T14:00:00Z');
function pythonStyleHash(value) {
 const sorted=v=>Array.isArray(v)?v.map(sorted):v && typeof v==='object'?
  Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,sorted(x)])):v;
 return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}
function configure() {
 process.env.CUSTOMER_SOURCES_ENABLED='true';
 process.env.CUSTOMER_SOURCE_GRANT_SECRET='synthetic-hmac-secret-for-local-isolated-tests-only-123456';
 process.env.CUSTOMER_SOURCE_CLIENTS=JSON.stringify([{id:'booking-assistant',token_sha256:digest(serviceToken),providers:['line','gmail','owlnest'],redirect_uri:'https://connector.example.invalid/os/callback',start_uri:'https://connector.example.invalid/start'}]);
}
async function setup(f, source='gmail') {
 configure();
 const w=await f.workspace(), propertyId=w.properties[0].id;
 const issue={action:'issue',propertyId,clientId:'booking-assistant',provider:source,state:'random-browser-state-123456',codeChallenge:challenge,requestKey:randomUUID(),version:w.version};
 const issued=await issueSourceCode(f.store,f.account,w.slug,issue,now);
 const redirect=new URL(issued.redirectUrl);
 const exchange={action:'exchange',code:redirect.searchParams.get('code'),codeVerifier:verifier,requestKey:randomUUID()};
 const client=sourceClient(`Bearer ${serviceToken}`);
 const grant=await exchangeSourceCode(f.store,client,exchange,now);
 return {w,propertyId,issue,issued,exchange,client,grant,auth:`Bearer ${grant.grantToken}`};
}
async function activate(f, s, account='mailbox-123') {
 await proposeSourceAccount(f.store,{action:'propose',grantId:s.grant.grantId,grantVersion:1,sourceAccount:account,sourceLabel:'Synthetic source',requestKey:randomUUID()},s.auth);
 const pending=await ownerSourceGrants(f.store,f.account.id,s.w.slug);
 await ownerSourceAction(f.store,f.account,s.w.slug,{action:'approve',grantId:s.grant.grantId,grantVersion:2,
  propertyId:s.propertyId,sourceAccount:account,version:pending.workspaceVersion,requestKey:randomUUID()},now);
}
test('owner approval binds connector to one property; revoke immediately stops grant and existing website sales',async()=>{
 const f=await websiteFixture({store:memoryStore(),now});
 const s=await setup(f), {grant,auth}=s;
 assert.equal((await f.store.read(`website:binding:${f.binding.id}`)).value.enabled,false);
 assert.equal(new URL(s.issued.redirectUrl).origin,'https://connector.example.invalid');
 assert.equal(new URL(s.issued.redirectUrl).searchParams.get('state'),s.issue.state);
 assert.equal((await exchangeSourceCode(f.store,s.client,s.exchange,now)).grantToken,grant.grantToken);
 await assert.rejects(exchangeSourceCode(f.store,s.client,{...s.exchange,requestKey:randomUUID()},now),/IDEMPOTENCY_CONFLICT/);
 assert.equal((await sourceGrantStatus(f.store,grant.grantId,auth)).status,'awaiting_source');
 const proposal={action:'propose',grantId:grant.grantId,grantVersion:1,sourceAccount:'mailbox-123',sourceLabel:'OTA mailbox',requestKey:randomUUID()};
 assert.equal((await proposeSourceAccount(f.store,proposal,auth)).status,'awaiting_owner');
 const pending=await ownerSourceGrants(f.store,f.account.id,s.w.slug);
 assert.equal(pending.grants[0].sourceAccount,'mailbox-123');
 const approve={action:'approve',grantId:grant.grantId,grantVersion:2,propertyId:s.propertyId,sourceAccount:'mailbox-123',version:pending.workspaceVersion,requestKey:randomUUID()};
 const accepted=await ownerSourceAction(f.store,f.account,s.w.slug,approve,now);
 assert.equal(accepted.grants[0].status,'active');
 assert.equal((await f.store.read(`website:binding:${f.binding.id}`)).value.enabled,false);
 assert.deepEqual((await sourceGrantStatus(f.store,grant.grantId,auth)).rooms.map(r=>r.id),s.w.properties[0].rooms.map(r=>r.id));
 await assert.rejects(ownerSourceAction(f.store,f.account,s.w.slug,{...approve,requestKey:randomUUID(),sourceAccount:'other'},now),/VERSION_CONFLICT/);
 const revoke={...approve,action:'revoke',grantVersion:3,version:accepted.workspaceVersion,requestKey:randomUUID()};
 const revoked=await ownerSourceAction(f.store,f.account,s.w.slug,revoke,now);
 assert.equal(revoked.grants[0].status,'revoked');
 assert.equal((await f.store.read(`website:binding:${f.binding.id}`)).value.enabled,false);
 await assert.rejects(authorizedGrant(f.store,grant.grantId,auth),/UNAUTHORIZED/);
});
test('PKCE, service credentials and owner membership reject cross-property or stolen setup',async()=>{
 const store=memoryStore(), f=await websiteFixture({store,now});
 const s=await setup(f,'owlnest');
 await assert.rejects(exchangeSourceCode(store,s.client,{...s.exchange,codeVerifier:'x'.repeat(43)},now),/UNAUTHORIZED/);
 await assert.rejects(authorizedGrant(store,s.grant.grantId,'Bearer '+'z'.repeat(43)),/UNAUTHORIZED/);
 await assert.rejects(issueSourceCode(store,f.account,s.w.slug,{...s.issue,propertyId:randomUUID(),requestKey:randomUUID()},now),/FORBIDDEN/);
 const wrong=await websiteFixture({store,now,ownerEmail:'second@example.invalid',siteId:'second-site'});
 await assert.rejects(ownerSourceGrants(store,wrong.account.id,s.w.slug),/NOT_FOUND/);
 const own=await store.read(`workspace:${s.w.id}`);
 await store.commit([{key:`workspace:${s.w.id}`,before:own.raw,after:{...own.value,members:own.value.members.map(m=>({...m,active:false})),version:own.value.version+1}}]);
 await assert.rejects(authorizedGrant(store,s.grant.grantId,s.auth),/FORBIDDEN/);
});
test('connector revocation retry returns its own original receipt and leaves site disabled',async()=>{
 const f=await websiteFixture({store:memoryStore(),now}), s=await setup(f);
 await activate(f,s);
 const input={action:'report_revoked',grantId:s.grant.grantId,grantVersion:3,requestKey:randomUUID()};
 const first=await reportSourceRevoked(f.store,input,s.auth,now);
 assert.equal(first.status,'revoked');
 assert.deepEqual(await reportSourceRevoked(f.store,input,s.auth,now),first);
 await assert.rejects(reportSourceRevoked(f.store,{...input,requestKey:randomUUID()},s.auth,now),/UNAUTHORIZED/);
 assert.equal((await f.store.read(`website:binding:${f.binding.id}`)).value.enabled,false);
});
test('revoking an older pending grant does not replace the newer connection marker',async()=>{
 const f=await websiteFixture({store:memoryStore(),now}), older=await setup(f), newer=await setup(f);
 const current=await ownerSourceGrants(f.store,f.account.id,older.w.slug);
 await ownerSourceAction(f.store,f.account,older.w.slug,{action:'revoke',grantId:older.grant.grantId,
  grantVersion:1,propertyId:older.propertyId,sourceAccount:'',version:current.workspaceVersion,
  requestKey:randomUUID()},now);
 assert.equal((await f.workspace()).sourceConnections[0].grantId,newer.grant.grantId);
 assert.equal((await f.store.read(`website:binding:${f.binding.id}`)).value.enabled,false);
});
test('OTA source upsert blocks the last website room, retries read back one order, and cancellation uses source CAS',async()=>{
 const f=await websiteFixture({store:memoryStore(),now}), s=await setup(f);
 await activate(f,s);
 const before=await f.workspace(), roomId=before.properties[0].rooms[0].id;
 const absent=await sourceBookingLink(f.store,s.grant.grantId,3,s.auth,'mailbox-123','OTA-123');
 assert.equal(absent.verified,true);assert.equal(absent.exists,false);assert.equal(absent.sourceVersion,null);
 const input={schemaVersion:1,grantId:s.grant.grantId,grantVersion:3,eventId:randomUUID(),requestKey:randomUUID(),
  kind:'upsert',sourceAccount:'mailbox-123',externalOrderId:'OTA-123',sourceVersion:'v1',previousSourceVersion:null,guestName:'OTA 測試',
  expectedWorkspaceVersion:before.version,checkIn:f.stay.checkIn,checkOut:f.stay.checkOut,roomIds:[roomId]};
 const created=await mutateSourceBooking(f.store,input,s.auth,now);
 assert.equal(created.guestName,'OTA 測試');
 const linked=await sourceBookingLink(f.store,s.grant.grantId,3,s.auth,'mailbox-123','OTA-123');
 assert.equal(linked.orderId,created.orderId);assert.equal(linked.sourceVersion,'v1');
 assert.equal(linked.requestKey,input.requestKey);assert.equal(linked.checkIn,f.stay.checkIn);
 assert.deepEqual(linked.roomIds,[roomId]);assert.equal(linked.diverged,false);
 assert.equal(created.verified,true);assert.equal(created.status,'confirmed');assert.equal(created.orderVersion,1);
 assert.deepEqual(await mutateSourceBooking(f.store,input,s.auth,now),created);
 assert.equal((await f.workspace()).bookings.length,1);
 assert.equal((await sourceBookingStatus(f.store,s.grant.grantId,s.auth,input.requestKey)).orderId,created.orderId);
 assert.equal((await f.call('bootstrap')).state,'unavailable');
 await assert.rejects(mutateSourceBooking(f.store,{...input,requestKey:randomUUID(),eventId:randomUUID(),sourceVersion:'v2',previousSourceVersion:null,expectedWorkspaceVersion:created.workspaceVersion},s.auth,now),/SOURCE_VERSION_CONFLICT/);
 const cancellation={...input,kind:'cancel',eventId:randomUUID(),requestKey:randomUUID(),sourceVersion:'v2',previousSourceVersion:'v1',expectedWorkspaceVersion:created.workspaceVersion};
 const cancelled=await mutateSourceBooking(f.store,cancellation,s.auth,now);
 assert.equal(cancelled.orderId,created.orderId);assert.equal(cancelled.orderVersion,2);assert.equal(cancelled.status,'cancelled');
 assert.equal((await f.call('bootstrap')).state,'unavailable');
});
test('a late OTA order is recorded without overwriting a website hold, and disables new sales for conflict review',async()=>{
 const f=await websiteFixture({store:memoryStore(),now}), {result}=await f.reserve(), s=await setup(f);
 await activate(f,s);
 const w=await f.workspace(),roomId=w.properties[0].rooms[0].id;
 const input={schemaVersion:1,grantId:s.grant.grantId,grantVersion:3,eventId:randomUUID(),requestKey:randomUUID(),
  kind:'upsert',sourceAccount:'mailbox-123',externalOrderId:'OTA-456',sourceVersion:'v1',previousSourceVersion:null,guestName:null,
  expectedWorkspaceVersion:w.version,checkIn:f.stay.checkIn,checkOut:f.stay.checkOut,roomIds:[roomId]};
 const imported=await mutateSourceBooking(f.store,input,s.auth,now);
 assert.notEqual(imported.orderId,result.orderId);
 assert.equal((await f.workspace()).reviewRecords[0].issues[0],'OCCUPANCY_CONFLICT');
 assert.equal((await f.call('bootstrap')).state,'unavailable');
 assert.equal((await f.call('requests',{idempotencyKey:(await f.workspace()).bookings.find(b=>b.id===result.orderId).requestKey})).orderId,result.orderId);
});
test('OTA cancellation before create leaves a durable source-version tombstone',async()=>{
 const f=await websiteFixture({store:memoryStore(),now}), s=await setup(f);
 await activate(f,s);
 const w=await f.workspace(), roomId=w.properties[0].rooms[0].id;
 const cancelled={schemaVersion:1,grantId:s.grant.grantId,grantVersion:3,eventId:randomUUID(),requestKey:randomUUID(),
  kind:'cancel',sourceAccount:'mailbox-123',externalOrderId:'booking:early-cancel',sourceVersion:'v2',
  previousSourceVersion:null,guestName:null,expectedWorkspaceVersion:w.version,checkIn:f.stay.checkIn,
  checkOut:f.stay.checkOut,roomIds:[roomId]};
 const result=await mutateSourceBooking(f.store,cancelled,s.auth,now);
 const link=await sourceBookingLink(f.store,s.grant.grantId,3,s.auth,'mailbox-123','booking:early-cancel');
 assert.equal(link.sourceVersion,'v2');assert.equal(link.requestKey,cancelled.requestKey);
 assert.deepEqual(link.roomIds,[roomId]);assert.equal(link.checkIn,f.stay.checkIn);
 assert.equal(result.verified,true);assert.equal(result.orderId,null);assert.equal(result.status,'cancelled');
 assert.equal((await f.workspace()).bookings.length,0);
 assert.equal((await sourceBookingStatus(f.store,s.grant.grantId,s.auth,cancelled.requestKey)).sourceVersion,'v2');
 await assert.rejects(mutateSourceBooking(f.store,{...cancelled,kind:'upsert',sourceVersion:'v1',eventId:randomUUID(),
  requestKey:randomUUID(),expectedWorkspaceVersion:result.workspaceVersion},s.auth,now),/SOURCE_VERSION_CONFLICT/);
});
test('external source refuses to overwrite an OS edit made after the last source version',async()=>{
 const f=await websiteFixture({store:memoryStore(),now}), s=await setup(f);
 await activate(f,s);
 const w=await f.workspace(),roomId=w.properties[0].rooms[0].id;
 const input={schemaVersion:1,grantId:s.grant.grantId,grantVersion:3,eventId:randomUUID(),requestKey:randomUUID(),
  kind:'upsert',sourceAccount:'mailbox-123',externalOrderId:'booking:changed',sourceVersion:'v1',
  previousSourceVersion:null,guestName:'李測試',expectedWorkspaceVersion:w.version,
  checkIn:f.stay.checkIn,checkOut:f.stay.checkOut,roomIds:[roomId]};
 await mutateSourceBooking(f.store,input,s.auth,now);
 const saved=await f.store.read(`workspace:${w.id}`),booking=saved.value.bookings[0];
 await f.store.commit([{key:`workspace:${w.id}`,before:saved.raw,after:{...saved.value,
  version:saved.value.version+1,bookings:[{...booking,version:booking.version+1,notes:'Owner changed'}]}}]);
 const link=await sourceBookingLink(f.store,s.grant.grantId,3,s.auth,'mailbox-123','booking:changed');
 assert.equal(link.diverged,true);assert.equal(link.sourceOrderVersion,1);
 await assert.rejects(mutateSourceBooking(f.store,{...input,eventId:randomUUID(),requestKey:randomUUID(),
  sourceVersion:'v2',previousSourceVersion:'v1',expectedWorkspaceVersion:link.workspaceVersion},s.auth,now),/SOURCE_CONFLICT/);
});
test('two grants cannot cross properties, owner account or source account',async()=>{
 const store=memoryStore(), a=await websiteFixture({store,now,siteId:'tenant-a',ownerEmail:'a@example.invalid'}),
  b=await websiteFixture({store,now,siteId:'tenant-b',ownerEmail:'b@example.invalid'});
 const sa=await setup(a), sb=await setup(b);
 await activate(a,sa,'a-mailbox');await activate(b,sb,'b-mailbox');
 const w=await a.workspace(),roomId=w.properties[0].rooms[0].id;
 const input={schemaVersion:1,grantId:sa.grant.grantId,grantVersion:3,eventId:randomUUID(),requestKey:randomUUID(),
  kind:'upsert',sourceAccount:'a-mailbox',externalOrderId:'OTA-X',sourceVersion:'v1',previousSourceVersion:null,guestName:'A guest',
  expectedWorkspaceVersion:w.version,checkIn:a.stay.checkIn,checkOut:a.stay.checkOut,roomIds:[roomId]};
 await assert.rejects(mutateSourceBooking(store,input,sb.auth,now),/UNAUTHORIZED/);
 await assert.rejects(mutateSourceBooking(store,{...input,externalOrderId:null},sa.auth,now),/INVALID_INPUT/);
 await assert.rejects(mutateSourceBooking(store,{...input,roomIds:[(await b.workspace()).properties[0].rooms[0].id]},sa.auth,now),/INVALID_INPUT/);
 await assert.rejects(mutateSourceBooking(store,{...input,sourceAccount:'b-mailbox'},sa.auth,now),/FORBIDDEN/);
 assert.equal((await mutateSourceBooking(store,input,sa.auth,now)).propertyId,sa.propertyId);
 assert.equal((await b.workspace()).bookings.length,0);
});
test('source write rechecks owner membership on the workspace it will commit',async()=>{
 const store=memoryStore(), f=await websiteFixture({store,now}), s=await setup(f);
 await activate(f,s);
 const w=await f.workspace(), roomId=w.properties[0].rooms[0].id;
 const input={schemaVersion:1,grantId:s.grant.grantId,grantVersion:3,eventId:randomUUID(),requestKey:randomUUID(),
  kind:'upsert',sourceAccount:'mailbox-123',externalOrderId:'booking:race',sourceVersion:'v1',
  previousSourceVersion:null,guestName:'Race guest',expectedWorkspaceVersion:w.version,
  checkIn:f.stay.checkIn,checkOut:f.stay.checkOut,roomIds:[roomId]};
 const originalRead=store.read.bind(store);let workspaceReads=0;
 store.read=async key=>{
  if(key===`workspace:${w.id}` && ++workspaceReads===2){
   const current=await originalRead(key);
   store.values.set(key,JSON.stringify({...current.value,version:current.value.version+1,
    members:current.value.members.map(m=>({...m,active:false}))}));
  }
  return originalRead(key);
 };
 await assert.rejects(mutateSourceBooking(store,input,s.auth,now),/FORBIDDEN/);
 assert.equal((await f.workspace()).bookings.length,0);
});
test('OwlNest open uses a durable fence until exact readback, close persists a block, and verified reopen releases it',async()=>{
 const f=await websiteFixture({store:memoryStore(),now}), s=await setup(f,'owlnest');
 await activate(f,s,'owl-account');
 const w=await f.workspace(), roomId=w.properties[0].rooms[0].id, dates=[f.stay.checkIn,new Date(Date.parse(f.stay.checkIn+'T00:00:00Z')+86400000).toISOString().slice(0,10)];
 const cells=(count,isLock)=>dates.map(date=>({roomId,date,count,isLock}));
 const before={observedAt:now.toISOString(),sourceVersion:'owl-v1',cells:cells(0,true)};
 assert.equal((await inventoryNight(f.store,s.grant.grantId,3,s.auth,s.propertyId,roomId,dates[0])).canOpen,true);
 const open={schemaVersion:1,action:'acquire_guard',grantId:s.grant.grantId,grantVersion:3,operationKey:randomUUID(),
  sourceAccount:'owl-account',expectedWorkspaceVersion:w.version,mode:'open',checkIn:f.stay.checkIn,
  checkOut:f.stay.checkOut,roomIds:[roomId],closedFenceId:null,providerBefore:before};
 const ownerAvailable=async()=> (await availability(f.store,f.account.id,w.slug,{propertyId:s.propertyId,from:f.stay.checkIn,to:f.stay.checkIn})).rows.some(r=>r.roomId===roomId);
 const guarded=await acquireInventoryGuard(f.store,open,s.auth,now);
 assert.equal(guarded.status,'pending');assert.equal(await ownerAvailable(),false);
 assert.equal((await inventoryNight(f.store,s.grant.grantId,3,s.auth,s.propertyId,roomId,dates[0])).canOpen,false);
 assert.equal((await acquireInventoryGuard(f.store,open,s.auth,new Date(now.getTime()+86400000))).fenceId,guarded.fenceId);
 assert.equal((await inventoryStatus(f.store,s.grant.grantId,s.auth,open.operationKey)).status,'pending');
 const first=await recordInventoryVerified(f.store,{schemaVersion:1,action:'record_verified',grantId:s.grant.grantId,
  grantVersion:3,operationKey:open.operationKey,nightOperationKey:'owl-night:one',expectedWorkspaceVersion:guarded.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+1000).toISOString(),sourceVersion:'owl-v2',cells:cells(1,false).slice(0,1)}},s.auth,new Date(now.getTime()+2000));
 assert.equal(first.status,'pending');assert.equal(first.verifiedCells,1);assert.equal(first.readyToFinalize,false);
 assert.equal(first.workspaceVersion,guarded.workspaceVersion+1);
 assert.deepEqual(first.missingCells,[{roomId,date:dates[1]}]);
 assert.equal(first.evidence[0].nightOperationKey,'owl-night:one');
 assert.equal(first.evidence[0].recordedWorkspaceVersion,first.workspaceVersion);
 assert.equal((await f.workspace()).version,first.workspaceVersion);
 assert.equal((await inventoryNight(f.store,s.grant.grantId,3,s.auth,s.propertyId,roomId,dates[0])).fences[0].evidence.evidenceHash,first.evidence[0].evidenceHash);
 assert.equal((await inventoryNight(f.store,s.grant.grantId,3,s.auth,s.propertyId,roomId,dates[1])).fences[0].evidence,null);
 assert.equal((await recordInventoryVerified(f.store,{schemaVersion:1,action:'record_verified',grantId:s.grant.grantId,
  grantVersion:3,operationKey:open.operationKey,nightOperationKey:'owl-night:one',expectedWorkspaceVersion:guarded.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+1000).toISOString(),sourceVersion:'owl-v2',cells:cells(1,false).slice(0,1)}},s.auth,new Date(now.getTime()+2500))).workspaceVersion,first.workspaceVersion);
 await assert.rejects(recordInventoryVerified(f.store,{schemaVersion:1,action:'record_verified',grantId:s.grant.grantId,
  grantVersion:3,operationKey:open.operationKey,nightOperationKey:'owl-night:other',expectedWorkspaceVersion:first.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+1000).toISOString(),sourceVersion:'owl-v2',cells:cells(1,false).slice(0,1)}},s.auth,new Date(now.getTime()+2500)),/IDEMPOTENCY_CONFLICT/);
 assert.equal(await ownerAvailable(),false);
 await assert.rejects(recordInventoryVerified(f.store,{schemaVersion:1,action:'record_verified',grantId:s.grant.grantId,
  grantVersion:3,operationKey:open.operationKey,nightOperationKey:'owl-night:two',expectedWorkspaceVersion:guarded.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+3000).toISOString(),sourceVersion:'owl-v2',cells:cells(1,false).slice(1)}},s.auth,new Date(now.getTime()+4000)),/VERSION_CONFLICT/);
 await assert.rejects(finalizeInventoryGuard(f.store,{schemaVersion:1,action:'finalize_guard',grantId:s.grant.grantId,
  grantVersion:3,operationKey:open.operationKey,expectedWorkspaceVersion:first.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+2000).toISOString(),sourceVersion:'owl-v2',cells:cells(1,false)}},s.auth,new Date(now.getTime()+3000)),/SOURCE_READBACK_REQUIRED/);
 assert.equal(await ownerAvailable(),false);
 const second=await recordInventoryVerified(f.store,{schemaVersion:1,action:'record_verified',grantId:s.grant.grantId,
  grantVersion:3,operationKey:open.operationKey,nightOperationKey:'owl-night:two',expectedWorkspaceVersion:first.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+3000).toISOString(),sourceVersion:'owl-v2',cells:cells(1,false).slice(1)}},s.auth,new Date(now.getTime()+4000));
 assert.equal(second.readyToFinalize,true);assert.equal(second.evidence.length,2);assert.equal(second.workspaceVersion,first.workspaceVersion+1);
 assert.equal(await ownerAvailable(),false);
 assert.deepEqual((await inventoryStatus(f.store,s.grant.grantId,s.auth,open.operationKey)).evidence,second.evidence);
 await assert.rejects(finalizeInventoryGuard(f.store,{schemaVersion:1,action:'finalize_guard',grantId:s.grant.grantId,
  grantVersion:3,operationKey:open.operationKey,expectedWorkspaceVersion:second.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+5000).toISOString(),sourceVersion:'owl-v2',cells:[cells(0,true)[0],cells(1,false)[1]]}},s.auth,new Date(now.getTime()+6000)),/SOURCE_READBACK_REQUIRED/);
 assert.equal(await ownerAvailable(),false);
 const opened=await finalizeInventoryGuard(f.store,{schemaVersion:1,action:'finalize_guard',grantId:s.grant.grantId,
  grantVersion:3,operationKey:open.operationKey,expectedWorkspaceVersion:second.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+5000).toISOString(),sourceVersion:'owl-v2',cells:cells(1,false)}},s.auth,new Date(now.getTime()+6000));
 assert.equal(opened.status,'open');assert.equal(await ownerAvailable(),true);
 const afterOpen=await f.workspace();
 const close={...open,operationKey:randomUUID(),mode:'close',expectedWorkspaceVersion:afterOpen.version,
  providerBefore:{observedAt:new Date(now.getTime()+7000).toISOString(),sourceVersion:'owl-v2',cells:cells(1,false)}};
 const closing=await acquireInventoryGuard(f.store,close,s.auth,new Date(now.getTime()+7000));
 const closeFirst=await recordInventoryVerified(f.store,{schemaVersion:1,action:'record_verified',grantId:s.grant.grantId,
  grantVersion:3,operationKey:close.operationKey,nightOperationKey:'owl-night:close-one',expectedWorkspaceVersion:closing.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+8000).toISOString(),sourceVersion:'owl-v3',cells:cells(0,true).slice(0,1)}},s.auth,new Date(now.getTime()+8500));
 assert.equal(closeFirst.readyToFinalize,false);assert.equal(await ownerAvailable(),false);
 const closeEvidence=await recordInventoryVerified(f.store,{schemaVersion:1,action:'record_verified',grantId:s.grant.grantId,
  grantVersion:3,operationKey:close.operationKey,nightOperationKey:'owl-night:close-two',expectedWorkspaceVersion:closeFirst.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+8500).toISOString(),sourceVersion:'owl-v3',cells:cells(0,true).slice(1)}},s.auth,new Date(now.getTime()+9000));
 assert.equal(closeEvidence.status,'pending');assert.equal(closeEvidence.readyToFinalize,true);
 const closed=await finalizeInventoryGuard(f.store,{schemaVersion:1,action:'finalize_guard',grantId:s.grant.grantId,
  grantVersion:3,operationKey:close.operationKey,expectedWorkspaceVersion:closeEvidence.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+9500).toISOString(),sourceVersion:'owl-v3',cells:cells(0,true)}},s.auth,new Date(now.getTime()+10000));
 assert.equal(closed.status,'closed');assert.equal(await ownerAvailable(),false);
 const afterClose=await f.workspace();
 const reopen={...open,operationKey:randomUUID(),expectedWorkspaceVersion:afterClose.version,closedFenceId:closing.fenceId,
  providerBefore:{observedAt:new Date(now.getTime()+10000).toISOString(),sourceVersion:'owl-v3',cells:cells(0,true)}};
 const reopening=await acquireInventoryGuard(f.store,reopen,s.auth,new Date(now.getTime()+10000));
 const reopenFirst=await recordInventoryVerified(f.store,{schemaVersion:1,action:'record_verified',grantId:s.grant.grantId,
  grantVersion:3,operationKey:reopen.operationKey,nightOperationKey:'owl-night:reopen-one',expectedWorkspaceVersion:reopening.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+11000).toISOString(),sourceVersion:'owl-v4',cells:cells(1,false).slice(0,1)}},s.auth,new Date(now.getTime()+11500));
 assert.equal(reopenFirst.readyToFinalize,false);assert.equal(await ownerAvailable(),false);
 const reopenSecond=await recordInventoryVerified(f.store,{schemaVersion:1,action:'record_verified',grantId:s.grant.grantId,
  grantVersion:3,operationKey:reopen.operationKey,nightOperationKey:'owl-night:reopen-two',expectedWorkspaceVersion:reopenFirst.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+11500).toISOString(),sourceVersion:'owl-v4',cells:cells(1,false).slice(1)}},s.auth,new Date(now.getTime()+12000));
 const reopened=await finalizeInventoryGuard(f.store,{schemaVersion:1,action:'finalize_guard',grantId:s.grant.grantId,
  grantVersion:3,operationKey:reopen.operationKey,expectedWorkspaceVersion:reopenSecond.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+12500).toISOString(),sourceVersion:'owl-v4',cells:cells(1,false)}},s.auth,new Date(now.getTime()+13000));
 assert.equal(reopened.status,'open');assert.equal((await f.workspace()).integrationFences.length,0);
 assert.equal(await ownerAvailable(),true);
});
test('OwlNest pending open cannot be released after a competing booking; revoked grant leaves stop-sale fence',async()=>{
 const f=await websiteFixture({store:memoryStore(),now}), s=await setup(f,'owlnest');
 await activate(f,s,'owl-account');
 const w=await f.workspace(), roomId=w.properties[0].rooms[0].id, day=f.stay.checkIn;
 const before={observedAt:now.toISOString(),sourceVersion:'owl-v1',cells:[{roomId,date:day,count:0,isLock:true}]};
 const input={schemaVersion:1,action:'acquire_guard',grantId:s.grant.grantId,grantVersion:3,operationKey:randomUUID(),
  sourceAccount:'owl-account',expectedWorkspaceVersion:w.version,mode:'open',checkIn:day,
  checkOut:new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10),roomIds:[roomId],closedFenceId:null,providerBefore:before};
 const guard=await acquireInventoryGuard(f.store,input,s.auth,now);
 const current=await f.workspace();
 const external={id:randomUUID(),version:1,propertyId:s.propertyId,roomIds:[roomId],checkIn:input.checkIn,checkOut:input.checkOut,status:'confirmed',entry:'os'};
 f.store.values.set('workspace:'+current.id,JSON.stringify({...current,version:current.version+1,bookings:[...current.bookings,external]}));
 const recorded=await recordInventoryVerified(f.store,{schemaVersion:1,action:'record_verified',grantId:s.grant.grantId,
  grantVersion:3,operationKey:input.operationKey,nightOperationKey:'owl-night:conflicted',expectedWorkspaceVersion:current.version+1,
  providerAfter:{observedAt:new Date(now.getTime()+1000).toISOString(),sourceVersion:'owl-v2',cells:[{roomId,date:day,count:1,isLock:false}]}},s.auth,new Date(now.getTime()+2000));
 await assert.rejects(finalizeInventoryGuard(f.store,{schemaVersion:1,action:'finalize_guard',grantId:s.grant.grantId,
  grantVersion:3,operationKey:input.operationKey,expectedWorkspaceVersion:recorded.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+3000).toISOString(),sourceVersion:'owl-v2',cells:[{roomId,date:day,count:1,isLock:false}]}},s.auth,new Date(now.getTime()+4000)),/ROOM_CONFLICT/);
 assert.equal((await inventoryStatus(f.store,s.grant.grantId,s.auth,input.operationKey)).status,'pending');
 const status=await ownerSourceGrants(f.store,f.account.id,w.slug);
 await ownerSourceAction(f.store,f.account,w.slug,{action:'revoke',grantId:s.grant.grantId,grantVersion:3,
  propertyId:s.propertyId,sourceAccount:'owl-account',version:status.workspaceVersion,requestKey:randomUUID()},now);
 assert.equal((await f.workspace()).integrationFences[0].state,'pending');
 assert.equal((await f.call('bootstrap')).state,'unavailable');
});
test('a replacement OwlNest account cannot reopen or read proof from an older grant fence',async()=>{
 const f=await websiteFixture({store:memoryStore(),now}), old=await setup(f,'owlnest');
 await activate(f,old,'owl-account-old');
 const w=await f.workspace(), roomId=w.properties[0].rooms[0].id, day=f.stay.checkIn;
 const close={schemaVersion:1,action:'acquire_guard',grantId:old.grant.grantId,grantVersion:3,
  operationKey:randomUUID(),sourceAccount:'owl-account-old',expectedWorkspaceVersion:w.version,
  mode:'close',checkIn:day,checkOut:new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10),
  roomIds:[roomId],closedFenceId:null,
  providerBefore:{observedAt:now.toISOString(),sourceVersion:'old-v1',cells:[{roomId,date:day,count:1,isLock:false}]}};
 const guard=await acquireInventoryGuard(f.store,close,old.auth,now);
 const recorded=await recordInventoryVerified(f.store,{schemaVersion:1,action:'record_verified',
  grantId:old.grant.grantId,grantVersion:3,operationKey:close.operationKey,
  nightOperationKey:'owl-night:old-close',expectedWorkspaceVersion:guard.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+1000).toISOString(),sourceVersion:'old-v2',
   cells:[{roomId,date:day,count:0,isLock:true}]}},old.auth,new Date(now.getTime()+2000));
 await finalizeInventoryGuard(f.store,{schemaVersion:1,action:'finalize_guard',
  grantId:old.grant.grantId,grantVersion:3,operationKey:close.operationKey,
  expectedWorkspaceVersion:recorded.workspaceVersion,
  providerAfter:{observedAt:new Date(now.getTime()+3000).toISOString(),sourceVersion:'old-v2',
   cells:[{roomId,date:day,count:0,isLock:true}]}},old.auth,new Date(now.getTime()+4000));
 const replacement=await setup(f,'owlnest');
 await activate(f,replacement,'owl-account-new');
 const after=await f.workspace();
 const night=await inventoryNight(f.store,replacement.grant.grantId,3,replacement.auth,
  replacement.propertyId,roomId,day);
 assert.equal(night.canOpen,false);
 assert.equal(night.fences[0].evidence,null);
 await assert.rejects(acquireInventoryGuard(f.store,{...close,grantId:replacement.grant.grantId,
  operationKey:randomUUID(),sourceAccount:'owl-account-new',expectedWorkspaceVersion:after.version,
  mode:'open',closedFenceId:guard.fenceId,
  providerBefore:{observedAt:new Date(now.getTime()+5000).toISOString(),sourceVersion:'new-v1',
   cells:[{roomId,date:day,count:0,isLock:true}]}},replacement.auth,new Date(now.getTime()+5000)),/FENCE_CONFLICT/);
 assert.equal((await f.workspace()).integrationFences[0].state,'closed');
});

async function activeLine(f) {
 const s=await setup(f,'line');
 const ownerSubject='U'+'a'.repeat(32), channelId='U'+'b'.repeat(32), sourceAccount='line:'+channelId;
 await assert.rejects(proposeSourceAccount(f.store,{action:'propose',grantId:s.grant.grantId,grantVersion:1,
  sourceAccount:'not-an-oa',sourceLabel:'bad',ownerSubject,requestKey:randomUUID()},s.auth),/INVALID_INPUT/);
 await proposeSourceAccount(f.store,{action:'propose',grantId:s.grant.grantId,grantVersion:1,
  sourceAccount,sourceLabel:'LINE OA synthetic',ownerSubject,requestKey:randomUUID()},s.auth);
 const pending=await ownerSourceGrants(f.store,f.account.id,s.w.slug);
 await ownerSourceAction(f.store,f.account,s.w.slug,{action:'approve',grantId:s.grant.grantId,grantVersion:2,
  propertyId:s.propertyId,sourceAccount,version:pending.workspaceVersion,requestKey:randomUUID()},now);
 const current=await f.workspace();
 const grant={account_id:f.account.id,grant_id:s.grant.grantId,grant_version:3,channel_id:channelId,
  user_id:ownerSubject,workspace_id:current.id,property_id:s.propertyId,property_name:current.properties[0].name};
 return {...s,grant};
}
test('LINE owner preview is immutable; commit and status replay the exact read-back booking',async()=>{
 const f=await websiteFixture({store:memoryStore(),now}), s=await activeLine(f);
 const room=(await f.workspace()).properties[0].rooms[0].id, request_key=randomUUID();
 const draft={action:'create',request_key,order_id:null,expected_order_version:0,
  changes:{guest_name:'王測試',guest_phone:'0912345678',guest_count:2,room_ids:[room],
   check_in:f.stay.checkIn,check_out:f.stay.checkOut,total:'3200.00',note:'晚到'}};
 const p=await sourceOwnerCommand(f.store,{action:'preview',grant:s.grant,draft},s.auth,now);
 assert.equal(p.verified,true);assert.equal(p.before,null);assert.equal(p.after.status,'confirmed');
 assert.equal(p.after.source,'line');assert.equal(p.order_version,0);
 assert.deepEqual(await sourceOwnerCommand(f.store,{action:'preview',grant:s.grant,draft},s.auth,now),p);
 await assert.rejects(sourceOwnerCommand(f.store,{action:'preview',grant:s.grant,draft:{...draft,changes:{...draft.changes,total:'4000.00'}}},s.auth,now),/IDEMPOTENCY_CONFLICT/);
 assert.equal((await sourceOwnerRead(f.store,{action:'status',grant:s.grant,request_key},s.auth)).state,'not_found');
 const confirmation={request_key,preview_token:p.preview_token,preview_hash:pythonStyleHash(p),
  expected_workspace_version:p.workspace_version,expected_order_version:p.order_version};
 const committed=await sourceOwnerCommand(f.store,{action:'commit',grant:s.grant,confirmation},s.auth,now);
 assert.equal(committed.state,'committed');assert.equal(committed.order_id,p.after.order_id);
 assert.equal(committed.preview_hash,confirmation.preview_hash);
 assert.deepEqual(await sourceOwnerCommand(f.store,{action:'commit',grant:s.grant,confirmation},s.auth,now),committed);
 assert.deepEqual(await sourceOwnerRead(f.store,{action:'status',grant:s.grant,request_key},s.auth),committed);
 assert.deepEqual(await sourceOwnerRead(f.store,{action:'inspect',grant:s.grant,order_id:committed.order_id},s.auth),p.after);
 assert.equal((await sourceOwnerRead(f.store,{action:'list',grant:s.grant},s.auth)).orders.length,1);
 await assert.rejects(sourceOwnerRead(f.store,{action:'list',grant:{...s.grant,workspace_id:randomUUID()}},s.auth),/FORBIDDEN/);
});

test('LINE stale preview rejects without write; paid cancellation preserves receipt and demands refund review',async()=>{
 const f=await websiteFixture({store:memoryStore(),now}), s=await activeLine(f);
 const room=(await f.workspace()).properties[0].rooms[0].id;
 const create={action:'create',request_key:randomUUID(),order_id:null,expected_order_version:0,
  changes:{guest_name:'林測試',guest_phone:'0911111111',guest_count:2,room_ids:[room],
   check_in:f.stay.checkIn,check_out:f.stay.checkOut,total:'3000.00'}};
 const p=await sourceOwnerCommand(f.store,{action:'preview',grant:s.grant,draft:create},s.auth,now);
 const confirmation=q=>({request_key:q.request_key,preview_token:q.preview_token,
  preview_hash:pythonStyleHash(q),
  expected_workspace_version:q.workspace_version,expected_order_version:q.order_version});
 const w=await f.workspace();
 await f.store.commit([{key:`workspace:${w.id}`,before:(await f.store.read(`workspace:${w.id}`)).raw,
  after:{...w,version:w.version+1}}]);
 const rejected=await sourceOwnerCommand(f.store,{action:'commit',grant:s.grant,confirmation:confirmation(p)},s.auth,now);
 assert.equal(rejected.state,'rejected');assert.equal((await f.workspace()).bookings.length,0);
 const renewed={...create,request_key:randomUUID()};
 const q=await sourceOwnerCommand(f.store,{action:'preview',grant:s.grant,draft:renewed},s.auth,now);
 const receipt=await sourceOwnerCommand(f.store,{action:'commit',grant:s.grant,confirmation:confirmation(q)},s.auth,now);
 const state=await f.store.read(`workspace:${s.w.id}`), booking=state.value.bookings[0];
 await f.store.commit([{key:`workspace:${s.w.id}`,before:state.raw,after:{...state.value,version:state.value.version+1,
  bookings:[{...booking,payments:[{id:randomUUID(),amount:500,kind:'deposit',receivedAt:now.toISOString(),method:'cash',actor:'owner'}]}]}}]);
 const before=await sourceOwnerRead(f.store,{action:'inspect',grant:s.grant,order_id:receipt.order_id},s.auth);
 assert.equal(before.received,'500.00');
 const cancel={action:'cancel',request_key:randomUUID(),order_id:receipt.order_id,
  expected_order_version:before.order_version,changes:{}};
 const c=await sourceOwnerCommand(f.store,{action:'preview',grant:s.grant,draft:cancel},s.auth,now);
 assert.equal(c.after.refund_review_required,true);assert.equal(c.after.received,'500.00');
 await sourceOwnerCommand(f.store,{action:'commit',grant:s.grant,confirmation:confirmation(c)},s.auth,now);
 const after=await sourceOwnerRead(f.store,{action:'inspect',grant:s.grant,order_id:receipt.order_id},s.auth);
 assert.equal(after.status,'cancelled');assert.equal(after.received,'500.00');assert.equal(after.refund_review_required,true);
 const current=await f.workspace();
 await assert.rejects(bookingOperation(f.store,f.account.id,s.w.slug,{action:'payment',bookingId:receipt.order_id,
  bookingVersion:after.order_version,version:current.version,requestKey:randomUUID(),
  kind:'deposit',amount:1,receivedAt:now.toISOString(),method:'cash'}),/ORDER_CANCELLED/);
 const refunded=await bookingOperation(f.store,f.account.id,s.w.slug,{action:'payment',bookingId:receipt.order_id,
  bookingVersion:after.order_version,version:current.version,requestKey:randomUUID(),
  kind:'refund',amount:500,receivedAt:now.toISOString(),method:'cash'});
 assert.equal(refunded.summary.received,0);
 assert.equal((await f.workspace()).bookings[0].lineOwner.refundReviewRequired,false);
});
