import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { digest, canonical, validateChange } from '../src/lib/calendar-changes/contract.ts';
import { encode, decode, mergeChange } from '../src/lib/calendar-changes/merge.ts';
import { RedisChangeStore } from '../src/lib/calendar-changes/store.ts';
import { processChange } from '../src/lib/calendar-changes/process.ts';
import { validatePricingSnapshot } from '../src/lib/pricing-snapshot.ts';
import { pricingProperty } from '../src/lib/property-pricing.ts';
import { refreshedSnapshot } from '../src/lib/owlnest-refresh.ts';
import { liveAvailability } from '../src/lib/live-availability.ts';
import { POST, GET } from '../src/app/api/v1/calendar/changes/route.ts';
import { localRedis } from './helpers/redis-command.mjs';
const t0='2026-10-01T00:00:00.000Z', t1='2026-10-01T00:01:00.000Z', t2='2026-10-01T00:02:00.000Z';
const token='synthetic-decision-token-scoped-for-local-test';
const client={id:'decision-test',token_sha256:digest(token),properties:['sweetfun','offland'],changes:['pricing_decisions']};
export const decision={run_id:'run-shadow-20261001',source_version:'input-snapshot-v1',base_price:2000,target_price:1800,published_price:null,adjustment_pct:-10,probability:{value:0.4,asof:'2026-10-01',source_version:'c'.repeat(20)},reason:'價格下限檢查通過，僅試算',model_version:'model-1',policy_version:'policy-1',calculated_at:t0,published_at:null,observed_at:t1,publish_status:'shadow'};
function snapshot(property='sweetfun') {return {schema:1,property_id:property,observed_at:t1,version:'a'.repeat(20),source_commit:'b'.repeat(40),cells:pricingProperty(property).roomNames.map(room=>({date:'2026-10-10',room,channels:{direct:2000},rack_price:2400,daytype:'weekday',baseline_version:'baseline-1',stock:{count:1,is_lock:false},pricing_decisions:{direct:structuredClone(decision)}}))};}
function event(property='sweetfun'){const s=snapshot(property);return {schema:1,event_id:'decision-'+randomUUID(),property_id:property,source_version:s.version,occurred_at:t2,changes:['pricing_decisions'],verified:true,pricing_snapshot:s};}
test('strict decision contract rejects false publication, bad provenance, inconsistent adjustments and over-scoped writes',()=>{
 assert.doesNotThrow(()=>validateChange(event(),client));
 for(const change of [d=>d.publish_status='verified',d=>d.published_price=1800,d=>d.adjustment_pct=50,d=>d.probability.value=2,d=>d.calculated_at='2026-02-30T00:00:00.000Z',d=>d.observed_at=t2,d=>d.guest_name='PRIVATE',d=>d.reason='',d=>d.probability.asof='2026-10-02']){const e=event();change(e.pricing_snapshot.cells[0].pricing_decisions.direct);assert.throws(()=>validateChange(e,client),/INVALID_PRICING_DECISION/);}
 assert.throws(()=>validateChange(event(),{...client,changes:['prices']}),/FORBIDDEN/);
 const mixed=event();mixed.changes=['prices'];assert.throws(()=>validateChange(mixed,{...client,changes:['prices']}),/INVALID_CHANGE/);
 const verified=event();Object.assign(verified.pricing_snapshot.cells[0].pricing_decisions.direct,{publish_status:'verified',published_price:1800,published_at:t1});assert.doesNotThrow(()=>validateChange(verified,client));
 verified.pricing_snapshot.cells[0].pricing_decisions.direct.published_price=1900;assert.throws(()=>validateChange(verified,client),/INVALID/);
});
test('decision-only events preserve prices and stock; late calculation cannot replace newer decision',()=>{
 const e=event(),prior=snapshot();prior.cells.forEach(c=>{delete c.pricing_decisions;c.channels.direct=3000;c.observed_at=t0;});
 const result=mergeChange(e,prior,null);assert.equal(result.prices.cells[0].channels.direct,3000);assert.equal(result.prices.cells[0].observed_at,t0);assert.equal(result.inventory,null);assert.equal(result.counts.applied,6);
 const price=event();price.changes=['prices'];price.pricing_snapshot.observed_at=t2;price.pricing_snapshot.cells.forEach(c=>{delete c.pricing_decisions;c.channels.direct=3500;});
 const next=mergeChange(price,result.prices,null);assert.deepEqual(next.prices.cells[0].pricing_decisions.direct,decision);assert.equal(next.prices.cells[0].channels.direct,3500);
 const newer=event();newer.pricing_snapshot.observed_at=t2;newer.pricing_snapshot.cells.forEach(c=>Object.assign(c.pricing_decisions.direct,{run_id:'newer-run',calculated_at:t1,observed_at:t2}));
 const saved=mergeChange(newer,next.prices,null).prices;
 const late=event();late.pricing_snapshot.observed_at='2026-10-01T00:03:00.000Z';late.pricing_snapshot.cells.forEach(c=>c.pricing_decisions.direct.observed_at=late.pricing_snapshot.observed_at);
 const rejected=mergeChange(late,saved,null);assert.equal(rejected.counts.superseded,6);assert.equal(rejected.prices,saved);
});
test('manual OwlNest refresh retains all decisions and availability exposes selected channel without suggesting publication',()=>{
 const prior=snapshot(),config=pricingProperty('sweetfun');
 const payload={status:0,data:config.roomNames.map((_,i)=>({room_id:29260+i,plans:[35000,35007,35005,35006,32116].map((id,j)=>({id,plan_items:[{date:'2026-10-10',price:2500+j}]})),stocks:[{date:'2026-10-10',count:1,is_lock:false}]}))};
 const refreshed=refreshedSnapshot(payload,prior,'2026-10-10','2026-10-11',t2);
 assert.deepEqual(refreshed.cells[0].pricing_decisions.direct,decision);
 const bookings={source:{snapshot_version:'fixture',observed_at:t2,sync:{status:'healthy',last_checked_at:t2}},bookings:[]};
 const result=liveAvailability({start:'2026-10-10',end:'2026-10-11',rooms:['101'],channel:'direct',demo_cycle:1},bookings,refreshed,new Date(t2));
 assert.deepEqual(result.cells[0].pricing_decision,decision);assert.equal(result.cells[0].pricing.suggested_price,null);assert.notEqual(result.cells[0].pricing.current_price,decision.target_price);
 assert.equal(liveAvailability({...result.query,channel:'agoda'},bookings,refreshed,new Date(t2)).cells[0].pricing_decision,null);
});
const integration=process.env.CALENDAR_TEST_REDIS_PORT?test:test.skip;
integration('real Redis and HTTP: exact field readback survives restart/retry; tampered ID rejected; shadow never writes price',async t=>{
 process.env.CALENDAR_CHANGE_NAMESPACE='decision-tests:'+randomUUID();process.env.CALENDAR_CHANGE_CLIENTS=JSON.stringify([client]);process.env.CALENDAR_CHANGES_ENABLED='true';process.env.BOOKING_SHEET_SOURCES='sweetfun,offland';process.env.UPSTASH_REDIS_REST_URL='https://redis.test.invalid';process.env.UPSTASH_REDIS_REST_TOKEN='fixture';
 const prior=snapshot('offland');prior.cells.forEach(c=>{delete c.pricing_decisions;c.channels.direct=3500;});await localRedis(['SET',pricingProperty('offland').key,encode(prior)]);
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,'https://redis.test.invalid');return Response.json({result:await localRedis(JSON.parse(options.body))});});
 const e=event('offland'),req=e=>new NextRequest('https://test.invalid/api/v1/calendar/changes',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(e)});
 const response=await POST(req(e));assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.verified,true);assert.equal(saved.decision_readback.cells.length,pricingProperty("offland").roomNames.length);assert(saved.decision_readback.cells.every(c=>c.matches));assert.deepEqual(saved.decision_readback.cells[0].decision,decision);assert.equal(saved.decision_readback.digest,digest(canonical(saved.decision_readback.cells)));
 const proof=await GET(new NextRequest('https://test.invalid'+saved.status_url,{headers:{authorization:'Bearer '+token}}));assert.deepEqual((await proof.json()).decision_readback,saved.decision_readback);
 assert.deepEqual((await (await POST(req(e))).json()).decision_readback,saved.decision_readback);
 const raw=decode(await new RedisChangeStore(localRedis).rawPrice('offland'));assert.equal(raw.cells[0].channels.direct,3500);validatePricingSnapshot(raw);
 const tampered=structuredClone(e);tampered.pricing_snapshot.cells[0].pricing_decisions.direct.reason='changed';assert.equal((await POST(req(tampered))).status,409);
 const late=event('offland');late.pricing_snapshot.cells.forEach(c=>c.pricing_decisions.direct.reason='same-time conflicting decision');
 const conflict=await POST(req(late));assert.equal(conflict.status,409);const retained=await conflict.json();assert.equal(retained.verified,false);assert(retained.decision_readback.cells.every(c=>!c.matches));assert.deepEqual(retained.decision_readback.cells[0].decision,decision);
});
integration('commit readback failure remains uncertain; a retry finds the immutable persisted receipt',async()=>{
 const store=new RedisChangeStore(localRedis),e=event('sweetfun');await localRedis(['DEL',pricingProperty('sweetfun').key]);
 const queued=await store.enqueue(client.id,e,t2);
 let reads=0;const flaky=new RedisChangeStore(async c=>{if(c[0]==='GET'&&c[1]===queued.key&&++reads===2)throw Error('readback transport failure');return localRedis(c);});
 const deps={store:flaky,checkBookings:async()=>{throw Error('unexpected upstream call');},now:()=>new Date(t2)};
 await assert.rejects(processChange(queued,deps),/readback/);
 const recovered=await processChange(queued,{...deps,store:new RedisChangeStore(localRedis)});assert.equal(recovered.verified,true);assert(recovered.decision_readback.cells.every(c=>c.matches));
});
