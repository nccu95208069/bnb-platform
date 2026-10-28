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
      ssot_source_system:'line_finance'},
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
  const entry=[...document.querySelectorAll('button')].find(button=>
    button.textContent.includes('Synthetic native receipt'));
  await ui.click(entry);
  assert.match(document.querySelector('[role="dialog"]').textContent,/來源：訂單收退款/);
  assert.equal(ui.button('查看原收退款'),undefined);
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
