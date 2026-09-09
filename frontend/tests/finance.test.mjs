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
 for(const expense_spread of [[],[{month:'2026-07',amount_cents:1},{month:'2026-08',amount_cents:2}],[{month:'2026-07',amount_cents:6000},{month:'2026-07',amount_cents:6345}],[{month:'2026-13',amount_cents:6000},{month:'2026-14',amount_cents:6345}],[{month:'2026-07',amount_cents:-1},{month:'2026-08',amount_cents:12346}]])assert.throws(()=>apply({...base,expense_spread}),/INVALID_INPUT/);
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
test('payment account settings only retain suffixes, enforce property and method',()=>{
 const input={action:'payment_account_create',method:'credit_card',last_digits:'0123',name:'Company',expected_version:0,request_id:base.request_id};
 const first=apply(input);const a=first.state.payment_accounts[0];assert.equal(a.last_digits,'0123');assert.equal(first.state.entries.length,0);assert.equal(apply(input,first.state).entry_id,a.id);
 const spend={...base,payment_account_id:a.id,method:'credit_card',expected_version:1,request_id:'00000000-0000-4000-8000-000000000002'};
 const result=apply(spend,first.state);assert.equal(result.state.entries[0].payment_account.last_digits,'0123');assert.equal(result.state.payment_accounts.length,1);
 for(const patch of [{last_digits:'1234567812345678'},{last_digits:'123'},{last_digits:'abcd'},{method:'cash'},{name:'a'.repeat(51)}])assert.throws(()=>apply({...input,...patch}),/INVALID_INPUT/);
 assert.throws(()=>apply({...spend,method:'bank_transfer'},first.state),/INVALID_INPUT/);
 assert.throws(()=>applyFinance(empty(),{...base,payment_account_id:a.id,method:'credit_card'},actor,'sweetfun',2026,now,[],[{...a,property_id:'offland'}]),/INVALID_INPUT/);
 assert.equal(apply({...input,method:'bank_transfer',last_digits:'00123'}).state.payment_accounts[0].last_digits,'00123');
 assert.throws(()=>apply({...input,last_digits:'9999'},first.state),/IDEMPOTENCY_CONFLICT/);
});
test('expense can reference previously configured account from another ledger year',()=>{
 const a={id:'saved',property_id:'sweetfun',method:'bank_transfer',last_digits:'00123',name:'Bank',created_at:now,actor_id:actor.id};
 const r=applyFinance(empty(),{...base,payment_account_id:a.id},actor,'sweetfun',2026,now,[],[a]);assert.equal(r.state.entries[0].payment_account.id,'saved');
});
test('editing expense updates same ID, retains audit and recorder, supports changing year',()=>{
 const first=apply({...base,advanced_by:{type:'self'}});const id=first.entry_id;
 const update={...base,action:'update_expense',entry_id:id,amount:200,date:'2025-12-31',expected_version:1,request_id:'00000000-0000-4000-8000-000000000002'};
 const editor={...actor,id:'second-admin',displayName:'Second'};
 const second=apply(update,first.state,editor);assert.equal(second.state.entries.length,1);const e=second.state.entries[0];assert.equal(e.id,id);assert.equal(e.amount_cents,20000);assert.equal(e.actor,actor.displayName);assert.equal(e.advanced_by.account_id,actor.id);assert.equal(e.history[0].before.amount_cents,12345);assert.equal(e.history[0].actor_id,editor.id);assert.equal(summarize([e],'2025-12').expense,20000);assert.equal(summarize([e],'2026-09').expense,0);assert.equal(apply(update,second.state,editor).entry_id,id);
 assert.throws(()=>apply({...update,advanced_by:null},second.state,editor),/IDEMPOTENCY_CONFLICT/);
 assert.throws(()=>apply({...update,request_id:'00000000-0000-4000-8000-000000000003'},second.state,editor),/VERSION_CONFLICT/);
 const third=apply({...update,amount:220,expected_version:2,advanced_by:null,request_id:'00000000-0000-4000-8000-000000000003'},second.state,editor);assert.equal(third.state.entries[0].advanced_by,undefined);assert.equal(third.state.entries[0].history.length,2);assert.equal(third.state.entries[0].history[1].before.history,undefined);
});
test('expense edits cannot mutate income, void rows, property, recurring identity or split totals',()=>{
 const first=apply();const update={...base,action:'update_expense',entry_id:first.entry_id,expected_version:1,request_id:'00000000-0000-4000-8000-000000000002'};
 for(const patch of [{kind:'income',category:'other'},{recurrence_id:'fake'},{allocations:[]},{date:'2026-09-10'}])assert.throws(()=>apply({...update,...patch},first.state));
 for(const patch of [{kind:'income'},{source:'calendar'},{status:'void'},{property_id:'offland'}])assert.throws(()=>apply(update,{...first.state,entries:[{...first.state.entries[0],...patch}]}),/INVALID_INPUT/);
 const recurring={...first.state,entries:[{...first.state.entries[0],recurrence_id:'r',occurrence:'2026-09-01'}]};assert.throws(()=>apply({...update,date:'2026-08-31'},recurring),/INVALID_INPUT/);assert.equal(apply(update,recurring).state.entries[0].recurrence_id,'r');
});

