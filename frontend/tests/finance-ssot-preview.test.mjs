import assert from 'node:assert/strict';
import test from 'node:test';
import {previewSsotOsFinance,applySsotFinance,osFinanceOriginHash} from
  '../src/lib/finance-ssot-operations.ts';
import {verifyFinancePreview} from '../src/lib/finance-ssot-preview.server.ts';

const secret='synthetic-finance-preview-secret-32-bytes';
const requestId='10000000-0000-4000-8000-000000000003';
const bookingId='10000000-0000-4000-8000-000000000004';
const actor={id:'synthetic-owner',displayName:'Synthetic Owner',role:'owner',
  allProperties:true,propertyIds:['sweetfun'],viewPrices:true};
const config={calendar:{proofSecret:secret},grant:{propertyId:'synthetic'}};
const report={projection_version:'synthetic-projection',asof:'2026-10-28',
  state:{version:0,entries:[],operations:[]},entries:[],recurring:[],
  orders:[{id:'synthetic-order',platform:'agoda',source:'sheet',
    booking_id:bookingId,ssot_booking_version:7,
    ssot_source_snapshot_hash:'a'.repeat(64),receivable:5000}],
  payment_accounts:[],payout_rules:[],ssot_catalog:{categories:[]}};
const input={request_id:requestId,property_id:'sweetfun',year:2026,
  projection_version:report.projection_version,expected_version:0,
  action:'create',kind:'income',category:'lodging',amount:25,date:'2026-10-27',
  method:'bank_transfer',stage:'balance',description:'Synthetic receipt',
  platform:'agoda',allocations:[{order_id:'synthetic-order',amount_cents:2500}]};

test('linked OS preview binds the exact IG command and token before any write',async()=>{
  const calls=[];
  const preview=async(_config,_actor,command,key)=>{
    calls.push({command,key});
    return {command:{...command,preview_token:'ig-preview-token'},
      bookings:[{bookingId}],source_instance_id:'synthetic',
      source_system:'os_manual'};
  };
  const result=await previewSsotOsFinance(input,report,actor,'sweetfun',2026,
    [],preview,config);
  assert.equal(calls.length,1);
  assert.equal(calls[0].key,requestId);
  assert.equal(result.booking_count,1);
  assert.match(result.lines.join('\n'),/synthetic-order/);
  const originHash=osFinanceOriginHash(input,actor.id,'sweetfun');
  const confirmed=verifyFinancePreview({...input,ssot_preview_proof:result.preview_proof},
    actor,'sweetfun',originHash,secret);
  assert.equal(confirmed.confirmed_command.preview_token,'ig-preview-token');
  assert.equal(confirmed.confirmed_command.request_key,requestId);
  assert.deepEqual(confirmed.draft_command,calls[0].command);
  await assert.rejects(async()=>verifyFinancePreview(
    {...input,amount:26,ssot_preview_proof:result.preview_proof},actor,'sweetfun',
    osFinanceOriginHash({...input,amount:26},actor.id,'sweetfun'),secret),
  /FINANCE_PREVIEW_EXPIRED/);
});

test('confirmed write uses the original command after the OS projection changes',async t=>{
  const original=await previewSsotOsFinance(input,report,actor,'sweetfun',2026,
    [],async(_config,_actor,command)=>({command:{...command,
      preview_token:'original-ig-token'},bookings:[{bookingId}],
      source_instance_id:'synthetic',source_system:'os_manual'}),config);
  const hash=osFinanceOriginHash(input,actor.id,'sweetfun');
  const confirmed=verifyFinancePreview({...input,
    ssot_preview_proof:original.preview_proof},actor,'sweetfun',hash,secret);
  const receipt={receipt_status:'accepted',request_key:requestId,
    origin_request_hash:hash,document_id:'10000000-0000-4000-8000-000000000009'};
  const paths=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const path=new URL(url).pathname;
    paths.push(path);
    if(path.endsWith('/commands')){
      assert.deepEqual(JSON.parse(options.body),confirmed.confirmed_command);
      return Response.json(receipt,{status:201});
    }
    if(path.endsWith(`/receipts/${requestId}`))return Response.json(receipt);
    throw Error('unexpected IG operation');
  });
  const changedReport={...report,projection_version:'newer-projection',
    ssot_catalog:{categories:[{kind:'income',code:'lodging',
      label:'住宿收入',status:'active'}]}};
  const result=await applySsotFinance({...input,
    ssot_preview_proof:original.preview_proof},changedReport,actor,'sweetfun',
  2026,[],hash,confirmed,{...config,calendar:{...config.calendar,
    baseUrl:'https://iron-gate-test.example'},
    grant:{credentialId:'10000000-0000-4000-8000-000000000005',
      clientId:'10000000-0000-4000-8000-000000000006',
      workspaceId:'10000000-0000-4000-8000-000000000007',
      propertyId:'10000000-0000-4000-8000-000000000001',token:'x'.repeat(43)}});
  assert.equal(result.verified,true);
  assert.equal(result.entry_id,receipt.document_id);
  assert.equal(paths.length,2);
  assert.ok(paths.every(path=>!path.endsWith('/commands/preview')));
});

test('a noncash OS preview signs a local validated plan without calling IG',async()=>{
  const plan={...input,action:'payout_rule',platform:'ctrip',mode:'monthly',
    day:12,offset:1};
  const result=await previewSsotOsFinance(plan,report,actor,'sweetfun',2026,
    [],async()=>{throw Error('unexpected IG preview');},config);
  assert.match(result.lines.join('\n'),/ctrip/);
  const proof=verifyFinancePreview({...plan,ssot_preview_proof:result.preview_proof},
    actor,'sweetfun',osFinanceOriginHash(plan,actor.id,'sweetfun'),secret);
  assert.equal(proof.plan_suffix,'payout-rules');
  assert.equal(proof.plan_command.day,12);
});

