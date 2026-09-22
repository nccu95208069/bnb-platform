import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {refreshedSnapshot,refreshOwlNest} from '../src/lib/owlnest-refresh.ts';
import {validatePricingSnapshot} from '../src/lib/pricing-snapshot.ts';
import {liveAvailability} from '../src/lib/live-availability.ts';
import {applyFinance,readFinance,writeFinance} from '../src/lib/finance-store.ts';
import {summarize} from '../src/lib/finance-model.ts';
const observed='2026-09-22T01:00:00Z',start='2026-09-22',end='2026-09-24';
const prior={schema:1,property_id:'offland',observed_at:'2026-09-21T01:00:00Z',version:'a'.repeat(20),source_commit:'b'.repeat(40),cells:[]};
const payload={status:0,data:[{room_id:34789,plans:[42385,42387,42391,42392,42393,42394].map((id,i)=>({id,plan_items:[start,'2026-09-23'].map(date=>({date,price:8000+i*100}))})),stocks:[{date:start,count:0,is_lock:true},{date:'2026-09-23',count:1,is_lock:false}]}]};
test('Offland maps six distinct plans to one villa and never invents prediction',()=>{
 const p=refreshedSnapshot(payload,prior,start,end,observed);assert.equal(p.cells.length,2);assert.equal(p.cells[0].room,'包棟');assert.equal(p.cells[0].channels.direct,8000);assert.equal(p.cells[0].channels.direct_four,8100);assert.equal(p.cells[0].channels.ctrip,8500);assert.equal(p.cells[0].sales_probability,null);assert.throws(()=>validatePricingSnapshot(p,'sweetfun'),/MISMATCH/);
 const source={source:{snapshot_version:'test',observed_at:observed,sync:{status:'healthy'}},bookings:[]};
 const q={start,end,rooms:[],channel:'direct_four',demo_cycle:1};
 const result=liveAvailability(q,source,p,new Date(observed),'offland');assert.equal(result.property_id,'offland');assert.deepEqual(result.rooms,['包棟']);assert.equal(result.counts.blocked,1);assert.equal(result.counts.available,1);assert.equal(result.cells[1].pricing.current_price,8100);
 const occupied={...source,bookings:[{room_number:'包棟',check_in:start,check_out:'2026-09-23',reservation_status:'confirmed'}]};assert.equal(liveAvailability(q,occupied,p,new Date(observed),'offland').cells[0].state,'sold');assert.equal(liveAvailability(q,occupied,p,new Date(observed),'offland').cells[1].state,'available');
 const bad=structuredClone(payload);bad.data[0].room_id=29260;assert.throws(()=>refreshedSnapshot(bad,prior,start,end,observed),/INCOMPLETE/);
});
test('first refresh writes isolated Offland key and verifies result',async()=>{
 const db=new Map();const commands=[];let forwarded;
 const command=async c=>{commands.push(c);if(c[0]==='SET'){db.set(c[1],c[2]);return 'OK';}if(c[0]==='GET')return db.get(c[1])??null;if(c[0]==='EVAL'&&c[2]===3){db.set(c[4],c.at(-1));return 1;}return 1;};
 const longPayload=structuredClone(payload);for(const p of longPayload.data[0].plans){p.plan_items=[];for(let d=Date.parse(start);d<Date.parse('2026-12-22');d+=86400000)p.plan_items.push({date:new Date(d).toISOString().slice(0,10),price:8000});}
 const result=await refreshOwlNest({command,read:async(a,b,property)=>{forwarded=property;return longPayload;},now:()=>new Date(observed)},'offland');assert.equal(result.verified,true);assert.equal(result.room_count,1);assert.equal(forwarded,'offland');assert.ok(commands.filter(c=>c[0]==='GET').every(c=>c[1]==='sweetfun-os:pricing:v1:offland'));assert.equal(JSON.parse(gunzipSync(Buffer.from(db.get('sweetfun-os:pricing:v1:offland').slice(4),'base64'))).property_id,'offland');
});
test('Offland expense, attribution, audit, replay and persistence are property isolated',async t=>{
 const actor={id:'offland-admin',displayName:'Test admin',role:'admin',viewPrices:true,allProperties:false,propertyIds:['offland']};
 const empty={version:0,entries:[],operations:[]};
 const input={action:'create',kind:'expense',category:'laundry',amount:1200,date:start,description:'',method:'bank_transfer',stage:'',advanced_by:{type:'self'},expense_spread:[{month:'2026-08',amount_cents:120000}],expected_version:0,request_id:'00000000-0000-4000-8000-000000000051'};
 const first=applyFinance(empty,input,actor,'offland',2026,observed);const entry=first.state.entries[0];assert.equal(entry.property_id,'offland');assert.equal(entry.advanced_by.account_id,actor.id);assert.equal(summarize(first.state.entries,'2026-08').allocatedExpense,120000);assert.equal(first.state.operations[0].event.property_id,'offland');assert.equal(first.state.operations[0].event.actor_id,actor.id);assert.equal(applyFinance(first.state,input,actor,'offland',2026,observed).entry_id,first.entry_id);assert.throws(()=>applyFinance(empty,input,actor,'sweetfun',2026,observed),/FORBIDDEN/);
 process.env.KV_REST_API_URL='https://test.invalid';process.env.KV_REST_API_TOKEN='test';const db=new Map();t.mock.method(globalThis,'fetch',async(_,o)=>{const c=JSON.parse(o.body);let result=null;if(c[0]==='GET')result=db.get(c[1])??null;if(c[0]==='EVAL'){assert.match(c[3],/:offland:/);db.set(c[3],c[5]);result=1;}return Response.json({result});});await writeFinance('offland',2026,null,first.state,input.request_id);assert.equal((await readFinance('offland',2026)).state.entries.length,1);assert.equal((await readFinance('sweetfun',2026)).state.entries.length,0);
});
