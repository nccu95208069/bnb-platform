import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/calendar-fixture.mjs';
import { workspaceDirectory } from '../src/lib/customer-workspaces/directory.ts';
import { customerReturnPath } from '../src/lib/customer-workspaces/return-path.ts';
test('directory uses fresh scoped membership and names; removed grants disappear',async()=>{
  const {store,workspace}=fixture();
  const account={id:'calendar-owner',workspaces:[{slug:workspace.slug,name:'stale name'},{slug:'removed-inn'}]};
  const initial = (await workspaceDirectory(store,account))[0];
  assert.equal(initial.name,workspace.name);
  assert.equal(initial.properties[0].calendarState,'pending');
  assert.equal(initial.properties[0].activeBookings,0);
  workspace.properties[0].setup={mode:'empty',readyAt:new Date().toISOString(),unresolvedCount:0};
  workspace.bookings=[{propertyId:'property',status:'confirmed'},{propertyId:'property',status:'cancelled'}];
  const readyKey=`workspace:${workspace.id}`,beforeReady=await store.read(readyKey);
  await store.commit([{key:readyKey,before:beforeReady.raw,after:workspace}]);
  const ready = (await workspaceDirectory(store,account))[0].properties[0];
  assert.equal(ready.calendarState,'ready');
  assert.equal(ready.activeBookings,1);
  workspace.members[0].active=false; const key=`workspace:${workspace.id}`,old=await store.read(key);await store.commit([{key,before:old.raw,after:workspace}]);
  assert.deepEqual(await workspaceDirectory(store,account),[]);
});
test('login return preserves real order and property routes, rejects redirects and malicious parameters',()=>{
  for(const value of ['/w/calendar-inn/website?property=abc','/w/calendar-inn/orders','/w/calendar-inn/arrivals?property=abc','/w/calendar-inn/orders/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']) assert.equal(customerReturnPath(value),value);
  for(const value of ['//evil.test','https://evil.test','/w/calendar-inn/../admin','/w/calendar-inn/orders?next=https://evil.test','/w/calendar-inn/orders#x',{},null]) assert.equal(customerReturnPath(value),null);
});
