import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { authenticateChangeClient, digest, eventDigest, validateChange, readChangeBody } from '../src/lib/calendar-changes/contract.ts';
import { decode, mergeChange } from '../src/lib/calendar-changes/merge.ts';
import { RedisChangeStore, changePrefix } from '../src/lib/calendar-changes/store.ts';
import { dailyObservation } from '../src/lib/calendar-changes/daily-observation.ts';
import { processChange, recoverChanges } from '../src/lib/calendar-changes/process.ts';
import { POST, GET } from '../src/app/api/v1/calendar/changes/route.ts';
import { localRedis } from './helpers/redis-command.mjs';
import { pricingProperty } from '../src/lib/property-pricing.ts';
import { HEADERS, SOURCE_ID, initialState, reconcile } from '../src/lib/sheet-monitor/reconcile.ts';
import { runMonitor } from '../src/lib/sheet-monitor/runner.ts';
import { adaptSweetfunSheet } from '../src/lib/booking-sources/sweetfun-sheet.ts';
const t0='2026-10-01T00:00:00.000Z',t1='2026-10-01T00:01:00.000Z',t2='2026-10-01T00:02:00.000Z';
const token='synthetic-calendar-token-for-isolated-tests';
const client={id:'pricing-test',token_sha256:digest(token),properties:['sweetfun','offland'],changes:['booking','prices','sales_probability','inventory']};
function fixture(property='sweetfun') {
 const s={schema:1,property_id:property,observed_at:t1,version:'a'.repeat(20),source_commit:'b'.repeat(40),cells:pricingProperty(property).roomNames.map(room=>({date:'2026-10-10',room,channels:{direct:2000},rack_price:2400,daytype:'weekday',baseline_version:'baseline-v1',sales_probability:{value:0.6,asof:'2026-10-01',source_version:'c'.repeat(20)},stock:{count:1,is_lock:false}}))};
 return {schema:1,event_id:'fixture-'+randomUUID(),property_id:property,occurred_at:t2,source_version:s.version,changes:['prices','sales_probability','inventory'],verified:true,pricing_snapshot:s};
}
test('strict scope, bearer, version, timestamps, payload size and PII field validation',async()=>{
 const event=fixture(); assert.equal(validateChange(event,client),event);
 assert.equal(authenticateChangeClient('Bearer '+token,JSON.stringify([client])).id,client.id);
 assert.equal(authenticateChangeClient('Bearer '+token+'x',JSON.stringify([client])),null);
 assert.throws(()=>authenticateChangeClient('Bearer '+token,JSON.stringify([client,client])),/CONFIG/);
 for(const mutate of [e=>e.guest_name='PRIVATE',e=>e.verified=false,e=>e.property_id='foreign',e=>e.source_version='d'.repeat(20),e=>e.occurred_at=t0,e=>e.changes.push('booking', 'booking'),e=>e.pricing_snapshot.cells[0].notes='PRIVATE',e=>e.pricing_snapshot.cells[0].channels.other=2000,e=>e.pricing_snapshot.cells[0].stock.count=-1]){const e=structuredClone(event);mutate(e);assert.throws(()=>validateChange(e,client));}
 assert.throws(()=>validateChange(event,{...client,changes:['booking']}),/FORBIDDEN/);
 assert.throws(()=>validateChange(event,{...client,properties:['offland']}),/FORBIDDEN/);
 assert.equal(eventDigest(event),eventDigest(Object.fromEntries(Object.entries(event).reverse())));
 await assert.rejects(()=>readChangeBody(new Request('https://test.invalid',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(2*1024*1024+1)})),/TOO_LARGE/);
});
test('late event cannot roll back price, model or inventory; independent times survive partial merge',()=>{
 const old=fixture(), fresh=structuredClone(old.pricing_snapshot); fresh.observed_at=t2;
 fresh.cells.forEach(c=>{c.channels.direct=3000;c.stock.is_lock=true;});
 const result=mergeChange(old,fresh,null);
 assert.equal(result.counts.applied,0);assert.equal(result.counts.superseded,18);assert.equal(result.prices,fresh);assert.equal(result.inventory,null);
 old.pricing_snapshot.cells.forEach(c=>{c.probability_observed_at=t2;c.stock_observed_at=t2;}); old.pricing_snapshot.observed_at=t2;
 const partial=mergeChange(old,fresh,null);assert.equal(partial.prices.cells[0].channels.direct,3000);assert.equal(partial.counts.superseded,12);assert.equal(partial.counts.applied,6);
 const same=fixture();same.pricing_snapshot.observed_at=t1.replace('.000','');
 assert.equal(mergeChange(same,fixture().pricing_snapshot,null).counts.superseded,0);
});
test('inventory-only updates preserve price and model timestamps; older model cannot replace newer asof',()=>{
 const e=fixture(), prior=e.pricing_snapshot;
 const stock={schema:1,event_id:'inventory-fixture',property_id:'sweetfun',occurred_at:t2,source_version:'inventory-v1',changes:['inventory'],verified:true,inventory_snapshot:{version:'inventory-v1',observed_at:t2,cells:[{date:'2026-10-10',room:'101',count:0,is_lock:true}]}};
 validateChange(stock,client); const merged=mergeChange(stock,prior,null);
 assert.equal(merged.prices,prior);assert.equal(merged.inventory.cells[0].is_lock,true);
 e.pricing_snapshot=structuredClone(prior); e.pricing_snapshot.observed_at=t2;e.pricing_snapshot.cells[0].sales_probability.asof='2026-09-30';e.changes=['sales_probability'];
 assert.equal(mergeChange(e,prior,null).counts.superseded,1);
});