test('Offland historical OS source cannot be edited through the live connector',async()=>{
  const historicalId='10000000-0000-4000-8000-000000000008';
  const offland={...report,ssot_live_source_instance_id:
    '10000000-0000-4000-8000-000000000005',entries:[{
      id:historicalId,ssot_source_system:'os_manual',
      ssot_source_instance_id:'10000000-0000-4000-8000-000000000006',
      ssot_source_record_id:'old-os-expense',ssot_document_version:1,
      kind:'expense',status:'active'}]};
  for(const change of [
    {...input,property_id:'offland',action:'void',
      entry_id:historicalId,reason:'Synthetic correction'},
    {...input,property_id:'offland',action:'update_expense',
      entry_id:historicalId,kind:'expense'}]){
    await assert.rejects(previewSsotOsFinance(change,offland,actor,'offland',2026,
      [],async()=>{throw Error('unexpected IG preview');},config),
    /SOURCE_MAPPING_REVIEW_REQUIRED/);
    const origin=osFinanceOriginHash(change,actor.id,'offland');
    await assert.rejects(applySsotFinance(change,offland,actor,'offland',2026,
      [],origin,{origin_hash:origin,draft_command:{},confirmed_command:{}},config),
    /SOURCE_MAPPING_REVIEW_REQUIRED/);
  }
});

test('Offland live OS expense can preview and confirm an update and a void',async t=>{
  const live='10000000-0000-4000-8000-000000000005';
  const entryId='10000000-0000-4000-8000-000000000008';
  const entry={id:entryId,property_id:'offland',kind:'expense',
    category:'electricity',amount_cents:2500,date:'2026-10-28',
    description:'Synthetic expense',method:'cash',source:'iron_gate',
    actor:'Synthetic Owner',created_at:'2026-10-28T01:00:00Z',status:'active',
    ssot_source_system:'os_manual',ssot_source_instance_id:live,
    ssot_source_record_id:'os-current-expense',ssot_document_version:1};
  const offland={...report,ssot_live_source_instance_id:live,
    entries:[entry],state:{version:0,entries:[entry],operations:[]},
    ssot_catalog:{categories:[{kind:'expense',code:'electricity',
      label:'電費',status:'active'}]}};
  const receipts=new Map();
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/commands')){
      const command=JSON.parse(options.body);
      const receipt={receipt_status:'accepted',request_key:command.request_key,
        origin_request_hash:command.origin_request_hash,document_id:entryId,
        document_version:2,event_ids:[]};
      receipts.set(command.request_key,receipt);
      return Response.json(receipt,{status:201});
    }
    const key=path.split('/').at(-1);
    if(path.includes('/receipts/')&&receipts.has(key))
      return Response.json(receipts.get(key));
    throw Error('unexpected IG operation');
  });
  const liveConfig={...config,calendar:{...config.calendar,
    baseUrl:'https://iron-gate-test.example'},
    grant:{credentialId:'10000000-0000-4000-8000-000000000005',
      clientId:'10000000-0000-4000-8000-000000000006',
      workspaceId:'10000000-0000-4000-8000-000000000007',
      propertyId:'10000000-0000-4000-8000-000000000001',token:'x'.repeat(43)}};
  const changes=[
    {request_id:'10000000-0000-4000-8000-000000000010',action:'update_expense',
      kind:'expense',category:'electricity',amount:25,date:'2026-10-28',
      method:'cash',description:'Synthetic correction'},
    {request_id:'10000000-0000-4000-8000-000000000011',action:'void',
      reason:'Synthetic void'}];
  const {allocations:_allocations,platform:_platform,stage:_stage,...baseInput}=input;
  void _allocations;void _platform;void _stage;
  for(const change of changes){
    const intent={...baseInput,...change,property_id:'offland',entry_id:entryId};
    const preview=await previewSsotOsFinance(intent,offland,actor,'offland',2026,
      [],async()=>{throw Error('unexpected linked preview');},liveConfig);
    const origin=osFinanceOriginHash(intent,actor.id,'offland');
    const confirmed=verifyFinancePreview({...intent,
      ssot_preview_proof:preview.preview_proof},actor,'offland',origin,secret);
    const result=await applySsotFinance(intent,offland,actor,'offland',2026,
      [],origin,confirmed,liveConfig);
    assert.equal(result.verified,true);
    assert.equal(result.entry_id,entryId);
  }
  assert.equal(receipts.size,2);
});

test('preview proof rejects tampering, another actor and expiry',async()=>{
  const plan={...input,action:'payout_rule',platform:'ctrip',mode:'manual',
    day:10,offset:1};
  const result=await previewSsotOsFinance(plan,report,actor,'sweetfun',2026,
    [],async()=>{throw Error('unexpected IG preview');},config);
  const bound={...plan,ssot_preview_proof:result.preview_proof};
  const hash=osFinanceOriginHash(plan,actor.id,'sweetfun');
  assert.throws(()=>verifyFinancePreview(bound,{...actor,id:'another-owner'},
    'sweetfun',hash,secret),/FINANCE_PREVIEW_EXPIRED/);
  assert.throws(()=>verifyFinancePreview({...bound,ssot_preview_proof:
    `${result.preview_proof[0]==='A'?'B':'A'}${result.preview_proof.slice(1)}`},
  actor,'sweetfun',hash,secret),
  /FINANCE_PREVIEW_REQUIRED/);
  assert.throws(()=>verifyFinancePreview(bound,actor,'sweetfun',hash,secret,
    Date.now()+11*60_000),/FINANCE_PREVIEW_EXPIRED/);
});
