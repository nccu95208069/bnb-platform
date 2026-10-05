import test from 'node:test';
import assert from 'node:assert/strict';
import {OsPaymentPanel} from '../src/components/payments/os-payment-panel.tsx';
import {mount} from './helpers/customer-dom.mjs';
const check={property_id:'sweetfun',order_id:'SF-test',source_version:'v1',booking_version:'booking-v1',total:4000,rooms:['101','102'],nights:2,source_paid:false,finance_received:0,ledger:{version:0,receipts:[]},can_record:true,sheet_write_enabled:true,payment_status:'unknown',payment_accounts:[{id:'bank',property_id:'sweetfun',method:'bank_transfer',last_digits:'12345',name:'測試銀行'}]};
const props={property:'sweetfun',order:'SF-test',canRecord:true,onChange:()=>{}};
test('one entry button, manual receipt uses selected finance account and only reports verified main Sheet success',async t=>{
 const posts=[];t.mock.method(globalThis,'fetch',async(url,options={})=>{if(options.method==='POST'&&JSON.parse(options.body).action==='check_sheet_access')return Response.json({verified:true});if(options.method==='POST'){posts.push(JSON.parse(options.body));return Response.json({verified:true,sheet_verified:true});}return Response.json(check);});
 const ui=await mount(t,OsPaymentPanel,props);assert.ok(ui.button('登記收款'));assert.equal(ui.button('登記訂金'),undefined);await ui.click(ui.button('登記收款'));
 await ui.fill(ui.control('本次收到多少（元）'),'500');await ui.fill(ui.control('收款帳戶'),'bank');await ui.click(ui.button('確認並同步主表'));
 assert.equal(posts.length,1);assert.equal(posts[0].amount,500);assert.equal(posts[0].payment_account_id,'bank');assert.equal(posts[0].status_only,false);assert.match(document.body.textContent,/main sheet 已同步確認/);
});
test('direct paid mode sends zero amount and does not require bank/payment fields',async t=>{
 const posts=[];t.mock.method(globalThis,'fetch',async(url,options={})=>{if(options.method==='POST'&&JSON.parse(options.body).action==='check_sheet_access')return Response.json({verified:true});if(options.method==='POST'){posts.push(JSON.parse(options.body));return Response.json({verified:true,sheet_verified:true});}return Response.json(check);});
 const ui=await mount(t,OsPaymentPanel,props);await ui.click(ui.button('登記收款'));await ui.click(ui.control('直接標示已付清'));assert.equal(ui.control('本次收到多少（元）'),undefined);await ui.click(ui.button('確認並同步主表'));assert.equal(posts.length,1);assert.equal(posts[0].amount,0);assert.equal(posts[0].status_only,true);assert.equal(posts[0].payment_account_id,undefined);
});
test('failed save locks original payload and retries without a new request ID',async t=>{
 const posts=[];t.mock.method(globalThis,'fetch',async(url,options={})=>{if(options.method==='POST'&&JSON.parse(options.body).action==='check_sheet_access')return Response.json({verified:true});if(options.method==='POST'){posts.push(JSON.parse(options.body));return posts.length===1?Response.json({detail:'OS 已保存，主表尚未確認同步。'},{status:503}):Response.json({verified:true,sheet_verified:true});}return Response.json(check);});
 const ui=await mount(t,OsPaymentPanel,props);await ui.click(ui.button('登記收款'));await ui.click(ui.control('直接標示已付清'));await ui.click(ui.button('確認並同步主表'));assert.ok(document.querySelector('fieldset').disabled);assert.equal(ui.button('取消'),undefined);assert.doesNotMatch(document.body.textContent,/已同步確認/);await ui.click(ui.button('重試並確認原登記'));assert.deepEqual(posts[1],posts[0]);
});
test('reload shows durable pending receipt and retry action instead of a new payment form',async t=>{
 const posts=[];t.mock.method(globalThis,'fetch',async(url,options={})=>{if(options.method==='POST'&&JSON.parse(options.body).action==='check_sheet_access')return Response.json({verified:true});if(options.method==='POST'){posts.push(JSON.parse(options.body));return Response.json({verified:true,sheet_verified:true});}return Response.json({...check,ledger:{version:1,receipts:[{id:'r1',request_id:'request-1',amount:500,payment_type:'deposit',payment_method:'cash',received_at:'2026-10-05T09:00:00Z',actor_name:'測試',sheet_sync:{state:'pending'}}]}});});
 const ui=await mount(t,OsPaymentPanel,props);assert.equal(ui.button('登記收款'),undefined);await ui.click(ui.button('繼續同步主表'));assert.equal(posts[0].action,'retry_sync');assert.equal(posts[0].request_id,'request-1');
});
test('failed connection check blocks new receipt submission and can be retried without losing the form',async t=>{
 let checks=0;
 t.mock.method(globalThis,'fetch',async(url,options={})=>{if(options.method==='POST'){assert.equal(JSON.parse(options.body).action,'check_sheet_access');return ++checks===1?Response.json({detail:'主表寫入權限不足'},{status:503}):Response.json({verified:true});}return Response.json(check);});
 const ui=await mount(t,OsPaymentPanel,props);await ui.click(ui.button('登記收款'));assert.equal(ui.button('確認並同步主表').disabled,true);assert.match(document.body.textContent,/主表寫入權限不足/);await ui.click(ui.button('重新檢查主表連線'));assert.equal(ui.button('確認並同步主表').disabled,false);assert.ok(ui.control('本次收到多少（元）'));
});
