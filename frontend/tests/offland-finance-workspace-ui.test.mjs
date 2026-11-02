import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {JSDOM} from 'jsdom';
import {act} from 'react';
import {mount} from './helpers/customer-dom.mjs';
// Initialize the actual Radix portal in its browser mode, as the production app does.
const bootstrap=new JSDOM('<body></body>');
globalThis.window=bootstrap.window;
globalThis.document=bootstrap.window.document;
const {FinanceWorkspace}=await import('../src/components/finance/finance-workspace.tsx');
const {FinanceSummary}=await import('../src/components/finance/finance-summary.tsx');
const {SummaryReceipt}=await import('../src/components/finance/summary-receipt.tsx');
after(()=>bootstrap.window.close());

const bookingId='10000000-0000-4000-8000-000000000007';
const order={id:`IG-${bookingId}`,calendar_id:`IG-${bookingId}`,booking_id:bookingId,
  source:'iron_gate',status:'confirmed',ssot_booking_version:3,
  ssot_command_eligible:true,ssot_payment_coverage:'verified_current',
  platform:'direct',rooms:['Eligible villa'],check_in:'2026-10-28',
  check_out:'2026-10-30',total:10000,received:2000,receivable:8000,
  eligible_date:null,source_paid:false,credit:0,source_version:'synthetic'};
const report={ssot_enabled:true,property_id:'offland',year:2026,version:0,
  properties:[{id:'offland',name:'遺忘無際 Offland'}],entries:[],orders:[order],
  updated_at:'2026-10-28T01:00:00Z',versions:{'2026':0},projection_version:'synthetic',
  recurring:[],due:[],payout_rules:[],excluded_orders:0,payment_accounts:[]};

function financeFetch(t,data,extra){
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    const path=String(url);calls.push(path);
    if(path.startsWith('/api/v1/finance/pending'))return Response.json({pending:null});
    if(path.startsWith('/api/v1/finance?'))return Response.json(data);
    if(extra)return extra(path,options);
    throw Error(`Unexpected request ${path}`);
  });
  return calls;
}

