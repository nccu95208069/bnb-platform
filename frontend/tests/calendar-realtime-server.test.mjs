import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { calendarEventStream } from '../src/lib/calendar-realtime/stream.server.ts';
import { calendarStreamConfig, streamProperties } from '../src/lib/calendar-realtime/config.server.ts';

const propertyId = '11111111-1111-4111-8111-111111111111';
const target = {property:'sweetfun', propertyId, topic:'calendar:'+'a'.repeat(64)};
function fixture(extra = {}) {
  let callbacks, disposed = 0;
  const controller = new AbortController();
  const stream = calendarEventStream({ targets:[target], signal:controller.signal,
    subscribe(value) { callbacks=value; return () => { disposed++; }; },
    authorized:async()=>true, ...extra });
  return { callbacks, controller, stream, disposed:()=>disposed, reader:stream.getReader() };
}
const text = value => new TextDecoder().decode(value);

test('server capability configuration is property-bound and never uses preview authority',()=>{
  const value={url:'https://abcdefghijklmnopqrst.supabase.co',key:'synthetic-public-key-'.repeat(3),properties:{sweetfun:{propertyId,topic:target.topic}}};
  const env={CALENDAR_REALTIME_CONFIG:JSON.stringify(value),IRON_GATE_SWEETFUN_CALENDAR_ENABLED:'true',IRON_GATE_SWEETFUN_CALENDAR_GRANT:JSON.stringify({propertyId})};
  assert.equal(calendarStreamConfig(['sweetfun'],env).targets[0].propertyId,propertyId);
  for(const change of [{IRON_GATE_SWEETFUN_CALENDAR_ENABLED:'false'}, {IRON_GATE_SWEETFUN_CALENDAR_GRANT:'{}'}, {CALENDAR_REALTIME_CONFIG:JSON.stringify({...value,url:'https://attacker.invalid'})}])
    assert.throws(()=>calendarStreamConfig(['sweetfun'],{...env,...change}),/UNAVAILABLE/);
  assert.throws(()=>calendarStreamConfig(['offland'],env),/UNAVAILABLE/);
  assert.deepEqual(streamProperties('sweetfun,offland'),['offland','sweetfun']);
  for(const value of [null,'','sweetfun,sweetfun','unknown','sweetfun,offland,unknown'])assert.throws(()=>streamProperties(value));
});

test('ready closes subscribe/read gap; events are scoped and strip all upstream details',async()=>{
  const f=fixture(); await f.reader.read();
  f.callbacks.ready();
  assert.match(text((await f.reader.read()).value),/event: ready\ndata: {"properties":\["sweetfun"\]}/);
  f.callbacks.changed('offland',{property_id:propertyId,cursor:'1'});
  f.callbacks.changed('sweetfun',{property_id:'foreign',cursor:'1'});
  f.callbacks.changed('sweetfun',{property_id:propertyId,cursor:'bad\ninjected'});
  f.callbacks.changed('sweetfun',{property_id:propertyId,cursor:'21',guest_name:'PRIVATE',topic:target.topic});
  assert.equal(text((await f.reader.read()).value),'event: change\ndata: {"property":"sweetfun","revision":"21"}\n\n');
  f.callbacks.changed('sweetfun',{property_id:propertyId,cursor:'21'});
  f.callbacks.changed('sweetfun',{property_id:propertyId,cursor:'20'});
  assert.match(text((await f.reader.read()).value),/"revision":"20"/,'lower sequence can commit later and must invalidate');
  f.controller.abort(); assert.equal((await f.reader.read()).done,true); assert.equal(f.disposed(),1);
});

test('revocation stops notifications, disposes provider and does not retain session cache',async()=>{
  let calls=0;
  const f=fixture({heartbeatMs:5,authorized:async()=>{calls++;return false;}});
  await f.reader.read();
  assert.match(text((await f.reader.read()).value),/event: revoked/);
  assert.equal((await f.reader.read()).done,true);
  assert.equal(calls,1); assert.equal(f.disposed(),1);
  f.callbacks.changed('sweetfun',{property_id:propertyId,cursor:'99'});
});

test('stream cancellation, join failure and lifetime expiry all close provider once',async()=>{
  const f=fixture(); await f.reader.cancel(); assert.equal(f.disposed(),1);
  f.callbacks.failed(); assert.equal(f.disposed(),1);
  const g=fixture({lifetimeMs:10,joinTimeoutMs:100}); await g.reader.read();
  assert.equal((await g.reader.read()).done,true); assert.equal(g.disposed(),1);
  const h=fixture({joinTimeoutMs:5}); await h.reader.read();
  assert.equal((await h.reader.read()).done,true); assert.equal(h.disposed(),1);
});

test('slow authorization rechecks never overlap and failures close the stream',async()=>{
  let running=0,max=0;
  const f=fixture({heartbeatMs:2,authorized:async()=>{max=Math.max(max,++running);await delay(12);running--;throw Error('private failure');}});
  await f.reader.read();assert.equal((await f.reader.read()).done,true);
  assert.equal(max,1);assert.equal(f.disposed(),1);
});