const integration = process.env.CALENDAR_TEST_REDIS_PORT ? test : test.skip;
integration('real Redis: durable duplicates, conflicting ID, scoped receipts, CAS and expired lock fences',async()=>{
 process.env.CALENDAR_CHANGE_NAMESPACE='calendar-tests:'+randomUUID();
 const store=new RedisChangeStore(localRedis), event=fixture();
 await localRedis(['DEL',pricingProperty('sweetfun').key]);
 const [a,b]=await Promise.all([store.enqueue(client.id,event,t2),store.enqueue(client.id,event,t2)]);assert.equal(a.key,b.key);
 await assert.rejects(()=>store.enqueue(client.id,{...event,occurred_at:t1},t2),/ID_REUSED/);
 assert.equal(await store.read('offland',client.id,event.event_id),null);
 assert.equal(await store.read('sweetfun','other-client',event.event_id),null);
 const deps={store,checkBookings:async()=>{throw Error('unexpected upstream read');},now:()=>new Date(t2)};
 const receipt=await processChange(a,deps);assert.equal(receipt.verified,true);assert.equal((await store.read('sweetfun',client.id,event.event_id)).value.receipt.price_version,receipt.price_version);
 assert.equal(await store.revision('sweetfun'),'1');assert.deepEqual(await processChange(b,deps),receipt);assert.equal(await store.revision('sweetfun'),'1');
 assert.equal((await store.pending('sweetfun',t2,10)).length,0);
 const pending=await store.enqueue(client.id,fixture(),t2);const owner=await store.acquire('sweetfun');
 assert.equal(await store.commit(pending,'wrong-owner',{...pending.value.receipt,status:'applied'}),false);
 const raw=await store.rawPrice('sweetfun');
 assert.equal(await store.commit(pending,owner,{...pending.value.receipt,status:'applied'},{before:'wrong-value',after:raw}),false);
 await localRedis(['DEL',changePrefix('sweetfun')+':lock']);
 assert.equal(await store.commit(pending,owner,{...pending.value.receipt,status:'applied'}),false);
 assert.equal(await store.rawPrice('sweetfun'),raw);
 const newer=fixture();newer.pricing_snapshot.observed_at=t2;newer.pricing_snapshot.cells.forEach(c=>c.channels.direct=4000);
 const next=await processChange(await store.enqueue(client.id,newer,t2),deps);assert.equal(next.verified,true);
 const delayed=await processChange(await store.enqueue(client.id,fixture(),t2),deps);assert.equal(delayed.status,'superseded');assert.equal(delayed.verified,false);assert.equal(decode(await store.rawPrice('sweetfun')).cells[0].channels.direct,4000);
});
integration('real Redis and Sheet reconciliation: 202-equivalent pending survives restart and confirms after 30 seconds',async()=>{
 process.env.CALENDAR_CHANGE_NAMESPACE='calendar-tests:'+randomUUID();
 const store=new RedisChangeStore(localRedis);
 const rows=[HEADERS,['101','','Direct','2026-10-10','2026-10-11','2026-10-01','2000','','OK','row-one','','parent-one','2']];
 let state=initialState(adaptSweetfunSheet(rows,SOURCE_ID,t0));state=reconcile(reconcile(state,rows,t0),rows,t1);
 let current=new Date(t2),values=structuredClone(rows);values[1][6]='2500';
 const monitor={acquire:async()=> 'owner',read:async()=>state,commit:async(_o,next)=>{state=next;return true;},release:async()=>{}};
 const deps=()=>({store:new RedisChangeStore(localRedis),now:()=>current,checkBookings:()=>runMonitor({store:monitor,read:async()=>values,seed:async()=>state.snapshot,now:()=>current.toISOString()})});
 const event={schema:1,event_id:'booking-fixture-'+randomUUID(),property_id:'sweetfun',occurred_at:t2,source_version:'order-revision-one',changes:['booking'],verified:true};
 const received=await store.enqueue(client.id,event,t2);
 const waiting=await processChange(received,deps());assert.equal(waiting.status,'awaiting_source');assert.equal(waiting.verified,false);assert.equal(state.snapshot.bookings[0].room_rate,2000);
 current=new Date(Date.parse(t2)+29_000);assert.equal((await recoverChanges('sweetfun',deps())).length,0);
 current=new Date(Date.parse(t2)+31_000);const [confirmed]=await recoverChanges('sweetfun',deps());assert.equal(confirmed.verified,true);assert.equal(state.snapshot.bookings[0].room_rate,2500);assert.equal(await store.revision('sweetfun'),'1');
});
integration('real HTTP handlers: POST then GET proof, token separation, disabled mode and no OwlNest calls',async t=>{
 process.env.CALENDAR_CHANGE_NAMESPACE='calendar-tests:'+randomUUID();process.env.CALENDAR_CHANGE_CLIENTS=JSON.stringify([client]);process.env.CALENDAR_CHANGES_ENABLED='true';process.env.BOOKING_SHEET_SOURCES='sweetfun,offland';
 process.env.UPSTASH_REDIS_REST_URL='https://redis.test.invalid';process.env.UPSTASH_REDIS_REST_TOKEN='fixture';
 await localRedis(['DEL',pricingProperty('offland').key]);
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push(String(url));assert.equal(url,'https://redis.test.invalid');return Response.json({result:await localRedis(JSON.parse(options.body))});});
 const e=fixture('offland'),request=(value,authorization='Bearer '+token)=>new NextRequest('https://test.invalid/api/v1/calendar/changes',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await POST(request(e,'Bearer wrong'))).status,401);assert.equal(calls.length,0);
 process.env.CALENDAR_CHANGES_ENABLED='false';assert.equal((await POST(request(e))).status,503);process.env.CALENDAR_CHANGES_ENABLED='true';
 const response=await POST(request(e));assert.equal(response.status,200);const received=await response.json();assert.equal(received.verified,true);
 const proof=await GET(new NextRequest('https://test.invalid'+received.status_url,{headers:{authorization:'Bearer '+token}}));assert.equal(proof.status,200);assert.equal((await proof.json()).source_version,e.source_version);
 assert.equal((await POST(request({...e,occurred_at:t1}))).status,409);
 assert.equal((await POST(request({...fixture('offland'),guest_name:'PRIVATE'}))).status,400);
 assert.equal((await GET(new NextRequest('https://test.invalid'+received.status_url,{headers:{authorization:'Bearer wrong'}}))).status,401);
 assert.equal((await localRedis(['TTL',(await new RedisChangeStore(localRedis).read('offland',client.id,e.event_id)).key]))>0,true);
 assert.equal(calls.some(url=>url.includes('owlting')),false);
});

