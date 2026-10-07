import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { localRedis } from './helpers/redis-command.mjs';
import { websiteFixture, editorToken } from './helpers/website-booking-fixture.mjs';
import { RedisCustomerStore } from '../src/lib/customer-workspaces/store.ts';
import { sessionFor, digest } from '../src/lib/customer-workspaces/auth.ts';
const prefix='synthetic:website-http:'+randomUUID();
process.env.CUSTOMER_WORKSPACE_NAMESPACE=prefix;
process.env.UPSTASH_REDIS_REST_URL='https://redis.test.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN='synthetic-redis-token';
const Connections=await import('../src/app/api/integration/website-booking/v1/connections/route.ts');
const Owner=await import('../src/app/api/website-booking/owner/route.ts');
const Guest=await import('../src/app/api/integration/website-booking/v1/bindings/[bindingId]/[action]/route.ts');
const Pairing=await import('../src/app/api/integration/website-booking/v1/line-binding/route.ts');
const Actions=await import('../src/app/api/integration/website-booking/v1/owner-actions/route.ts');
const Discovery=await import('../src/app/api/integration/website-booking/v1/bindings/route.ts');
const origin='https://os.example.invalid';
function request(path,body,{token,cookie,headers={}}={}) {return new NextRequest(origin+path,{method:'POST',headers:{origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(cookie?{cookie}:{}),...headers},body:typeof body==='string'?body:JSON.stringify(body)});}
async function setup(t){
 t.mock.method(globalThis,'fetch',async(url,init)=>{assert.equal(String(url),'https://redis.test.invalid','no external network in integration tests');return Response.json({result:await localRedis(JSON.parse(init.body))});});
 const keys=await localRedis(['KEYS',prefix+':*']);if(keys.length)await localRedis(['DEL',...keys]);
 const store=new RedisCustomerStore(),f=await websiteFixture({store,approve:false}),cookie='bnb_customer_session='+sessionFor(f.account);
 const approval=await Owner.POST(request('/api/website-booking/owner',f.approval,{cookie}));assert.equal(approval.status,200,await approval.clone().text());
 const status=await Connections.POST(request('/api/integration/website-booking/v1/connections',{schemaVersion:1,action:'status',siteId:f.prepare.siteId,connectionId:f.connection.connectionId},{token:editorToken}));assert.equal(status.status,200);
 const binding=await status.json();
 const call=async(action,body={},headers={})=> Guest.POST(request('/api/integration/website-booking/v1/bindings/'+binding.bindingId+'/'+action,{schemaVersion:1,source:'Official Website',configurationHash:f.prepare.configurationHash,...body},{token:binding.bindingToken,headers}),{params:Promise.resolve({bindingId:binding.bindingId,action})});
 const stay={checkIn:f.config.opensOn,checkOut:new Date(Date.parse(f.config.opensOn)+86400000).toISOString().slice(0,10),roomTypeId:'double',quantity:1,adults:2,children:0};
 const quote=async()=>{const a=await call('availability',stay);assert.equal(a.status,200);const q=await call('quotes',{...stay,availabilityToken:(await a.json()).availabilityToken});assert.equal(q.status,200);return q.json();};
 return {...f,cookie,binding,call,stay,quote};
}
test('HTTP and Redis Lua: concurrent retry occupies once; new store reads back; LINE converts same order',async t=>{
 const f=await setup(t),q=await f.quote(),key=randomUUID(),body={quoteId:q.quoteId,guest:{name:'Synthetic guest',email:'guest@example.invalid',phone:'+00000000',note:''},acceptedPolicy:true,idempotencyKey:key};
 const responses=await Promise.all([f.call('reservations',body,{'idempotency-key':key}),f.call('reservations',body,{'idempotency-key':key})]);for(const r of responses)assert.equal(r.status,200,await r.clone().text());
 const [a,b]=await Promise.all(responses.map(r=>r.json()));assert.equal(a.orderId,b.orderId);
 const fresh=new RedisCustomerStore(),storedBinding=(await fresh.read('website:binding:'+f.binding.bindingId)).value,w=(await fresh.read('workspace:'+storedBinding.workspaceId)).value;
 assert.equal(w.bookings.length,1);assert.equal(w.bookings[0].platform,'Official Website');
 const lookup=await f.call('requests',{idempotencyKey:key});assert.equal((await lookup.json()).orderId,a.orderId);assert.equal(lookup.headers.get('cache-control'),'private, no-store');assert.equal(lookup.headers.get('access-control-allow-origin'),null);
 const workerToken='synthetic-line-http-worker-token-only',recipientId='U'+'1'.repeat(32);
 process.env.WEBSITE_BOOKING_WORKERS=JSON.stringify([{id:'test-line',token_sha256:digest(workerToken),site_scopes:[{client_id:storedBinding.clientId,site_id:storedBinding.siteId}],actions:['line_binding','owner_actions','notifications'],channels:['ownerLine']}]);
 const discovery=await Discovery.POST(request('/api/integration/website-booking/v1/bindings',{schemaVersion:1,action:'discover'},{token:workerToken}));assert.equal(discovery.status,200);assert.deepEqual(await discovery.json(),{schemaVersion:1,bindings:[{bindingId:storedBinding.id,lineConnected:false,inventoryMode:'platform_only'}],channels:['ownerLine']});
 assert.equal((await Discovery.POST(request('/api/integration/website-booking/v1/bindings',{schemaVersion:1,action:'discover',siteId:'forged'},{token:workerToken}))).status,400);
 const pairResponse=await Owner.POST(request('/api/website-booking/owner',{action:'line-prepare',connectionId:f.connection.connectionId,requestKey:randomUUID()},{cookie:f.cookie}));assert.equal(pairResponse.status,200);const pair=await pairResponse.json();
 const paired=await Pairing.POST(request('/api/integration/website-booking/v1/line-binding',{schemaVersion:1,bindingId:storedBinding.id,pairingToken:pair.pairingToken,recipientId},{token:workerToken}));assert.equal(paired.status,200,await paired.clone().text());
 const common={schemaVersion:1,bindingId:storedBinding.id,recipientId,bookingId:a.orderId};
 const inspected=await Actions.POST(request('/api/integration/website-booking/v1/owner-actions',{...common,action:'inspect'},{token:workerToken}));assert.equal(inspected.status,200,await inspected.clone().text());const info=await inspected.json();
 const command={...common,action:'hold-convert',requestKey:randomUUID(),version:info.version,bookingVersion:info.bookingVersion,confirmed:true,confirmPlatformOnly:true,confirmedReceipt:true,amount:500,method:'cash',receivedAt:new Date(Date.now()-1000).toISOString()};
 const converted=await Actions.POST(request('/api/integration/website-booking/v1/owner-actions',command,{token:workerToken}));assert.equal(converted.status,200,await converted.clone().text());const current=await converted.json();assert.equal(current.bookingId,a.orderId);assert.equal(current.remaining,1500);assert.equal(current.source,'Official Website');
 const replay=await Actions.POST(request('/api/integration/website-booking/v1/owner-actions',command,{token:workerToken}));assert((await replay.json()).operation.replayed);
 const canonical=(await fresh.read('workspace:'+w.id)).value;assert.equal(canonical.bookings.length,1);assert.equal(canonical.bookings[0].payments.length,1);assert.equal((await(await f.call('requests',{idempotencyKey:key})).json()).status,'confirmed');
});
test('HTTP rejects cookie service auth, forged authority, missing idempotency header, cross-origin owner approval and oversized input',async t=>{
 const f=await setup(t),q=await f.quote(),idempotencyKey=randomUUID();
 assert.equal((await Connections.POST(request('/api/integration/website-booking/v1/connections',f.prepare,{token:editorToken,cookie:f.cookie}))).status,401);
 assert.equal((await Owner.POST(request('/api/website-booking/owner',f.approval,{cookie:f.cookie,headers:{origin:'https://attacker.example.invalid'}}))).status,403);
 assert.equal((await f.call('availability',{...f.stay,workspaceId:'forged'})).status,400);
 assert.equal((await f.call('reservations',{quoteId:q.quoteId,guest:{name:'Synthetic',email:'guest@example.invalid',phone:'+00000000',note:''},acceptedPolicy:true,idempotencyKey})).status,400);
 assert.equal((await Connections.POST(request('/api/integration/website-booking/v1/connections','x'.repeat(40000),{token:editorToken}))).status,400);
 const owner=await Owner.GET(new NextRequest(origin+'/api/website-booking/owner?connection='+f.connection.connectionId,{headers:{cookie:f.cookie}}));assert.equal(owner.status,200);assert(!(await owner.text()).includes(f.binding.bindingToken));
});
test('Redis last-room contention permits one different request and failed lookup stays not_found',async t=>{
 const f=await setup(t),quotes=await Promise.all([f.quote(),f.quote()]),keys=[randomUUID(),randomUUID()];
 const r=await Promise.all(quotes.map((q,i)=>f.call('reservations',{quoteId:q.quoteId,guest:{name:'Synthetic',email:'guest@example.invalid',phone:'+00000000',note:''},acceptedPolicy:true,idempotencyKey:keys[i]},{'idempotency-key':keys[i]})));
 assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);const failed=r.findIndex(x=>x.status===409);assert.equal((await(await f.call('requests',{idempotencyKey:keys[failed]})).json()).status,'not_found');
});
