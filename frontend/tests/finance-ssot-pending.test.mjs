import assert from 'node:assert/strict';
import test from 'node:test';
import {readPendingOsFinance,reservePendingOsFinance,acceptPendingOsFinance,
  acknowledgePendingOsFinance} from '../src/lib/finance-ssot-pending.server.ts';
import {resumeSsotFinance,osFinanceOriginHash} from
  '../src/lib/finance-ssot-operations.ts';
import {submitSsotOsFinance} from '../src/lib/finance-ssot-submit.server.ts';

const requestId='10000000-0000-4000-8000-000000000003';
const otherId='10000000-0000-4000-8000-000000000004';
const actor={id:'synthetic-owner',role:'owner',allProperties:true,
  propertyIds:['sweetfun'],viewPrices:true};
const input={request_id:requestId,property_id:'sweetfun',year:2026,
  action:'create',kind:'expense',amount:1200,description:'Synthetic supplies',
  projection_version:'original-projection',expected_version:0};
const config={calendar:{baseUrl:'https://iron-gate-test.example',
  proofSecret:'synthetic-proof-secret-32-bytes-long'},
  grant:{credentialId:'10000000-0000-4000-8000-000000000005',
    clientId:'10000000-0000-4000-8000-000000000006',
    workspaceId:'10000000-0000-4000-8000-000000000007',
    propertyId:'10000000-0000-4000-8000-000000000001',token:'x'.repeat(43)}};

test('an unknown OS write survives reload and reuses the original request',async t=>{
  const oldUrl=process.env.UPSTASH_REDIS_REST_URL;
  const oldToken=process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL='https://redis.test.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN='synthetic-token';
  t.after(()=>{
    if(oldUrl===undefined)delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL=oldUrl;
    if(oldToken===undefined)delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN=oldToken;
  });
  const values=new Map();
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(String(url),'https://redis.test.invalid');
    const [verb,...args]=JSON.parse(options.body);
    let result;
    if(verb==='GET')result=values.get(args[0])??null;
    else if(verb==='SET'){
      const [key,value,mode]=args;
      if(mode==='NX'&&values.has(key))result=null;
      else{values.set(key,value);result='OK';}
    }else if(verb==='EVAL'){
      const [script,,key,expected,replacement]=args;
      if(values.get(key)!==expected)result=0;
      else if(script.includes("redis.call('DEL'")){
        values.delete(key);result=1;
      }else{values.set(key,replacement);result=1;}
    }else throw Error(`unexpected Redis command ${verb}`);
    return Response.json({result});
  });

  await reservePendingOsFinance(input,'sweetfun',actor);
  // The ledger accepted this request, but the OS response was lost before
  // the server could mark completion. All in-memory browser state is gone.
  const reloaded=await readPendingOsFinance('sweetfun',actor);
  assert.equal(reloaded.status,'pending');
  assert.deepEqual(reloaded.input,input);
  await assert.rejects(reservePendingOsFinance({...input,request_id:otherId},
    'sweetfun',actor),/FINANCE_PENDING_REQUEST/);

  const receipt={receipt_status:'accepted',request_key:requestId,
    document_id:'10000000-0000-4000-8000-000000000008',
    origin_request_hash:osFinanceOriginHash(input,actor.id,'sweetfun')};
  const recovered=await resumeSsotFinance(reloaded.input,actor,'sweetfun',
    async()=>receipt,config);
  assert.equal(recovered.result.entry_id,receipt.document_id);
  await acceptPendingOsFinance('sweetfun',actor,requestId,recovered.result);
  assert.equal((await readPendingOsFinance('sweetfun',actor)).status,'accepted');
  await assert.rejects(reservePendingOsFinance({...input,request_id:otherId},
    'sweetfun',actor),/FINANCE_PENDING_REQUEST/);
  await assert.rejects(acknowledgePendingOsFinance('sweetfun',actor,otherId),
    /FINANCE_PENDING_REQUEST/);
  assert.equal(await acknowledgePendingOsFinance('sweetfun',actor,requestId),true);
  assert.equal(await readPendingOsFinance('sweetfun',actor),null);
});

