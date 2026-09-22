import test from 'node:test';
import assert from 'node:assert/strict';
import {attachOfflandReference,validateOfflandReference} from '../src/lib/offland-reference.ts';
const snapshot=()=>({schema:1,property_id:'offland',version:'a'.repeat(20),asof:'2026-09-22',model:'offland-pooled-retained-v1',publication_enabled:false,cells:[{date:'2026-10-05',probability:.3,direct:{current:10000,suggested:8800},direct_four:{current:8600,suggested:7260}}]});
const result=()=>({property_id:'offland',asof:'2026-09-22',query:{channel:'direct'},source_notice:'',cells:[{date:'2026-10-05',state:'available',pricing:{policy:'observed_snapshot',current_price:10000,suggested_price:null}}]});
test('reference leaves authoritative current and suggested prices untouched',()=>{
 const original=result(),out=attachOfflandReference(original,validateOfflandReference(snapshot()));
 assert.equal(out.cells[0].offland_reference.suggested_price,8800);
 assert.deepEqual(out.cells[0].pricing,original.cells[0].pricing);
 assert.equal(original.cells[0].offland_reference,undefined);
});
test('Sweetfun does not receive Offland data',()=>{const r=result();r.property_id='sweetfun';assert.equal(attachOfflandReference(r,snapshot()),r);});
test('sold, missing, future and stale references are withheld',()=>{
 for(const state of ['sold','blocked','unknown','conflict']){const r=result();r.cells[0].state=state;assert.equal(attachOfflandReference(r,snapshot()).cells[0].offland_reference,null);}
 for(const asof of ['2026-09-21','2026-09-26']){const r=result();r.asof=asof;assert.equal(attachOfflandReference(r,snapshot()).cells[0].offland_reference,null);}
 assert.equal(attachOfflandReference(result(),null).cells[0].offland_reference,null);
});
test('current-price mismatch and OTA channels never inherit direct suggestion',()=>{
 const r=result();r.cells[0].pricing.current_price=9999;
 assert.equal(attachOfflandReference(r,snapshot()).cells[0].offland_reference.suggested_price,null);
 r.query.channel='booking';assert.equal(attachOfflandReference(r,snapshot()).cells[0].offland_reference.suggested_price,null);
 r.query.channel='direct_four';r.cells[0].pricing.current_price=8600;
 assert.equal(attachOfflandReference(r,snapshot()).cells[0].offland_reference.suggested_price,7260);
});
test('invalid identity, auto publishing, dates, floors and duplicate cells rejected',()=>{
 for(const mutate of [s=>s.property_id='sweetfun',s=>s.publication_enabled=true,s=>s.cells[0].probability=2,s=>s.cells[0].date='2027-06-01',s=>s.cells[0].direct.suggested=2000,s=>s.cells.push(s.cells[0])]){const s=snapshot();mutate(s);assert.throws(()=>validateOfflandReference(s));}
});
