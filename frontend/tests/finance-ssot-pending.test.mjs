import assert from 'node:assert/strict';
import test from 'node:test';
import {readPendingOsFinance,reservePendingOsFinance,acceptPendingOsFinance,
  acknowledgePendingOsFinance} from '../src/lib/finance-ssot-pending.server.ts';
import {resumeSsotFinance,osFinanceOriginHash} from
  '../src/lib/finance-ssot-operations.ts';

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
      const [script,_count,key,expected,replacement]=args;
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
