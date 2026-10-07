import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePricingDecisions} from '../src/lib/pricing-decision.ts';
import {readPricingSnapshot} from '../src/lib/pricing-snapshot.ts';
import {encode} from '../src/lib/calendar-changes/merge.ts';
import {attachOfflandReference} from '../src/lib/offland-reference.ts';
const at='2026-10-07T09:00:00.000Z';
const decision={run_id:'synthetic-run-001',source_version:'input-v1',base_price:null,target_price:10000,published_price:null,
 adjustment_pct:null,probability:null,reason:'holiday_or_eve',model_version:'model-v1',policy_version:'policy-v1',
 calculated_at:at,published_at:null,observed_at:at,publish_status:'skipped'};
test('undefined protected-day and fractional OTA bases are preserved without invented or rounded money',()=>{
 assert.doesNotThrow(()=>validatePricingDecisions({direct:decision},['direct'],at));
 for(const change of [d=>d.publish_status='proposed',d=>d.adjustment_pct=0,d=>d.published_price=10000]){
  const d=structuredClone(decision);change(d);assert.throws(()=>validatePricingDecisions({direct:d},['direct'],at));
 }
 const d={...decision,base_price:9000.25,adjustment_pct:(10000/9000.25-1)*100};
 assert.doesNotThrow(()=>validatePricingDecisions({direct:d},['direct'],at));
});
test('267-day complete decision snapshot exceeds old 4 MiB but all readers share a bounded limit',()=>{
 const channels=['direct','airbnb','booking','agoda','owljourney'];
 const d={...decision,reason:'r'.repeat(500)};
 const cells=[];
 for(let i=0;i<267;i++)for(const room of ['101','102','201','202','301','302'])cells.push({date:new Date(Date.UTC(2026,9,7+i)).toISOString().slice(0,10),room,
  channels:Object.fromEntries(channels.map(c=>[c,10000])),pricing_decisions:Object.fromEntries(channels.map(c=>[c,d])),
  rack_price:null,daytype:'protected',baseline_version:'base-v1',stock:{count:1,is_lock:false}});
 const snapshot={schema:1,property_id:'sweetfun',observed_at:at,source_commit:'b'.repeat(40),version:'a'.repeat(20),cells};
 assert.ok(Buffer.byteLength(JSON.stringify(snapshot))>4*1024*1024);
 assert.equal(readPricingSnapshot(encode(snapshot)).cells.length,1602);
});
test('legacy OFFLAND reference cannot visually replace a received decision',()=>{
 const result={property_id:'offland',asof:'2026-10-07',query:{channel:'direct'},source_notice:'',cells:[{date:'2026-10-13',state:'available',pricing_decision:decision,pricing:{current_price:10000,policy:'observed_snapshot'}}]};
 const reference={asof:'2026-10-07',version:'a'.repeat(20),cells:[{date:'2026-10-13',probability:.2,direct:{current:10000,suggested:9000}}]};
 assert.equal(attachOfflandReference(result,reference).cells[0].offland_reference,null);
});
