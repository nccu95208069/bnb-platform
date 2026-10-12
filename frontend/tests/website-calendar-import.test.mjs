import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { websiteFixture } from './helpers/website-booking-fixture.mjs';
import { ics, event } from './helpers/calendar-fixture.mjs';
import { addDays } from '../src/lib/website-booking/config.ts';
import { uploadCalendar, previewCalendar, commitCalendar } from '../src/lib/customer-workspaces/calendar-import.ts';
import { setWebsiteSales } from '../src/lib/website-booking/management.ts';

async function importStay(f, to = addDays(f.config.closesOn, 1)) {
 const roomId=f.binding.physicalMappings[0].roomIds[0];
 const source=await uploadCalendar(f.store,f.account.id,f.binding.slug,f.binding.propertyId,
  Buffer.from(ics([event({uid:'occupied-night',start:f.stay.checkIn.replaceAll('-',''),end:addDays(f.stay.checkIn,1).replaceAll('-',''),title:'Synthetic occupied stay'})])),
  'synthetic.ics',{kind:'ios_calendar',from:f.config.opensOn,to,timezone:'Asia/Taipei'});
 const preview=await previewCalendar(f.store,f.account.id,f.binding.slug,f.binding.propertyId,source.id,
  {calendarIds:['room-cal'],rooms:{'room-cal':[roomId]},dateMode:'stay',titleRooms:false,extractLabels:true,overrides:{}});
 assert.equal(preview.rows.length,1);
 assert.equal(preview.rows[0].issues.length,0);
 await commitCalendar(f.store,f.account.id,f.binding.slug,f.binding.propertyId,
  {previewId:preview.id,selected:[preview.rows[0].id],confirmed:true,confirmedCoverage:true,mode:'migration'});
 return roomId;
}

async function enable(f) {
 return setWebsiteSales(f.store,f.account.id,f.binding.slug,
  {action:'sales',bindingId:f.binding.id,revision:f.binding.revision,enabled:true,confirmedStaticSource:true,requestKey:randomUUID()});
}

test('owner-confirmed file calendar shares imported room-nights with a sales-off website binding',async()=>{
 const f=await websiteFixture({activateSales:false,mode:'rooms'});
 const roomId=await importStay(f);
 let workspace=await f.workspace();
 assert.equal(workspace.bookings[0].entry,'calendar');
 assert.deepEqual(workspace.bookings[0].roomIds,[roomId]);
 assert.equal((await f.call('bootstrap')).state,'unavailable');
 await enable(f);
 assert.equal((await f.call('bootstrap')).state,'ready');
 assert.equal((await f.call('availability',{...f.stay,checkOut:addDays(f.stay.checkIn,1)})).options[0].availableUnits,0);
 await assert.rejects(f.quote({checkOut:addDays(f.stay.checkIn,1)}),/ROOM_CONFLICT/);
 const freeStay={...f.stay,checkIn:addDays(f.stay.checkOut,1),checkOut:addDays(f.stay.checkOut,2)};
 assert.equal((await f.call('availability',freeStay)).options[0].availableUnits,1);
});

test('an imported file covering less than the advertised period cannot enable sales',async()=>{
 const f=await websiteFixture({activateSales:false,mode:'rooms'});
 await importStay(f,addDays(f.config.closesOn,-1));
 await assert.rejects(enable(f),/SOURCE_COVERAGE/);
 assert.equal((await f.call('bootstrap')).state,'unavailable');
});

test('static calendar sales require an explicit owner acknowledgement',async()=>{
 const f=await websiteFixture({activateSales:false,mode:'rooms'});
 await importStay(f);
 await assert.rejects(setWebsiteSales(f.store,f.account.id,f.binding.slug,
  {action:'sales',bindingId:f.binding.id,revision:f.binding.revision,enabled:true,requestKey:randomUUID()}),
 /STATIC_SOURCE_CONFIRMATION_REQUIRED/);
 assert.equal((await f.call('bootstrap')).state,'unavailable');
});

test('pending source changes or a connected read-only calendar stop a previously enabled website',async()=>{
 const f=await websiteFixture({activateSales:false,mode:'rooms'});
 await importStay(f);await enable(f);
 assert.equal((await f.call('bootstrap')).state,'ready');
 let saved=await f.store.read('workspace:'+f.binding.workspaceId);
 const pending=structuredClone(saved.value);
 pending.calendarSources[0].pendingCount=1;
 pending.properties[0].setup.unresolvedCount=1;
 await f.store.commit([{key:'workspace:'+f.binding.workspaceId,before:saved.raw,after:pending}]);
 assert.equal((await f.call('bootstrap')).state,'unavailable');
 await assert.rejects(f.call('availability',f.stay),/LEGACY_INTEGRATION_REQUIRED/);
 saved=await f.store.read('workspace:'+f.binding.workspaceId);
 const connected=structuredClone(saved.value);
 connected.calendarSources[0].pendingCount=0;
 connected.calendarSources[0].mode='connected';
 connected.properties[0].setup.unresolvedCount=0;
 await f.store.commit([{key:'workspace:'+f.binding.workspaceId,before:saved.raw,after:connected}]);
 assert.equal((await f.call('bootstrap')).state,'unavailable');
 await assert.rejects(f.call('availability',f.stay),/LEGACY_INTEGRATION_REQUIRED/);
});