test('an existing unknown request stays blocked after preview expiry and a missing receipt',async t=>{
  const names=['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN',
    'OS_SWEETFUN_FINANCE_SSOT_ENABLED','CALENDAR_SOURCE',
    'IRON_GATE_SWEETFUN_CALENDAR_ENABLED',
    'IRON_GATE_SWEETFUN_CALENDAR_PREVIEW_ENABLED',
    'IRON_GATE_SWEETFUN_CALENDAR_GRANT',
    'IRON_GATE_SWEETFUN_SSOT_FINANCE_GRANT',
    'IRON_GATE_SWEETFUN_BASE_URL','IRON_GATE_SWEETFUN_AUTHORITY_EPOCH',
    'IRON_GATE_SWEETFUN_ROOM_IDS','IRON_GATE_SWEETFUN_OS_PROOF_SECRET'];
  const old=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  const grant={credentialId:'10000000-0000-4000-8000-000000000005',
    clientId:'10000000-0000-4000-8000-000000000006',
    workspaceId:'10000000-0000-4000-8000-000000000007',
    propertyId:'10000000-0000-4000-8000-000000000001',token:'x'.repeat(43)};
  Object.assign(process.env,{
    UPSTASH_REDIS_REST_URL:'https://redis.test.invalid',
    UPSTASH_REDIS_REST_TOKEN:'synthetic-token',
    OS_SWEETFUN_FINANCE_SSOT_ENABLED:'true',CALENDAR_SOURCE:'sheet_snapshot',
    IRON_GATE_SWEETFUN_CALENDAR_ENABLED:'true',
    IRON_GATE_SWEETFUN_CALENDAR_PREVIEW_ENABLED:'false',
    IRON_GATE_SWEETFUN_CALENDAR_GRANT:JSON.stringify(grant),
    IRON_GATE_SWEETFUN_SSOT_FINANCE_GRANT:JSON.stringify(grant),
    IRON_GATE_SWEETFUN_BASE_URL:'https://iron-gate-test.example',
    IRON_GATE_SWEETFUN_AUTHORITY_EPOCH:'1',
    IRON_GATE_SWEETFUN_ROOM_IDS:JSON.stringify(Object.fromEntries(
      ['101','102','201','202','301','302'].map((room,index)=>
        [room,`10000000-0000-4000-8000-00000000001${index}`]))),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET:'synthetic-proof-secret-32-bytes-long'});
  t.after(()=>{for(const name of names){
    if(old[name]===undefined)delete process.env[name];
    else process.env[name]=old[name];
  }});
  // The stored request survives a stale OS projection and an expired preview.
  const unknown={...input,projection_version:'stale-projection',
    ssot_preview_proof:'expired-preview'};
  const values=new Map();let accepted=false;const paths=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url)==='https://redis.test.invalid'){
      const [verb,...args]=JSON.parse(options.body);
      let result;
      if(verb==='GET')result=values.get(args[0])??null;
      else if(verb==='SET'){
        const [key,value,mode]=args;
        if(mode==='NX'&&values.has(key))result=null;
        else{values.set(key,value);result='OK';}
      }else if(verb==='EVAL'){
        const [script,_count,key,expected,replacement]=args;
        if(values.get(key)!==expected)result=0;
        else if(script.includes("redis.call('DEL'")){
          values.delete(key);result=1;
        }else{values.set(key,replacement);result=1;}
      }else throw Error(`unexpected Redis command ${verb}`);
      return Response.json({result});
    }
    const path=new URL(url).pathname;
    paths.push(path);
    assert.ok(path.endsWith(`/receipts/${requestId}`),
      'retry may only read the original receipt');
    return accepted?Response.json({receipt_status:'accepted',request_key:requestId,
      document_id:'10000000-0000-4000-8000-000000000008',
      origin_request_hash:osFinanceOriginHash(unknown,actor.id,'sweetfun')}):
      Response.json({error:{code:'REQUEST_NOT_FOUND'}},{status:404});
  });
  const reservations=await Promise.all([
    reservePendingOsFinance(unknown,'sweetfun',actor),
    reservePendingOsFinance(unknown,'sweetfun',actor)]);
  assert.deepEqual(reservations.map(value=>value.created).sort(),[false,true]);
  await assert.rejects(submitSsotOsFinance(unknown,actor,'sweetfun',2026),
    /WRITE_UNCONFIRMED/);
  assert.equal((await readPendingOsFinance('sweetfun',actor)).status,'pending');
  await assert.rejects(submitSsotOsFinance({...unknown,request_id:otherId},
    actor,'sweetfun',2026),/FINANCE_PENDING_REQUEST/);
  assert.equal(paths.length,1);
  accepted=true;
  const recovered=await submitSsotOsFinance(unknown,actor,'sweetfun',2026);
  assert.equal(recovered.verified,true);
  assert.equal((await readPendingOsFinance('sweetfun',actor)).status,'accepted');
  assert.equal(paths.length,2);
});
