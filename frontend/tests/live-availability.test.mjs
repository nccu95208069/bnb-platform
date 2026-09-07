import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {NextRequest} from 'next/server';
import {liveAvailability} from '../src/lib/live-availability.ts';
import {validatePricingSnapshot,PRICING_KEY} from '../src/lib/pricing-snapshot.ts';
import {GET} from '../src/app/api/v1/availability/route.ts';
import {createMemberSession,MEMBER_COOKIE} from '../src/lib/workspace-auth/session.ts';
import {createPasswordCredential} from '../src/lib/owner-password.ts';

const now=new Date('2026-09-07T12:00:00Z');
const source={source:{snapshot_version:'test',observed_at:now.toISOString(),sync:{status:'healthy',last_checked_at:now.toISOString()}},bookings:[]};
const prices={schema:1,property_id:'sweetfun',version:'a'.repeat(20),source_commit:'b'.repeat(40),observed_at:now.toISOString(),cells:['101','102','201','202','301','302'].map(room=>({date:'2026-09-07',room,channels:{direct:1800,booking:2000},rack_price:2400,daytype:'平日',baseline_version:'v003',stock:{count:1,is_lock:false}}))};
const query={start:'2026-09-07',end:'2026-09-08',channel:'booking',rooms:[],demo_cycle:1};
test('uses correct channel and checkout semantics, does not expose guest information or invent recommendations',()=>{
 const result=liveAvailability(query,{...source,bookings:[{room_number:'101',check_in:'2026-09-06',check_out:'2026-09-07',guest_name:'PRIVATE'},{room_number:'102',check_in:'2026-09-07',check_out:'2026-09-08'}]},prices,now);
 assert.equal(result.cells[0].state,'available');assert.equal(result.cells[1].state,'sold');
 assert.equal(result.cells[0].pricing.current_price,2000);assert.equal(result.cells[0].pricing.base_price,2400);
 assert.equal(result.cells[0].pricing.suggested_price,null);assert.equal(result.cells[0].sellable_units,null);
 assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
test('source outage, overlapping marker, locked stock and missing price never become confirmed inventory or invented prices',()=>{
 const p=structuredClone(prices);p.cells[0].stock.is_lock=true;p.cells[1].stock.count=0;delete p.cells[2].channels.booking;
 const r=liveAvailability(query,{...source,bookings:[{room_number:'301',check_in:'2026-09-07',check_out:'2026-09-08',source_conflict:true}]},p,now);
 assert.equal(r.cells[0].state,'blocked');assert.equal(r.cells[1].state,'unknown');assert.equal(r.cells[2].pricing.current_price,null);assert.equal(r.cells[4].state,'conflict');
 const stale=liveAvailability(query,{...source,source:{...source.source,sync:{status:'stale'}}},null,now);
 assert.equal(stale.counts.available,0);assert.equal(stale.counts.unknown,6);
 const old=liveAvailability(query,source,{...prices,observed_at:'2026-09-01T00:00:00Z'},now);
 assert.equal(old.cells[0].pricing.policy,'stale_snapshot');
});
test('rejects duplicate cells, unsupported channels and invalid prices',()=>{
 assert.equal(validatePricingSnapshot(prices),prices);
 for(const change of [p=>p.cells.push(p.cells[0]),p=>p.cells[0].channels.trip=1900,p=>p.cells[0].rack_price=-1]){
  const p=structuredClone(prices);change(p);assert.throws(()=>validatePricingSnapshot(p));
 }
});
test('real route rejects anonymous, hidden-price, reset-required and wrong-property roles before pricing reads',async t=>{
 process.env.CALENDAR_OWNER_CODE_HASH=createHash('sha256').update('test').digest('hex');process.env.CALENDAR_OWNER_SESSION_SECRET='b'.repeat(64);
 process.env.KV_REST_API_URL='https://test.invalid';process.env.KV_REST_API_TOKEN='test';
 const member={id:'c'.repeat(32),displayName:'Synthetic',role:'viewer_no_price',status:'active',propertyIds:['sweetfun'],allProperties:false,credential:await createPasswordCredential('Synthetic password testing!')};
 let priceReads=0;
 t.mock.method(globalThis,'fetch',async (_url,opt)=>{const command=JSON.parse(opt.body);if(command[1]===PRICING_KEY){priceReads++;return Response.json({result:'gz1:'+gzipSync(JSON.stringify(prices)).toString('base64')});}return Response.json({result:JSON.stringify({version:1,members:[member]})});});
 const request=(cookie,params='')=>new NextRequest('https://test.invalid/api/v1/availability?start=2026-09-07&end=2026-09-08'+params,{headers:cookie?{cookie}:{}});
 assert.equal((await GET(request())).status,401);
 const cookie=()=>`${MEMBER_COOKIE}=${createMemberSession(member)}`;
 assert.equal((await GET(request(cookie()))).status,403);
 member.role='viewer';member.propertyIds=['offland'];assert.equal((await GET(request(cookie()))).status,403);
 assert.equal((await GET(request(cookie(),'&property=offland'))).status,422);
 member.propertyIds=['sweetfun'];member.mustResetPassword=true;assert.equal((await GET(request(cookie()))).status,401);
 member.mustResetPassword=false;assert.equal((await GET(request(cookie(),'&channel=invalid'))).status,400);
 assert.equal(priceReads,0);
});
