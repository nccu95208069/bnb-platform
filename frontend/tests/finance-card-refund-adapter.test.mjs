import assert from 'node:assert/strict';
import test from 'node:test';
import {readManualPayment,recordManualPayment} from
  '../src/lib/booking-sources/iron-gate-manual-payment.server.ts';

const bookingId='10000000-0000-4000-8000-000000000001';
const propertyId='10000000-0000-4000-8000-000000000002';
const workspaceId='10000000-0000-4000-8000-000000000003';
const receiptId='10000000-0000-4000-8000-000000000004';
const refundId='10000000-0000-4000-8000-000000000005';
const actor={id:'synthetic-owner',role:'owner',allProperties:true,
  propertyIds:['sweetfun'],viewPrices:true};
const config={calendar:{baseUrl:'https://iron-gate-test.example',
  proofSecret:'synthetic-proof-secret-32-bytes-long'},
  grant:{credentialId:'10000000-0000-4000-8000-000000000006',
    clientId:'10000000-0000-4000-8000-000000000007',workspaceId,
    propertyId,token:'x'.repeat(43)}};
const receipt={id:receiptId,kind:'received',amountCents:10000,currency:'TWD',
  evidenceRef:'booking-card:SYNTHETIC',method:'credit_card',
  occurredAt:'2026-10-20T00:00:00.000Z',recordedAt:'2026-10-20T00:00:01.000Z',
  actorId:'card-sync'};
const input={expectedBookingVersion:2,kind:'refunded',amountCents:3000,
  evidenceRef:'synthetic refund',method:'credit_card',
  occurredAt:'2026-10-21T00:00:00.000Z',refundOfEventId:receiptId};
function booking(events=[receipt]){
  const received=events.filter(e=>e.kind==='received').reduce((n,e)=>n+e.amountCents,0);
  const refunded=events.filter(e=>e.kind==='refunded').reduce((n,e)=>n+e.amountCents,0);
  return {id:bookingId,propertyId,workspaceId,source:'external',cardManaged:true,
    version:events.length+1,status:'cancelled',currency:'TWD',totalCents:10000,
    paymentEvents:events,paymentSummary:{receivedCents:received,refundedCents:refunded,
      netReceivedCents:received-refunded}};
}

test('Card-managed booking permits only an SSOT refund linked to its original receipt',async t=>{
  const old=process.env.OS_SWEETFUN_FINANCE_SSOT_ENABLED;
  t.after(()=>{if(old===undefined)delete process.env.OS_SWEETFUN_FINANCE_SSOT_ENABLED;
    else process.env.OS_SWEETFUN_FINANCE_SSOT_ENABLED=old;});
  let current=booking();
  let posts=0;
  const send=async(_url,options)=>{
    if(options.method==='GET')return Response.json(current);
    posts++;
    const body=JSON.parse(options.body);
    assert.equal(body.kind,'refunded');
    assert.equal(body.refundOfEventId,receiptId);
    current=booking([...current.paymentEvents,{...receipt,id:refundId,
      kind:'refunded',amountCents:3000,evidenceRef:'synthetic refund',
      occurredAt:input.occurredAt,recordedAt:'2026-10-21T00:00:01.000Z',
      actorId:'synthetic-owner',refundOfEventId:receiptId}]);
    return Response.json({bookingId,paymentEventId:refundId,bookingVersion:current.version});
  };
  assert.equal((await readManualPayment(actor,config,bookingId,send)).cardManaged,true);
  await assert.rejects(recordManualPayment(actor,config,bookingId,input,refundId,send),
    /IRON_GATE_FINANCE_UNAVAILABLE/);
  process.env.OS_SWEETFUN_FINANCE_SSOT_ENABLED='true';
  await assert.rejects(recordManualPayment(actor,config,bookingId,
    {...input,kind:'received',refundOfEventId:undefined},refundId,send),
  /SOURCE_MAPPING_REVIEW_REQUIRED/);
  await assert.rejects(recordManualPayment(actor,config,bookingId,
    {...input,refundOfEventId:'10000000-0000-4000-8000-000000000009'},refundId,send),
  /INVALID_REFUND_REFERENCE/);
  assert.equal(posts,0);
  const result=await recordManualPayment(actor,config,bookingId,input,refundId,send);
  assert.equal(result.netReceivedCents,7000);
  assert.equal(posts,1);
});
