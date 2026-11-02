import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {NextRequest} from 'next/server';
import {websiteFixture} from './helpers/website-booking-fixture.mjs';
import {sessionFor} from '../src/lib/customer-workspaces/auth.ts';
import {prepareConnection,approveConnection,connectionStatus} from '../src/lib/website-booking/connections.ts';
import {store,failure} from '../src/lib/website-booking/http.ts';
import * as Management from '../src/app/api/customer-workspaces/[slug]/website/route.ts';

test('missing empty-calendar acknowledgement is a recoverable 409; it writes nothing and the confirmed retry opens once',async()=>{
 const f=await websiteFixture({approve:false});
 Object.assign(store,f.store);
 const client={...f.client,site_ids:[],allow_new_sites:true},siteId=randomUUID();
 const pending=await prepareConnection(store,client,{...f.prepare,requestId:randomUUID(),siteId},f.now);
 await approveConnection(store,f.account,{...f.approval,connectionId:pending.connectionId},f.now);
 const status=await connectionStatus(store,client,{schemaVersion:1,action:'status',siteId,connectionId:pending.connectionId},f.now);
 const binding=(await store.read('website:binding:'+status.bindingId)).value;
 const url='https://os.example.invalid/api/customer-workspaces/'+binding.slug+'/website';
 const context={params:Promise.resolve({slug:binding.slug})};
 const headers={origin:'https://os.example.invalid','content-type':'application/json',cookie:'bnb_customer_session='+sessionFor(f.account)};
 const post=input=>Management.POST(new NextRequest(url,{method:'POST',headers,body:JSON.stringify(input)}),context);
 const input={action:'sales',bindingId:binding.id,revision:binding.revision,enabled:true,requestKey:randomUUID()};
 const before=JSON.stringify([...f.store.values]);
 const denied=await post(input);
 assert.equal(denied.status,409);
 assert.equal((await denied.json()).code,'EMPTY_CALENDAR_CONFIRMATION_REQUIRED');
 assert.equal(JSON.stringify([...f.store.values]),before);
 assert.equal((await post({...input,confirmedEmptyCalendar:false})).status,409);
 for(let n=0;n<2;n++){
  const response=await post({...input,confirmedEmptyCalendar:true});assert.equal(response.status,200);
  const current=(await response.json()).sites[0];assert.equal(current.enabled,true);assert.equal(current.revision,2);
 }
 const saved=(await store.read('workspace:'+binding.workspaceId)).value;
 assert.equal(saved.audit.filter(row=>row.action==='website.sales.enabled').length,1);
 assert.equal(saved.bookings.length,0);
});

test('known inventory confirmation and coverage failures remain actionable while unknown failures stay unavailable',async()=>{
 for(const code of ['EMPTY_CALENDAR_CONFIRMATION_REQUIRED','STATIC_SOURCE_CONFIRMATION_REQUIRED','SOURCE_COVERAGE']){
  const response=failure(Error(code));assert.equal(response.status,409);assert.equal((await response.json()).code,code);
 }
 const unknown=failure(Error('private upstream failure'));assert.equal(unknown.status,503);
 assert.deepEqual(await unknown.json(),{code:'SERVICE_UNAVAILABLE',detail:'服務暫時無法確認結果，請保留原查詢碼。'});
});
