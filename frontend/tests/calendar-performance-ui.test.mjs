import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { mount } from './helpers/customer-dom.mjs';
import { useCalendarPerformance } from '../src/components/calendar/use-calendar-performance.ts';
function Probe({range='private-range-key',ready=false}) { useCalendarPerformance(range,ready); return null; }
const settle = () => act(async()=>{await new Promise(r=>setTimeout(r,15));});

test('paint timings wait for coverage; empty loaded ranges count and private range keys never enter metrics',async t=>{
 for(const name of ['calendar.open','calendar.range'])performance.clearMeasures(name);
 const logs=[];
 t.mock.method(console,'info',(...args)=>logs.push(args));
 const {root}=await mount(t,Probe,{},'?calendar_perf=1');
 await settle();
 assert.equal(performance.getEntriesByName('calendar.open').length,0);
 await act(()=>root.render(createElement(Probe,{ready:true})));
 await settle();
 assert.equal(performance.getEntriesByName('calendar.open').length,1);
 assert.equal(performance.getEntriesByName('calendar.range').length,1);
 assert.ok(performance.getEntriesByName('calendar.range')[0].duration>=0);
 await act(()=>root.render(createElement(Probe,{range:'other-private-range',ready:true})));
 await settle();
 const events=logs.map(args=>JSON.parse(args[1]));
 assert.deepEqual(events.map(e=>e.metric),['calendar.range','calendar.open','calendar.range']);
 assert.ok(events.every(e=>Object.keys(e).sort().join(',')==='durationMs,metric'));
 assert.doesNotMatch(JSON.stringify(logs),/private-range|other-private/);
});

test('resource diagnostics expose only fixed stage names and durations without URLs or identities',async t=>{
 const logs=[];let observerCallback;let disconnected=false;
 t.mock.method(console,'info',(...args)=>logs.push(args));
 const old=globalThis.PerformanceObserver;
 globalThis.PerformanceObserver=class {constructor(callback){observerCallback=callback;} observe(){} disconnect(){disconnected=true;}};
 t.after(()=>{globalThis.PerformanceObserver=old;});
 const {root}=await mount(t,Probe,{},'?calendar_perf=1');
 observerCallback({getEntries:()=>[
  {name:'https://operations.test/api/v1/bookings/calendar?private-secret=guest',duration:44.321,
   serverTiming:[{name:'auth',duration:3},{name:'payment',duration:8},{name:'guest-name',duration:99}]},
  {name:'https://operations.test/api/private-orders?guest=secret',duration:10,serverTiming:[]}
 ]});
 assert.deepEqual(JSON.parse(logs[0][1]),{metric:'calendar.api',durationMs:44.3,stages:{auth:3,payment:8}});
 assert.equal(logs.length,1);
 await act(()=>root.unmount());assert.equal(disconnected,true);
});
