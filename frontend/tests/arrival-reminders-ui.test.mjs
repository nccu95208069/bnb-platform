import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {ArrivalReminders} from '../src/components/arrival-reminders.tsx';
test('arrival UI preserves full notes, persists handled state through readback and keeps source failure explicit',async t=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'https://test.local'});
  const prior={window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT};
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
  const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root'));
  t.after(async()=>{await act(()=>root.unmount());Object.assign(globalThis,prior);dom.window.close();});
  let handled=false,failed=false,partial=false;const calls=[];
  const item={id:'booking',guest:'Synthetic',checkIn:'2026-10-10',checkOut:'2026-10-11',rooms:['101'],notes:'需要嬰兒床\n晚上九點抵達',href:'/w/test-inn/orders/booking',fingerprint:'version1'};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,options});assert.match(url,/property=second/);
    if(failed)return Response.json({detail:'來源尚待核對'},{status:503});
    if(options.method==='POST'){assert.equal(JSON.parse(options.body).fingerprint,'version1');handled=true;return Response.json({handledAt:'2026-10-10T01:00:00Z'});}
    return Response.json({propertyName:'Second',day:'2026-10-10',checkedAt:'2026-10-10T01:00:00Z',unconfirmed:partial?[{id:'pending',date:'2026-10-11',rooms:['102'],reason:'order_link',notes:'待核對的完整備註',href:'/calendar?stay=2026-10-11_102'}]:[],arrivals:[{...item,handledAt:handled?'2026-10-10T01:00:00Z':null}]});
  });
  await act(()=>root.render(createElement(ArrivalReminders,{properties:[{id:'first',name:'First'},{id:'second',name:'Second'}],initialProperty:'second',workspace:'test-inn'})));
  assert.ok(document.body.textContent.includes(item.notes));assert.equal(document.querySelector('a').getAttribute('href'),item.href);
  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
  await act(()=>button('標記已處理').click());assert.ok(document.body.textContent.includes('已處理'));assert.equal(button('標記已處理'),undefined);assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
  partial=true;await act(()=>button('重新載入').click());assert.match(document.querySelector('[role="alert"]').textContent,/可能不完整/);assert.match(document.querySelector('[aria-label="待核對房晚"]').textContent,/待核對的完整備註/);assert.equal(document.querySelector('[aria-label="待核對房晚"] button'),null);assert.equal(document.querySelectorAll('article').length,2);
  failed=true;await act(()=>button('重新載入').click());assert.equal(document.querySelector('[role="alert"]').textContent,'來源尚待核對');assert.equal(document.querySelector('article'),null);assert.ok(!document.body.textContent.includes('目前沒有'));
});