test('Offland current receipt opens shared finance form and selects only eligible current orders',async t=>{
  const data={...report,orders:[order,
    {...order,id:'IG-review',rooms:['Review villa'],ssot_command_eligible:false,
      receivable:0,receivable_review_required:true},
    {...order,id:'IG-cancelled',rooms:['Cancelled villa'],status:'cancelled',
      receivable:0,ssot_command_eligible:false},
    {...order,id:'IG-held',rooms:['Held villa'],status:'held',
      receivable:0,ssot_command_eligible:false}]};
  const previews=[];
  const calls=financeFetch(t,data,(path,options)=>{
    assert.equal(path,'/api/v1/finance/preview');
    assert.equal(options.method,'POST');
    const input=JSON.parse(options.body);previews.push(input);
    return Response.json({request_id:input.request_id,preview_proof:'synthetic',
      lines:['Synthetic receipt preview']});
  });
  const ui=await mount(t,FinanceWorkspace,{view:'bookkeeping'},
    'finance/bookkeeping?month=2026-10&property=offland');
  await ui.click(ui.button('登記入帳'));
  const dialog=document.querySelector('[role="dialog"]');
  assert.ok(dialog);assert.match(dialog.textContent,/新增收入/);
  assert.match(dialog.textContent,/Eligible villa/);
  assert.doesNotMatch(dialog.textContent,/Review villa|Cancelled villa|Held villa/);
  assert.equal(dialog.querySelector('input[type="checkbox"]').checked,true);
  assert.ok(ui.button('儲存收入'));
  assert.equal(ui.button('查看收退款'),undefined);
  t.mock.method(window,'confirm',()=>false);
  await act(()=>dialog.querySelector('form').dispatchEvent(
    new window.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(previews.length,1);
  assert.equal(previews[0].property_id,'offland');
  assert.deepEqual(previews[0].allocations,[{order_id:order.id,amount_cents:8000}]);
  assert.ok(calls.every(path=>path.startsWith('/api/v1/finance')));
});

test('Offland read-only source entries have truthful labels and cannot open Sweetfun payment panel',async t=>{
  const common={property_id:'offland',category:'other',amount_cents:2500,
    date:'2026-10-28',method:'cash',source:'iron_gate',actor:'Synthetic operator',
    created_at:'2026-10-28T01:00:00Z',status:'active'};
  financeFetch(t,{...report,entries:[
    {...common,id:'line-expense',kind:'expense',description:'Synthetic LINE expense',
      method:null,ssot_source_system:'line_finance'},
    {...common,id:'native-receipt',kind:'income',description:'Synthetic native receipt',
      ssot_source_system:'iron_gate_native',iron_gate_booking_id:bookingId},
    {...common,id:'os-income',kind:'income',description:'Synthetic other income',
      ssot_source_system:'os_manual'}]});
  const ui=await mount(t,FinanceWorkspace,{view:'overview'},
    'finance?month=2026-10&property=offland');
  assert.match(document.body.textContent,/LINE 收支登記/);
  assert.match(document.body.textContent,/訂單收退款/);
  assert.match(document.body.textContent,/手動記帳/);
  assert.doesNotMatch(document.body.textContent,/Booking 刷卡|直訂收退款/);
  const historical=[...document.querySelectorAll('button')].find(button=>
    button.textContent.includes('Synthetic LINE expense'));
  await ui.click(historical);
  assert.match(document.querySelector('[role="dialog"]').textContent,/付款方式未記錄/);
  assert.doesNotMatch(document.querySelector('[role="dialog"]').textContent,/其他花費 · 其他(?: |<|$)/);
  await ui.click(ui.button('Close'));
  const entry=[...document.querySelectorAll('button')].find(button=>
    button.textContent.includes('Synthetic native receipt'));
  await ui.click(entry);
  assert.match(document.querySelector('[role="dialog"]').textContent,/來源：訂單收退款/);
  assert.equal(ui.button('查看原收退款'),undefined);
});

test('imported OS expense is read only while a live OS expense can still be changed',async t=>{
  const live='10000000-0000-4000-8000-000000000005';
  const history='10000000-0000-4000-8000-000000000006';
  const common={property_id:'offland',kind:'expense',category:'electricity',
    amount_cents:2500,date:'2026-10-28',description:'',method:'bank_transfer',
    source:'iron_gate',ssot_source_system:'os_manual',actor:'Synthetic operator',
    created_at:'2026-10-28T01:00:00Z',status:'active'};
  financeFetch(t,{...report,ssot_live_source_instance_id:live,entries:[
    {...common,id:'historical-os',description:'Synthetic historical OS expense',
      ssot_source_instance_id:history,
      ssot_source_recorded_at:'2026-10-15T08:30:00.000Z'},
    {...common,id:'current-os',description:'Synthetic current OS expense',
      ssot_source_instance_id:live}]});
  const ui=await mount(t,FinanceWorkspace,{view:'overview'},
    'finance?month=2026-10&property=offland');
  const row=label=>[...document.querySelectorAll('button')].find(button=>
    button.textContent.includes(label));
  await ui.click(row('Synthetic historical OS expense'));
  assert.equal(ui.button('編輯費用'),undefined);
  assert.equal(ui.button('作廢這筆紀錄'),undefined);
  assert.match(document.querySelector('[role="dialog"]').textContent,/此筆僅供查閱/);
  assert.match(document.querySelector('[role="dialog"]').textContent,/原帳登記者姓名未在此頁顯示/);
  assert.match(document.querySelector('[role="dialog"]').textContent,/原帳紀錄時間：/);
  assert.match(document.querySelector('[role="dialog"]').textContent,/搬入帳本時間：/);
  await ui.click(ui.button('Close'));
  await ui.click(row('Synthetic current OS expense'));
  assert.ok(ui.button('編輯費用'));
  assert.ok(ui.button('作廢這筆紀錄'));
});

test('Sweetfun existing native SSOT receipts keep their dedicated payment panel',async t=>{
  const calls=financeFetch(t,{...report,property_id:'sweetfun',
    properties:[{id:'sweetfun',name:'水芳 Sweetfun'}],
    orders:[{...order,ssot_command_eligible:undefined}]},()=>Response.json({
      bookingId,version:3,status:'confirmed',totalCents:10000,
      receivedCents:2000,refundedCents:0,netReceivedCents:2000,events:[]}));
  const ui=await mount(t,FinanceWorkspace,{view:'overview'},
    'finance?month=2026-10&property=sweetfun');
  await ui.click(ui.button('登記入帳'));
  assert.match(document.querySelector('[role="dialog"]').textContent,/直訂收退款/);
  assert.ok(ui.button('登記收付'));
  assert.equal(ui.button('儲存收入'),undefined);
  assert.ok(calls.some(path=>!path.startsWith('/api/v1/finance')));
});


test('New Offland ledger explicitly separates preserved history from empty new cash',async t=>{
 financeFetch(t,{...report,history_status:'not_imported',general_only:true,orders:[order]});
 const ui=await mount(t,FinanceWorkspace,{view:'bookkeeping'},'finance/bookkeeping?month=2026-10&property=offland');
 assert.match(document.body.textContent,/目前只顯示新帳本的收支/);
 const link=[...document.querySelectorAll('a')].find(a=>a.textContent==='查看 OS 舊帳（唯讀）');
 assert.equal(link?.getAttribute('href'),'/finance/history?property=offland');
 assert.equal(ui.button('登記入帳'),undefined);
 assert.ok(ui.button('新增支出'));await ui.click(ui.button('收入'));await ui.click(ui.button('新增收入'));
 const dialog=document.querySelector('[role=dialog]');assert.ok(dialog);
 assert.equal(dialog.querySelector('option[value=lodging]'),null);assert.ok(dialog.querySelector('option[value=other]'));
 assert.match(dialog.textContent,/請勿改用其他分類登記房費/);
});

test('Offland general-history import keeps the old booking cash warning visible',async t=>{
 financeFetch(t,{...report,history_status:'general_imported_booking_review',
   general_only:true,orders:[{...order,ssot_command_eligible:false,
     receivable_review_required:true}]});
 const ui=await mount(t,FinanceWorkspace,{view:'bookkeeping'},
   'finance/bookkeeping?month=2026-10&property=offland');
 assert.match(document.body.textContent,/OS 與 LINE 的舊一般收支已核對搬入本帳本/);
 assert.match(document.body.textContent,/舊訂單收款仍待逐筆核對/);
 assert.doesNotMatch(document.body.textContent,/以前的帳已保留，尚未搬入本頁/);
 assert.equal(ui.button('登記入帳'),undefined);
 const link=[...document.querySelectorAll('a')].find(a=>
   a.textContent==='查看 OS 原始舊帳（唯讀）');
 assert.equal(link?.getAttribute('href'),'/finance/history?property=offland');
});

test('partial OS history import does not claim LINE is complete',async t=>{
 financeFetch(t,{...report,history_status:'os_imported_line_pending',
   general_only:true});
 await mount(t,FinanceWorkspace,{view:'overview'},
   'finance?month=2026-10&property=offland');
 assert.match(document.body.textContent,/OS 舊一般支出已核對搬入本帳本/);
 assert.match(document.body.textContent,/LINE 舊帳仍在搬移與核對/);
 assert.doesNotMatch(document.body.textContent,/OS 與 LINE 的舊一般收支已核對搬入本帳本/);
});

test('Offland order summary preserves unknown old cash after general-history import',async t=>{
 t.mock.method(globalThis,'fetch',async url=>{
   assert.match(String(url),/^\/api\/v1\/finance-summary\?/);
   return Response.json({property_id:'offland',properties:report.properties,
     updated_at:report.updated_at,orders:[],
     history_status:'general_imported_booking_review'});
 });
 await mount(t,FinanceSummary,{},'finance/summary?property=offland');
 assert.match(document.body.textContent,/OS 與 LINE 的舊一般收支已搬入帳本/);
 assert.match(document.body.textContent,/不能據此判定客人還欠多少/);
 assert.doesNotMatch(document.body.textContent,/以前的收款尚未搬入核對/);
});

test('retained funds stay visible with unknown amount and never enter receivables or receipt selection',async t=>{
  const retained={...order,status:'retained',rooms:['Retained villa'],
    retained_credit_cents:null,retained_credit_review_required:true,
    // Simulate a stale pre-retention amount/eligibility in an already open view.
    receivable:8000,ssot_command_eligible:true,receivable_review_required:true};
  financeFetch(t,{...report,orders:[retained]});
  const ui=await mount(t,FinanceWorkspace,{view:'bookkeeping'},
    'finance/bookkeeping?month=2026-10&property=offland');
  const section=document.querySelector('section[aria-label="保留訂單款項"]');
  assert.ok(section);
  assert.match(section.textContent,/保留可用款 · 金額待核/);
  assert.match(section.textContent,/可以先重新安排入住，差額另行核對/);
  assert.equal(ui.button('登記收到房費').disabled,true);
  await ui.click([...document.querySelectorAll('input[type=checkbox]')][0]);
  assert.doesNotMatch(document.body.textContent,/筆訂單應收待核對/);
  await ui.click(ui.button('收入'));
  await ui.click(ui.button('新增收入'));
  const dialog=document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.doesNotMatch(dialog.textContent,/Retained villa/);
});

test('retained funds remain readable under the general-income-only rollout',async t=>{
  financeFetch(t,{...report,general_only:true,history_status:'not_imported',orders:[{
    ...order,status:'retained',check_in:'',check_out:'',rooms:[],receivable:0,
    retained_credit_cents:null,retained_credit_review_required:true,
  }]});
  const ui=await mount(t,FinanceWorkspace,{view:'overview'},'finance?month=2026-10&property=offland');
  assert.match(document.querySelector('section[aria-label="保留訂單款項"]').textContent,/金額待核/);
  const link=[...document.querySelectorAll('a')].find(a=>a.textContent==='查看保留款明細');
  assert.equal(link?.getAttribute('href'),'/finance/summary?property=offland&status=retained');
  assert.equal(ui.button('登記收到房費'),undefined);
});

test('retained summary shows original cash records and no due or collection action',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{
    assert.match(String(url),/^\/api\/v1\/finance-summary\?/);
    return Response.json({property_id:'offland',properties:report.properties,
      updated_at:report.updated_at,orders:[{id:order.id,status:'retained',platform:'direct',
        rooms:[],check_in:'',check_out:'',ota_ids:[],owl_ids:[],row_ids:[order.id],aliases:[],
        source_amount_cents:1000000,recorded_received_cents:250000,ota_collected_cents:0,
        receivable_total_cents:null,outstanding_cents:null,retained_credit_cents:null,
        retained_credit_review_required:true,can_record:false,
        issues:['retained_stay_unassigned','retained_credit_review_required'],
        records:[{id:'original-receipt',amount_cents:300000,method:'bank_transfer',
          at:'2026-09-15',actor:'Synthetic operator',source:'iron_gate'},
        {id:'original-refund',amount_cents:-50000,method:'bank_transfer',
          at:'2026-10-01',actor:'Synthetic operator',source:'iron_gate'}]}]});
  });
  const ui=await mount(t,FinanceSummary,{},'finance/summary?property=offland&status=retained');
  const article=document.querySelector('article');
  assert.ok(article);
  assert.match(article.textContent,/保留待安排 · 入住日期未定/);
  assert.match(article.textContent,/金額待核/);
  assert.match(article.textContent,/歷史金額，不是保留款或目前應收/);
  assert.deepEqual([...article.querySelectorAll('dt')].map(el=>el.textContent),[
    '保留可用款','本帳本淨收款','差額']);
  assert.equal(ui.button('登記收款'),undefined);
  assert.equal(article.querySelectorAll('li').length,2);
  assert.match(article.querySelectorAll('li')[0].textContent,/2026\/09\/15.*3,000/);
  assert.match(article.querySelectorAll('li')[1].textContent,/2026\/10\/01.*500/);
  assert.equal(document.querySelector('input[type=month]').disabled,true);
  await ui.fill(document.querySelector('select[aria-label="訂單範圍"]'),'month');
  assert.equal(document.querySelector('article'),null);
  assert.equal(document.querySelector('input[type=month]').disabled,false);
});

test('receipt dialog rechecks retained status even if stale numbers imply unpaid room fees',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({...report,orders:[{
    ...order,status:'retained',receivable:8000,ssot_command_eligible:true,
  }]}));
  const ui=await mount(t,SummaryReceipt,{property:'offland',orderId:order.id,
    onClose(){},onSaved(){}},'finance/summary?property=offland');
  const dialog=document.querySelector('[role=dialog]');
  assert.match(dialog.textContent,/保留待安排，原款項繼續保留/);
  assert.equal(dialog.querySelector('form'),null);
  assert.equal(ui.button('確認收款'),undefined);
});
