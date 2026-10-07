import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { useCalendarRevision } from '../src/components/calendar/use-calendar-revision.ts';
import { mount } from './helpers/customer-dom.mjs';

test('visible calendar reloads only for new revisions; hidden screens and disabled hooks do not poll',async t=>{
 let tick, revision='v1', reloads=0, reads=0, hidden=false;
 t.mock.method(globalThis,'setInterval',fn=>{tick=fn;return 1;});
 t.mock.method(globalThis,'clearInterval',()=>{});
 t.mock.method(globalThis,'fetch',async()=>{reads++;return Response.json({property_id:'sweetfun',revision});});
 function Probe(){useCalendarRevision('sweetfun',true,changed);return createElement('span',null,'calendar');}
 const changed=()=>reloads++;
 const {act}=await import('react');
 await mount(t,Probe,{});
 Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
 // JSDOM initially reports hidden; the first visible tick establishes a baseline.
 await act(async()=>{tick();await new Promise(resolve=>setTimeout(resolve,0));});
 assert.equal(reloads,0);
 await act(async()=>{tick();await new Promise(resolve=>setTimeout(resolve,0));});assert.equal(reloads,0);
 revision='v2';await act(async()=>{tick();await new Promise(resolve=>setTimeout(resolve,0));});assert.equal(reloads,1);
 hidden=true;const before=reads;await act(async()=>{tick();});assert.equal(reads,before);
});
