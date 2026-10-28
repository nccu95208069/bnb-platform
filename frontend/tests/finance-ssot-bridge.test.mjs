import assert from 'node:assert/strict';
import test from 'node:test';
import {previewSsotFinanceCommand,readSsotReceipt,
  submitSsotFinanceCommand,submitSsotPlan} from
  '../src/lib/booking-sources/iron-gate-ssot-finance.server.ts';
import {osFinanceOriginHash,resumeSsotFinance} from
  '../src/lib/finance-ssot-operations.ts';

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

test('Sheet preview exposes the authenticated connector even without a booking',async()=>{
  const expense={...command,event_kind:'expense_paid',booking_allocations:[],
    category_code:'supplies',expense_attributions:[{month:'2026-10-01',
      amount_cents:1000,allocation_policy:'ig_v1_earliest_cent'}]};
  const send=async()=>reply({resolved_command:expense,preview_token:null,
    bookings:[],source_instance_id:'10000000-0000-4000-8000-000000000009',
    source_system:'sheet_bulk',source_sheet_ref:'SyntheticSheet_0123456789'});
  const result=await previewSsotFinanceCommand(config,actor,expense,key,send);
  assert.equal(result.source_system,'sheet_bulk');
  assert.equal(result.command.preview_token,undefined);
});

test('plan commands require a matching accepted readback',async()=>{
  const plan={request_key:key,code:'synthetic-category',kind:'expense',label:'Supplies'};
  const send=async url=>new URL(url).pathname.endsWith('/categories')?
    reply({...receipt,category_code:plan.code},201):
    reply({...receipt,category_code:'different'});
  await assert.rejects(submitSsotPlan(config,actor,'categories',plan,key,send),
    /FINANCE_SSOT_READBACK_MISMATCH/);
});

test('OS retry resolves the original accepted request before consulting a newer projection',async()=>{
  const input={request_id:key,projection_version:'old-projection',
    property_id:'sweetfun',year:2026,action:'create',kind:'income',amount:10,
    allocations:[{order_id:'SF-SYNTHETIC',amount_cents:1000}]};
  const hash=osFinanceOriginHash(input,actor.id,'sweetfun');
  let reads=0;
  const read=async()=>{reads++;return {...receipt,origin_request_hash:hash};};
  const resumed=await resumeSsotFinance(input,actor,'sweetfun',read,config);
  assert.equal(resumed.result.verified,true);
  assert.equal(resumed.result.entry_id,receipt.document_id);
  assert.equal(reads,1);
  assert.equal(osFinanceOriginHash({...input,action:'create'},actor.id,'sweetfun'),hash);
  await assert.rejects(resumeSsotFinance({...input,amount:11},actor,
    'sweetfun',read,config),/IDEMPOTENCY_CONFLICT/);
  assert.equal((await resumeSsotFinance(input,actor,'sweetfun',
    async()=>null,config)).result,null);
});

test('OS receipt lookup distinguishes a missing request from an unavailable readback',async()=>{
  const missing=async()=>reply({error:{code:'REQUEST_NOT_FOUND'}},404);
  assert.equal(await readSsotReceipt(config,actor,key,missing),null);
  const down=async()=>reply({error:{code:'UNAVAILABLE'}},503);
  await assert.rejects(readSsotReceipt(config,actor,key,down),
    /UNAVAILABLE/);
});
