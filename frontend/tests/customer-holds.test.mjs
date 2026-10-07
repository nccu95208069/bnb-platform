import test from 'node:test';
import assert from 'node:assert/strict';
import { createBooking, createHold, loadWorkspace, view } from '../src/lib/customer-workspaces/service.ts';
import { holdOperation, pendingHoldTasks } from '../src/lib/customer-workspaces/holds.ts';
import { holdPhase, bookingStatusLabel } from '../src/lib/customer-workspaces/hold-state.ts';
import { availability, bookingOperation } from '../src/lib/customer-workspaces/operations.ts';
import { orderMutation } from '../src/lib/customer-workspaces/order-mutations.ts';
import { financeSummary } from '../src/lib/customer-workspaces/domain.ts';
import { buildStandardWorkbook } from '../src/lib/customer-workspaces/standard-sheet.ts';
import { queryOrders } from '../src/lib/customer-workspaces/order-query.ts';

process.env.CUSTOMER_HOLDS_ENABLED = 'true';
function fixture() {
  const workspace = { id:'workspace-holds', slug:'synthetic-holds', name:'Synthetic', version:1,
    members:[{accountId:'owner',role:'owner',active:true,allProperties:true,propertyIds:[]}],
    properties:[{id:'property-a',name:'Synthetic',kind:'mixed',sourceMode:'native',rooms:[{id:'room-a',name:'A'},{id:'room-b',name:'B'}],villaRoomIds:['room-a','room-b']}], bookings:[],audit:[] };
  const values = new Map([['slug:synthetic-holds',JSON.stringify(workspace.id)],['workspace:workspace-holds',JSON.stringify(workspace)]]);
  const store = {
    values,
    async read(key){const raw=values.get(key)??null;return {raw,value:raw?JSON.parse(raw):null};},
    async commit(changes){if(changes.some(c=>(values.get(c.key)??null)!==c.before))throw Error('VERSION_CONFLICT');for(const c of changes)values.set(c.key,JSON.stringify(c.after));},
    async limit(){},
  };
  let seq=0;
  const current=async()=>(await loadWorkspace(store,'owner',workspace.slug)).workspace;
  const command=async(extra)=>({requestKey:`synthetic-operation-${++seq}`,version:(await current()).version,...extra});
  const args=[store,'owner',workspace.slug];
  const reserve=async(extra={})=>createHold(...args,await command({propertyId:'property-a',checkIn:'2027-10-10',checkOut:'2027-10-12',roomIds:['room-a'],guestName:'Synthetic guest',total:9000,platform:'Official Website',confirmPlatformOnly:true,...extra}));
  const op=async(bookingId,action,extra={})=>holdOperation(...args,await command({bookingId,bookingVersion:(await current()).bookings.find(b=>b.id===bookingId).version,action,confirmPlatformOnly:true,...extra}));
  const edit=(fn)=>{const w=JSON.parse(values.get('workspace:workspace-holds'));fn(w);values.set('workspace:workspace-holds',JSON.stringify(w));};
  return {store,args,current,command,reserve,op,edit};
}
const payment={amount:3000,method:'cash',receivedAt:'2025-01-01T00:00:00Z',confirmedReceipt:true};

