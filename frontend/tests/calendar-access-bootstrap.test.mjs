import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { mount } from './helpers/customer-dom.mjs';
process.env.NEXT_PUBLIC_CALENDAR_SOURCE = 'sheet_snapshot';
const { useAccessControl } = await import('../src/lib/access-control.ts');
const { AuthGuard } = await import('../src/components/admin/auth-guard.tsx');
const member = { id:'synthetic-owner', tenantId:'test', tenantName:'Test', displayName:'Owner',
  email:null,phone:null,role:'owner',status:'active',allProperties:true,propertyIds:['sweetfun','offland'] };
const session = {available:true,authenticated:true,membership:member};
const response = data => new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});

test('server bootstrap mounts calendar without a session fetch; focus still checks revoked access',async t=>{
 useAccessControl.getState().reset();
 // A failed prior session must not redirect before the new server bootstrap applies.
 useAccessControl.setState({initialized:true,membership:null});
 let reads=0;
 t.mock.method(globalThis,'fetch',async()=>{reads++;return response({available:true,authenticated:false,membership:null});});
 const mounted = await mount(t,AuthGuard,{initialSession:session,initialAuthMs:12,children:createElement('div',{'data-calendar-child':true})});
 assert.ok(document.querySelector('[data-calendar-child]'));
 assert.equal(location.pathname,'/');
 await act(()=>useAccessControl.getState().initialize());
 assert.equal(reads,0);
 assert.equal(useAccessControl.getState().membership.id,member.id);
 await act(()=>window.dispatchEvent(new Event('focus')));
 assert.equal(reads,1);
 assert.equal(useAccessControl.getState().membership,null);
 assert.equal(document.querySelector('[data-calendar-child]'),null);
 await act(()=>mounted.root.unmount());
 useAccessControl.getState().reset();
});

test('recent initialization deduplicates, expiration and force read current role',async t=>{
 useAccessControl.getState().reset();
 let reads=0;
 t.mock.method(globalThis,'fetch',async()=>{reads++;return response({...session,membership:{...member,role:'viewer_no_price',allProperties:false,propertyIds:['offland']}});});
 useAccessControl.getState().bootstrap(session);
 await useAccessControl.getState().initialize();
 assert.equal(reads,0);
 useAccessControl.setState({sessionVerifiedAt:Date.now()-31_000});
 await useAccessControl.getState().initialize();
 assert.equal(reads,1);
 assert.equal(useAccessControl.getState().membership.role,'viewer_no_price');
 await useAccessControl.getState().initialize({force:true});
 assert.equal(reads,2);
});

test('logout or newer bootstrap prevents an older pending session from restoring private state',async t=>{
 useAccessControl.getState().reset();
 let resolveRead;
 t.mock.method(globalThis,'fetch',()=>new Promise(resolve=>{resolveRead=resolve;}));
 const pending=useAccessControl.getState().initialize();
 useAccessControl.getState().reset();
 resolveRead(response(session)); await pending;
 assert.equal(useAccessControl.getState().membership,null);
 assert.equal(useAccessControl.getState().initialized,false);
 const older=useAccessControl.getState().initialize();
 useAccessControl.getState().bootstrap({...session,membership:{...member,role:'viewer_no_price'}});
 resolveRead(response(session)); await older;
 assert.equal(useAccessControl.getState().membership.role,'viewer_no_price');
 useAccessControl.getState().reset();
});

test('forced authentication does not get skipped while unrelated member settings are loading',async t=>{
 useAccessControl.getState().bootstrap(session);
 useAccessControl.setState({loading:true});
 let reads=0;
 t.mock.method(globalThis,'fetch',async()=>{reads++;return response({available:true,authenticated:false,membership:null});});
 await useAccessControl.getState().initialize({force:true});
 assert.equal(reads,1);
 assert.equal(useAccessControl.getState().membership,null);
 useAccessControl.getState().reset();
});
