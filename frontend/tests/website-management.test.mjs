import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { websiteFixture } from './helpers/website-booking-fixture.mjs';
import { digest } from '../src/lib/customer-workspaces/auth.ts';
import { prepareConnection, approveConnection, ownerConnection, connectionStatus } from '../src/lib/website-booking/connections.ts';
import { setWebsiteSales, websiteManagement } from '../src/lib/website-booking/management.ts';

test('owner management lists only own websites, pauses atomically, replays safely, and keeps old order lookup',async()=>{
 const f=await websiteFixture(),created=await f.reserve();
 const before=await websiteManagement(f.store,f.account.id,f.binding.slug);
 assert.equal(before.sites.length,1);assert.equal(before.sites[0].id,f.binding.id);
 assert.doesNotMatch(JSON.stringify(before),/bindingToken|credentialGeneration|token_sha256/);
 const input={action:'sales',bindingId:f.binding.id,revision:f.binding.revision,enabled:false,requestKey:randomUUID()};
 const result=await setWebsiteSales(f.store,f.account.id,f.binding.slug,input);
 assert.equal(result.sites[0].enabled,false);
 assert.equal((await setWebsiteSales(f.store,f.account.id,f.binding.slug,input)).sites[0].revision,2);
 assert.equal((await f.call('bootstrap')).state,'unavailable');
 assert.equal((await f.call('requests',{idempotencyKey:created.input.idempotencyKey})).orderId,created.result.orderId);
 await assert.rejects(setWebsiteSales(f.store,f.account.id,f.binding.slug,{...input,enabled:true}),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(setWebsiteSales(f.store,f.account.id,f.binding.slug,{...input,enabled:true,requestKey:randomUUID()}),/VERSION_CONFLICT/);
 await assert.rejects(websiteManagement(f.store,randomUUID(),f.binding.slug),/NOT_FOUND|FORBIDDEN/);
 const w=await f.workspace();assert.equal(w.audit.filter(a=>a.action==='website.sales.paused').length,1);
 w.members.push({accountId:randomUUID(),email:'staff@example.invalid',role:'admin',active:true,allProperties:true,propertyIds:[]});
 f.store.values.set('workspace:'+w.id,JSON.stringify(w));
 await assert.rejects(websiteManagement(f.store,w.members[1].accountId,w.slug),/FORBIDDEN/);
});

test('website reapproval preserves owner-managed base prices, overrides, pricing disable and sales pause',async()=>{
 const f=await websiteFixture();
 await setWebsiteSales(f.store,f.account.id,f.binding.slug,{action:'sales',bindingId:f.binding.id,revision:1,enabled:false,requestKey:randomUUID()});
 let w=await f.workspace();const p=w.properties[0];p.pricing.base[p.rooms[0].id]=3456.78;p.pricing.base.villa=7890;
 p.pricing.enabled=false;p.pricing.overrides=[{roomId:p.rooms[0].id,from:f.stay.checkIn,to:f.stay.checkOut,amount:4567}];
 const expected=structuredClone(p.pricing);f.store.values.set('workspace:'+w.id,JSON.stringify(w));
 const config={...f.config,transferInstructions:'Updated synthetic terms',wholeHouseNightly:'99999',rooms:f.config.rooms.map(r=>({...r,nightly:'99999'}))};
 const preparation={...f.prepare,requestId:randomUUID(),reservationConfig:config,configurationHash:digest(JSON.stringify({reservationConfig:config,roomIds:f.prepare.roomRecords.map(r=>r.id)}))};
 const c=await prepareConnection(f.store,f.client,preparation);
 const details=await ownerConnection(f.store,f.account,c.connectionId);
 await approveConnection(f.store,f.account,{action:'approve',connectionId:c.connectionId,requestKey:randomUUID(),confirmed:true,mode:'existing',slug:w.slug,version:w.version,propertyId:p.id,roomMappings:details.connection.binding.roomMappings});
 w=await f.workspace();assert.deepEqual(w.properties[0].pricing,expected);
 const managed=await websiteManagement(f.store,f.account.id,w.slug);assert.equal(managed.sites.length,1);assert.equal(managed.sites[0].enabled,false);
 const current=await connectionStatus(f.store,f.client,{schemaVersion:1,action:'status',siteId:f.prepare.siteId,connectionId:c.connectionId});assert.equal(current.state,'connected');
 assert.equal(new URL(current.calendarUrl).searchParams.get('property'),p.id);
});
