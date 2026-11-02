import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {GuestNotificationButton,GuestNotificationProvider} from '../src/components/calendar/guest-notification.tsx';
import {useAccessControl} from '../src/lib/access-control.ts';

test('calendar notification uses the legacy status key with the exact Iron Gate booking proof',async t=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://test.local'});
 const prior={window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT};
 const oldAccess=useAccessControl.getState();
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 useAccessControl.setState({membership:{role:'owner',allProperties:false,propertyIds:['sweetfun']},previewRole:null});
 const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root'));
 t.after(async()=>{await act(()=>root.unmount());useAccessControl.setState(oldAccess,true);Object.assign(globalThis,prior);dom.window.close();});
 const legacy='SF-1234567890abcdef1234',ig='IG-66666666-6666-4666-8666-666666666666';
 const state={version:2,notified:true,at:'2026-10-23T00:00:00.000Z',actor:'operator',actor_name:'Operator',request_id:'previous'};
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  if(options.method==='POST'){
   const body=JSON.parse(options.body);calls.push(body);
   return Response.json({state:{...state,version:body.expected_version+1,notified:body.notified}});
  }
  assert.match(url,/guest-notification\?property=sweetfun/);
  return Response.json({states:{[legacy]:state},can_write:true});
 });
 const booking=(id,notification)=>({property_id:'sweetfun',order_id:id,notification_order_id:notification,reservation_status:'confirmed'});
 await act(()=>root.render(createElement(GuestNotificationProvider,null,
  createElement(GuestNotificationButton,{booking:booking(ig,legacy)}))));
 const button=()=>document.querySelector('button');
 assert.equal(button().textContent,'✅ 已通知');
 await act(()=>button().click());
 assert.equal(calls.length,1);
 assert.equal(calls[0].property_id,'sweetfun');
 assert.equal(calls[0].order_id,legacy);
 assert.equal(calls[0].ig_booking_id,ig);
 assert.equal(calls[0].expected_version,2);
 assert.equal(calls[0].notified,false);
 assert.equal(button().textContent,'尚未通知');
});