integration('daily OwlNest check chooses a persisted 08–09 Taipei minute and attempts at most once',async()=>{
 process.env.CALENDAR_CHANGE_NAMESPACE='calendar-tests:'+randomUUID();let current=new Date('2026-10-01T00:00:00Z'),reads=0;
 const deps={command:localRedis,now:()=>current,minute:()=>37,refresh:async()=>{reads++;return {verified:true};}};
 assert.equal((await dailyObservation('sweetfun',deps)).status,'scheduled');assert.equal(reads,0);
 current=new Date('2026-10-01T00:37:00Z');
 await Promise.all([dailyObservation('sweetfun',deps),dailyObservation('sweetfun',deps)]);assert.equal(reads,1);
 current=new Date('2026-10-01T00:58:00Z');await dailyObservation('sweetfun',deps);assert.equal(reads,1);
 current=new Date('2026-10-01T01:00:00Z');assert.equal((await dailyObservation('offland',deps)).status,'outside_window');assert.equal(reads,1);
 current=new Date('2026-10-02T00:40:00Z');deps.refresh=async()=>{reads++;throw Error('upstream secret');};
 assert.equal((await dailyObservation('sweetfun',deps)).status,'needs_attention');await dailyObservation('sweetfun',deps);assert.equal(reads,2);
});
