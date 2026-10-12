import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/customer-dom.mjs';
import { websiteFixture } from './helpers/website-booking-fixture.mjs';
import { view } from '../src/lib/customer-workspaces/service.ts';
import { websiteManagement, setWebsiteSales } from '../src/lib/website-booking/management.ts';
import { WebsiteWorkspace } from '../src/components/website-booking/website-workspace.tsx';

test('simplified owner entry uses selected property links and its pause button reaches the real management service',async t=>{
 const f=await websiteFixture(),w=await f.workspace(),data=view(w,w.members[0]);
 const old=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=old});
 globalThis.fetch=async(url,options)=>{assert.equal(url,`/api/customer-workspaces/${w.slug}/website`);calls.push(options);const result=options.method==='POST'?await setWebsiteSales(f.store,f.account.id,w.slug,JSON.parse(options.body)):await websiteManagement(f.store,f.account.id,w.slug);return Response.json(result)};
 const ui=await mount(t,WebsiteWorkspace,{data,initialPropertyId:w.properties[0].id});
 assert.match(document.body.textContent,/OS 允許接單/);
 const calendar=[...document.querySelectorAll('a')].find(a=>a.textContent.includes('房況日曆'));assert.equal(new URL(calendar.href).searchParams.get('property'),w.properties[0].id);
 await ui.click(ui.button('暫停官網收單'));
 assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.match(document.body.textContent,/OS 尚未開放接單/);
 assert.equal((await f.call('bootstrap')).state,'unavailable');
 const sent=JSON.parse(calls.find(c=>c.method==='POST').body);assert.equal(sent.enabled,false);assert.equal(sent.bindingId,f.binding.id);assert.equal('ownerAccountId' in sent,false);
});

test('price-restricted users get scoped calendar and order links without management fetches or finance links',async t=>{
 const f=await websiteFixture(),w=await f.workspace();const data=view(w,{...w.members[0],role:'viewer_no_price'});
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old});globalThis.fetch=async()=>{throw Error('Restricted viewer must not load management')};
 await mount(t,WebsiteWorkspace,{data});
 assert.equal(document.querySelectorAll('button').length,0);assert.doesNotMatch(document.body.textContent,/收款記帳|房價與旅宿設定|房型對應與旅客規則/);
});

test('an imported static source shows its coverage and needs acknowledgement before sales can be requested',async t=>{
 const f=await websiteFixture({activateSales:false}),w=await f.workspace(),data=view(w,w.members[0]);
 const old=globalThis.fetch,requests=[];t.after(()=>{globalThis.fetch=old});
 const management=await websiteManagement(f.store,f.account.id,w.slug);
 management.sites[0].source={mode:'sheet',coverageFrom:'2026-10-01',coverageTo:'2026-12-01'};
 globalThis.fetch=async(_url,options)=>{
  if(options.method==='POST') requests.push(JSON.parse(options.body));
  return Response.json(management);
 };
 const ui=await mount(t,WebsiteWorkspace,{data});
 assert.match(document.body.textContent,/不是持續同步/);
 assert.match(document.body.textContent,/2026-12-01/);
 assert.equal(ui.button('開放官網收單').disabled,true);
 await ui.click(document.querySelector('input[type=checkbox]'));
 assert.equal(ui.button('開放官網收單').disabled,false);
 await ui.click(ui.button('開放官網收單'));
 assert.equal(requests.length,1);
 assert.equal(requests[0].confirmedStaticSource,true);
});
