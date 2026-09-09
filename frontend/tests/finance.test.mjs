import test from 'node:test';
import assert from 'node:assert/strict';
import {applyFinance,canUseFinance,calendarIncome,readFinance,writeFinance} from '../src/lib/finance-store.ts';
import {summarize} from '../src/lib/finance-model.ts';
const actor={id:'test-admin',displayName:'測試管理員',role:'admin',viewPrices:true,allProperties:false,propertyIds:['sweetfun']};
const empty=()=>({version:0,entries:[],operations:[]});
const base={action:'create',kind:'expense',category:'laundry',amount:123.45,date:'2026-09-08',description:'測試送洗',method:'bank_transfer',stage:'',expected_version:0,request_id:'00000000-0000-4000-8000-000000000001'};
const now='2026-09-08T06:00:00.000Z';
const apply=(input=base,state=empty(),a=actor)=>applyFinance(state,input,a,'sweetfun',2026,now);
test('finance denies housekeepers, viewers, hidden prices and wrong property',()=>{for(const a of [{...actor,role:'housekeeper'},{...actor,role:'viewer'},{...actor,viewPrices:false},{...actor,propertyIds:['offland']}])assert.throws(()=>apply(base,empty(),a),/FORBIDDEN/);assert.equal(canUseFinance(null),false);});
test('valid expense stores integer cents and server actor; rejects invalid money/categories/dates',()=>{const r=apply();assert.equal(r.state.entries[0].amount_cents,12345);assert.equal(r.state.entries[0].actor,actor.displayName);assert.equal(apply({...base,description:''}).state.entries[0].description,'');for(const patch of [{amount:0},{amount:-1},{amount:0.001},{amount:Infinity},{category:'lodging'},{date:'2026-02-30'},{date:'2027-01-01'},{method:'ota'}])assert.throws(()=>apply({...base,...patch}),/INVALID_INPUT/);assert.throws(()=>apply({...base,date:'2026-09-09'}),/FUTURE_DATE/);});
test('request replay returns same entry, not second charge; changed payload denied',()=>{const first=apply();const replay=apply(base,first.state);assert.equal(replay.entry_id,first.entry_id);assert.equal(replay.state.entries.length,1);assert.throws(()=>apply({...base,amount:1},first.state),/IDEMPOTENCY_CONFLICT/);assert.throws(()=>apply({...base,request_id:'00000000-0000-4000-8000-000000000002'},first.state),/VERSION_CONFLICT/);});
test('void preserves original amount/date/actor, records reason and removes from totals',()=>{const first=apply();const result=apply({action:'void',entry_id:first.entry_id,reason:'重複輸入',request_id:'00000000-0000-4000-8000-000000000002',expected_version:1},first.state);assert.equal(result.state.entries[0].amount_cents,12345);assert.equal(result.state.entries[0].void_reason,'重複輸入');assert.equal(summarize(result.state.entries,'2026-09').expense,0);assert.equal(result.state.operations.length,2);});
test('month totals and annual expense trend do not mix income or void records',()=>{const expense=apply().state.entries[0];const entries=[expense,{...expense,id:'aug',date:'2026-08-01',amount_cents:50000},{...expense,id:'income',kind:'income',category:'lodging',amount_cents:100000,method:'ota'},{...expense,id:'void',status:'void'}];const r=summarize(entries,'2026-09');assert.equal(r.expense,12345);assert.equal(r.income,100000);assert.equal(r.ota,100000);assert.equal(r.net,87655);assert.equal(r.monthly[7].expense,50000);assert.equal(r.categories[0].amount,12345);});
test('income stages stay separate from categories',()=>{const result=apply({...base,kind:'income',category:'lodging',stage:'deposit'});assert.equal(result.state.entries[0].category,'lodging');assert.equal(result.state.entries[0].stage,'deposit');});
test('CAS detects concurrent writes and verifies persisted operation',async()=>{const original=global.fetch;process.env.KV_REST_API_URL='https://test.invalid';process.env.KV_REST_API_TOKEN='test';const db=new Map();global.fetch=async(_,options)=>{const c=JSON.parse(options.body);let result=null;if(c[0]==='GET')result=db.get(c[1])??null;else if(c[0]==='EVAL'){if((db.get(c[3])??'')===c[4]){db.set(c[3],c[5]);result=1;}else result=0;}return Response.json({result});};try{const created=apply();await writeFinance('sweetfun',2026,null,created.state,base.request_id);assert.equal((await readFinance('sweetfun',2026)).state.entries.length,1);await assert.rejects(()=>writeFinance('sweetfun',2026,null,created.state,base.request_id),/VERSION_CONFLICT/);}finally{global.fetch=original;}});
test('calendar receipts read once, Taipei date crosses month, excludes mission keys',async()=>{const original=global.fetch;const key='sweetfun-os:payments:v1:sweetfun:'+'a'.repeat(64);const receipt={id:'r',amount:1000,payment_type:'deposit',payment_method:'ota',received_at:'2026-08-31T17:00:00Z',created_at:now,actor_name:'測試',note:''};global.fetch=async(_,options)=>{const c=JSON.parse(options.body);if(c[0]==='SCAN'){assert.equal(c[3],'sweetfun-os:payments:v1:sweetfun:*');return Response.json({result:['0',[key,key,key+':mission:id']]});}assert.equal(c[0],'MGET');assert.equal(c.length,2);return Response.json({result:[JSON.stringify({version:1,receipts:[receipt,receipt]})]});};try{const entries=await calendarIncome('sweetfun',2026);assert.equal(entries.length,1);assert.equal(entries[0].date,'2026-09-01');assert.equal(entries[0].category,'lodging');assert.equal(entries[0].source,'calendar');assert.equal(entries[0].amount_cents,100000);}finally{global.fetch=original;}});
test('optional advance payer is separate from recorder and included in idempotency',()=>{
 assert.equal(apply().state.entries[0].advanced_by,undefined);
 const input={...base,advanced_by:{type:'self',name:'forged'}};
 const first=apply(input);assert.deepEqual(first.state.entries[0].advanced_by,{type:'self',name:actor.displayName,account_id:actor.id});
 assert.equal(apply(input,first.state).entry_id,first.entry_id);
 assert.throws(()=>apply({...input,advanced_by:{type:'other',name:'Someone'}},first.state),/IDEMPOTENCY_CONFLICT/);
 assert.equal(apply({...base,advanced_by:{type:'other',name:'  Supplier  '}}).state.entries[0].advanced_by.name,'Supplier');
 for(const advanced_by of [{type:'other',name:' '},{type:'other',name:'x'.repeat(101)},{type:'account',account_id:'unknown'},'bad'])assert.throws(()=>apply({...base,advanced_by}),/INVALID_INPUT/);
 assert.throws(()=>apply({...base,kind:'income',category:'other',advanced_by:{type:'self'}}),/INVALID_INPUT/);
});
test('account payer must be active and in property scope; name is server-resolved',()=>{
 const m={id:'member-1',displayName:'Team member',status:'active',allProperties:false,propertyIds:['sweetfun']};
 const input={...base,advanced_by:{type:'account',account_id:m.id,name:'forged'}};
 const run=member=>applyFinance(empty(),input,actor,'sweetfun',2026,now,[member]);
 assert.deepEqual(run(m).state.entries[0].advanced_by,{type:'account',account_id:m.id,name:m.displayName});
 for(const member of [{...m,status:'suspended'},{...m,propertyIds:['offland']}])assert.throws(()=>run(member),/INVALID_INPUT/);
});
test('expense spread preserves cash date and allocates charts across years',()=>{
 const expense_spread=[{month:'2025-12',amount_cents:6000},{month:'2026-01',amount_cents:6345}];
 const input={...base,expense_spread};const r=apply(input);const entries=r.state.entries;
 assert.equal(entries.length,1);assert.equal(summarize(entries,'2026-09').expense,12345);
 assert.equal(summarize(entries,'2026-09').allocatedExpense,0);
 assert.equal(summarize(entries,'2025-12').allocatedExpense,6000);
 assert.equal(summarize(entries,'2026-01').categories[0].amount,6345);
 assert.equal(summarize(entries,'2026-09').monthly[0].expense,6345);
 assert.equal(apply(input,r.state).entry_id,r.entry_id);
 assert.throws(()=>apply({...input,expense_spread:[{month:'2025-12',amount_cents:6001},{month:'2026-01',amount_cents:6344}]},r.state),/IDEMPOTENCY_CONFLICT/);
 assert.equal(summarize([{...entries[0],status:'void'}],'2025-12').allocatedExpense,0);
});
test('spread rejects bad totals, duplicate months, invalid months and income',()=>{
 for(const expense_spread of [[],[{month:'2026-07',amount_cents:12345}],[{month:'2026-07',amount_cents:1},{month:'2026-08',amount_cents:2}],[{month:'2026-07',amount_cents:6000},{month:'2026-07',amount_cents:6345}],[{month:'2026-13',amount_cents:6000},{month:'2026-14',amount_cents:6345}],[{month:'2026-07',amount_cents:-1},{month:'2026-08',amount_cents:12346}]])assert.throws(()=>apply({...base,expense_spread}),/INVALID_INPUT/);
 assert.throws(()=>apply({...base,kind:'income',category:'other',expense_spread:[{month:'2026-07',amount_cents:6000},{month:'2026-08',amount_cents:6345}]}),/INVALID_INPUT/);
});
test('separate utilities and custom expense categories persist with server IDs',()=>{
 for(const category of ['water','electricity','gas'])assert.equal(apply({...base,category}).state.entries[0].category,category);
 const input={...base,category:'custom',category_name:'  Garden care  '};const created=apply(input);const e=created.state.entries[0];assert.match(e.category,/^custom_[a-f0-9]{20}$/);assert.equal(e.category_name,'Garden care');assert.equal(summarize([e],'2026-09').categories[0].label,'Garden care');assert.equal(apply(input,created.state).entry_id,e.id);
 assert.equal(apply({...base,category:e.category,category_name:e.category_name}).state.entries[0].category,e.category);
 for(const patch of [{category_name:' '},{category_name:'a'.repeat(51)},{category:'custom_wrong'},{kind:'income',category:'custom'}])assert.throws(()=>apply({...input,...patch}),/INVALID_INPUT/);
 assert.throws(()=>apply({...input,category_name:'Different'},created.state),/IDEMPOTENCY_CONFLICT/);
});
test('custom categories survive recurring expense generation and separate property catalogs',async()=>{
 const {recurrenceDue,expenseCategories}=await import('../src/lib/finance-model.ts');
 const result=apply({action:'recurring_create',category:'custom',category_name:'Garden care',amount:100,description:'',method:'bank_transfer',start:'2026-09-01',day:1,expected_version:0,request_id:base.request_id});
 const rules=result.state.recurring;const due=recurrenceDue(rules,[],2026,'2026-09-09');assert.equal(due[0].category_name,'Garden care');assert.equal(expenseCategories(rules)[rules[0].category],'Garden care');assert.equal(expenseCategories([])[rules[0].category],undefined);
});
