import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { mount } from './helpers/customer-dom.mjs';
import { useCalendarPerformance } from '../src/components/calendar/use-calendar-performance.ts';
function Probe({range='private-range-key',ready=false,cachedReady=false}) { useCalendarPerformance(range,ready,cachedReady); return null; }
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

test('resource diagnostics include sync sizes and only fixed names and numbers without URLs or identities',async t=>{
 const logs=[];let observerCallback;let disconnected=false;
 t.mock.method(console,'info',(...args)=>logs.push(args));
 const old=globalThis.PerformanceObserver;
 globalThis.PerformanceObserver=class {constructor(callback){observerCallback=callback;} observe(){} disconnect(){disconnected=true;}};
 t.after(()=>{globalThis.PerformanceObserver=old;});
 const {root}=await mount(t,Probe,{},'?calendar_perf=1');
 observerCallback({getEntries:()=>[
  {name:'https://operations.test/api/v1/bookings/calendar?private-secret=guest',duration:44.321,
   decodedBodySize:12000,transferSize:3500,
   serverTiming:[{name:'auth',duration:3},{name:'payment',duration:8},{name:'guest-name',duration:99}]},
  {name:'https://operations.test/api/v1/bookings/calendar/sync?date=2026-11-10&id=private-secret',duration:18.325,
   decodedBodySize:1400,transferSize:900,
   serverTiming:[{name:'source',duration:7},{name:'total',duration:18},{name:'auth',duration:NaN}]},
  {name:'https://operations.test/api/calendar-session?guest=private-secret',duration:2.8,
   decodedBodySize:NaN,transferSize:-1,serverTiming:[]},
  {name:'https://operations.test/api/private-orders?guest=secret',duration:10,serverTiming:[]}
 ]});
 assert.deepEqual(logs.map(args=>JSON.parse(args[1])),[
  {metric:'calendar.api',durationMs:44.3,stages:{auth:3,payment:8},decodedBodySize:12000,transferSize:3500},
  {metric:'calendar.sync',durationMs:18.3,stages:{source:7,total:18},decodedBodySize:1400,transferSize:900},
  {metric:'calendar.session',durationMs:2.8,stages:{},decodedBodySize:0,transferSize:0},
 ]);
 assert.doesNotMatch(JSON.stringify(logs),/https|operations|private-secret|guest-name|2026-11-10/);
 await act(()=>root.unmount());assert.equal(disconnected,true);
});

test('cached paint is measured before fresh readiness and never substitutes for the live opening measure',async t=>{
 for(const name of ['calendar.cached','calendar.open','calendar.range'])performance.clearMeasures(name);
 const logs=[];
 t.mock.method(console,'info',(...args)=>logs.push(args));
 const originalEntries=performance.getEntriesByType.bind(performance);
 t.mock.method(performance,'getEntriesByType',type=>type==='navigation'
  ? [{name:'https://operations.test/calendar?calendar_perf=1&private=secret',startTime:0}]
  : originalEntries(type));
 const {root}=await mount(t,Probe,{cachedReady:true},'?calendar_perf=1');
 await settle();
 assert.equal(performance.getEntriesByName('calendar.cached').length,1);
 assert.equal(performance.getEntriesByName('calendar.cached')[0].startTime,0);
 assert.equal(performance.getEntriesByName('calendar.open').length,0);
 assert.equal(performance.getEntriesByName('calendar.range').length,0);
 await act(()=>root.render(createElement(Probe,{range:'another-private-range',cachedReady:true})));
 await settle();
 assert.equal(logs.filter(args=>JSON.parse(args[1]).metric==='calendar.cached').length,1);
 await act(()=>root.render(createElement(Probe,{range:'another-private-range',ready:true,cachedReady:false})));
 await settle();
 assert.equal(performance.getEntriesByName('calendar.open').length,1);
 assert.deepEqual(logs.map(args=>JSON.parse(args[1]).metric),['calendar.cached','calendar.range','calendar.open']);
 assert.ok(logs.every(args=>Number.isFinite(JSON.parse(args[1]).durationMs)));
 assert.doesNotMatch(JSON.stringify(logs),/private|secret|operations/);
});
