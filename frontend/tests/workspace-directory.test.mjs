import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/calendar-fixture.mjs';
import { workspaceDirectory } from '../src/lib/customer-workspaces/directory.ts';
import { customerReturnPath } from '../src/lib/customer-workspaces/return-path.ts';
test('directory uses fresh scoped membership and names; removed grants disappear',async()=>{
  const {store,workspace}=fixture();
  const account={id:'calendar-owner',workspaces:[{slug:workspace.slug,name:'stale name'},{slug:'removed-inn'}]};
  assert.equal((await workspaceDirectory(store,account))[0].name,workspace.name);
  workspace.members[0].active=false; const key=`workspace:${workspace.id}`,old=await store.read(key);await store.commit([{key,before:old.raw,after:workspace}]);
  assert.deepEqual(await workspaceDirectory(store,account),[]);
});
test('login return preserves real order and property routes, rejects redirects and malicious parameters',()=>{
  for(const value of ['/w/calendar-inn/orders','/w/calendar-inn/arrivals?property=abc','/w/calendar-inn/orders/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']) assert.equal(customerReturnPath(value),value);
  for(const value of ['//evil.test','https://evil.test','/w/calendar-inn/../admin','/w/calendar-inn/orders?next=https://evil.test','/w/calendar-inn/orders#x',{},null]) assert.equal(customerReturnPath(value),null);
});