test('hold occupies nights, villa and availability; expiry survives reload without reopening',async()=>{
  const f=fixture(),{booking}=await f.reserve();
  const w=await f.current(),expires=new Date(Date.parse(booking.hold.expiresAt)+1);
  assert.equal(Date.parse(booking.hold.expiresAt)-Date.parse(booking.hold.startedAt),86400000);
  assert.equal(holdPhase(w.bookings[0],expires),'awaiting_owner');
  assert.equal(pendingHoldTasks(w,expires).length,1);
  assert.equal(w.bookings[0].status,'held');
  const list=await availability(...f.args,{propertyId:'property-a',from:'2027-10-10',to:'2027-10-12',showPrices:false});
  assert(!list.rows.some(r=>r.date==='2027-10-10'&&['room-a','villa'].includes(r.roomId)));
  assert(list.rows.some(r=>r.date==='2027-10-12'&&r.roomId==='room-a'));
  await assert.rejects(f.reserve({roomIds:['room-a','room-b']}),/ROOM_CONFLICT/);
  await assert.rejects(createBooking(...f.args,await f.command({propertyId:'property-a',checkIn:'2027-10-10',checkOut:'2027-10-12',roomIds:['room-a'],total:9000})),/ROOM_CONFLICT/);
});
test('concurrent last-room creation admits only one; exact retry is durable',async()=>{
  const f=fixture();
  const input=await f.command({propertyId:'property-a',checkIn:'2027-10-10',checkOut:'2027-10-12',roomIds:['room-a'],total:9000,confirmPlatformOnly:true});
  const results=await Promise.allSettled([createHold(...f.args,input),createHold(...f.args,{...input,requestKey:'other-synthetic-key'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const first=results.find(r=>r.status==='fulfilled').value;
  const original=results[0].status==='fulfilled'?input:{...input,requestKey:'other-synthetic-key'};
  assert.equal((await createHold(...f.args,original)).booking.id,first.booking.id);
  assert.equal((await f.current()).bookings.length,1);
  await assert.rejects(createHold(...f.args,{...original,total:8000}),/IDEMPOTENCY_CONFLICT/);
});
test('extension rejects stale buttons and invalid deadlines, keeps same identity',async()=>{
  const f=fixture(),{booking}=await f.reserve();
  const input=await f.command({action:'hold-extend',bookingId:booking.id,bookingVersion:1,hours:12,confirmPlatformOnly:true});
  await holdOperation(...f.args,input);
  const after=(await f.current()).bookings[0];
  assert.equal(Date.parse(after.hold.expiresAt)-Date.parse(booking.hold.expiresAt),12*3600000);
  await holdOperation(...f.args,input);
  assert.equal((await f.current()).bookings[0].hold.expiresAt,after.hold.expiresAt);
  await assert.rejects(holdOperation(...f.args,{...input,requestKey:'stale-new-operation'}),/VERSION_CONFLICT/);
  await assert.rejects(f.op(booking.id,'hold-extend',{expiresAt:'2026-02-30T00:00:00.000Z'}),/INVALID_HOLD_DEADLINE/);
});
test('confirmed deposit converts atomically with same ID/source, correct balance, no duplicate receipt',async()=>{
  const f=fixture(),{booking}=await f.reserve();
  const input=await f.command({action:'hold-convert',bookingId:booking.id,bookingVersion:1,confirmPlatformOnly:true,...payment});
  await holdOperation(...f.args,input);await holdOperation(...f.args,input);
  const saved=(await f.current()).bookings[0];
  assert.equal(saved.id,booking.id);assert.equal(saved.platform,'Official Website');assert.equal(saved.status,'confirmed');
  assert.equal(saved.payments.length,1);assert.equal(saved.payments[0].method,'現金');assert.equal(financeSummary(saved).remaining,6000);assert.equal(financeSummary(saved).status,'partial');
  await assert.rejects(f.op(saved.id,'hold-release'),/HOLD_STATE_CONFLICT/);
  await assert.rejects(orderMutation(...f.args,await f.command({action:'order-details',bookingId:saved.id,bookingVersion:saved.version,platform:'LINE'})),/BOOKING_SOURCE_IMMUTABLE/);
});
test('release plus late payment never steals inventory or converts cancelled booking',async()=>{
  const f=fixture(),{booking}=await f.reserve();
  await f.op(booking.id,'hold-release');
  const second=await f.reserve();
  await f.op(booking.id,'hold-late-payment',payment);
  const w=await f.current(),late=w.bookings.find(b=>b.id===booking.id);
  assert.equal(view(w,{...w.members[0],role:'viewer_no_price'}).bookings.find(b=>b.id===booking.id).hold.latePaymentReview,undefined);
  assert.equal(late.status,'cancelled');assert.equal(late.hold.latePaymentReview,true);assert.equal(financeSummary(late).received,3000);
  assert.equal(w.bookings.find(b=>b.id===second.booking.id).status,'held');
  assert(pendingHoldTasks(w).some(t=>t.kind==='late_payment_review'&&t.bookingId===booking.id));
  await f.op(booking.id,'hold-refund',payment);
  const refunded=(await f.current()).bookings.find(b=>b.id===booking.id);
  assert.equal(financeSummary(refunded).received,0);assert.equal(refunded.status,'cancelled');assert.equal(refunded.hold.latePaymentReview,false);
});
test('receipt/release race cannot confirm and reopen same booking',async()=>{
  const f=fixture(),{booking}=await f.reserve(),base=await f.command({bookingId:booking.id,bookingVersion:1,confirmPlatformOnly:true});
  const results=await Promise.allSettled([holdOperation(...f.args,{...base,action:'hold-convert',...payment}),holdOperation(...f.args,{...base,requestKey:'release-race-operation',action:'hold-release'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const saved=(await f.current()).bookings[0];
  assert(saved.status==='confirmed'?saved.payments.length===1:saved.status==='cancelled'&&saved.payments.length===0);
});
test('role/property/receipt guards and hidden-price projection',async()=>{
  const f=fixture(),{booking}=await f.reserve();
  await assert.rejects(f.op(booking.id,'hold-convert',{...payment,confirmedReceipt:false}),/RECEIPT_CONFIRMATION_REQUIRED/);
  await assert.rejects(f.op(booking.id,'hold-convert',{...payment,amount:10000}),/OVERPAYMENT/);
  await assert.rejects(f.op(booking.id,'hold-convert',{...payment,method:'bank'}),/RECEIPT_ACCOUNT_REQUIRED/);
  await assert.rejects(f.op(booking.id,'hold-convert',{...payment,receivedAt:'2025-01-01T24:01:00Z'}),/INVALID_INPUT/);
  await assert.rejects(bookingOperation(...f.args,await f.command({action:'payment',bookingId:booking.id,bookingVersion:1,...payment,kind:'deposit'})),/HOLD_ACTION_REQUIRED/);
  f.edit(w=>w.members[0].role='viewer_no_price');
  const w=await f.current(),privateView=view(w,w.members[0]);
  assert.equal(privateView.bookings[0].total,null);assert.deepEqual(privateView.bookings[0].payments,[]);
  await assert.rejects(f.op(booking.id,'hold-release'),/FORBIDDEN/);
  f.edit(w=>{w.members[0].role='admin';w.members[0].allProperties=false;w.members[0].propertyIds=[];});
  await assert.rejects(f.op(booking.id,'hold-release'),/NOT_FOUND/);
});
test('hold export and query never label held inventory cancelled or count it as confirmed',async()=>{
  const f=fixture(),{booking}=await f.reserve(),w=await f.current(),v=view(w,w.members[0]);
  const workbook=buildStandardWorkbook(w,{generatedAt:booking.hold.startedAt});
  assert.equal(workbook.schemaVersion,4);assert.equal(workbook.tables.orders[1][5],'保留中');assert.equal(workbook.tables.nights[1][7],'保留中');
  assert.equal(workbook.tables.orders[1][18],'Official Website');assert.equal(workbook.tables.orders[1][24],booking.hold.expiresAt);
  assert.equal(queryOrders(v,{status:'held'}).total,1);assert.equal(queryOrders(v,{status:'confirmed'}).total,0);
});

test('disabling new hold commands never releases existing occupancy',async()=>{
  const f=fixture(),{booking}=await f.reserve();
  process.env.CUSTOMER_HOLDS_ENABLED='false';
  try {
    await assert.rejects(f.reserve({roomIds:['room-b']}),/HOLDS_UNAVAILABLE/);
    await assert.rejects(f.op(booking.id,'hold-release'),/HOLDS_UNAVAILABLE/);
    const rows=(await availability(...f.args,{propertyId:'property-a',from:'2027-10-10',to:'2027-10-12',showPrices:false})).rows;
    assert(!rows.some(r=>r.date==='2027-10-10'&&r.roomId==='room-a'));
  } finally { process.env.CUSTOMER_HOLDS_ENABLED='true'; }
});

test('cancelling a converted formal booking retains its conversion history and cannot accept released-hold late payments',async()=>{
 const f=fixture(),{booking}=await f.reserve();await f.op(booking.id,'hold-convert',payment);
 let saved=(await f.current()).bookings[0];
 await bookingOperation(...f.args,await f.command({action:'payment',bookingId:saved.id,bookingVersion:saved.version,kind:'refund',amount:3000,receivedAt:payment.receivedAt}));
 saved=(await f.current()).bookings[0];
 await bookingOperation(...f.args,await f.command({action:'cancel',bookingId:saved.id,bookingVersion:saved.version}));
 const w=await f.current(),v=view(w,w.members[0]).bookings[0];
 assert.equal(v.status,'cancelled');assert.equal(v.hold.state,'converted');assert.equal(bookingStatusLabel(v),'已取消');
 await assert.rejects(f.op(booking.id,'hold-late-payment',payment),/HOLD_STATE_CONFLICT/);
});
