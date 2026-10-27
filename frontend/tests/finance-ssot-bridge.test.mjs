import assert from 'node:assert/strict';
import test from 'node:test';
import {submitSsotFinanceCommand,submitSsotPlan} from
  '../src/lib/booking-sources/iron-gate-ssot-finance.server.ts';

const propertyId='10000000-0000-4000-8000-000000000001';
const bookingId='10000000-0000-4000-8000-000000000002';
const key='10000000-0000-4000-8000-000000000003';
const config={calendar:{baseUrl:'https://iron-gate-test.example',
  proofSecret:'synthetic-proof-secret-32-bytes-long'},
  grant:{credentialId:'10000000-0000-4000-8000-000000000004',
    clientId:'10000000-0000-4000-8000-000000000005',
    workspaceId:'10000000-0000-4000-8000-000000000006',
    propertyId,token:'x'.repeat(43)}};
const actor={id:'synthetic-owner',role:'owner',allProperties:true,
  propertyIds:['sweetfun'],viewPrices:true};
const command={request_key:key,source_record_id:`os-${key}`,source_version:'1',
  action:'create',event_kind:'property_receipt',amount_cents:1000,currency:'TWD',
  effective_on:'2026-10-28',cash_on:'2026-10-28',receipt_purpose:'room',
  evidence_level:'operator_attested',booking_allocations:[{booking_id:bookingId,
    expected_booking_version:1,amount_cents:1000,allocation_kind:'room'}]};
const receipt={receipt_status:'accepted',request_key:key,
  document_id:'10000000-0000-4000-8000-000000000007',document_version:1,
  event_ids:['10000000-0000-4000-8000-000000000008']};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,
  headers:{'content-type':'application/json'}});

test('OS bridge previews linked booking, commits once and compares the authoritative receipt',async()=>{
  const paths=[];
  const send=async (url,options)=>{
    const path=new URL(url).pathname;
    paths.push(path);
    if(path.endsWith('/commands/preview'))return reply({resolved_command:command,
      preview_token:'synthetic-token'});
    if(path.endsWith('/commands')){
      if(!JSON.parse(options.body).preview_token)
        return reply({error:{code:'VERSION_CONFLICT'}},409);
      return reply(receipt,201);
    }
    if(path.endsWith(`/receipts/${key}`))return reply({event_ids:receipt.event_ids,
      document_version:1,document_id:receipt.document_id,
      request_key:key,receipt_status:'accepted'});
    throw Error('unexpected path');
  };
  const result=await submitSsotFinanceCommand(config,actor,command,key,send);
  assert.deepEqual(result.event_ids,receipt.event_ids);
  assert.deepEqual(paths.map(p=>p.split('/').slice(-2).join('/')),
    ['finance/commands','commands/preview','finance/commands',`receipts/${key}`]);
});

test('unknown POST outcome recovers only through the original request receipt',async()=>{
  let called=0;
  const send=async url=>{
    called++;
    if(new URL(url).pathname.endsWith('/commands'))throw Error('network interrupted');
    return reply(receipt);
  };
  assert.equal((await submitSsotFinanceCommand(config,actor,
    {...command,booking_allocations:[]},key,send)).document_id,receipt.document_id);
  assert.equal(called,2);
});

test('approved Sheet command stops on booking version conflict without a silent repreview',async()=>{
  const paths=[];
  const send=async url=>{
    const path=new URL(url).pathname;
    paths.push(path);
    return reply({error:{code:'VERSION_CONFLICT'}},409);
  };
  await assert.rejects(submitSsotFinanceCommand(config,actor,
    {...command,preview_token:'approved-version-token'},key,send,
    {repreviewOnConflict:false}),/VERSION_CONFLICT/);
  assert.deepEqual(paths.map(path=>path.split('/').at(-1)),['commands']);
});

test('plan commands require a matching accepted readback',async()=>{
  const plan={request_key:key,code:'synthetic-category',kind:'expense',label:'Supplies'};
  const send=async url=>new URL(url).pathname.endsWith('/categories')?
    reply({...receipt,category_code:plan.code},201):
    reply({...receipt,category_code:'different'});
  await assert.rejects(submitSsotPlan(config,actor,'categories',plan,key,send),
    /FINANCE_SSOT_READBACK_MISMATCH/);
});
