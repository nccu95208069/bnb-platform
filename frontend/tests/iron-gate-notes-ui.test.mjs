import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { BookingSourceNotes } from '../src/components/calendar/booking-source-notes.tsx';
import { mount } from './helpers/customer-dom.mjs';
const id='66666666-6666-4666-8666-666666666666';
const booking={id:'row',property_id:'sweetfun',order_id:'IG-'+id,iron_gate_booking_id:id,iron_gate_booking_version:1,source_read_only:true,price_hidden:false};
const props=value=>({booking:value,orderSegments:[],viewPrices:true});
const payload=(notes,bookingId=id,property='sweetfun')=>({bookingId,property,version:1,notes});
test('current notes replace Sheet sync warning and preserve multiline text without executing markup',async t=>{
 const notes='第一行\n歷史來源備註：提醒\n<script>not executable</script>';
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,`/api/v1/bookings/${id}/notes?property=sweetfun`);assert.equal(options.cache,'no-store');return Response.json(payload(notes));});
 await mount(t,BookingSourceNotes,props(booking));assert.equal(document.querySelector('section').getAttribute('aria-label'),'訂單備註');assert.ok([...document.querySelectorAll('p')].some(p=>p.textContent===notes&&p.classList.contains('whitespace-pre-wrap')));assert.equal(document.querySelector('script'),null);assert.doesNotMatch(document.body.textContent,/待主表同步|主表備註/);
});
test('failed reads are distinct from empty notes and can retry',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>++calls===1?new Response('',{status:503}):Response.json(payload(null)));const ui=await mount(t,BookingSourceNotes,props(booking));assert.match(document.body.textContent,/暫時無法讀取備註/);assert.doesNotMatch(document.body.textContent,/尚無訂單備註/);await ui.click(ui.button('重試'));assert.equal(calls,2);assert.match(document.body.textContent,/尚無訂單備註/);assert.doesNotMatch(document.body.textContent,/暫時無法讀取備註/);
});
test('switching orders discards late responses from the previous order',async t=>{
 let resolveFirst;const pending=new Promise(resolve=>{resolveFirst=resolve});let firstSignal;const other='77777777-7777-4777-8777-777777777777';
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(url.includes(id)){firstSignal=options.signal;return pending}return Response.json(payload('第二筆備註',other));});
 const ui=await mount(t,BookingSourceNotes,props(booking));assert.match(document.body.textContent,/讀取中/);await act(()=>ui.root.render(createElement(BookingSourceNotes,props({...booking,iron_gate_booking_id:other,order_id:'IG-'+other}))));assert.equal(firstSignal.aborted,true);assert.match(document.body.textContent,/第二筆備註/);await act(()=>resolveFirst(Response.json(payload('第一筆舊備註'))));assert.doesNotMatch(document.body.textContent,/第一筆舊備註/);
});
test('hidden-price UI never requests or renders notes',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('unexpected')});const ui=await mount(t,BookingSourceNotes,{...props(booking),viewPrices:false});assert.equal(calls,0);assert.equal(document.querySelector('section'),null);await act(()=>ui.root.render(createElement(BookingSourceNotes,props({...booking,price_hidden:true}))));assert.equal(calls,0);assert.equal(document.querySelector('section'),null);
});
test('wrong order response is an error, not another guest note',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json(payload('wrong order','other')));await mount(t,BookingSourceNotes,props(booking));assert.match(document.body.textContent,/暫時無法讀取備註/);assert.doesNotMatch(document.body.textContent,/wrong order/);
});