test('single expense month separates cash and expense and supports moving between months',async()=>{
 const {entryInMonth,expenseAmountInMonth}=await import('../src/lib/finance-model.ts');
 const first=apply({...base,amount:7694});
 const updated=apply({...base,amount:7694,action:'update_expense',entry_id:first.entry_id,expense_spread:[{month:'2026-08',amount_cents:769400}],expected_version:1,request_id:'00000000-0000-4000-8000-000000000002'},first.state);const e=updated.state.entries[0];
 assert.equal(e.date,'2026-09-08');assert.equal(e.created_at,now);assert.equal(entryInMonth(e,'2026-08'),true);assert.equal(entryInMonth(e,'2026-09'),false);assert.equal(expenseAmountInMonth(e,'2026-08'),769400);assert.equal(summarize([e],'2026-08').allocatedExpense,769400);assert.equal(summarize([e],'2026-09').expense,769400);assert.equal(summarize([e],'2026-09').allocatedExpense,0);
 const split={...e,expense_spread:[{month:'2026-08',amount_cents:384700},{month:'2026-09',amount_cents:384700}]};assert.equal(expenseAmountInMonth(split,'2026-09'),384700);
});
test('audit captures authoritative actor, immutable before/after and idempotent actions',()=>{
 const a={...actor,email:'admin@example.test'};
 const first=apply({...base,actor_id:'forged'},empty(),a);
 const event=first.state.operations[0].event;
 assert.equal(event.action,'expense_created');assert.equal(event.actor_id,a.id);assert.equal(event.actor_email,a.email);assert.equal(event.actor_role,'admin');assert.equal(event.at,now);assert.equal(event.before,null);assert.equal(event.after.amount_cents,12345);assert.equal(event.version_after,1);
 const edit={...base,action:'update_expense',entry_id:first.entry_id,amount:200,request_id:'00000000-0000-4000-8000-000000000002',expected_version:1};
 const second=apply(edit,first.state,a),change=second.state.operations[1].event;
 assert.equal(change.action,'expense_updated');assert.equal(change.before.amount_cents,12345);assert.equal(change.after.amount_cents,20000);assert.ok(change.changed_fields.includes('amount_cents'));assert.equal(change.after.history,undefined);assert.equal(event.after.amount_cents,12345);
 assert.equal(apply(edit,second.state,a).state.operations.length,2);
 const third=apply({action:'void',entry_id:first.entry_id,reason:'duplicate',expected_version:2,request_id:'00000000-0000-4000-8000-000000000003'},second.state,a).state.operations[2].event;
 assert.equal(third.action,'expense_voided');assert.equal(third.before.status,'active');assert.equal(third.after.status,'void');assert.equal(third.after.void_reason,'duplicate');
 const income=apply({...base,kind:'income',category:'other'});assert.equal(income.state.operations[0].event.action,'income_created');
});
test('audit includes payment account and recurring/payout setting changes',()=>{
 const account=apply({...base,action:'payment_account_create',name:'Card',method:'credit_card',last_digits:'1234'}).state.operations[0].event;
 assert.equal(account.action,'payment_account_created');assert.equal(account.after.last_digits,'1234');assert.equal(account.before,null);
 const recurring=apply({...base,action:'recurring_create',start:'2026-09-01',end:null,day:10});
 assert.equal(recurring.state.operations[0].event.action,'recurring_created');
 const stopped=apply({action:'recurring_stop',rule_id:recurring.entry_id,expected_version:1,request_id:'00000000-0000-4000-8000-000000000002'},recurring.state).state.operations[1].event;
 assert.equal(stopped.action,'recurring_stopped');assert.equal(stopped.before.stopped_at,undefined);assert.equal(stopped.after.stopped_at,'2026-09-08');
 const rule=apply({...base,action:'payout_rule',platform:'ctrip',mode:'monthly',day:10,offset:1});
 const updated=apply({...base,action:'payout_rule',platform:'ctrip',mode:'monthly',day:20,offset:1,expected_version:1,request_id:'00000000-0000-4000-8000-000000000002'},rule.state).state.operations[1].event;
 assert.equal(updated.action,'payout_rule_updated');assert.equal(updated.before.day,10);assert.equal(updated.after.day,20);assert.equal(updated.target_id,'ctrip');
});
test('payout audit preserves effective prior-year rule',()=>{
 const result=applyFinance(empty(),{...base,action:'payout_rule',platform:'ctrip',mode:'monthly',day:20,offset:1},actor,'sweetfun',2026,now,[],[],[{platform:'ctrip',mode:'monthly',day:5,offset:1,updated_at:'2025-12-01'}]);
 assert.equal(result.state.operations[0].event.before.day,5);
});
test('write verification rejects missing audit even if operation ID exists',async t=>{
 process.env.KV_REST_API_URL='https://test.invalid';process.env.KV_REST_API_TOKEN='test';const state=apply().state;
 const missing=JSON.parse(JSON.stringify(state));delete missing.operations[0].event;
 t.mock.method(globalThis,'fetch',async(_,options)=>{const c=JSON.parse(options.body);return Response.json({result:c[0]==='EVAL'?1:JSON.stringify(missing)});});
 await assert.rejects(()=>writeFinance('sweetfun',2026,null,state,base.request_id),/WRITE_UNCONFIRMED/);
});
