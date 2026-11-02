import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/customer-dom.mjs';
import { fixture } from './helpers/order-fixture.mjs';
import { createHold, view } from '../src/lib/customer-workspaces/service.ts';
import { holdOperation } from '../src/lib/customer-workspaces/holds.ts';
import { OrderDetail } from '../src/components/customer-workspaces/order-detail.tsx';
import { CustomerCalendar } from '../src/components/customer-workspaces/calendar.tsx';
process.env.CUSTOMER_HOLDS_ENABLED='true';
const initial=async f=>{const w=await f.current();return view(w,w.members[0]);};
async function reserve(f){return createHold(f.store,'owner','test-orders',await f.input({propertyId:'p2',checkIn:'2027-02-01',checkOut:'2027-02-02',roomIds:['201'],total:9000,confirmPlatformOnly:true,platform:'Official Website'}));}
test('hold receipt form confirms amount; lost response locks other actions and retries exactly once',async t=>{
 const f=fixture(),{booking}=await reserve(f),calls=[];
 t.mock.method(globalThis,'fetch',async(_,options)=>{const input=JSON.parse(options.body);calls.push(input);const result=await holdOperation(f.store,'owner','test-orders',input);if(calls.length===1)throw Error('lost response');return Response.json(result);});
 const {button,control,click,fill}=await mount(t,OrderDetail,{initial:await initial(f),bookingId:booking.id,backHref:'/w/test-orders/orders'});
 assert.match(document.body.textContent,/保留中/);
 await click(button('確認已收訂金'));
 await fill(control('實際收款金額'),'3000');await fill(control('入帳時間（臺北）'),'2026-01-01T12:00');
 await click(control('我已核對實際入帳，金額與時間正確。'));
 await click(control('我確認這次操作僅更新本工作區，外部通路需另外核對。'));
 await click(button('確認儲存'));
 assert.equal(button('釋出保留').disabled,true);assert.equal(document.querySelector('a').getAttribute('aria-disabled'),'true');
 await click(button('重試相同操作並核對結果'));
 assert.deepEqual(calls[0],calls[1]);
 const saved=(await f.current()).bookings.find(b=>b.id===booking.id);assert.equal(saved.status,'confirmed');assert.equal(saved.payments.length,1);assert.equal(saved.payments[0].amount,3000);
 assert.match(document.body.textContent,/6,000/);assert.equal(button('釋出保留'),undefined);
});
test('new hold calendar flow requires platform-only acknowledgement and creates a real 24-hour hold',async t=>{
 const f=fixture(),calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,input:JSON.parse(options.body)});const result=await createHold(f.store,'owner','test-orders',calls.at(-1).input);return Response.json({workspace:result.workspace,bookingId:result.booking.id});});
 const {button,control,click,fill}=await mount(t,CustomerCalendar,{initial:await initial(f),initialPropertyId:'p2'});
 await click(button('＋新增訂房'));
 await fill(control('建立類型'),'hold');await fill(control('入住日期'),'2027-02-01');
 const room=[...document.querySelectorAll('input[type=checkbox]')].find(i=>i.closest('label')?.textContent.includes('201'));
 if(room)await click(room);else {const b=button('201');if(b)await click(b);}
 await fill(control('整筆房費（全部房間、全部晚數合計）'),'9000');
 await click(control('我確認僅保留本工作區房況，外部通路尚未同步關房。'));
 await click(button('建立 24 小時保留單'));
 assert.equal(calls.length,1);assert.match(calls[0].url,/operations$/);assert.equal(calls[0].input.action,'hold-create');
 const saved=(await f.current()).bookings.at(-1);assert.equal(saved.status,'held');assert.equal(saved.payments.length,0);assert.match(document.body.textContent,/保留期限/);
});
